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
from db import get_db, get_all_agents_from_db, current_org


def _load_sandbox_traces(conn, agent_id: str, org_id: str) -> list:
    """Most recent 10 completed sandbox traces for the agent."""
    rows = conn.execute(
        "SELECT trace_json FROM simulations "
        "WHERE agent_id = %s AND status = 'completed' AND org_id = %s "
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
        "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('LLM_CALL', 'LLM_CALL_PROXY') "
        "AND user_email = %s AND timestamp > %s",
        (agent_id, seven_days_ago),
    ).fetchone()
    # Positional indexing here (`row[0]`) raised KeyError: 0 under psycopg3's
    # dict_row factory, which every connection uses. The whole per-agent body is
    # wrapped in `except Exception: failed += 1`, so the job had been failing on
    # EVERY agent and writing zero snapshots since the Postgres migration — quietly,
    # because nothing polls its exit code. Found while restructuring for LOW-015;
    # not a security finding, but it silently emptied the table that feeds the
    # vs-last-time delta.
    return int(row["n"]) if row else 0


def snapshot_all_agents() -> dict:
    """Snapshot every agent across every org. Returns a summary dict."""
    now = datetime.utcnow()
    snapshot_date = now.date().isoformat()
    captured_at = now.isoformat()

    written = 0
    skipped = 0
    failed = 0

    # LOW-015: this used to be ONE transaction wrapping the whole fleet, run at
    # the scheduler's default 'system' RLS context. Two problems. A pooled
    # connection was held open for as long as the slowest agent's forecast took,
    # across every tenant — on a real fleet that is a long-lived transaction
    # blocking vacuum and holding a pool slot the request path needs. And the RLS
    # backstop was inert for the one job that touches every tenant's rows: the
    # queries are explicitly org-scoped in SQL, so nothing leaked, but the
    # defence-in-depth layer was doing nothing precisely where it would matter
    # most.
    #
    # Now: one short read to list the fleet, then a separate transaction PER ORG
    # with current_org set to that tenant, so each org's writes are checked by RLS
    # as if a member of that org had made them.
    with get_db() as conn:
        all_agents = get_all_agents_from_db(conn)

    by_org: dict[str, list] = {}
    for agent in all_agents:
        if not agent:
            skipped += 1
            continue
        by_org.setdefault(agent.get("org_id") or "default", []).append(agent)

    for org_id_ctx, agents in by_org.items():
        token = current_org.set(org_id_ctx)
        try:
            w, sk, f = _snapshot_one_org(agents, snapshot_date, captured_at)
            written += w
            skipped += sk
            failed += f
        finally:
            current_org.reset(token)

    return {"snapshot_date": snapshot_date, "written": written, "skipped": skipped, "failed": failed}


def _snapshot_one_org(agents: list, snapshot_date: str, captured_at: str) -> tuple[int, int, int]:
    """Snapshot one org's agents in its own transaction, at its own RLS context."""
    written = skipped = failed = 0
    with get_db() as conn:
        for agent in agents:
            # (falsy rows are filtered by the caller before grouping)
            agent_id = agent["id"]
            org_id = agent.get("org_id") or "default"
            # Idempotent per day — safe to re-run (and lets the in-process
            # scheduler poll without duplicating rows).
            already = conn.execute(
                "SELECT 1 FROM forecast_snapshots WHERE agent_id = %s AND org_id = %s AND snapshot_date = %s LIMIT 1",
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
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
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
    return written, skipped, failed


def main() -> int:
    result = snapshot_all_agents()
    print(
        f"forecast_snapshots {result['snapshot_date']}: "
        f"written={result['written']} skipped={result['skipped']} failed={result['failed']}"
    )
    return 0 if result["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
