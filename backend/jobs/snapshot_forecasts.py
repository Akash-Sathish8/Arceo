"""Nightly snapshot of every agent's spend forecast.

Writes one row per agent per day into `forecast_snapshots` (idempotent —
an agent already snapshotted today is skipped, so re-runs are safe). The
forecast endpoint reads the snapshot from ~30 days ago to compute
`vsLastMonth`.

The backend runs this automatically via an in-process daily scheduler
(see main.py startup). Manual run / external cron still work:
    cd arceo/backend && python3 -m jobs.snapshot_forecasts
    0 2 * * * cd /path/to/arceo/backend && python3 -m jobs.snapshot_forecasts
"""

from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timedelta

from analysis.spend_forecast import forecast_spend
from db import get_db, get_all_agents_from_db


def _load_sandbox_traces(conn, agent_id: str, org_id: str) -> list:
    """Most recent 10 completed sandbox traces for the agent."""
    rows = conn.execute(
        "SELECT trace_json FROM simulations "
        "WHERE agent_id = ? AND status = 'completed' AND org_id = ? "
        "ORDER BY created_at DESC LIMIT 10",
        (agent_id, org_id),
    ).fetchall()
    traces = []
    for r in rows:
        try:
            if r["trace_json"]:
                traces.append(json.loads(r["trace_json"]))
        except (json.JSONDecodeError, TypeError):
            continue
    return traces


def _live_trace_count_7d(conn, agent_id: str) -> int:
    # LLM_CALL / LLM_CALL_PROXY store the agent id in user_email (resource =
    # provider:model). Both capture paths (SDK wrap_llm + transparent proxy) count.
    seven_days_ago = (datetime.utcnow() - timedelta(days=7)).isoformat()
    row = conn.execute(
        "SELECT COUNT(*) FROM audit_log WHERE action IN ('LLM_CALL', 'LLM_CALL_PROXY') AND user_email = ? AND timestamp > ?",
        (agent_id, seven_days_ago),
    ).fetchone()
    return int(row[0]) if row else 0


def snapshot_all_agents() -> dict:
    """Snapshot every agent across every org. Returns a summary dict."""
    now = datetime.utcnow()
    snapshot_date = now.date().isoformat()
    captured_at = now.isoformat()

    written = 0
    skipped = 0
    failed = 0

    with get_db() as conn:
        agents = get_all_agents_from_db(conn)
        for agent in agents:
            if not agent:
                skipped += 1
                continue
            agent_id = agent["id"]
            org_id = agent.get("org_id") or "default"
            # Idempotent per day — safe to re-run (and lets the in-process
            # scheduler poll without duplicating rows).
            already = conn.execute(
                "SELECT 1 FROM forecast_snapshots WHERE agent_id = ? AND org_id = ? AND snapshot_date = ? LIMIT 1",
                (agent_id, org_id, snapshot_date),
            ).fetchone()
            if already:
                skipped += 1
                continue
            try:
                sandbox_traces = _load_sandbox_traces(conn, agent_id, org_id)
                live_count = _live_trace_count_7d(conn, agent_id)
                forecast = forecast_spend(
                    agent,
                    sandbox_traces=sandbox_traces or None,
                    live_trace_count_7d=live_count,
                    org_id=org_id,
                    _skip_sensitivity=True,
                )
                if not forecast.get("available", True):
                    # No real data → no forecast → don't persist a fabricated snapshot.
                    skipped += 1
                    continue
                from analysis.spend_forecast import FORECAST_FORMULA_VERSION
                composition = {
                    "tokensPct": forecast.get("tokensPct"),
                    "toolsPct": forecast.get("toolsPct"),
                    "infraPct": forecast.get("infraPct"),
                    "tokensUsd": forecast.get("tokensUsd"),
                    "toolsUsd": forecast.get("toolsUsd"),
                    "infraUsd": forecast.get("infraUsd"),
                    "model": forecast.get("model"),
                    "confidence": forecast.get("confidence"),
                    # Stamp the formula version so the vs-last-month delta can be
                    # suppressed when comparing across a formula re-baseline.
                    "formulaVersion": FORECAST_FORMULA_VERSION,
                }
                conn.execute(
                    "INSERT INTO forecast_snapshots "
                    "(id, agent_id, org_id, snapshot_date, point_usd, low_usd, high_usd, composition_json, captured_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(uuid.uuid4()),
                        agent_id,
                        org_id,
                        snapshot_date,
                        float(forecast.get("point", 0)),
                        float(forecast.get("low", 0)),
                        float(forecast.get("high", 0)),
                        json.dumps(composition),
                        captured_at,
                    ),
                )
                written += 1
            except Exception as e:  # noqa: BLE001 — job must keep going past one bad agent
                print(f"  ✗ {agent_id}: {e}", file=sys.stderr)
                failed += 1

    return {"snapshot_date": snapshot_date, "written": written, "skipped": skipped, "failed": failed}


def main() -> int:
    result = snapshot_all_agents()
    print(
        f"forecast_snapshots {result['snapshot_date']}: "
        f"written={result['written']} skipped={result['skipped']} failed={result['failed']}"
    )
    return 0 if result["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
