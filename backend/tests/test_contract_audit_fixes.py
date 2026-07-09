"""Regression tests for the 2026-07-09 frontend/backend contract audit fixes.

1. A metadata-only agent update (rename/description — what the AgentDetail
   edit form sends) must NOT wipe the agent's tools. AgentInput.tools
   defaulted to [] and update_agent unconditionally deleted + re-inserted,
   so every rename destroyed the tool set.
2. A requires_prior policy condition has no param field — a required
   ConditionInput.field 422'd every such policy before the handler ran.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main  # noqa: E402

STRIPE_TOOL = {
    "name": "stripe", "service": "stripe",
    "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}],
}


@pytest.fixture()
def client():
    with TestClient(main.app) as c:
        yield c


def _auth(client, email):
    client.post("/api/auth/signup", json={"email": email, "password": "pw12345678", "name": "T"})
    r = client.post("/api/auth/login", json={"email": email, "password": "pw12345678"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_rename_only_update_preserves_tools(client):
    h = _auth(client, "renamer@example.com")
    r = client.post("/api/authority/agents", headers=h, json={"name": "keep-tools", "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text
    agent_id = r.json()["id"]

    r = client.put(f"/api/authority/agent/{agent_id}", headers=h,
                   json={"name": "renamed", "description": "new desc"})
    assert r.status_code == 200, r.text

    detail = client.get(f"/api/authority/agent/{agent_id}", headers=h).json()
    assert detail["agent"]["name"] == "renamed"
    tool_names = [t["name"] for t in detail["agent"]["tools"]]
    assert "stripe" in tool_names, "rename-only PUT wiped the agent's tools"


def test_explicit_tools_update_still_replaces(client):
    h = _auth(client, "retooler@example.com")
    r = client.post("/api/authority/agents", headers=h, json={"name": "swap-tools", "tools": [STRIPE_TOOL]})
    agent_id = r.json()["id"]

    new_tool = {"name": "zendesk", "service": "zendesk",
                "actions": [{"action": "get_ticket", "risk_labels": [], "reversible": True}]}
    r = client.put(f"/api/authority/agent/{agent_id}", headers=h,
                   json={"name": "swap-tools", "tools": [new_tool]})
    assert r.status_code == 200, r.text

    detail = client.get(f"/api/authority/agent/{agent_id}", headers=h).json()
    tool_names = [t["name"] for t in detail["agent"]["tools"]]
    assert tool_names == ["zendesk"], "explicit tools update must replace the set"


def test_pending_approval_carries_params(client):
    """Reviewers must see WHAT they are approving — params flow from the
    enforce call through execution_log into the approvals queue."""
    h = _auth(client, "reviewer@example.com")
    r = client.post("/api/authority/agents", headers=h, json={"name": "param-agent", "tools": [STRIPE_TOOL]})
    agent_id = r.json()["id"]
    r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=h, json={
        "action_pattern": "stripe.create_refund", "effect": "REQUIRE_APPROVAL", "reason": "review refunds",
    })
    assert r.status_code == 200, r.text

    r = client.post("/api/enforce", headers=h, json={
        "agent_id": agent_id, "tool": "stripe", "action": "create_refund",
        "params": {"amount": 420, "customer": "cus_bob"},
    })
    assert r.status_code == 200, r.text
    assert r.json()["decision"] == "REQUIRE_APPROVAL"

    queue = client.get("/api/approvals", headers=h).json()["approvals"]
    mine = [a for a in queue if a["agent_id"] == agent_id]
    assert mine, "pending approval row missing"
    assert mine[0]["params"] == {"amount": 420, "customer": "cus_bob"}, \
        f"approval row lost its params: {mine[0].get('params')!r}"
    # Provenance: the API endpoint is real traffic, and the row must carry
    # the policy that paused it so the reviewer knows why it's in front of them.
    assert mine[0]["source"] == "runtime"
    assert mine[0]["policy"]["action_pattern"] == "stripe.create_refund"
    assert "review refunds" in (mine[0]["policy"]["reason"] or "")


def test_requires_prior_condition_is_accepted(client):
    h = _auth(client, "prior@example.com")
    r = client.post("/api/authority/agents", headers=h, json={"name": "prior-agent", "tools": [STRIPE_TOOL]})
    agent_id = r.json()["id"]

    r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=h, json={
        "action_pattern": "stripe.create_refund",
        "effect": "REQUIRE_APPROVAL",
        "reason": "refunds need a looked-up ticket first",
        "conditions": [{"op": "requires_prior", "value": "zendesk.get_ticket"}],
    })
    assert r.status_code == 200, f"requires_prior condition rejected: {r.status_code} {r.text}"
