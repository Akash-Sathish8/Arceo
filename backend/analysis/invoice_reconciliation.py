"""Invoice reconciliation — "Arceo tracked $X, your invoice says $Y."

The accuracy story made checkable: a customer imports what their LLM provider
actually billed (a usage-export CSV or just the invoice total) and we compare
it against the LLM spend Arceo captured for the same window. A close match is
the proof the tracker earns trust with; a gap gets an honest explanation, not
a shrug.

Scope rules that keep the math defensible:
- Reconciliation is ORG-level per provider. An invoice covers an API key /
  org, not one agent — comparing it to a single agent would be fiction.
- We compare against CAPTURED LLM token cost only (audit_log LLM_CALL rows),
  because that is what the provider bills. Tool/infra estimates never enter.
- Captured calls are priced at CURRENT catalog rates (the tracker has no
  price history), and the UI says so — a provider repricing mid-window shows
  up as part of the delta.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timedelta
from typing import Any, Optional

from analysis.spend_forecast import (
    _call_cost_usd,
    _extract_usage,
    _resolve_model_key,
    load_defaults,
)

# Providers we can attribute captured rows to (audit_log resource is
# "provider:model"). Free-text on import; normalized for matching.
_PROVIDER_ALIASES = {
    "anthropic": "anthropic", "claude": "anthropic",
    "openai": "openai", "gpt": "openai",
    "google": "google", "gemini": "google", "googleai": "google",
}


def normalize_provider(name: str) -> str:
    n = (name or "").strip().lower()
    return _PROVIDER_ALIASES.get(n, n)


# ── CSV parsing (flexible headers) ────────────────────────────────────────────
# Provider usage exports differ and change; instead of pinning exact schemas we
# detect the three columns that matter by fuzzy header match. Anything we can't
# map is ignored — the import still works with just a cost column.

_COST_HEADERS = ("cost_usd", "cost", "amount_usd", "amount", "usd", "total_cost",
                 "total_usd", "spend", "price_usd", "price", "charge")
_DATE_HEADERS = ("usage_date", "date", "day", "period_start", "start_time",
                 "start_date", "timestamp", "period")
_MODEL_HEADERS = ("model_version", "model_id", "model", "sku", "line_item",
                  "description")

MAX_CSV_BYTES = 2_000_000
MAX_CSV_ROWS = 50_000


def _pick_column(headers: list[str], candidates: tuple[str, ...]) -> Optional[str]:
    lowered = {h.lower().strip(): h for h in headers}
    for cand in candidates:
        if cand in lowered:
            return lowered[cand]
    # Substring fallback ("Cost (USD)" → cost) — first candidate hit wins.
    for cand in candidates:
        for low, orig in lowered.items():
            if cand in low:
                return orig
    return None


def _parse_money(raw: Any) -> Optional[float]:
    if raw is None:
        return None
    s = str(raw).strip().replace("$", "").replace(",", "").replace("USD", "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _parse_day(raw: Any) -> Optional[str]:
    """Best-effort YYYY-MM-DD from common export date formats."""
    s = str(raw or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y/%m/%d", "%m/%d/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s[:19] if "T" in s else s, fmt).date().isoformat()
        except ValueError:
            continue
    try:  # full ISO with tz etc.
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return None


def parse_invoice_csv(text: str) -> dict:
    """Parse a provider usage/billing export into normalized line items.

    Returns {line_items, total_usd, period_start, period_end, columns} where
    line_items is [{day, model, usd}] (day/model may be None when the export
    lacks those columns). Raises ValueError with a plain-English message when
    no usable cost column is found — the caller surfaces it verbatim.
    """
    if len(text.encode("utf-8", errors="ignore")) > MAX_CSV_BYTES:
        raise ValueError("That CSV is larger than 2 MB. Export a single billing period instead.")
    reader = csv.DictReader(io.StringIO(text))
    headers = reader.fieldnames or []
    cost_col = _pick_column(headers, _COST_HEADERS)
    if not cost_col:
        raise ValueError(
            "Couldn't find a cost column. Expected a header like 'cost', 'amount' "
            f"or 'cost_usd'. We found: {', '.join(headers[:12]) or 'no headers'}."
        )
    date_col = _pick_column(headers, _DATE_HEADERS)
    model_col = _pick_column(headers, _MODEL_HEADERS)

    items: list[dict] = []
    skipped = 0
    for i, row in enumerate(reader):
        if i >= MAX_CSV_ROWS:
            raise ValueError("That CSV has more than 50,000 rows. Export a single billing period instead.")
        usd = _parse_money(row.get(cost_col))
        if usd is None:
            skipped += 1
            continue
        items.append({
            "day": _parse_day(row.get(date_col)) if date_col else None,
            "model": (str(row.get(model_col)).strip() or None) if model_col else None,
            "usd": usd,
        })
    if not items:
        raise ValueError("No rows with a parseable cost value were found in the CSV.")

    days = sorted({it["day"] for it in items if it["day"]})
    return {
        "line_items": items,
        "total_usd": round(sum(it["usd"] for it in items), 2),
        "period_start": days[0] if days else None,
        "period_end": days[-1] if days else None,
        "columns": {"cost": cost_col, "date": date_col, "model": model_col},
        "rows_skipped": skipped,
    }


# ── Captured-spend aggregation ───────────────────────────────────────────────

def aggregate_captured_spend(audit_rows: list, provider: str,
                             defaults: Optional[dict] = None) -> dict:
    """Org-wide captured LLM token spend for one provider.

    `audit_rows` are LLM_CALL/LLM_CALL_PROXY rows (already org-scoped and
    window-filtered by the caller) exposing detail/resource/timestamp. Rows
    whose resource prefix doesn't match `provider` are skipped. Returns
    {total_usd, calls, by_day, by_model} — by_day keys are YYYY-MM-DD.
    """
    defaults = defaults or load_defaults()
    provider = normalize_provider(provider)
    total = 0.0
    calls = 0
    by_day: dict[str, float] = {}
    by_model: dict[str, float] = {}

    for row in audit_rows:
        resource = str(row.get("resource") if isinstance(row, dict) else row["resource"] or "")
        row_provider = normalize_provider(resource.split(":", 1)[0]) if ":" in resource else ""
        if row_provider != provider:
            continue
        raw = row.get("detail") if isinstance(row, dict) else row["detail"]
        ts = row.get("timestamp") if isinstance(row, dict) else row["timestamp"]
        try:
            detail = json.loads(raw) if raw else None
        except (json.JSONDecodeError, TypeError):
            continue
        if not detail:
            continue
        usage = _extract_usage(detail)
        if usage is None:
            continue
        total_in, cached, cache_creation, out = usage
        model_key = _resolve_model_key(detail.get("model"), defaults)
        usd = _call_cost_usd(total_in, cached, out, model_key, defaults,
                             cache_creation=cache_creation)
        total += usd
        calls += 1
        day = str(ts)[:10] if ts else None
        if day:
            by_day[day] = by_day.get(day, 0.0) + usd
        by_model[model_key] = by_model.get(model_key, 0.0) + usd

    return {
        "total_usd": round(total, 4),
        "calls": calls,
        "by_day": {d: round(v, 4) for d, v in sorted(by_day.items())},
        "by_model": {m: round(v, 4) for m, v in sorted(by_model.items(), key=lambda kv: -kv[1])},
    }


# ── Reconciliation ───────────────────────────────────────────────────────────

def reconcile(invoice: dict, captured: dict) -> dict:
    """Compare an imported invoice against captured spend for the same window.

    `invoice`: {total_usd, period_start, period_end, line_items?, source}
    `captured`: output of aggregate_captured_spend.

    Verdict bands (plain English, CFO-facing):
      <=5%  reconciled       — the tracker matches the bill
      <=20% partial          — close, with an explainable gap
      >20%  large_gap        — something material isn't captured
    """
    invoice_total = float(invoice.get("total_usd") or 0.0)
    tracked_total = float(captured.get("total_usd") or 0.0)
    delta = round(tracked_total - invoice_total, 2)
    delta_pct = round(delta / invoice_total * 100, 1) if invoice_total > 0 else None

    if invoice_total <= 0:
        verdict = "no_invoice_total"
    elif abs(delta) <= invoice_total * 0.05:
        verdict = "reconciled"
    elif abs(delta) <= invoice_total * 0.20:
        verdict = "partial"
    else:
        verdict = "large_gap"

    # Honest gap explanations, ordered by how often each is the real cause.
    causes: list[str] = []
    if verdict in ("partial", "large_gap"):
        if delta < 0:
            causes.append(
                "The invoice includes traffic Arceo never saw. Anything on this "
                "API key that isn't wrapped by the SDK or routed through the "
                "proxy (other apps, notebooks, humans testing in a console)."
            )
            causes.append(
                "Capture gaps: agents that ran while capture was failing "
                "silently don't appear in tracked spend."
            )
        else:
            causes.append(
                "Arceo prices captured calls at today's catalog rates; if the "
                "provider repriced during the window (or you have negotiated "
                "rates), tracked spend drifts from the bill. Set your rates in "
                "Settings → Cost model."
            )
            causes.append(
                "Batch-discounted traffic (50% off) is billed lower than the "
                "standard rates Arceo prices at."
            )
        causes.append(
            "Cache billing differences: providers bill cache writes and reads "
            "at special rates that Arceo approximates per model family."
        )

    # Per-day alignment when the import carried dates.
    by_day = []
    inv_days: dict[str, float] = {}
    for it in invoice.get("line_items") or []:
        if it.get("day"):
            inv_days[it["day"]] = inv_days.get(it["day"], 0.0) + float(it["usd"])
    if inv_days:
        tracked_days = captured.get("by_day") or {}
        for day in sorted(set(inv_days) | set(tracked_days)):
            by_day.append({
                "day": day,
                "invoiceUsd": round(inv_days.get(day, 0.0), 4),
                "trackedUsd": round(tracked_days.get(day, 0.0), 4),
            })

    coverage_pct = (round(min(tracked_total / invoice_total, 1.0) * 100)
                    if invoice_total > 0 else None)

    return {
        "invoiceUsd": round(invoice_total, 2),
        "trackedUsd": round(tracked_total, 2),
        "deltaUsd": delta,
        "deltaPct": delta_pct,
        "coveragePct": coverage_pct,
        "verdict": verdict,
        "causes": causes,
        "byDay": by_day,
        "trackedByModel": captured.get("by_model") or {},
        "trackedCalls": captured.get("calls", 0),
        "periodStart": invoice.get("period_start"),
        "periodEnd": invoice.get("period_end"),
        # Disclosed limitation, rendered by the UI: no historical price book.
        "pricedAtCurrentRates": True,
    }


def window_bounds(period_start: Optional[str], period_end: Optional[str]) -> tuple[str, str]:
    """Inclusive day window → [start_iso, end_exclusive_iso) for timestamp filters.
    Defaults to the last 30 days when the import carries no dates."""
    if period_start and period_end:
        end = (datetime.fromisoformat(period_end) + timedelta(days=1)).isoformat()
        return datetime.fromisoformat(period_start).isoformat(), end
    now = datetime.utcnow()
    return (now - timedelta(days=30)).isoformat(), (now + timedelta(days=1)).isoformat()
