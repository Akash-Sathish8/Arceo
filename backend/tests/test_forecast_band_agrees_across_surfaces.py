"""One agent must not show two different confidence bands on one screen.

`forecast_spend` derives the confidence tier from its `sandbox_traces` argument
(`_detect_tier`), and the band multipliers follow the tier. Three endpoints call
it; the timeseries one did not pass the argument.

That is not a missing forecast input — it is a silent DEMOTION. An agent with
live sandbox runs and under 50 captured calls resolved to MEDIUM (x0.70-x2.00)
on the card and LOW (x0.50-x3.00) on the chart beneath it, and the Cost Portfolio
renders both at once. The CFO-facing surface contradicted itself, and the wider
of the two bands was the one drawn as a projection.

The fix routes all three callers through `_sandbox_traces_for_tier`, so the
question "which traces count toward the tier" is answered in one place. These
tests pin the invariant at the API boundary rather than the helper, because the
defect was never in the tier logic — it was in a caller forgetting to ask.
"""

from __future__ import annotations

import json
import uuid

import pytest

STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"action": "create_refund", "risk_labels": ["moves_money"],
                            "reversible": False}]}


def _make_agent(client, headers) -> str:
    """Declared volume, so the forecast is always `available` and the assertion
    is about the BAND rather than about an empty state."""
    r = client.post("/api/authority/agents", headers=headers,
                    json={"name": "band-" + uuid.uuid4().hex[:6],
                          "tools": [STRIPE_TOOL],
                          "simulation_model": "claude-sonnet-4-6",
                          "expected_calls_per_day": 100})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _insert_live_sim(agent_id: str, org_id: str, created_at: str = "2026-08-01") -> None:
    """A completed LIVE sandbox run — the thing that promotes LOW to MEDIUM."""
    from db import get_db

    with get_db() as conn:
        conn.execute(
            "INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, "
            "report_json, org_id, created_at, run_mode) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (uuid.uuid4().hex[:12], agent_id, "scenario-1", "completed",
             json.dumps({"prompt": "normal run", "steps": []}),
             json.dumps({"risk_score": 10, "violations": [], "chains_triggered": []}),
             org_id, created_at, "live"),
        )


@pytest.fixture()
def org(two_orgs):
    return two_orgs["org_a"]


def _card(client, headers, agent_id) -> dict:
    r = client.get(f"/api/agents/{agent_id}/spend-forecast", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _chart(client, headers, agent_id) -> dict:
    r = client.get(f"/api/agents/{agent_id}/spend-timeseries", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


# ── The regression ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("with_sim", [False, True], ids=["no-sandbox", "with-sandbox"])
def test_chart_band_equals_card_band(client, org, with_sim):
    """Both directions. The no-sandbox case guards against "fix" attempts that
    hardcode MEDIUM; the with-sandbox case is the actual defect."""
    agent_id = _make_agent(client, org["headers"])
    if with_sim:
        _insert_live_sim(agent_id, org["org_id"])

    card = _card(client, org["headers"], agent_id)
    chart = _chart(client, org["headers"], agent_id)

    assert card["confidence"] == ("medium" if with_sim else "low")
    proj = chart["projection"]
    assert proj is not None, "projection missing; the agent should have a forecast"

    # The endpoint publishes the card's monthly figures divided by 30.
    assert proj["dailyPoint"] == pytest.approx(round(card["point"] / 30.0, 2))
    assert proj["dailyLow"] == pytest.approx(round(card["low"] / 30.0, 2))
    assert proj["dailyHigh"] == pytest.approx(round(card["high"] / 30.0, 2))


def test_the_band_actually_narrows_when_a_sandbox_run_lands(client, org):
    """Stops the test above from passing vacuously. If the two surfaces agreed
    because BOTH were stuck at LOW, the assertions would still hold — so pin
    that a live sandbox run visibly tightens the chart's own band."""
    agent_id = _make_agent(client, org["headers"])
    before = _chart(client, org["headers"], agent_id)["projection"]

    _insert_live_sim(agent_id, org["org_id"])
    after = _chart(client, org["headers"], agent_id)["projection"]

    def spread(p):
        return p["dailyHigh"] / p["dailyLow"]

    assert spread(before) > spread(after), (
        f"chart band did not narrow after a live sandbox run: "
        f"{spread(before):.2f}x -> {spread(after):.2f}x — the timeseries endpoint "
        "is ignoring sandbox traces again"
    )


def test_a_dry_run_does_not_narrow_the_chart_band(client, org):
    """The tier rules the chart inherits must be the SAME rules, not merely
    consistent ones. A dry run records no turn_usage, so it is no measurement at
    all — it must not tighten the band on either surface."""
    from db import get_db

    agent_id = _make_agent(client, org["headers"])
    before = _chart(client, org["headers"], agent_id)["projection"]

    with get_db() as conn:
        conn.execute(
            "INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, "
            "report_json, org_id, created_at, run_mode) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (uuid.uuid4().hex[:12], agent_id, "scenario-1", "completed",
             json.dumps({"prompt": "dry run", "steps": []}),
             json.dumps({"risk_score": 10, "violations": [], "chains_triggered": []}),
             org["org_id"], "2026-08-01", "dry"),
        )

    after = _chart(client, org["headers"], agent_id)["projection"]
    assert after["dailyLow"] == before["dailyLow"]
    assert after["dailyHigh"] == before["dailyHigh"]


def test_another_orgs_sandbox_run_cannot_narrow_your_band(client, two_orgs):
    """The helper carries the org filter now. If a future edit drops it, a
    tenant's band would be tightened by a stranger's simulation — a cross-org
    leak that shows up as a number, not as leaked data, so nothing else would
    catch it."""
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    agent_id = _make_agent(client, a["headers"])
    before = _chart(client, a["headers"], agent_id)["projection"]

    # Same agent_id, other org's id on the row.
    _insert_live_sim(agent_id, b["org_id"])

    after = _chart(client, a["headers"], agent_id)["projection"]
    assert after["dailyLow"] == before["dailyLow"]
    assert after["dailyHigh"] == before["dailyHigh"]
