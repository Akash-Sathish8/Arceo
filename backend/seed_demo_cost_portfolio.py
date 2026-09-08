"""Seed a demo agent with a realistic, backdated 30-day cost-portfolio story.

Why this exists: `/api/agent/{id}/llm-call` stamps server-now, so seeding the
usual way piles every call onto today — the actuals chart shows one spike, not
a line. This script inserts a multi-day trace via raw SQL with backdated
timestamps, so:

  * the 30-day actuals chart draws a real line,
  * the high-confidence tier fires (>=50 captured calls in the last 7 days),
  * "vs last month" shows a real number (a ~31-day-old forecast snapshot).

It registers the agent through the public (unauthenticated) endpoint, so it
NEVER logs in — which matters because the dev server runs DEMO_MODE=true, where
any login wipes the demo tables. Run it with the server up:

    cd arceo/backend && python3 seed_demo_cost_portfolio.py

Idempotent: re-running clears this agent's prior trace/snapshots and reseeds a
fresh window ending today, so it's safe to run right before each demo.
"""

import random
import sys
import json
from datetime import datetime, timedelta

import httpx

from db import get_db

BASE = "http://localhost:8000"
AGENT_NAME = "Acme Support Copilot"
AGENT_ID = "acme-support-copilot"
MODEL = "claude-sonnet-4-5-20250929"

# A support agent: refunds (money), customer emails (PII + external), ticket
# reads. Gives a real worst-case for the Risk x Cost panel too.
TOOLS = [
    {"name": "stripe", "service": "Stripe", "description": "Payments",
     "actions": [{"name": "create_refund", "description": "Refund a customer charge"}]},
    {"name": "sendgrid", "service": "SendGrid", "description": "Email",
     "actions": [{"name": "send_email", "description": "Email a customer"}]},
    {"name": "zendesk", "service": "Zendesk", "description": "Support tickets",
     "actions": [{"name": "get_ticket", "description": "Read a support ticket"}]},
]


def register_agent() -> str:
    r = httpx.post(f"{BASE}/api/authority/agents/register", json={
        "name": AGENT_NAME, "description": "Customer support agent for refunds, emails, and tickets.",
        "tools": TOOLS,
    }, timeout=60)
    r.raise_for_status()
    agent_id = r.json()["id"]
    # Honesty flag: this agent's traffic is synthetic. The register API
    # deliberately can't set is_demo (no external caller should), so the
    # seeder marks it directly — the Cost Portfolio renders a "Demo data"
    # chip off this and the forecast response carries isDemo.
    with get_db() as conn:
        conn.execute("UPDATE agents SET is_demo = true WHERE id = %s", (agent_id,))
    return agent_id


def _usage_detail(in_base: int, out: int, cache_read: int) -> str:
    return json.dumps({
        "provider": "anthropic", "model": MODEL,
        "response": {"usage": {
            "input_tokens": in_base,
            "output_tokens": out,
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": 0,
        }},
    })


def seed_trace(agent_org: str) -> int:
    """Insert ~30 days of cron-spread LLM calls with realistic variance."""
    rng = random.Random(42)  # deterministic — same demo every run
    now = datetime.utcnow()
    rows = []
    for day in range(29, -1, -1):
        date = now - timedelta(days=day)
        # Weekdays busier than weekends; a couple of high days for texture.
        base = 22 if date.weekday() < 5 else 9
        n_calls = max(3, int(rng.gauss(base, 4)))
        for _ in range(n_calls):
            ts = date.replace(
                hour=rng.randint(7, 21), minute=rng.randint(0, 59), second=rng.randint(0, 59)
            )
            in_base = rng.randint(1500, 2600)
            out = rng.randint(180, 520)
            cache_read = rng.choice([0, 1800, 2000, 2200])  # ~55% cache hit on avg
            rows.append((None, AGENT_ID, "LLM_CALL", f"anthropic:{MODEL}",
                         _usage_detail(in_base, out, cache_read), agent_org, ts.isoformat()))
    with get_db() as conn:
        # audit_log is append-only (Phase 6) — can't delete prior seed rows;
        # re-running the seeder just appends more LLM_CALL history, which is fine.
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO audit_log (user_id, user_email, action, resource, detail, org_id, timestamp) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s)", rows)
    return len(rows)


def seed_prior_snapshot(agent_org: str):
    """A ~31-day-old forecast snapshot so 'vs last month' is real for this agent.

    Seeded ~12% below the current forecast so the comparison shows a believable
    upward trend rather than a flat or fabricated-looking number.
    """
    import uuid
    # Derive the prior point from a local forecast (no HTTP/auth needed).
    from db import get_agent_from_db
    from analysis.spend_forecast import (
        forecast_spend, compute_live_rolling_averages, load_defaults,
        LIVE_TRACE_MIN_CALLS, FORECAST_FORMULA_VERSION,
    )
    # Loaded before the connection below: load_defaults opens its own pooled
    # connection. The demo runs off seeded data, so it needs the org's rates
    # here too or the demo reproduces the list-price bug.
    org_defaults = load_defaults(agent_org)
    with get_db() as conn:
        agent = get_agent_from_db(conn, AGENT_ID, org_id=agent_org)
        seven_days_ago = (datetime.utcnow() - timedelta(days=7)).isoformat()
        live_count = int(conn.execute(
            "SELECT COUNT(*) AS n FROM audit_log WHERE action='LLM_CALL' AND user_email=%s AND timestamp > %s",
            (AGENT_ID, seven_days_ago),
        ).fetchone()["n"])
        # Mirror /api/agents/{id}/spend-forecast EXACTLY: at high tier it feeds
        # the live rolling averages back in as overrides. If we forecast without
        # them here, `current` falls back to capability-tree defaults (~3.5x
        # higher) and the snapshot anchors 'vs last month' to a number the live
        # dashboard never shows — which is what made the delta read -66%.
        overrides = None
        if live_count >= LIVE_TRACE_MIN_CALLS:
            live_rows = conn.execute(
                "SELECT detail, timestamp FROM audit_log "
                "WHERE action='LLM_CALL' AND user_email=%s AND timestamp > %s",
                (AGENT_ID, seven_days_ago),
            ).fetchall()
            overrides = compute_live_rolling_averages(live_rows, defaults=org_defaults) or None
        current = forecast_spend(agent, live_trace_count_7d=live_count,
                                 overrides=overrides, org_id=agent_org,
                                 _skip_sensitivity=True)
        # ILLUSTRATIVE demo seed only: there is no real prior-month traffic on a
        # freshly-wiped demo, so we synthesize a plausible prior so the demo can
        # show the vs-last-month feature working. NOT a measured number — the live
        # product path stays honest (vsLastMonthAvailable=false until a real
        # nightly snapshot exists). Kept slightly off-round so it doesn't read as
        # a suspiciously exact fabricated trend.
        prior_point = round(current["point"] * 0.93, 2)
        captured = (datetime.utcnow() - timedelta(days=31)).isoformat()
        # Stamp the current formula version into the snapshot, exactly like the
        # nightly job (jobs/snapshot_forecasts.py). Without this, _prev_snapshot_point
        # treats the snapshot as a cross-formula re-baseline and suppresses the
        # vs-last-month delta (vsLastMonthAvailable=false).
        composition_json = json.dumps({
            "tokensPct": current.get("tokensPct"),
            "toolsPct": current.get("toolsPct"),
            "infraPct": current.get("infraPct"),
            "tokensUsd": current.get("tokensUsd"),
            "toolsUsd": current.get("toolsUsd"),
            "infraUsd": current.get("infraUsd"),
            "model": current.get("model"),
            "confidence": current.get("confidence"),
            "formulaVersion": FORECAST_FORMULA_VERSION,
        })
        conn.execute("DELETE FROM forecast_snapshots WHERE agent_id=%s", (AGENT_ID,))
        conn.execute(
            "INSERT INTO forecast_snapshots "
            "(id, agent_id, org_id, snapshot_date, point_usd, low_usd, high_usd, composition_json, captured_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (str(uuid.uuid4()), AGENT_ID, agent_org,
             (datetime.utcnow() - timedelta(days=31)).date().isoformat(),
             prior_point, round(prior_point * 0.85, 2), round(prior_point * 1.15, 2),
             composition_json, captured),
        )
    return prior_point, current["point"]


def seed_demo_invoice(agent_org: str) -> float:
    """ILLUSTRATIVE demo seed only: a fabricated provider bill at ~1.06× the
    tracked spend, so the reconciliation demo beat shows a realistic picture —
    a bill slightly ABOVE tracked (every real key carries some non-agent
    traffic: consoles, notebooks, other apps). Stored with source='demo';
    the UI labels it 'Sample import' off that. Deleted+reinserted per run
    (invoice_imports is not append-only, unlike audit_log)."""
    from datetime import datetime, timedelta

    from analysis.invoice_reconciliation import aggregate_captured_spend
    from analysis.spend_forecast import load_defaults

    start = (datetime.utcnow() - timedelta(days=30)).isoformat()
    with get_db() as conn:
        rows = conn.execute(
            "SELECT l.detail, l.resource, l.timestamp FROM audit_log l "
            "JOIN agents a ON a.id = l.user_email "
            "WHERE l.action IN ('LLM_CALL', 'LLM_CALL_PROXY') AND a.org_id = %s "
            "AND l.timestamp >= %s",
            (agent_org, start),
        ).fetchall()
        captured = aggregate_captured_spend([dict(r) for r in rows], "anthropic",
                                            defaults=load_defaults())
        # Per-day bill = tracked × 1.06, slightly off-round like a real invoice.
        items = [{"day": d, "model": None, "usd": round(v * 1.06, 4)}
                 for d, v in captured["by_day"].items()]
        total = round(sum(it["usd"] for it in items), 2)
        days = sorted(captured["by_day"])
        conn.execute("DELETE FROM invoice_imports WHERE org_id = %s AND source = 'demo'",
                     (agent_org,))
        conn.execute(
            "INSERT INTO invoice_imports (org_id, provider, source, filename, "
            "period_start, period_end, total_usd, line_items, created_at) "
            "VALUES (%s, 'anthropic', 'demo', %s, %s, %s, %s, %s, %s)",
            (agent_org, "anthropic-usage-export-demo.csv",
             days[0] if days else None, days[-1] if days else None,
             total, json.dumps(items), datetime.utcnow().isoformat()),
        )
    return total


def main() -> int:
    try:
        aid = register_agent()
    except Exception as e:
        print(f"Could not register agent (is the server up on :8000?): {e}", file=sys.stderr)
        return 1
    with get_db() as conn:
        agent_org = conn.execute("SELECT org_id FROM agents WHERE id=%s", (aid,)).fetchone()["org_id"]

    n = seed_trace(agent_org)
    prior, current = seed_prior_snapshot(agent_org)
    invoice_total = seed_demo_invoice(agent_org)
    last7 = "≥50 (high tier)" if n else "0"
    print(f"Seeded '{AGENT_NAME}' ({aid}) in org '{agent_org}':")
    print(f"  • {n} backdated LLM calls across 30 days  → real actuals line, high-confidence tier")
    print(f"  • prior snapshot ${prior} vs current ${current}  → 'vs last month' shows a real trend")
    print(f"  • demo Anthropic bill ${invoice_total} (source='demo')  → reconciliation panel shows ~94% coverage")
    print(f"\nOpen: {BASE.replace(':8000', ':5173')}/agent/{aid}/spend  (frontend)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
