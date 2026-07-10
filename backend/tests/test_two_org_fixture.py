"""Smoke tests for the shared client/two_orgs fixtures (Phase 1, A2a).

The real consumer is the pre-migration behavioral baseline; these pin the
fixture contract early so it can't rot before that suite lands.
"""

from __future__ import annotations

STRIPE_TOOL = {
    "name": "stripe", "service": "stripe",
    "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}],
}


def test_two_orgs_are_distinct_tenants(two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    assert a["org_id"] and b["org_id"]
    assert a["org_id"] != b["org_id"]
    assert a["token"] != b["token"]


def test_cross_org_agent_is_invisible(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    r = client.post("/api/authority/agents", headers=a["headers"],
                    json={"name": "org-a-private-agent", "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text
    agent_id = r.json()["agent"]["id"] if "agent" in r.json() else r.json().get("id")
    assert agent_id, f"unexpected create-agent shape: {r.json()}"

    # Org B must get a 404 (not 403 — existence itself is tenant data).
    r_b = client.get(f"/api/authority/agent/{agent_id}", headers=b["headers"])
    assert r_b.status_code == 404, f"cross-tenant read returned {r_b.status_code}: {r_b.text[:200]}"

    # And it must not appear in org B's list.
    listing = client.get("/api/authority/agents", headers=b["headers"]).json()
    agents = listing["agents"] if isinstance(listing, dict) and "agents" in listing else listing
    assert all(ag.get("id") != agent_id for ag in agents)
