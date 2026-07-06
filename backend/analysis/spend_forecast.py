"""Operational spend forecaster.

Given an agent's capability tree + optional sandbox traces + optional user
overrides, produces a monthly cost forecast at one of three confidence tiers
(low / medium / high) based on data availability.

Formula and methodology: brain/Signals/Cost calculation methodology.md
Calibration sources: brain/Signals/Cost forecaster calibration data.md
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Optional

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore

# ── Config load ──────────────────────────────────────────────────────────────

_DEFAULTS_PATH = Path(__file__).parent / "cost_defaults_operational.yaml"
_DEFAULTS_CACHE: Optional[dict] = None


def load_defaults(org_id: Optional[str] = None) -> dict:
    """Load and cache the operational cost defaults YAML.

    With `org_id`, returns a deep copy with that org's `cost_overrides` rows
    merged on top (a customer's negotiated model rates, custom tool prices,
    infra overhead). The module cache only ever holds the pristine YAML — the
    per-org merge happens after the cache read and merged copies are never
    cached, so one org's overrides can't leak into another's forecasts.
    """
    global _DEFAULTS_CACHE
    if _DEFAULTS_CACHE is None:
        if yaml is None:
            # Minimal fallback if pyyaml is not installed.
            _DEFAULTS_CACHE = _MINIMAL_DEFAULTS
        else:
            with open(_DEFAULTS_PATH) as f:
                _DEFAULTS_CACHE = yaml.safe_load(f)
    if not org_id:
        return _DEFAULTS_CACHE
    rows = _fetch_org_overrides(org_id)
    org_default_model = _fetch_org_default_model(org_id)
    if not rows and not org_default_model:
        return _DEFAULTS_CACHE
    import copy
    merged = copy.deepcopy(_DEFAULTS_CACHE)
    for scope, key, sub_key, value in rows:
        if scope == "model":
            # Only patch models that exist — a partial model dict (an override
            # for a key with no base pricing) can't be priced.
            if key in merged.get("models", {}):
                merged["models"][key][sub_key] = value
        elif scope == "tool":
            merged.setdefault("tool_action_costs", {}).setdefault(key, {})[sub_key] = value
        elif scope == "infra":
            merged.setdefault("infrastructure", {})[key] = value
    # Per-org default model: only honor a recognized one (else keep the YAML
    # default rather than pricing at an unknown model).
    if org_default_model and _model_recognized(org_default_model, merged):
        merged["default_model"] = _resolve_model_key(org_default_model, merged)
    return merged


def _fetch_org_default_model(org_id: str) -> Optional[str]:
    """Read an org's configured default model from workspace_settings, or None."""
    try:
        from db import get_db
        with get_db() as conn:
            row = conn.execute(
                "SELECT default_model FROM workspace_settings WHERE org_id = ?",
                (org_id,),
            ).fetchone()
        return (row["default_model"] or None) if row else None
    except Exception:
        return None


def _fetch_org_overrides(org_id: str) -> list[tuple]:
    """Read an org's cost_overrides rows. Returns [] on any failure (missing
    table, no DB) so the forecaster degrades to pristine defaults."""
    try:
        from db import get_db
        with get_db() as conn:
            rows = conn.execute(
                "SELECT scope, key, sub_key, value FROM cost_overrides WHERE org_id = ?",
                (org_id,),
            ).fetchall()
        return [(r["scope"], r["key"], r["sub_key"], float(r["value"])) for r in rows]
    except Exception:
        return []


def clear_override_caches() -> None:
    """Bust derived caches after a cost_overrides write. The defaults cache
    itself holds only pristine YAML and never needs busting."""
    _SENSITIVITY_CACHE.clear()


def _first_set(*vals, default):
    """First value that is not None, else default. Unlike `a or b`, a legitimate
    0 (e.g. a paused agent at 0 calls/day) is honored rather than treated as
    unset and silently bumped to the default."""
    for v in vals:
        if v is not None:
            return v
    return default


# ── Unit economics — picked by tool mix ──────────────────────────────────────
# LABELS ONLY. There are deliberately NO hardcoded $ values here — the per-outcome
# dollar figure is computed per-agent from REAL sandbox-observed outcome counts in
# `_compute_unit_econ`, or shown as "not measured" (null). No canned $.

_UNIT_ECON_SETS = {
    "support": [
        {"label": "Per refund processed"},
        {"label": "Per ticket resolved"},
        {"label": "Per customer touched"},
        {"label": "Per email sent"},
    ],
    "sales": [
        {"label": "Per lead enriched"},
        {"label": "Per outbound email"},
        {"label": "Per meeting booked"},
        {"label": "Per opportunity created"},
    ],
    "devops": [
        {"label": "Per deploy"},
        {"label": "Per incident triaged"},
        {"label": "Per rollback"},
        {"label": "Per alert routed"},
    ],
    "ops": [
        {"label": "Per record exported"},
        {"label": "Per batch run"},
        {"label": "Per file delivered"},
        {"label": "Per quality check"},
    ],
}


def _pick_unit_econ_set(agent_config: dict) -> list[dict]:
    """Pick the unit-economics row LABELS that fit the agent's tool mix.
    Dollar values are computed per-agent (or left null) by `_compute_unit_econ`.
    """
    tool_names = {(t.get("name") or "").lower() for t in agent_config.get("tools", [])}
    if {"github", "pagerduty", "aws", "aws_ec2", "aws_ecs", "aws_rds", "aws_lambda"} & tool_names:
        return _UNIT_ECON_SETS["devops"]
    if {"hubspot", "salesforce", "calendly", "clearbit"} & tool_names:
        return _UNIT_ECON_SETS["sales"]
    if {"snowflake", "aws_s3", "bigquery"} & tool_names:
        return _UNIT_ECON_SETS["ops"]
    return _UNIT_ECON_SETS["support"]


# Map each unit-econ row label to the tool.action patterns that count as one
# such outcome. An agent only shows a row if it has at least one matching
# action; otherwise the row is dropped (per-agent honesty over uniform layout).
_UNIT_ECON_ACTIONS: dict[str, list[str]] = {
    # support
    "Per refund processed": ["stripe.create_refund"],
    "Per ticket resolved": ["zendesk.update_ticket", "zendesk.close_ticket"],
    "Per customer touched": ["zendesk.get_user", "zendesk.create_user", "hubspot.get_contact"],
    "Per email sent": ["sendgrid.send_email", "sendgrid.send_template_email", "gmail.send_message"],
    # sales
    "Per lead enriched": ["clearbit.enrich", "hubspot.update_contact"],
    "Per outbound email": ["sendgrid.send_email", "sendgrid.send_template_email", "gmail.send_message"],
    "Per meeting booked": ["calendly.create_event", "calendly.create_invitee"],
    "Per opportunity created": ["salesforce.create_opportunity", "hubspot.create_deal"],
    # devops
    "Per deploy": ["github.create_deployment", "aws_ecs.update_service", "aws_lambda.update_function_code"],
    "Per incident triaged": ["pagerduty.update_incident", "pagerduty.acknowledge_incident"],
    "Per rollback": ["github.revert_deployment", "aws_ecs.update_service"],
    "Per alert routed": ["pagerduty.create_incident"],
    # ops
    "Per record exported": ["aws_s3.put_object", "snowflake.unload"],
    "Per batch run": ["snowflake.execute_query", "bigquery.run_query"],
    "Per file delivered": ["aws_s3.put_object"],
    "Per quality check": ["snowflake.execute_query"],
}


def _agent_action_set(agent_config: dict) -> set[str]:
    """Flatten an agent's tools/actions into {tool.action} strings."""
    result: set[str] = set()
    for tool in agent_config.get("tools", []):
        tool_name = (tool.get("name") or "").lower()
        if not tool_name:
            continue
        for action_obj in tool.get("actions", []):
            if isinstance(action_obj, dict):
                action_name = action_obj.get("action") or action_obj.get("name") or ""
            else:
                action_name = str(action_obj)
            if action_name:
                result.add(f"{tool_name}.{action_name}")
    return result


def _count_action_occurrences(sandbox_traces: list, targets: set[str]) -> int:
    """Count steps across all traces whose tool.action is in targets."""
    total = 0
    for trace in sandbox_traces:
        for step in trace.get("steps", []) or []:
            tool = (step.get("tool") or "").lower()
            action = step.get("action") or ""
            if action and f"{tool}.{action}" in targets:
                total += 1
    return total


def _format_unit_value(usd: float) -> str:
    """Format a per-outcome USD value with precision sized by magnitude."""
    if usd >= 1.0:
        return f"${usd:,.2f}"
    if usd >= 0.01:
        return f"${usd:.2f}"
    if usd >= 0.001:
        return f"${usd:.3f}"
    return f"${usd:.4f}"


def _compute_unit_econ(
    agent_config: dict,
    sandbox_traces: Optional[list],
    monthly_point: float,
    runs_per_day: int,
) -> list[dict]:
    """Per-agent unit-economics rows — honest, never fabricated.

    Per-outcome $ is computed ONLY from real outcome counts observed in sandbox
    traces. There is NO canned archetype $ and NO uniform-mix guess: a row the
    agent CAN produce shows `value: None` ("not measured") until a sandbox sweep
    counts real outcomes. `runs_per_day` is per-RUN volume (sandbox occurrences
    are per run)."""
    archetype_rows = _pick_unit_econ_set(agent_config)
    agent_actions = _agent_action_set(agent_config)
    num_traces = len(sandbox_traces) if sandbox_traces else 0
    total_monthly_runs = max(int(runs_per_day or 0), 0) * 30

    rows: list[dict] = []
    for row in archetype_rows:
        label = row["label"]
        candidates = _UNIT_ECON_ACTIONS.get(label, [])
        matching = {a for a in candidates if a in agent_actions}
        if not matching:
            continue
        value = None  # honest default: not measured yet
        if num_traces > 0 and monthly_point > 0 and total_monthly_runs > 0:
            occurrences = _count_action_occurrences(sandbox_traces, matching)
            if occurrences > 0:
                monthly_outcomes = (occurrences / num_traces) * total_monthly_runs
                if monthly_outcomes > 0:
                    value = _format_unit_value(monthly_point / monthly_outcomes)
        rows.append({"label": label, "value": value})
    return rows


# ── Tier detection ───────────────────────────────────────────────────────────

# Below this many captured LLM calls in the trailing window, observed rolling
# averages are too noisy to trust — fall back to the static/sandbox estimate,
# and don't claim the high-confidence band.
LIVE_TRACE_MIN_CALLS = 50

# But early live traffic IS a real volume signal (D27): a zero-code customer's
# first captured calls must unlock a forecast at the wide low/medium band, not
# a "no data" screen that contradicts the data-sources panel. From this floor
# up, live traces count toward availability and feed the rolling averages;
# below it a monthly extrapolation would ride on a handful of calls, so we
# show capture progress instead of a number. HIGH confidence still requires
# LIVE_TRACE_MIN_CALLS.
LIVE_TRACE_MIN_CALLS_FORECAST = 5

# Bumped whenever the cost FORMULA changes scale (not just calibration values),
# so vs-last-month doesn't show a bogus jump comparing across formula versions.
# v2 (2026-06-19): runs × turns model — forecasts ~4× higher than v1.
FORECAST_FORMULA_VERSION = 2


def _detect_tier(sandbox_traces: Optional[list], live_trace_count_7d: int = 0) -> str:
    """Determine confidence tier from input availability.

    High tier (the tight ±15% band) requires enough live calls that the rolling
    averages are actually applied — claiming high confidence on a handful of
    calls while still using default inputs would be dishonest. Below that, a
    few live calls don't beat sandbox traces, so fall through to medium/low.
    """
    if live_trace_count_7d >= LIVE_TRACE_MIN_CALLS:
        return "high"
    if sandbox_traces and len(sandbox_traces) > 0:
        return "medium"
    return "low"


# ── Live trace ingestion (real production traffic → forecast overrides) ───────

def _common_prefix_len(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


# Bedrock-style dotted owner prefixes (us.anthropic.claude-..., anthropic.claude-...)
_VENDOR_DOT_PREFIXES = (
    "us.", "eu.", "apac.",
    "anthropic.", "amazon.", "meta.", "mistral.", "cohere.", "ai21.",
)
# Path-style provider namespaces (meta-llama/Llama-..., models/gemini-..., etc.)
_VENDOR_PATH_PREFIXES = (
    "accounts/fireworks/models/", "bedrock/", "vertex_ai/", "vertex/",
    "openai/", "google/", "models/", "meta-llama/", "mistralai/",
    "together_ai/", "togethercomputer/", "groq/", "deepseek-ai/",
    "cohere/", "fireworks/", "xai/", "anthropic/",
)


def _normalize_model_id(model_str: str) -> str:
    """Strip provider namespaces and normalize separators on a raw model id so
    real-world ids resolve against the catalog.

    Examples:
      us.anthropic.claude-3-5-sonnet-20241022  -> claude-3-5-sonnet-20241022
      meta-llama/Llama-3.1-70B-Instruct        -> llama-3-1-70b-instruct
      models/gemini-1.5-pro                     -> gemini-1-5-pro
    """
    ms = model_str.lower().strip()
    changed = True
    while changed:  # peel stacked dotted prefixes (us.anthropic.)
        changed = False
        for p in _VENDOR_DOT_PREFIXES:
            if ms.startswith(p):
                ms = ms[len(p):]
                changed = True
    for p in sorted(_VENDOR_PATH_PREFIXES, key=len, reverse=True):
        if ms.startswith(p):
            ms = ms[len(p):]
            break
    if "/" in ms:
        ms = ms.rsplit("/", 1)[-1]
    # Version separators vary by vendor: "3.1" / "3_1" → "3-1".
    return ms.replace(".", "-").replace("_", "-")


def _resolve_model_key(model_str: Optional[str], defaults: dict) -> str:
    """Map a raw provider model id (e.g. 'claude-sonnet-4-5-20250929',
    'gpt-4o-2024-08-06', 'meta-llama/Llama-3.1-70B') to the closest catalog key.

    Tries exact, then normalized-exact, then a catalog key that prefixes the
    normalized id (longest wins), then longest-common-prefix. Falls back to the
    default model only when nothing meaningful overlaps.
    """
    models = defaults.get("models", {})
    default = defaults.get("default_model")
    if not model_str:
        return default
    raw = model_str.lower()
    if raw in models:
        return raw
    ms = _normalize_model_id(model_str)
    if ms in models:
        return ms
    # Prefer a key that is an actual prefix of the id (longest such key wins so
    # "gpt-4o-mini" beats "gpt-4o", "llama-3-1-70b" beats nothing shorter).
    prefix_match = max((k for k in models if ms.startswith(k)), key=len, default=None)
    if prefix_match:
        return prefix_match
    # Version drift / partial id — fall back to longest common character prefix.
    best_key, best_len = None, 0
    for key in models:
        overlap = _common_prefix_len(key, ms)
        if overlap > best_len:
            best_key, best_len = key, overlap
    # Require a family-level overlap to avoid matching unrelated providers.
    return best_key if best_len >= 4 else default


def _model_recognized(model_str: Optional[str], defaults: dict) -> bool:
    """True if `model_str` maps to a priced model by exact, normalized, prefix,
    or family (>=4 shared leading chars) match — i.e. NOT a blind fallback to the
    default. A version near-match (claude-sonnet-4-5 -> -4-6) and a namespaced id
    (meta-llama/Llama-3.1-70B) count as recognized; a genuinely unknown model
    does not.
    """
    if not model_str:
        return False
    models = defaults.get("models", {})
    if model_str.lower() in models:
        return True
    ms = _normalize_model_id(model_str)
    if ms in models:
        return True
    if any(ms.startswith(k) or k.startswith(ms) for k in models):
        return True
    return max((_common_prefix_len(k, ms) for k in models), default=0) >= 4


def _extract_usage(detail: dict) -> Optional[tuple[int, int, int]]:
    """Pull (total_input_tokens, cached_input_tokens, output_tokens) from a
    captured LLM call's stored provider response.

    Handles the major provider shapes:
      - Anthropic: usage.{input_tokens, output_tokens, cache_read_input_tokens,
        cache_creation_input_tokens}. Anthropic's input_tokens EXCLUDES cached
        tokens, so total input = input + cache_read + cache_creation.
      - OpenAI (+ OpenAI-compatible: DeepSeek, xAI, Together, Groq, Mistral):
        usage.{prompt_tokens, completion_tokens,
        prompt_tokens_details.cached_tokens}. prompt_tokens INCLUDES cached.
      - Gemini: usageMetadata.{promptTokenCount, candidatesTokenCount,
        cachedContentTokenCount}. promptTokenCount INCLUDES cached.

    Returns None when the response has no usable usage block.
    """
    response = detail.get("response")
    if not isinstance(response, dict):
        return None
    usage = response.get("usage")
    if not isinstance(usage, dict):
        # Gemini's native shape puts counts under usageMetadata.
        usage = response.get("usageMetadata")
    if not isinstance(usage, dict):
        return None

    if "input_tokens" in usage:  # Anthropic
        base_in = int(usage.get("input_tokens") or 0)
        cache_read = int(usage.get("cache_read_input_tokens") or 0)
        cache_creation = int(usage.get("cache_creation_input_tokens") or 0)
        total_in = base_in + cache_read + cache_creation
        out = int(usage.get("output_tokens") or 0)
        cached = cache_read
    elif "prompt_tokens" in usage:  # OpenAI + OpenAI-compatible
        total_in = int(usage.get("prompt_tokens") or 0)
        out = int(usage.get("completion_tokens") or 0)
        details = usage.get("prompt_tokens_details") or {}
        cached = int(details.get("cached_tokens") or 0) if isinstance(details, dict) else 0
    elif "promptTokenCount" in usage:  # Gemini
        total_in = int(usage.get("promptTokenCount") or 0)
        out = int(usage.get("candidatesTokenCount") or 0)
        cached = int(usage.get("cachedContentTokenCount") or 0)
    else:
        return None

    if total_in <= 0 and out <= 0:
        return None
    return total_in, min(cached, total_in), out


def _parse_iso(ts: Any):
    if not ts:
        return None
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00").split("+")[0])
    except (ValueError, TypeError):
        return None


def _row_get(row: Any, key: str) -> Any:
    """Read a column from a sqlite3.Row or a plain dict."""
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        if isinstance(row, dict):
            return row.get(key)
        return None


def compute_live_rolling_averages(audit_rows: list) -> dict:
    """Per-agent rolling averages from captured LLM calls.

    `audit_rows` are LLM_CALL audit entries (sqlite3.Row or dict) exposing
    `detail` (JSON string) and `timestamp` (ISO). Returns override keys ready to
    merge into `forecast_spend`: {llm_calls_per_day, cache_hit, input_tokens,
    output_tokens, llm_cost_per_call}. `llm_cost_per_call` is the mean of each
    call's REAL $ (its own model + tokens + cache) — so the high tier prices the
    actual model mix, not a single reconstructed model. Returns {} when no rows
    carry usable token usage.
    """
    defaults = load_defaults()
    usages: list[tuple[int, int, int]] = []
    per_call_costs: list[float] = []
    times = []
    for row in audit_rows:
        raw = _row_get(row, "detail")
        if not raw:
            continue
        try:
            detail = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        u = _extract_usage(detail)
        if u is None:
            continue
        usages.append(u)
        # Real per-call $ using THIS call's own model (blends a mixed-model fleet).
        _tin, _cached, _out = u
        _mk = _resolve_model_key(detail.get("model"), defaults)
        per_call_costs.append(_call_cost_usd(_tin, _cached, _out, _mk, defaults))
        t = _parse_iso(_row_get(row, "timestamp"))
        if t is not None:
            times.append(t)

    if not usages:
        return {}

    n = len(usages)
    total_in = sum(x[0] for x in usages)
    total_cached = sum(x[1] for x in usages)
    total_out = sum(x[2] for x in usages)

    # Observed call rate over the actual span the data covers, clamped to the
    # 7-day window we queried (avoids understating a 2-day-old agent and
    # overstating a single burst).
    if len(times) >= 2:
        span_days = (max(times) - min(times)).total_seconds() / 86400.0
        span_days = min(7.0, max(1.0, span_days))
    else:
        span_days = 1.0

    return {
        # Audit rows are individual LLM calls → this is total LLM calls/day
        # (= runs × turns). forecast_spend uses it directly at the live tier and
        # does NOT re-multiply by turns_per_run.
        "llm_calls_per_day": max(1, round(n / span_days)),
        "cache_hit": round(total_cached / total_in * 100) if total_in > 0 else 0,
        "input_tokens": round(total_in / n),
        "output_tokens": round(total_out / n),
        "llm_cost_per_call": round(sum(per_call_costs) / n, 6) if per_call_costs else None,
        # Honesty metadata, not a forecast input: how many days of traffic the
        # averages above actually cover. A 20-minute burst clamps to 1 day —
        # the UI captions the high-tier number with this so ±15% never rides
        # on an unrepresentative window.
        "observed_days": round(span_days, 1),
    }


def compute_sandbox_averages(traces: list) -> dict:
    """Per-run turn count + per-turn token averages from sandbox traces that
    captured real usage (`turn_usage`). Mirrors `compute_live_rolling_averages`
    but for the medium tier. Returns {turns_per_run, input_tokens, output_tokens},
    or {} when no trace carries usable turn usage.

    Divisor note: turns_per_run is averaged over RUNS (one trace = one run);
    tokens are averaged over TURNS (the per-LLM-call basis the cost math uses).

    Deliberately NO cache_hit: simulations run each scenario cold, so their
    measured cache rate is structurally 0% — treating that as a measurement of
    production cache locality doubled a cache-heavy agent's forecast while
    CLAIMING higher confidence. Cache stays declared/default until live traces
    (which do see real locality) measure it.
    """
    per_run_turns: list[int] = []
    in_sum = out_sum = turn_n = 0
    for t in traces or []:
        tu = (t.get("turn_usage") if isinstance(t, dict) else None) or []
        usable = [x for x in tu if isinstance(x, dict)
                  and (int(x.get("input_tokens") or 0) + int(x.get("output_tokens") or 0)) > 0]
        if not usable:
            continue
        per_run_turns.append(len(usable))
        for x in usable:
            in_sum += int(x.get("input_tokens") or 0)
            out_sum += int(x.get("output_tokens") or 0)
            turn_n += 1
    if not per_run_turns or turn_n == 0:
        return {}
    return {
        "turns_per_run": max(1, round(sum(per_run_turns) / len(per_run_turns))),
        "input_tokens": round(in_sum / turn_n),
        "output_tokens": round(out_sum / turn_n),
    }


def compute_spend_timeseries(
    audit_rows: list,
    *,
    days: int = 30,
    defaults: Optional[dict] = None,
) -> list[dict]:
    """Observed daily LLM spend from captured calls, one row per calendar day.

    Returns `days` rows ending today (UTC), each {date, usd, calls}. Days with
    no traffic are included with zeros so the chart x-axis stays continuous.
    Cost is the measured LLM token cost only (tools/infra aren't in LLM_CALL
    capture); the caller labels it as such.
    """
    from datetime import datetime, timedelta

    defaults = defaults or load_defaults()
    buckets: dict[str, list[float]] = {}  # date -> [usd, calls]

    for row in audit_rows:
        raw = _row_get(row, "detail")
        ts = _row_get(row, "timestamp")
        if not raw or not ts:
            continue
        try:
            detail = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        u = _extract_usage(detail)
        if u is None:
            continue
        total_in, cached, out = u
        model_key = _resolve_model_key(detail.get("model"), defaults)
        usd = _call_cost_usd(total_in, cached, out, model_key, defaults)
        date = str(ts)[:10]
        b = buckets.setdefault(date, [0.0, 0.0])
        b[0] += usd
        b[1] += 1

    today = datetime.utcnow().date()
    series: list[dict] = []
    for i in range(days - 1, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        usd, calls = buckets.get(d, [0.0, 0.0])
        series.append({"date": d, "usd": round(usd, 2), "calls": int(calls)})
    return series


def compute_month_to_date_spend(
    audit_rows: list, *, now=None, defaults: Optional[dict] = None
) -> float:
    """Observed LLM spend so far this calendar month, from captured calls.

    Real money spent (not forecast), summed from `response.usage` × model
    pricing — the basis for the budget cap alert. Caller passes rows already
    filtered to the agent; this filters to the current month and sums.
    """
    from datetime import datetime as _dt

    defaults = defaults or load_defaults()
    now = now or _dt.utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    total = 0.0
    for row in audit_rows:
        raw = _row_get(row, "detail")
        ts = _parse_iso(_row_get(row, "timestamp"))
        if not raw or ts is None or ts < month_start:
            continue
        try:
            detail = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        u = _extract_usage(detail)
        if u is None:
            continue
        total_in, cached, out = u
        model_key = _resolve_model_key(detail.get("model"), defaults)
        total += _call_cost_usd(total_in, cached, out, model_key, defaults)
    return round(total, 2)


def _call_cost_usd(
    total_input: int, cached_input: int, output: int, model_key: str, defaults: dict
) -> float:
    """Dollar cost of a single captured call, applying the model's cache
    discount to the cached portion of input."""
    models = defaults.get("models", {})
    mp = models.get(model_key) or models.get(defaults.get("default_model")) or {}
    in_price = float(mp.get("input_per_mtok", 0.0)) / 1_000_000.0
    out_price = float(mp.get("output_per_mtok", 0.0)) / 1_000_000.0
    cache_discount = float(mp.get("cache_discount", 0.5))
    non_cached = max(0, total_input - cached_input)
    return (
        non_cached * in_price
        + cached_input * in_price * (1.0 - cache_discount)
        + output * out_price
    )


# ── Spend anomaly detection (last 24h vs trailing baseline) ──────────────────

# Fire when the last 24h cost this many times the trailing daily average.
SPEND_ANOMALY_RATIO = 3.0
# Baseline gates: a brand-new agent (or one doing pennies of traffic) has no
# meaningful "usual rate" — never flag those, just report insufficient baseline.
SPEND_ANOMALY_MIN_BASELINE_CALLS = 10
SPEND_ANOMALY_MIN_BASELINE_DAILY_USD = 0.05


def detect_spend_anomaly(
    audit_rows: list,
    *,
    now=None,
    defaults: Optional[dict] = None,
) -> dict:
    """Compare the last 24h of observed LLM spend against the trailing 7-day
    daily average (excluding the last 24h) and flag a >=SPEND_ANOMALY_RATIO
    jump.

    `audit_rows` are LLM_CALL audit entries (sqlite3.Row or dict) covering the
    last 8 days for one agent. Returns:

      {"flagged": bool, "ratio": float, "last24hUsd": float,
       "baselineDailyUsd": float, "last24hCalls": int,
       "baselineDailyCalls": float, "drivers": [str, ...],
       "baselineSufficient": bool}

    Drivers are plain-English fragments ("call volume is 4x its usual rate")
    so the Slack alert and the CFO-facing banner can use them verbatim.
    """
    from datetime import datetime, timedelta

    defaults = defaults or load_defaults()
    now = now or datetime.utcnow()
    cutoff_recent = now - timedelta(days=1)
    cutoff_baseline = now - timedelta(days=8)

    # (usd, total_tokens, model_key) per call, split into the two windows.
    recent: list[tuple[float, int, str]] = []
    baseline: list[tuple[float, int, str]] = []
    for row in audit_rows:
        raw = _row_get(row, "detail")
        ts = _parse_iso(_row_get(row, "timestamp"))
        if not raw or ts is None or ts < cutoff_baseline:
            continue
        try:
            detail = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        u = _extract_usage(detail)
        if u is None:
            continue
        total_in, cached, out = u
        model_key = _resolve_model_key(detail.get("model"), defaults)
        usd = _call_cost_usd(total_in, cached, out, model_key, defaults)
        call = (usd, total_in + out, model_key)
        (recent if ts >= cutoff_recent else baseline).append(call)

    baseline_usd = sum(c[0] for c in baseline)
    baseline_daily_usd = baseline_usd / 7.0
    baseline_daily_calls = len(baseline) / 7.0
    recent_usd = sum(c[0] for c in recent)

    result = {
        "flagged": False,
        "ratio": 0.0,
        "last24hUsd": round(recent_usd, 2),
        "baselineDailyUsd": round(baseline_daily_usd, 2),
        "last24hCalls": len(recent),
        "baselineDailyCalls": round(baseline_daily_calls, 1),
        "drivers": [],
        "baselineSufficient": (
            len(baseline) >= SPEND_ANOMALY_MIN_BASELINE_CALLS
            and baseline_daily_usd >= SPEND_ANOMALY_MIN_BASELINE_DAILY_USD
        ),
    }
    if not result["baselineSufficient"]:
        return result

    ratio = recent_usd / baseline_daily_usd
    result["ratio"] = round(ratio, 1)
    if ratio < SPEND_ANOMALY_RATIO:
        return result
    result["flagged"] = True

    # ── Drivers: what changed vs the baseline window ──────────────────────────
    drivers: list[str] = []

    # 1. Call volume
    if baseline_daily_calls > 0:
        call_ratio = len(recent) / baseline_daily_calls
        if call_ratio >= 2.0:
            drivers.append(
                f"call volume is {call_ratio:.1f}x its usual daily rate "
                f"({len(recent)} calls vs ~{baseline_daily_calls:.0f}/day)"
            )

    # 2. Call size (tokens per call)
    if recent and baseline:
        recent_tok = sum(c[1] for c in recent) / len(recent)
        base_tok = sum(c[1] for c in baseline) / len(baseline)
        if base_tok > 0 and recent_tok / base_tok >= 1.5:
            drivers.append(
                f"individual calls are {recent_tok / base_tok:.1f}x larger "
                f"than usual ({recent_tok:.0f} vs {base_tok:.0f} tokens per call)"
            )

    # 3. Model mix — a model that wasn't in the baseline now driving spend
    base_models = {c[2] for c in baseline}
    new_model_usd: dict[str, float] = {}
    for usd, _tok, mk in recent:
        if mk not in base_models:
            new_model_usd[mk] = new_model_usd.get(mk, 0.0) + usd
    if new_model_usd and recent_usd > 0:
        top_model = max(new_model_usd, key=new_model_usd.get)
        share = new_model_usd[top_model] / recent_usd * 100
        if share >= 25:
            drivers.append(
                f"a model not seen before ({top_model}) accounts for "
                f"{share:.0f}% of the last 24h spend"
            )

    if not drivers:
        # Spend jumped without volume/size/model shifts standing out — say so
        # rather than leaving the alert unexplained.
        drivers.append("no single driver stands out; spend rose across the board")
    result["drivers"] = drivers
    return result


# ── Token estimate (static, from capability tree alone) ──────────────────────

def _estimate_tokens_per_call(agent_config: dict, defaults: dict, model_inflation: float, turns_per_run: float = 1.0) -> tuple[int, int]:
    """Estimate input + output tokens per call from capability tree alone.

    Used at the low confidence tier. Sandbox/live traces would override this.

    A declared `avg_context_tokens` (a RAG agent's retrieved context, or a long
    system prompt the extractor recovered) replaces the flat system-prompt
    assumption — without it, a 1-tool agent carrying an 80k-token context is
    priced identically to a 1-tool agent with a one-line prompt.

    `turns_per_run` adds an averaged history-growth term: later turns in an
    agentic loop carry the accumulated conversation, so the AVERAGE turn's input
    is larger than the first turn's. (Per-turn basis — the volume layer scales
    by total turns separately.)
    """
    td = defaults["turn_defaults"]
    num_tools = len(agent_config.get("tools", []))

    declared_ctx = agent_config.get("avg_context_tokens")
    try:
        declared_ctx = int(declared_ctx) if declared_ctx else 0
    except (TypeError, ValueError):
        declared_ctx = 0
    base_context = declared_ctx if declared_ctx > 0 else td["system_prompt_tokens"]

    # Average accumulated history across the run (linear growth → mean is half
    # the final). 0 for a single-turn agent.
    history_growth = float(td.get("history_growth_per_turn", 0))
    avg_history = history_growth * max(0.0, float(turns_per_run) - 1.0) / 2.0

    in_tokens = (
        base_context
        + num_tools * td["tool_overhead_per_tool"]
        + td["user_message_tokens"]
        + td["tool_result_tokens"]  # assume at least one tool result returned per call
        + avg_history
    )
    out_tokens = td["completion_tokens"]
    return int(in_tokens * model_inflation), int(out_tokens * model_inflation)


# ── Tool pricing resolution (aliases + known-free) ──────────────────────────

# Real tool names → the pricing key that represents their per-call API cost.
# Without this, `gmail`, `aws`, etc. miss the `tool_action_costs` table entirely
# and price at $0 while also counting as "uncovered" in the confidence panel.
TOOL_PRICING_ALIASES: dict[str, str] = {
    # Email providers bill per message like SendGrid.
    "gmail": "sendgrid", "email": "sendgrid", "ses": "sendgrid",
    "mailgun": "sendgrid", "mail": "sendgrid", "smtp": "sendgrid",
    "postmark": "sendgrid", "sendgrid_mail": "sendgrid",
    # SMS / voice.
    "sms": "twilio", "messagebird": "twilio", "vonage": "twilio",
    # AWS — generic handle and per-service aliases.
    "aws": "aws_lambda", "lambda": "aws_lambda", "aws_lambda": "aws_lambda",
    "s3": "aws_s3", "aws_s3": "aws_s3",
    "rds": "aws_rds", "aws_rds": "aws_rds",
    # Vector stores / embeddings.
    "vector_db": "pinecone", "pinecone": "pinecone",
    "embeddings": "openai_embeddings",
}

# Tools whose APIs are effectively free at agent volumes. Priced at $0 (correct)
# but counted as COVERED — a known zero, not an unknown gap.
KNOWN_FREE_TOOLS: frozenset[str] = frozenset({
    "slack", "github", "zendesk", "salesforce", "pagerduty", "hubspot",
    "calendly", "jira", "datadog", "okta", "google_sheets", "google_workspace",
    "notion", "linear", "discord", "teams", "asana", "trello", "intercom",
    "freshdesk", "servicenow", "confluence",
})

_TOOL_READ_PREFIXES = (
    "get_", "list_", "read_", "search_", "query_", "check_",
    "describe_", "fetch_", "lookup_", "find_", "show_",
)


def _resolve_pricing_key(tool_name: str) -> str:
    """Map a real tool name to its pricing-table key (alias applied)."""
    t = (tool_name or "").lower()
    return TOOL_PRICING_ALIASES.get(t, t)


def _tool_is_priced(tac: dict, tool_name: str) -> bool:
    """True if we have a defensible per-call cost for this tool — either a
    pricing-table entry (directly or via alias) or a known-free API ($0)."""
    t = (tool_name or "").lower()
    if t in KNOWN_FREE_TOOLS:
        return True
    return _resolve_pricing_key(t) in tac


def _tool_action_price(tac: dict, tool_name: str, action_name: str) -> float:
    """Per-call USD cost for one tool.action, resolving aliases.

    Exact action match wins. For an *aliased* tool whose action is named
    differently from the canonical provider (e.g. gmail.send_message →
    sendgrid), a billable (non-read) action falls back to the cheapest known
    price of that provider as a floor. Direct-match tools keep exact-or-zero
    so already-correct pricing is unchanged.
    """
    raw = (tool_name or "").lower()
    if raw in KNOWN_FREE_TOOLS:
        return 0.0
    key = _resolve_pricing_key(raw)
    pricing = tac.get(key)
    if not pricing:
        return 0.0
    if action_name in pricing:
        return float(pricing[action_name])
    if key != raw and not action_name.lower().startswith(_TOOL_READ_PREFIXES):
        nonzero = [float(v) for v in pricing.values() if float(v) > 0]
        if nonzero:
            return min(nonzero)
    return 0.0


# ── Tool cost per call (uniform action distribution baseline) ───────────────

def _estimate_tool_cost_per_call(
    agent_config: dict, defaults: dict, sandbox_traces: Optional[list] = None
) -> tuple[float, list[dict], bool]:
    """Expected per-call tool cost + per-action (tool, action, cost, weight) rows.

    `weight` is each action's per-call probability. With sandbox traces present
    it's the REAL observed frequency (count/total observed steps); otherwise it's
    a uniform 1/N guess. Returns (cost_per_call, rows, mix_measured)."""
    tac = defaults["tool_action_costs"]
    base: list[tuple[str, str, float]] = []
    for tool in agent_config.get("tools", []):
        tool_name = (tool.get("name") or "").lower()
        for action_obj in tool.get("actions", []):
            if isinstance(action_obj, dict):
                action_name = action_obj.get("action") or action_obj.get("name") or ""
            else:
                action_name = str(action_obj)
            if not action_name:
                continue
            base.append((tool_name, action_name, _tool_action_price(tac, tool_name, action_name)))

    if not base:
        return 0.0, [], False

    # Observed weighting when traces exist: weight each action by its real share.
    weights: dict[str, float] = {}
    mix_measured = False
    if sandbox_traces:
        counts = {f"{tn}.{an}": _count_action_occurrences(sandbox_traces, {f"{tn}.{an}"}) for tn, an, _ in base}
        total_obs = sum(counts.values())
        if total_obs > 0:
            mix_measured = True
            weights = {k: c / total_obs for k, c in counts.items()}
    if not mix_measured:
        # Uniform fallback: each action equally likely per call.
        n = len(base)
        weights = {f"{tn}.{an}": 1.0 / n for tn, an, _ in base}

    rows = [(tn, an, cost, weights.get(f"{tn}.{an}", 0.0)) for tn, an, cost in base]
    total_per_call = sum(cost * w for _, _, cost, w in rows)
    return total_per_call, rows, mix_measured


# ── Per-agent sensitivity (±20% perturbation) ────────────────────────────────

_SENSITIVITY_CACHE: dict[tuple[str, str, str], list[dict]] = {}


# ── Data sources panel ───────────────────────────────────────────────────────

def compute_data_sources(
    *,
    sandbox_sim_count: int,
    live_call_count_7d: int,
    agent_config: dict,
    defaults: Optional[dict] = None,
    oldest_snapshot_days: Optional[int] = None,
    snapshot_count: int = 0,
) -> list[dict]:
    """Build the Confidence sources panel rows from real counts.

    Each row is {label, status, statusTone}; statusTone is one of
    "calibrated" / "active" / "partial" / "disconnected" so the frontend
    can apply the existing tone color map.
    """
    defaults = defaults or load_defaults()
    tac = defaults.get("tool_action_costs", {}) or {}

    # Sandbox
    if sandbox_sim_count >= 10:
        sb_status, sb_tone = f"{sandbox_sim_count} RUNS", "calibrated"
    elif sandbox_sim_count > 0:
        sb_status, sb_tone = f"{sandbox_sim_count} RUN" + ("S" if sandbox_sim_count > 1 else ""), "partial"
    else:
        sb_status, sb_tone = "NO RUNS YET", "disconnected"

    # Live LLM call capture
    if live_call_count_7d > 0:
        live_status, live_tone = f"{live_call_count_7d} CALLS", "active"
    else:
        live_status, live_tone = "NOT CONNECTED", "disconnected"

    # Tool API pricing — fraction of agent's tools with a known per-call cost
    # (priced table entry, alias, or a known-free $0 API).
    tool_names = [(t.get("name") or "").lower() for t in agent_config.get("tools", []) if t.get("name")]
    total_tools = len(tool_names)
    covered_tools = sum(1 for n in tool_names if _tool_is_priced(tac, n))
    if total_tools == 0:
        pricing_status, pricing_tone = "NO TOOLS", "disconnected"
    elif covered_tools == total_tools:
        pricing_status, pricing_tone = f"{covered_tools} OF {total_tools} TOOLS", "calibrated"
    elif covered_tools > 0:
        pricing_status, pricing_tone = f"{covered_tools} OF {total_tools} TOOLS", "partial"
    else:
        pricing_status, pricing_tone = f"0 OF {total_tools} TOOLS", "disconnected"

    # Historical baseline
    if snapshot_count == 0:
        hist_status, hist_tone = "NOT CONNECTED", "disconnected"
    elif oldest_snapshot_days is not None and oldest_snapshot_days >= 30:
        hist_status, hist_tone = f"{oldest_snapshot_days}D HISTORY", "active"
    else:
        days = oldest_snapshot_days if oldest_snapshot_days is not None else 0
        hist_status, hist_tone = f"NEEDS 30D · {days}D SO FAR", "partial"

    return [
        {"label": "Sandbox simulation traces",  "status": sb_status,      "statusTone": sb_tone},
        {"label": "Live LLM call capture · last 7 days", "status": live_status, "statusTone": live_tone},
        {"label": "Tool API pricing",           "status": pricing_status, "statusTone": pricing_tone},
        {"label": "Historical baseline",        "status": hist_status,    "statusTone": hist_tone},
    ]


def _stable_hash(payload: Any) -> str:
    return hashlib.sha1(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]


def _color_for_rank(rank: int, total: int) -> str:
    if rank == 0:
        return "linear-gradient(90deg, #fecaca, #ef4444)"
    if rank <= max(1, total // 2):
        return "linear-gradient(90deg, #fde68a, #f59e0b)"
    return "linear-gradient(90deg, #d1d5db, #9ca3af)"


def _compute_per_agent_sensitivity(
    agent_config: dict,
    sandbox_traces: Optional[list],
    live_trace_count_7d: int,
    overrides: dict,
    baseline_point: float,
    defaults: dict,
    org_id: Optional[str] = None,
) -> list[dict]:
    """Per-agent sensitivity ranking via ±20% perturbation.

    Re-runs the forecast 5x (one per input) at +20% and -20% of baseline,
    averages the |Δpoint|/baseline ratio, ranks by impact. Model choice is
    measured as the spread across all available models.
    """
    if baseline_point <= 0:
        return []  # can't perturb a zero baseline — return nothing, never canned %

    sd = defaults["scenario_defaults"]
    # Perturb the SAME volume key the baseline forecast is driven by. At the
    # high (live) tier, volume is observed `llm_calls_per_day`; perturbing
    # `runs_per_day` there flips the forecast onto a runs×turns basis (a totally
    # different volume), which produced absurd swings (e.g. 2000%). On the live
    # basis we perturb `llm_calls_per_day`; otherwise `runs_per_day`.
    _live_calls = overrides.get("llm_calls_per_day")
    _on_live_basis = (
        _live_calls is not None
        and overrides.get("runs_per_day") is None
        and overrides.get("calls_per_day") is None
        and overrides.get("turns_per_run") is None
    )
    if _on_live_basis:
        base_calls = float(_live_calls)
        _volume_key = "llm_calls_per_day"
    else:
        base_calls = float(_first_set(
            overrides.get("runs_per_day"),
            overrides.get("calls_per_day"),
            agent_config.get("expected_calls_per_day"),
            default=sd["default_calls_per_day"],
        ))
        _volume_key = "runs_per_day"
    base_runtime = float(overrides.get("runtime") or sd["default_runtime_seconds"])
    base_cache = float(overrides.get("cache_hit", sd["default_cache_hit_rate"] * 100))
    base_retry = float(overrides.get("retry_rate", sd["default_retry_rate"] * 100))
    # Mirror forecast_spend's model resolution so the model-choice spread is
    # measured against the agent's actual baseline model, not always the default.
    _declared = (agent_config.get("simulation_model") or "").strip()
    base_model = overrides.get("model")
    if not base_model and _declared and _model_recognized(_declared, defaults):
        base_model = _resolve_model_key(_declared, defaults)
    if not base_model:
        base_model = defaults["default_model"]

    def _point_with(**override_updates) -> float:
        merged = {**overrides, **override_updates}
        result = forecast_spend(
            agent_config,
            sandbox_traces=sandbox_traces,
            live_trace_count_7d=live_trace_count_7d,
            overrides=merged,
            org_id=org_id,
            _skip_sensitivity=True,
        )
        return float(result.get("pointExact", result.get("point", 0)))

    def _avg_pct_change(plus_overrides: dict, minus_overrides: dict) -> int:
        plus_point = _point_with(**plus_overrides)
        minus_point = _point_with(**minus_overrides)
        delta = (abs(plus_point - baseline_point) + abs(minus_point - baseline_point)) / 2
        return int(round(delta / baseline_point * 100))

    sensitivities: list[tuple[str, int]] = []

    sensitivities.append(("Calls per day", _avg_pct_change(
        {_volume_key: max(1, int(round(base_calls * 1.2)))},
        {_volume_key: max(1, int(round(base_calls * 0.8)))},
    )))

    # Model choice — spread across all available models (categorical, no ±20%)
    model_points = [baseline_point]
    for m_name in defaults.get("models", {}).keys():
        if m_name == base_model:
            continue
        try:
            model_points.append(_point_with(model=m_name))
        except Exception:
            continue
    if len(model_points) > 1:
        model_pct = int(round((max(model_points) - min(model_points)) / baseline_point * 100))
    else:
        model_pct = 0
    sensitivities.append(("Model choice", model_pct))

    sensitivities.append(("Cache hit rate", _avg_pct_change(
        {"cache_hit": min(100.0, base_cache * 1.2)},
        {"cache_hit": max(0.0, base_cache * 0.8)},
    )))

    sensitivities.append(("Runtime / call", _avg_pct_change(
        {"runtime": base_runtime * 1.2},
        {"runtime": base_runtime * 0.8},
    )))

    sensitivities.append(("Retry rate", _avg_pct_change(
        {"retry_rate": min(100.0, base_retry * 1.2)},
        {"retry_rate": max(0.0, base_retry * 0.8)},
    )))

    sensitivities.sort(key=lambda t: t[1], reverse=True)

    return [
        {"label": label, "pct": pct, "color": _color_for_rank(i, len(sensitivities))}
        for i, (label, pct) in enumerate(sensitivities)
    ]


def _cached_sensitivity(
    agent_config: dict,
    sandbox_traces: Optional[list],
    live_trace_count_7d: int,
    overrides: dict,
    baseline_point: float,
    defaults: dict,
    org_id: Optional[str] = None,
) -> list[dict]:
    agent_id = str(agent_config.get("id") or agent_config.get("name") or "unknown")
    key = (
        agent_id,
        _stable_hash(agent_config),
        # org_id is in the key because per-org cost overrides shift the
        # perturbation results; clear_override_caches() busts on writes.
        _stable_hash({"overrides": overrides, "org": org_id, "tier_inputs": [bool(sandbox_traces), live_trace_count_7d > 0]}),
    )
    cached = _SENSITIVITY_CACHE.get(key)
    if cached is not None:
        return cached
    result = _compute_per_agent_sensitivity(
        agent_config, sandbox_traces, live_trace_count_7d, overrides, baseline_point, defaults,
        org_id=org_id,
    )
    _SENSITIVITY_CACHE[key] = result
    return result


# ── Main forecast function ───────────────────────────────────────────────────

def _infer_archetype(agent_config: dict) -> str:
    """Infer an agent archetype from its tool names (mirrors main._infer_agent_type_from_config,
    plus a scheduler bucket). Used only to pick a cold-start turns-per-run default."""
    tool_names = {(t.get("name") or "").lower() for t in agent_config.get("tools", [])}
    if tool_names and tool_names <= {"calendly", "calendar", "google_calendar", "scheduler", "cron"}:
        return "scheduler"
    if "zendesk" in tool_names or ("stripe" in tool_names and ("email" in tool_names or "sendgrid" in tool_names or "gmail" in tool_names)):
        return "support"
    if "github" in tool_names or "aws" in tool_names:
        return "ops" if "pagerduty" in tool_names else "devops"
    if "hubspot" in tool_names or "calendly" in tool_names or "salesforce" in tool_names:
        return "sales"
    return "default"


def _default_turns_per_run(agent_config: dict, defaults: dict) -> float:
    """Archetype-aware cold-start turns/run (a scheduler isn't a devops loop).
    Falls back to the flat avg_turns_per_run when no map / archetype match.

    Bounded by capability: archetype comes from tool NAMES, so a one-action
    `github` status checker infers "devops" and inherited an 8-turn loop guess.
    An agent with <=2 declared actions has nothing to loop over — cap at 2.
    """
    sd = defaults.get("scenario_defaults", {})
    by_arch = defaults.get("default_turns_per_run_by_archetype") or {}
    arch = _infer_archetype(agent_config)
    turns = float(by_arch.get(arch, by_arch.get("default", sd.get("avg_turns_per_run", 4))))
    n_actions = sum(len(t.get("actions") or []) for t in agent_config.get("tools", []))
    if 0 < n_actions <= 2:
        turns = min(turns, 2.0)
    return turns


def forecast_spend(
    agent_config: dict,
    *,
    sandbox_traces: Optional[list] = None,
    live_trace_count_7d: int = 0,
    overrides: Optional[dict] = None,
    previous_snapshot_point: Optional[float] = None,
    org_id: Optional[str] = None,
    _skip_sensitivity: bool = False,
) -> dict:
    """Compute a spend forecast for an agent.

    `org_id` applies that org's cost_overrides (negotiated model rates etc.)
    on top of the YAML defaults. Returns a dict matching the shape the
    frontend's MockSpend type expects.
    """
    defaults = load_defaults(org_id)
    overrides = overrides or {}

    # ── Coverage: do we actually know this agent's model? ──
    # The forecast prices in a known model; if the agent declares one we don't
    # recognize, we still compute a number (at the priced model's rates) but must
    # disclose it and not claim a tight band on a guessed price.
    declared_model = (agent_config.get("simulation_model") or "").strip()
    model_recognized = (not declared_model) or _model_recognized(declared_model, defaults)

    # ── Tier (capped to low when the dominant cost driver is unknown) ──
    tier = _detect_tier(sandbox_traces, live_trace_count_7d)
    if not model_recognized:
        tier = "low"
    band = defaults["confidence_bands"][tier]

    # ── Resolve inputs (overrides > agent's declared model > YAML default) ──
    # Pricing precedence: an explicit slider/override model wins; otherwise the
    # agent's own declared model is priced at its real rate (a Haiku agent must
    # not be billed as Sonnet); only then fall back to the default. This is what
    # makes persisting simulation_model actually move the number.
    sd = defaults["scenario_defaults"]
    model_name = overrides.get("model")
    if not model_name and declared_model and model_recognized:
        model_name = _resolve_model_key(declared_model, defaults)
    if not model_name or model_name not in defaults["models"]:
        model_name = defaults["default_model"]
    model_pricing = defaults["models"][model_name]
    inflation = float(model_pricing.get("tokenizer_inflation", 1.0))

    # ── Availability: never fabricate a number with no real signal ──
    # Suppress the forecast unless the user has given us SOMETHING real: declared
    # volume, a sandbox sweep, or live traces. A bare freshly-registered agent
    # returns available=False instead of a defaults-only guess dressed as a number.
    has_volume = (
        agent_config.get("expected_calls_per_day") is not None
        or overrides.get("runs_per_day") is not None
        or overrides.get("calls_per_day") is not None
        or overrides.get("llm_calls_per_day") is not None
    )
    available = has_volume or bool(sandbox_traces) or (live_trace_count_7d >= LIVE_TRACE_MIN_CALLS_FORECAST)
    if not available:
        _tn = [(t.get("name") or "").lower() for t in agent_config.get("tools", []) if t.get("name")]
        _tc = defaults.get("tool_action_costs", {}) or {}
        return {
            "available": False,
            # 1–4 captured calls: capture IS working, we just won't extrapolate
            # a month from it yet — the UI shows progress, not "no data".
            "reason": "collecting_live_traffic" if live_trace_count_7d > 0 else "no_data",
            "liveCalls7d": live_trace_count_7d,
            "liveCallsNeeded": LIVE_TRACE_MIN_CALLS_FORECAST,
            "needs": ["declare_volume", "sandbox_sweep", "live_traces"],
            "point": None, "low": None, "high": None, "annual": None, "pointExact": None,
            "vsLastMonth": 0, "vsLastMonthAvailable": False,
            "confidence": None,
            "model": model_name,
            "coverage": {
                "modelRecognized": model_recognized,
                "declaredModel": declared_model or None,
                "pricedModel": model_name,
                "toolsPriced": sum(1 for n in _tn if _tool_is_priced(_tc, n)),
                "toolsTotal": len(_tn),
            },
            "lastCalibrated": defaults.get("last_calibrated"),
        }

    # ── Volume: runs/day × turns/run = LLM calls/day ──
    # An agent RUN is an agentic loop of several LLM round-trips (turns). Cost is
    # per LLM call, so monthly cost scales with llm_calls_per_day = runs × turns —
    # not runs alone (the old bug, which under-counted ~4×).
    #   runs_per_day  : business volume (declared / slider / default)
    #   turns_per_run : LLM round-trips per run (measured by sandbox/live, else
    #                   archetype default)
    # Live tier observes total LLM calls/day directly and must NOT re-multiply by
    # turns — unless the CFO is actively dialing a runs/turns what-if slider.
    # Sandbox-measured averages (medium tier): real turns + tokens from sims.
    # Lower priority than live/explicit overrides, higher than static defaults.
    # Kept SEPARATE from `overrides` so sandbox turns can't masquerade as an
    # explicit what-if and suppress the live-tier branch below.
    sandbox_avgs = compute_sandbox_averages(sandbox_traces) if sandbox_traces else {}

    explicit_runs = _first_set(
        overrides.get("runs_per_day"),
        overrides.get("calls_per_day"),   # legacy alias = runs at static/sandbox tier
        default=None,
    )
    explicit_turns = overrides.get("turns_per_run")
    observed_llm_calls = overrides.get("llm_calls_per_day")

    known_turns = _first_set(
        explicit_turns,
        sandbox_avgs.get("turns_per_run"),
        agent_config.get("expected_turns_per_run"),
        default=None,
    )
    volume_declared = explicit_runs is not None or agent_config.get("expected_calls_per_day") is not None
    if known_turns is not None:
        turns_per_run = max(1, int(round(float(known_turns))))
    elif volume_declared:
        # Declared volume WITHOUT declared/measured turns: the customer's number
        # is their total model-calls/day (what a provider console shows). An
        # archetype guess multiplied it 4-8x invisibly and was the single
        # largest source of forecast error (mean |err| 546% -> 60% on the truth
        # fleet with this rule alone). An assumption may widen a band; it must
        # never multiply a declared number.
        turns_per_run = 1
    else:
        turns_per_run = max(1, int(round(_default_turns_per_run(agent_config, defaults))))
    runs_per_day = int(_first_set(
        explicit_runs,
        agent_config.get("expected_calls_per_day"),
        default=sd["default_calls_per_day"],
    ))

    # Did the customer ever opt into runs-x-turns semantics? Only by declaring
    # turns (API/UI) or driving the what-if sliders. A bare declared calls/day
    # is TOTAL model calls (the P1 contract) — and that contract must survive
    # the tier upgrade: when a sweep later MEASURES turns, the measurement
    # refines the run split, it must not re-multiply the declared total (which
    # turned a correct low-tier forecast into a wrong medium-tier one while
    # claiming more confidence).
    volume_is_total = (
        agent_config.get("expected_calls_per_day") is not None
        and explicit_runs is None
        and explicit_turns is None
        and agent_config.get("expected_turns_per_run") is None
    )
    if observed_llm_calls is not None and explicit_runs is None and explicit_turns is None:
        # Live tier, no manual what-if → trust observed total LLM calls.
        llm_calls_per_day = int(observed_llm_calls)
        turns_per_run = round(llm_calls_per_day / runs_per_day, 1) if runs_per_day else turns_per_run
    elif volume_is_total:
        llm_calls_per_day = int(agent_config["expected_calls_per_day"])
        runs_per_day = max(1, int(round(llm_calls_per_day / turns_per_run)))
    else:
        llm_calls_per_day = int(round(runs_per_day * turns_per_run))

    runtime = float(overrides.get("runtime") or sd["default_runtime_seconds"])
    # No sandbox term here on purpose — sims can't measure production cache
    # locality (see compute_sandbox_averages). Live rolling averages arrive
    # via `overrides` on the live path.
    cache_hit_rate = float(_first_set(
        overrides.get("cache_hit"),
        default=sd["default_cache_hit_rate"] * 100,
    )) / 100.0
    retry_rate = float(overrides.get("retry_rate", sd["default_retry_rate"] * 100)) / 100.0

    # ── Token estimate ──
    # Observed per-turn tokens from live traces (high) or sandbox sims (medium)
    # override the static capability-tree estimate. Real counts already reflect
    # the tokenizer, so model inflation is not re-applied to them.
    # D25 precedence: live-measured > declared context > sandbox-measured >
    # static default. Sandbox mocks return tiny payloads, so their "measured"
    # input tokens must never outrank a declared context — a RAG agent that
    # declared an 80k-token context was repriced off 1.4k-token mock traces at
    # HIGHER confidence (-96% under truth). Sims do measure completion size
    # faithfully, so a sandbox output average still refines the estimate.
    try:
        _declared_ctx = int(agent_config.get("avg_context_tokens") or 0)
    except (TypeError, ValueError):
        _declared_ctx = 0
    live_in, live_out = overrides.get("input_tokens"), overrides.get("output_tokens")
    sbx_in, sbx_out = sandbox_avgs.get("input_tokens"), sandbox_avgs.get("output_tokens")
    if live_in is not None and live_out is not None:
        in_tokens, out_tokens = int(live_in), int(live_out)
    elif _declared_ctx > 0:
        in_tokens, out_tokens = _estimate_tokens_per_call(agent_config, defaults, inflation, turns_per_run)
        if sbx_out is not None:
            out_tokens = int(sbx_out)
    elif sbx_in is not None and sbx_out is not None:
        in_tokens, out_tokens = int(sbx_in), int(sbx_out)
    else:
        in_tokens, out_tokens = _estimate_tokens_per_call(agent_config, defaults, inflation, turns_per_run)

    # ── Per-call LLM cost ──
    in_price = model_pricing["input_per_mtok"] / 1_000_000.0
    out_price = model_pricing["output_per_mtok"] / 1_000_000.0
    cache_discount = float(model_pricing.get("cache_discount", 0.5))
    cache_factor = 1.0 - (cache_hit_rate * cache_discount)
    retry_factor = 1.0 + retry_rate
    obs_cost = overrides.get("llm_cost_per_call")
    if obs_cost is not None:
        # Live tier: mean of REAL per-call $ — blends the actual model mix
        # (fixes single-model reconstruction for model-switching agents).
        llm_cost_per_call = float(obs_cost)
    else:
        llm_cost_per_call = (in_tokens * in_price + out_tokens * out_price) * cache_factor * retry_factor

    # ── Per-call tool cost (weighted by observed action mix when traces exist) ──
    tool_cost_per_call, actions_with_cost, tool_mix_measured = _estimate_tool_cost_per_call(
        agent_config, defaults, sandbox_traces
    )

    # ── Infra overhead ──
    # Split into a fixed per-call overhead plus a runtime-proportional compute
    # cost, so a longer-running call actually costs more — this is what makes
    # the "Runtime / call" sensitivity lever real instead of structurally zero.
    infra = defaults["infrastructure"]
    infra_base = float(infra.get("per_call_overhead_usd", 0.0))
    compute_per_sec = float(infra.get("compute_cost_per_second_usd", 0.0))
    infra_per_call = infra_base + runtime * compute_per_sec

    # ── Monthly totals ──
    # All three are PER-LLM-CALL costs → scale by llm_calls_per_day (= runs×turns).
    days_per_month = 30
    monthly_llm = llm_cost_per_call * llm_calls_per_day * days_per_month
    monthly_tools = tool_cost_per_call * llm_calls_per_day * days_per_month
    monthly_infra = infra_per_call * llm_calls_per_day * days_per_month
    monthly_point = monthly_llm + monthly_tools + monthly_infra

    monthly_low = monthly_point * band["low_multiplier"]
    monthly_high = monthly_point * band["high_multiplier"]

    # ── Composition percentages ──
    if monthly_point > 0:
        tokens_pct = round((monthly_llm / monthly_point) * 100)
        tools_pct = round((monthly_tools / monthly_point) * 100)
        infra_pct = max(0, 100 - tokens_pct - tools_pct)
    else:
        tokens_pct = tools_pct = infra_pct = None  # undefined — don't fabricate 70/20/10

    # ── Top tool calls ── projected by per-action weight (observed share when
    # traces exist, else uniform 1/N — disclosed via inputSources.toolMix).
    monthly_calls = llm_calls_per_day * days_per_month
    top_tools: list[dict] = []
    for tool_name, action_name, cost_per, weight in actions_with_cost:
        calls = monthly_calls * weight
        top_tools.append({
            "tool": f"{tool_name}.{action_name}",
            "callsPerMonth": int(round(calls)),
            "costPer": round(cost_per, 4),
            "monthly": round(calls * cost_per, 2),
        })
    top_tools.sort(key=lambda x: x["monthly"], reverse=True)
    top_tools = top_tools[:4]

    # Only a real ~30-day-old snapshot makes the comparison meaningful. Without
    # one, vs_last_month is 0 — but that's "no baseline", not "flat". Surface the
    # distinction so the UI can hide the stat instead of implying no change.
    vs_last_month_available = bool(previous_snapshot_point and previous_snapshot_point > 0)
    if vs_last_month_available:
        vs_last_month = int(round((monthly_point - previous_snapshot_point) / previous_snapshot_point * 100))
    else:
        vs_last_month = 0

    # ── Coverage summary (disclosure only — not used in the math above) ──
    _tool_names = [(t.get("name") or "").lower() for t in agent_config.get("tools", []) if t.get("name")]
    _tac = defaults.get("tool_action_costs", {}) or {}
    tools_total = len(_tool_names)
    tools_priced = sum(1 for n in _tool_names if _tool_is_priced(_tac, n))

    # ── Per-input source disclosure: declared / measured / default ──
    # So a defaulted input is never silently presented as a measurement.
    _live_path = observed_llm_calls is not None and explicit_runs is None and explicit_turns is None
    if explicit_runs is not None or agent_config.get("expected_calls_per_day") is not None:
        runs_source = "declared"
    else:
        runs_source = "default"
    if _live_path:
        turns_source = "measured"
    elif explicit_turns is not None:
        turns_source = "declared"
    elif sandbox_avgs.get("turns_per_run") is not None:
        turns_source = "measured"
    elif agent_config.get("expected_turns_per_run") is not None:
        turns_source = "declared"
    elif volume_declared:
        # turns=1 by the P1 rule: declared volume counts total model calls.
        turns_source = "volume"
    else:
        turns_source = "default"
    # Mirrors the D25 precedence above: only live data may claim "measured"
    # over a declared context; sandbox tokens are "measured" only when nothing
    # was declared.
    if overrides.get("llm_cost_per_call") is not None or overrides.get("input_tokens") is not None:
        tokens_source = "measured"
    elif _declared_ctx > 0:
        tokens_source = "declared"
    elif sandbox_avgs.get("input_tokens") is not None:
        tokens_source = "measured"
    else:
        tokens_source = "default"
    if _live_path:
        cache_source = "measured"
    elif overrides.get("cache_hit") is not None:
        cache_source = "declared"
    else:
        cache_source = "default"
    model_source = "declared" if (overrides.get("model") or (declared_model and model_recognized)) else "default"
    input_sources = {
        "runsPerDay": runs_source,
        "turnsPerRun": turns_source,
        "tokensPerCall": tokens_source,
        "cacheHit": cache_source,
        "model": model_source,
        "toolMix": "measured" if tool_mix_measured else "default",
    }

    return {
        "available": True,
        "point": round(monthly_point),
        # Unrounded point — used by the sensitivity engine so small but real
        # levers (runtime, retry) aren't lost to whole-dollar rounding.
        "pointExact": monthly_point,
        # Days of live traffic behind the averages (live tier only) — the UI
        # captions the forecast with this so a burst never masquerades as a month.
        "observedDays": (overrides.get("observed_days") if _live_path else None),
        "low": round(monthly_low),
        "high": round(monthly_high),
        "annual": round(monthly_point * 12),
        "vsLastMonth": vs_last_month,
        "vsLastMonthAvailable": vs_last_month_available,
        "callsPerDay": llm_calls_per_day,   # total LLM calls/day (= runs × turns); back-compat key
        "runsPerDay": runs_per_day,
        "turnsPerRun": turns_per_run,
        "runtime": runtime,
        "tokensPerCall": in_tokens + out_tokens,
        "cacheHit": int(cache_hit_rate * 100),
        "retryRate": int(retry_rate * 100),
        "tokensPct": tokens_pct,
        "toolsPct": tools_pct,
        "infraPct": infra_pct,
        "tokensUsd": round(monthly_llm),
        "toolsUsd": round(monthly_tools),
        "infraUsd": round(monthly_infra),
        "topTools": top_tools,
        # Unit econ outcomes are per-RUN (sandbox occurrences are per run) → pass runs_per_day, not llm_calls.
        "unitEcon": _compute_unit_econ(agent_config, sandbox_traces, monthly_point, runs_per_day),
        "sensitivity": (
            []  # never canned; sensitivity is real per-agent or absent
            if _skip_sensitivity
            else _cached_sensitivity(
                agent_config, sandbox_traces, live_trace_count_7d, overrides, monthly_point, defaults,
                org_id=org_id,
            )
        ),
        "inputSources": input_sources,
        "confidence": tier,
        "model": model_name,
        "coverage": {
            "modelRecognized": model_recognized,
            "declaredModel": declared_model or None,
            "pricedModel": model_name,
            "toolsPriced": tools_priced,
            "toolsTotal": tools_total,
        },
        "lastCalibrated": defaults.get("last_calibrated"),
    }


# ── Budget-fit recommender (CFO: "I have $X — does it fit, and how?") ─────────

def compute_budget_fit(
    agent_config: dict,
    *,
    budget: float,
    base_overrides: Optional[dict] = None,
    org_id: Optional[str] = None,
    cost_report_items: Optional[list] = None,
) -> dict:
    """Given a monthly budget, say whether the agent fits and — if over — return
    a ranked list of honest levers to close the gap.

    This is an *options engine*, not an optimizer: the cost model knows cost,
    not quality, so every quality-affecting lever carries a plain-English
    tradeoff and the human decides. `cost_report_items` (from /cost-report)
    powers the risk-reduction crossover on the action-gating lever.

    Returns {budget, forecastPoint, gap, status ("under"|"over"),
             currentModel, recommendations: [{lever, label, projectedSaving,
             newPoint, tradeoff, riskReductionUsd?}]}.
    """
    base_overrides = dict(base_overrides or {})

    def _point(extra: dict) -> tuple[int, dict]:
        f = forecast_spend(
            agent_config, overrides={**base_overrides, **extra} or None,
            org_id=org_id, _skip_sensitivity=True,
        )
        return f["point"], f

    base_point, base = _point({})
    if not base.get("available") or base_point is None:
        # Can't fit a budget to a forecast we don't have — need data first.
        return {
            "available": False,
            "reason": "no_data",
            "needs": ["declare_volume", "sandbox_sweep", "live_traces"],
            "budget": round(budget),
            "forecastPoint": None,
            "recommendations": [],
        }
    gap = base_point - budget
    status = "over" if gap > 0 else "under"
    result = {
        "budget": round(budget),
        "forecastPoint": base_point,
        "gap": round(gap),
        "status": status,
        "currentModel": base["model"],
        "recommendations": [],
    }
    if gap <= 0:
        return result

    cost_recs: list[dict] = []

    # ── Lever 1: model tier — least-aggressive downgrade that fits, else cheapest
    cur_model = base_overrides.get("model") or base["model"]
    cheaper: list[tuple[str, int]] = []
    for m_name in (load_defaults(org_id).get("models", {})):
        if m_name == cur_model:
            continue
        p, _ = _point({"model": m_name})
        if p < base_point:
            cheaper.append((m_name, p))
    if cheaper:
        fitting = [c for c in cheaper if c[1] <= budget]
        # Among models that fit, prefer the most expensive (smallest change);
        # if none fit, take the cheapest (max saving).
        pick = max(fitting, key=lambda c: c[1]) if fitting else min(cheaper, key=lambda c: c[1])
        cost_recs.append({
            "lever": "model",
            "label": f"Switch the model to {pick[0]}",
            "projectedSaving": round(base_point - pick[1]),
            "newPoint": pick[1],
            "tradeoff": "Cheaper per token — verify quality on your evals before switching.",
        })

    # ── Lever 2: cache hit rate — only if there's real headroom
    cur_cache = base["cacheHit"]
    if cur_cache < 80:
        p, _ = _point({"cache_hit": 80})
        if p < base_point:
            cost_recs.append({
                "lever": "cache",
                "label": f"Raise cache hit rate to 80% (now {cur_cache}%)",
                "projectedSaving": round(base_point - p),
                "newPoint": p,
                "tradeoff": "Depends on reusing a stable system prompt — not a dial you just turn.",
            })

    # ── Lever 3: call volume — the always-available "do less work" lever.
    # Operate on RUNS/day (the business lever); cost scales linearly so the same
    # ratio applies whether expressed as runs or LLM calls.
    cur_runs = base.get("runsPerDay") or base["callsPerDay"]
    if base_point > 0:
        target_runs = max(1, int(cur_runs * budget / base_point))
        if target_runs < cur_runs:
            p, _ = _point({"runs_per_day": target_runs})
            cost_recs.append({
                "lever": "volume",
                "label": f"Cut usage to ~{target_runs} runs/day (now {cur_runs})",
                "projectedSaving": round(base_point - p),
                "newPoint": p,
                "tradeoff": "This is doing less work — fewer runs, not cheaper runs.",
            })

    cost_recs.sort(key=lambda r: r["projectedSaving"], reverse=True)

    # ── Lever 4 (kept separate so it isn't crowded out): gate the riskiest
    # unprotected action. Mostly a RISK lever — surfaces the cost+risk crossover.
    gate_rec = None
    if cost_report_items:
        unprotected = [i for i in cost_report_items if not i.get("has_policy")]
        if unprotected:
            worst = max(unprotected, key=lambda i: i.get("per_incident_max_usd", 0) or 0)
            action_key = f"{worst.get('tool')}.{worst.get('action')}"
            tool_saving = 0
            for t in base.get("topTools", []):
                if t.get("tool") == action_key:
                    tool_saving = t.get("monthly", 0)
                    break
            risk_usd = round(worst.get("per_incident_max_usd", 0) or 0)
            if risk_usd > 0:
                gate_rec = {
                    "lever": "gate",
                    "label": f"Require approval on {action_key}",
                    "projectedSaving": round(tool_saving),
                    "newPoint": round(base_point - tool_saving),
                    "tradeoff": "Adds a human check on that action — small cost impact, large risk cut.",
                    "riskReductionUsd": risk_usd,
                }

    recs = cost_recs[:3]
    if gate_rec:
        recs.append(gate_rec)
    result["recommendations"] = recs
    return result


# ── Minimal fallback if pyyaml not installed ─────────────────────────────────

_MINIMAL_DEFAULTS = {
    "last_calibrated": "2026-05-29",
    "default_model": "claude-sonnet-4-6",
    "models": {
        "claude-sonnet-4-6": {"input_per_mtok": 3.00, "output_per_mtok": 15.00, "cache_discount": 0.90, "tokenizer_inflation": 1.0},
        "claude-haiku-4-5": {"input_per_mtok": 1.00, "output_per_mtok": 5.00, "cache_discount": 0.90, "tokenizer_inflation": 1.0},
        "claude-opus-4-8": {"input_per_mtok": 5.00, "output_per_mtok": 25.00, "cache_discount": 0.90, "tokenizer_inflation": 1.35},
        "gpt-4o": {"input_per_mtok": 2.50, "output_per_mtok": 10.00, "cache_discount": 0.50, "tokenizer_inflation": 1.0},
        "gpt-4o-mini": {"input_per_mtok": 0.15, "output_per_mtok": 0.60, "cache_discount": 0.50, "tokenizer_inflation": 1.0},
        "gpt-4-1": {"input_per_mtok": 2.00, "output_per_mtok": 8.00, "cache_discount": 0.50, "tokenizer_inflation": 1.0},
        "gemini-2-5-pro": {"input_per_mtok": 1.25, "output_per_mtok": 10.00, "cache_discount": 0.90, "tokenizer_inflation": 1.0},
        "gemini-1-5-flash": {"input_per_mtok": 0.075, "output_per_mtok": 0.30, "cache_discount": 0.90, "tokenizer_inflation": 1.0},
        "llama-3-3-70b": {"input_per_mtok": 0.60, "output_per_mtok": 0.60, "cache_discount": 0.0, "tokenizer_inflation": 1.0},
        "deepseek-v3": {"input_per_mtok": 0.27, "output_per_mtok": 1.10, "cache_discount": 0.75, "tokenizer_inflation": 1.0},
        "mistral-large": {"input_per_mtok": 2.00, "output_per_mtok": 6.00, "cache_discount": 0.0, "tokenizer_inflation": 1.0},
    },
    "tool_action_costs": {
        "sendgrid": {"send_email": 0.0004},
        "twilio": {"send_sms": 0.0079, "make_call": 0.014},
        "stripe": {"create_payout": 0.25, "create_refund": 0.0},
    },
    "turn_defaults": {
        "system_prompt_tokens": 800,
        "tool_overhead_per_tool": 400,
        "user_message_tokens": 120,
        "tool_result_tokens": 500,
        "completion_tokens": 300,
        "history_growth_per_turn": 1500,
    },
    "scenario_defaults": {
        "default_calls_per_day": 100,
        "avg_turns_per_run": 4,
        "default_runtime_seconds": 4.2,
        "default_cache_hit_rate": 0.60,
        "default_retry_rate": 0.03,
    },
    "default_turns_per_run_by_archetype": {
        "scheduler": 2, "support": 4, "sales": 4, "devops": 8, "ops": 8, "default": 4,
    },
    "confidence_bands": {
        "low": {"low_multiplier": 0.50, "high_multiplier": 3.00},  # asymmetric — see YAML calibration note
        "medium": {"low_multiplier": 0.70, "high_multiplier": 2.00},  # asymmetric — see YAML calibration note
        "high": {"low_multiplier": 0.85, "high_multiplier": 1.15},
    },
    "infrastructure": {"per_call_overhead_usd": 0.0002, "compute_cost_per_second_usd": 0.00018},
    "sensitivity_ranking": [
        {"label": "Calls per day", "pct": 76, "color": "linear-gradient(90deg, #fecaca, #ef4444)"},
        {"label": "Model choice", "pct": 42, "color": "linear-gradient(90deg, #fde68a, #f59e0b)"},
        {"label": "Cache hit rate", "pct": 23, "color": "linear-gradient(90deg, #fde68a, #f59e0b)"},
        {"label": "Runtime / call", "pct": 18, "color": "linear-gradient(90deg, #d1d5db, #9ca3af)"},
        {"label": "Retry rate", "pct": 10, "color": "linear-gradient(90deg, #d1d5db, #9ca3af)"},
    ],
}
