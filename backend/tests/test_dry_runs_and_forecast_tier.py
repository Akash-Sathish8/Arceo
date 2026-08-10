"""Dry-run simulations must not promote the spend forecast's confidence tier.

The cost path selected completed simulations with no run_mode filter, while the
risk path has always filtered on run_mode = 'live' (_latest_sim_evidence, and
see test_evidence_integrity.py). That asymmetry mattered because a dry run is
not a weaker measurement — it is no measurement at all:

  run_simulation_dry never appends turn_usage (only the live path does), so
  compute_sandbox_averages returns {} and every forecast input stays a YAML
  default. But the row still lands with status = 'completed', so it matched the
  query, and _detect_tier promotes on row COUNT alone.

Net effect: one dry sandbox run moved an agent from LOW (band x0.50-x3.00) to
MEDIUM (x0.70-x2.00) on zero evidence — a tighter number presented to a CFO
because someone clicked the default-selected 'dry' option in the Sandbox.
"""

from __future__ import annotations

import json
import uuid

import pytest

STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"action": "create_refund", "risk_labels": ["moves_money"],
                            "reversible": False}]}


def _make_agent(client, headers) -> str:
    """An agent with declared volume, so the forecast is always `available` and
    the assertion is about the TIER, not about the empty state."""
    r = client.post("/api/authority/agents", headers=headers,
                    json={"name": "dry-tier-" + uuid.uuid4().hex[:6],
                          "tools": [STRIPE_TOOL],
                          "simulation_model": "claude-sonnet-4-6",
                          "expected_calls_per_day": 100})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _insert_sim(agent_id: str, org_id: str, run_mode: str) -> None:
    """A completed simulation in the given run_mode. The trace carries no
    turn_usage — exactly what run_simulation_dry produces, and the reason a dry
    row cannot inform any forecast input."""
    from db import get_db

    with get_db() as conn:
        conn.execute(
            "INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, "
            "report_json, org_id, created_at, run_mode) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (uuid.uuid4().hex[:12], agent_id, "scenario-1", "completed",
             json.dumps({"prompt": "normal run", "steps": []}),
             json.dumps({"risk_score": 10, "violations": [], "chains_triggered": []}),
             org_id, "2026-08-01", run_mode),
        )


@pytest.fixture()
def org(two_orgs):
    return two_orgs["org_a"]


def test_dry_only_agent_is_not_promoted_to_medium(client, org):
    agent_id = _make_agent(client, org["headers"])
    _insert_sim(agent_id, org["org_id"], "dry")

    f = client.get(f"/api/agents/{agent_id}/spend-forecast", headers=org["headers"])
    assert f.status_code == 200, f.text
    assert f.json()["confidence"] == "low"


def test_live_sandbox_run_still_promotes_to_medium(client, org):
    """The other half: this must not become a blanket 'ignore sandbox traces'."""
    agent_id = _make_agent(client, org["headers"])
    _insert_sim(agent_id, org["org_id"], "live")

    f = client.get(f"/api/agents/{agent_id}/spend-forecast", headers=org["headers"])
    assert f.status_code == 200, f.text
    assert f.json()["confidence"] == "medium"


def test_dry_runs_are_not_counted_as_measured_sources(client, org):
    """The data-sources panel reports what we measured. A dry run measured
    nothing, so counting it there overstates the evidence to the same reader."""
    agent_id = _make_agent(client, org["headers"])
    _insert_sim(agent_id, org["org_id"], "dry")
    _insert_sim(agent_id, org["org_id"], "dry")
    _insert_sim(agent_id, org["org_id"], "live")

    f = client.get(f"/api/agents/{agent_id}/spend-forecast",
                   headers=org["headers"]).json()
    sandbox = [s for s in (f.get("dataSources") or [])
               if "sandbox" in s["label"].lower() or "simulation" in s["label"].lower()]
    assert sandbox, f"no sandbox row in dataSources: {f.get('dataSources')}"
    # Three completed rows, one of them real.
    assert "1" in sandbox[0]["status"], sandbox[0]


def test_fleet_forecast_agrees_with_the_per_agent_one(client, org):
    """Both endpoints run their own query. They disagreed before the fix only
    if you looked, which is how this survived — pin them together."""
    agent_id = _make_agent(client, org["headers"])
    _insert_sim(agent_id, org["org_id"], "dry")

    single = client.get(f"/api/agents/{agent_id}/spend-forecast",
                        headers=org["headers"]).json()
    fleet = client.get("/api/agents/spend-forecasts", headers=org["headers"]).json()
    entry = (fleet.get("forecasts") or fleet).get(agent_id)
    assert entry is not None, fleet
    assert entry["confidence"] == single["confidence"] == "low"
