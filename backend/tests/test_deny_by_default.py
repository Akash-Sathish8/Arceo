"""Phase-1 B1: opt-in per-agent DENY-by-default, end-to-end through the API.

Contract: default_effect defaults to ALLOW (no agent goes dark on upgrade);
flipping it to DENY blocks any action no policy matches; explicit policies
still win; the PUT validates values and an omitted field never resets one.
"""

from __future__ import annotations

STRIPE_TOOL = {
    "name": "stripe", "service": "stripe",
    "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}],
}


def _mk_agent(client, headers, name):
    r = client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text
    body = r.json()
    return body["agent"]["id"] if "agent" in body else body["id"]


def _enforce(client, headers, agent_id, tool="stripe", action="create_refund"):
    r = client.post("/api/enforce", headers=headers,
                    json={"agent_id": agent_id, "tool": tool, "action": action})
    assert r.status_code == 200, r.text
    return r.json()


def test_default_effect_defaults_to_allow(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"], "deny-default-baseline")
    detail = client.get(f"/api/authority/agent/{agent_id}", headers=a["headers"]).json()
    assert detail["agent"]["default_effect"] == "ALLOW"
    assert _enforce(client, a["headers"], agent_id)["decision"] == "ALLOW"


def test_deny_by_default_blocks_unmatched(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"], "deny-default-on")
    r = client.put(f"/api/authority/agent/{agent_id}", headers=a["headers"],
                   json={"name": "deny-default-on", "default_effect": "DENY"})
    assert r.status_code == 200, r.text

    out = _enforce(client, a["headers"], agent_id)
    assert out["decision"] == "BLOCK"
    assert "deny-by-default" in out["message"]

    # An explicit ALLOW policy still wins over the DENY default.
    r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=a["headers"],
                    json={"action_pattern": "stripe.create_refund", "effect": "ALLOW",
                          "reason": "reviewed", "priority": 10})
    assert r.status_code == 200, r.text
    assert _enforce(client, a["headers"], agent_id)["decision"] == "ALLOW"
    # ...but an action with no policy stays blocked.
    assert _enforce(client, a["headers"], agent_id, action="delete_customer")["decision"] == "BLOCK"


def test_put_validates_and_omitted_field_preserves_value(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"], "deny-default-preserve")

    r = client.put(f"/api/authority/agent/{agent_id}", headers=a["headers"],
                   json={"name": "deny-default-preserve", "default_effect": "MAYBE"})
    assert r.status_code == 400

    client.put(f"/api/authority/agent/{agent_id}", headers=a["headers"],
               json={"name": "deny-default-preserve", "default_effect": "DENY"})
    # A rename-only PUT (no default_effect key) must not reset DENY.
    client.put(f"/api/authority/agent/{agent_id}", headers=a["headers"],
               json={"name": "renamed-agent"})
    detail = client.get(f"/api/authority/agent/{agent_id}", headers=a["headers"]).json()
    assert detail["agent"]["default_effect"] == "DENY"
