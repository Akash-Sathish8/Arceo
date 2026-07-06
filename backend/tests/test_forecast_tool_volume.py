"""Tool-call volume must be bounded per run (2026-07-06 accuracy pass).

A run can't invoke more distinct actions than it exposes, and a specific action
fires ~once per run — so a rare write among few actions in a deep loop must not
read as runs×turns/n calls (the '8,000 payouts/month' = 2.67/run bug).
"""

from __future__ import annotations

from analysis.spend_forecast import forecast_spend

DAYS = 30


def _agent(n_actions):
    actions = [{"action": f"act_{i}", "description": ""} for i in range(n_actions)]
    return {"id": "a", "name": "A", "simulation_model": "claude-haiku-4-5",
            "tools": [{"name": "t", "service": "t", "actions": actions}]}


def test_action_volume_bounded_to_one_per_run_when_actions_fewer_than_turns():
    runs, turns = 100, 8
    f = forecast_spend(_agent(3), overrides={"model": "claude-haiku-4-5",
                       "runs_per_day": runs, "turns_per_run": turns}, _skip_sensitivity=True)
    assert f["topTools"], "no tool projection"
    for t in f["topTools"]:
        per_run = t["callsPerMonth"] / (runs * DAYS)
        assert per_run <= 1.01, f"{t['tool']} fires {per_run:.2f}/run (bug: runs×turns/n)"


def test_declared_total_calls_forecast_is_unchanged():
    # turns=1 (bare declared calls/day = total) → the cap is identity; a 2-action
    # agent's per-action volume stays calls×days×(1/2).
    agent = {"id": "a", "name": "A", "simulation_model": "claude-sonnet-4-6",
             "expected_calls_per_day": 120,
             "tools": [{"name": "stripe", "service": "stripe", "actions": [
                 {"action": "create_charge", "description": ""},
                 {"action": "get_customer", "description": ""}]}]}
    f = forecast_spend(agent, overrides={"model": "claude-sonnet-4-6"}, _skip_sensitivity=True)
    for t in f["topTools"]:
        assert t["callsPerMonth"] == 120 * DAYS // 2  # 1800, unchanged by the cap
