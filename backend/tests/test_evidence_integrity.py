"""Phase-1 B3: dry-run simulations are never behavioral evidence.

simulations.run_mode ('dry' | 'live') gates everything that feeds uplift,
confidence, and "Demonstrated" badges: _latest_sim_evidence reads live rows
only; a dry-only agent is flagged dry_run_only so the UI can say "static
analysis only" instead of "Confirmed by simulation". The migration backfills
historic rows off the '[STATIC ANALYSIS]' marker only run_simulation_dry
writes.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

from db import get_db
import main as main_mod

RISKY_REPORT = {
    "risk_score": 85,
    "violations": [{"title": "moves money unsupervised", "severity": "critical"}],
    "chains_triggered": [{"chain_id": "pii-exfil", "data_linked": True}],
}
CLEAN_REPORT = {"risk_score": 5, "violations": [], "chains_triggered": []}


def _insert_sim(agent_id: str, run_mode: str, report: dict, created_at: str,
                trace_prompt: str = "normal run", org_id: str = "default"):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, report_json, org_id, created_at, run_mode) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (uuid.uuid4().hex[:12], agent_id, "test-scenario", "completed",
             json.dumps({"prompt": trace_prompt}), json.dumps(report), org_id, created_at, run_mode),
        )


def _evidence(agent_id: str):
    with get_db() as conn:
        return main_mod._latest_sim_evidence(conn, agent_id)


def _ts(minutes_ago: int) -> str:
    return (datetime.utcnow() - timedelta(minutes=minutes_ago)).isoformat()


def test_dry_run_after_live_run_does_not_replace_evidence():
    agent = f"evi-{uuid.uuid4().hex[:8]}"
    _insert_sim(agent, "live", CLEAN_REPORT, _ts(60))
    _insert_sim(agent, "dry", RISKY_REPORT, _ts(1), trace_prompt="[STATIC ANALYSIS] x")

    ev = _evidence(agent)
    assert ev["ran"] is True
    # The newer dry run's risk-85/confirmed-chain report must NOT be the evidence.
    assert ev["risk_score"] == 5
    assert ev["confirmed_chain"] is False
    assert ev["demonstrated_chains"] == {}


def test_dry_only_agent_reports_dry_run_only_not_evidence():
    agent = f"evi-{uuid.uuid4().hex[:8]}"
    _insert_sim(agent, "dry", RISKY_REPORT, _ts(1), trace_prompt="[STATIC ANALYSIS] x")

    ev = _evidence(agent)
    assert ev == {"ran": False, "dry_run_only": True}


def test_never_simulated_agent_returns_none():
    assert _evidence(f"evi-{uuid.uuid4().hex[:8]}") is None


def test_live_run_is_evidence():
    agent = f"evi-{uuid.uuid4().hex[:8]}"
    _insert_sim(agent, "live", RISKY_REPORT, _ts(1))
    ev = _evidence(agent)
    assert ev["ran"] is True and ev["confirmed_chain"] is True
    assert ev["demonstrated_chains"] == {"pii-exfil": True}


def test_evidence_grade_gates_high_confidence_behind_live():
    from authority.graph import _evidence_grade

    conf, uplift, ev = _evidence_grade({"ran": False, "dry_run_only": True})
    assert conf == "low" and uplift == 0.0
    assert ev == {"hasSim": False, "dryRunOnly": True}

    conf, uplift, ev = _evidence_grade(
        {"ran": True, "risk_score": 85, "has_violation": True,
         "confirmed_chain": True, "demonstrated_chains": {"c": True}})
    assert conf == "high" and uplift > 0


# test_backfill_tags_static_analysis_rows_as_dry was removed in the Postgres
# cutover: it simulated a pre-migration SQLite DB (DROP COLUMN run_mode, then
# re-run init_db's defensive PRAGMA/ALTER migration + backfill). That defensive
# path was deleted — Alembic owns all schema and 0001_baseline includes
# run_mode from birth, so the pre-migration state is unreachable on Postgres.
# The behavior it protected (dry rows are never evidence) stays covered by the
# tests above; the schema-level guarantee it relied on is covered below.


def test_fresh_schema_defaults_run_mode_to_live():
    """Alembic 0001 bakes run_mode in from birth: a row inserted without it
    must land as 'live' (NOT NULL DEFAULT), keeping the evidence gate's
    live-only filter meaningful without any backfill machinery."""
    agent = f"evi-{uuid.uuid4().hex[:8]}"
    with get_db() as conn:
        conn.execute(
            "INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, report_json, org_id, created_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (uuid.uuid4().hex[:12], agent, "s", "completed",
             json.dumps({"prompt": "real run"}), json.dumps(CLEAN_REPORT), "default", _ts(1)),
        )
        mode = conn.execute(
            "SELECT run_mode FROM simulations WHERE agent_id = %s", (agent,)
        ).fetchone()["run_mode"]
    assert mode == "live"
