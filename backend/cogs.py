"""Arceo's OWN LLM spend — cost of goods sold, per org per month.

⚠️ This is NOT the customer budget counter, and confusing the two is the whole
point of the item that created this module.

  `agent_budgets` / `_budget_gate` / `_budget_settle`  — what the CUSTOMER's
      agents spend on the CUSTOMER's key, through the LLM proxy and the capture
      endpoint. Their money, their cap.

  `cogs:{org}:{month}` (here)                          — what ARCEO spends on
      ARCEO's key doing work on that customer's behalf: risk classification,
      code extraction, sandbox simulations, sweeps, red teams, scenario
      generation, LLM mocks, executive summaries, and the /api/scan endpoint the
      GitHub Action calls. Our money, our margin.

Every one of those paths resolves its key with `os.getenv("ANTHROPIC_API_KEY")`
— the server's — so every one of them is COGS. Before this, none of them moved
any counter at all: the three sandbox gates call `_budget_gate` with
`reserve=False` and no matching settle, so they read the customer's captured
dollars and never write anything. A cap can never trip on a counter that never
advances, which is why the plan puts metering strictly before gating.

## Why the metering lives at the client, not at the call sites

The obvious implementation is to instrument each `messages.create(...)`. There
are eleven of them across six modules, and that is precisely the shape that
drifts: a twelfth call site gets added, nobody remembers, and the margin number
is quietly wrong in the safe-looking direction (too low). `llm_models.py` already
requires every call to go through `anthropic_client()` — so the meter goes there
once, and a new call site is metered whether or not its author knows this module
exists.

## Attribution

The org comes from `db.current_org`, the per-request context variable the tenant
middleware sets, so nothing has to thread an org id through six modules of
sandbox internals. Work with no request behind it (the snapshot scheduler, a
CLI job) lands under the literal org `"system"` rather than being dropped —
spend we cannot attribute is still spend, and a large `cogs:system` bucket is
itself the signal that attribution is broken.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

logger = logging.getLogger("arceo.cogs")

#: Redis scope prefix. `shared_state._spend_key` namespaces it further.
SCOPE_PREFIX = "cogs"

#: Where spend with no request context is attributed. Deliberately a real
#: bucket rather than a discard — see the module docstring.
UNATTRIBUTED_ORG = "system"


def scope_for(org_id: Optional[str] = None, now: Optional[datetime] = None) -> str:
    """`cogs:{org}:{YYYY-MM}` — the counter key for one org's current month."""
    if not org_id:
        try:
            import db as _db

            org_id = _db.current_org.get() or UNATTRIBUTED_ORG
        except Exception:
            org_id = UNATTRIBUTED_ORG
    stamp = (now or datetime.utcnow()).strftime("%Y-%m")
    return f"{SCOPE_PREFIX}:{org_id}:{stamp}"


def price(model: str, usage: Any) -> float:
    """Dollar cost of one completed call on Arceo's key, or 0.0 if unpriceable.

    Deliberately reuses the SAME catalog and the SAME arithmetic the customer
    forecast uses (`analysis.spend_forecast`). If Arceo priced its own spend with
    a second, private table, the two would drift and the gross-margin number
    would stop being comparable to the figure we show the customer — which is
    the number this whole product is sold on.
    """
    from analysis.spend_forecast import (
        _call_cost_usd, _extract_usage, _resolve_model_key, load_defaults,
    )

    # `_extract_usage` wants the stored-response shape, and it already handles
    # Anthropic's convention that input_tokens EXCLUDES cached tokens — worth
    # reusing rather than re-deriving, because getting that backwards
    # understates cache-heavy calls silently.
    detail = {"response": {"usage": _usage_as_dict(usage)}}
    parsed = _extract_usage(detail)
    if parsed is None:
        return 0.0
    total_in, cache_read, cache_creation, out = parsed

    defaults = load_defaults()
    key = _resolve_model_key(model, defaults)
    # `at=None` on purpose: this prices money ARCEO IS SPENDING RIGHT NOW at the
    # standing rate. The dated-promo path exists for repricing history.
    return _call_cost_usd(total_in, cache_read, out, key, defaults,
                          cache_creation=cache_creation)


def _usage_as_dict(usage: Any) -> dict:
    """Anthropic's usage object (or a plain dict) as a dict. Never raises."""
    if usage is None:
        return {}
    if isinstance(usage, dict):
        return usage
    for attr in ("model_dump", "dict"):
        fn = getattr(usage, attr, None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                pass
    out = {}
    for k in ("input_tokens", "output_tokens", "cache_read_input_tokens",
              "cache_creation_input_tokens"):
        v = getattr(usage, k, None)
        if v is not None:
            out[k] = v
    return out


def record(model: str, usage: Any, *, org_id: Optional[str] = None,
           source: str = "") -> float:
    """Meter one completed Anthropic call against the org's monthly COGS.

    Returns the dollar amount recorded (0.0 when the response carried no usable
    usage). NEVER raises: this sits on the return path of every LLM call in the
    product, and failing to record a cost must not fail the work that incurred
    it. A metering bug that took down simulations would be a worse outcome than
    the missing number it was added to provide.
    """
    try:
        usd = price(model, usage)
        if usd <= 0:
            return 0.0
        import shared_state

        shared_state.spend_accrue(scope_for(org_id), usd)
        logger.debug("cogs %.6f USD model=%s source=%s", usd, model, source or "?")
        return usd
    except Exception as e:  # noqa: BLE001 — metering must never break the caller
        logger.warning("cogs: failed to record spend for %s (%s): %s", model, source, e)
        return 0.0


def total(org_id: Optional[str] = None, now: Optional[datetime] = None) -> Optional[float]:
    """This org's Arceo-side spend so far this month, or None if unavailable.

    ⚠️ Redis-only, and therefore NOT a system of record. The customer budget
    counter can be rebuilt from the audit log (`_mtd_spend_from_audit`) because
    every customer call is persisted as an LLM_CALL row; Arceo's own calls are
    not persisted anywhere, so a Redis flush loses the month. That is an accepted
    limit of this first cut — the number exists to answer "what is our margin on
    this account", not to bill anyone — but it must not be quoted as authoritative
    without a durable backing store behind it.
    """
    try:
        import shared_state

        return shared_state.spend_total(scope_for(org_id, now))
    except Exception:
        return None
