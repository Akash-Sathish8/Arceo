"""Sandbox executor enforcement (2026-07-07, D32).

The executor used to reach enforcement over HTTP without credentials; when
/api/enforce gained auth (pilot-hardening), the 401 fell through as ALLOW and
every simulated action executed with policies silently ignored — fail-open in
every live sim, multi-agent sim, and red-team run. The executor now calls
enforce_check in-process (like the dry-run path always did) and fails CLOSED
on enforcement errors. It also passes params, so conditional policies fire in
simulations for the first time.
"""

from __future__ import annotations

import json

import db
from sandbox.agents.executor import execute_tool_call
from sandbox.mocks.registry import MockState

db.init_db()


def _seed_policy(agent_id, pattern, effect, priority, conditions="[]"):
    with db.get_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO agents (id, name, description, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (agent_id, agent_id, "test agent", db.DEFAULT_ORG_ID, "2026-07-07T00:00:00", "2026-07-07T00:00:00"),
        )
        conn.execute(
            "INSERT INTO policies (agent_id, action_pattern, effect, reason, conditions, priority, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (agent_id, pattern, effect, "test policy", conditions, priority, "test", "2026-07-07T00:00:00"),
        )


def test_block_policy_blocks_simulated_action():
    _seed_policy("sim-enf-block", "stripe.*", "BLOCK", 100)
    step = execute_tool_call(
        agent_id="sim-enf-block", tool="stripe", action="create_refund",
        params={"amount": 49}, state=MockState(), step_index=0,
    )
    assert step.enforce_decision == "BLOCK"
    assert step.result.get("blocked") is True


def test_no_policy_allows_and_executes_mock():
    step = execute_tool_call(
        agent_id="sim-enf-nopol", tool="stripe", action="get_customer",
        params={"customer_id": "cus_1"}, state=MockState(), step_index=0,
    )
    assert step.enforce_decision == "ALLOW"
    assert step.result and "blocked" not in step.result


def test_conditional_param_policy_fires_in_sims():
    conditions = json.dumps([{"field": "amount", "op": "gt", "value": 100}])
    _seed_policy("sim-enf-cond", "stripe.create_refund", "BLOCK", 100, conditions=conditions)
    over = execute_tool_call(
        agent_id="sim-enf-cond", tool="stripe", action="create_refund",
        params={"amount": 500}, state=MockState(), step_index=0,
    )
    under = execute_tool_call(
        agent_id="sim-enf-cond", tool="stripe", action="create_refund",
        params={"amount": 50}, state=MockState(), step_index=1,
    )
    assert over.enforce_decision == "BLOCK"
    assert under.enforce_decision == "ALLOW"


def test_sim_execution_rows_are_labeled_sandbox():
    """Simulation-originated executions must be distinguishable from live
    traffic — reviewers should never mistake a sandbox run for agent behavior."""
    _seed_policy("sim-enf-src", "stripe.*", "REQUIRE_APPROVAL", 50)
    execute_tool_call(
        agent_id="sim-enf-src", tool="stripe", action="create_refund",
        params={"amount": 10}, state=MockState(), step_index=0,
    )
    with db.get_db() as conn:
        row = conn.execute(
            "SELECT source FROM execution_log WHERE agent_id = 'sim-enf-src' ORDER BY id DESC LIMIT 1"
        ).fetchone()
    assert row["source"] == "sandbox"


def test_enforcement_failure_fails_closed(monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError("enforcement unavailable")

    monkeypatch.setattr("sandbox.agents.executor.enforce_check", boom)
    step = execute_tool_call(
        agent_id="sim-enf-err", tool="stripe", action="create_refund",
        params={"amount": 500}, state=MockState(), step_index=0,
    )
    assert step.enforce_decision == "ERROR"
    assert step.result.get("error") is True  # mock was NOT executed
