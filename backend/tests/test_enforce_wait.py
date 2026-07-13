"""Phase-4 PR-3: 'wait right there' — the status endpoint + SDK enforce_and_wait.

A held action's status endpoint flips PENDING → ALLOW/BLOCK when a human
decides; the SDK helper loops on it so the agent's code just blocks until the
answer comes.
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from arceo import _enforce as sdk_enforce  # noqa: E402

STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}


def _agent_with_gate(client, headers, name):
    agent_id = client.post("/api/authority/agents", headers=headers,
                           json={"name": name, "tools": [STRIPE_TOOL]}).json()["id"]
    client.post(f"/api/authority/agent/{agent_id}/policies", headers=headers,
                json={"action_pattern": "stripe.create_refund", "effect": "REQUIRE_APPROVAL",
                      "reason": "sign-off", "priority": 10})
    return agent_id


def _hold(client, headers, agent_id):
    r = client.post("/api/enforce", headers=headers,
                    json={"agent_id": agent_id, "tool": "stripe", "action": "create_refund"})
    assert r.json()["decision"] == "REQUIRE_APPROVAL"
    return r.json()["execution_id"]


def test_status_endpoint_reflects_decision(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _agent_with_gate(client, a["headers"], "wait-" + uuid.uuid4().hex[:6])
    exec_id = _hold(client, a["headers"], agent_id)

    r = client.get(f"/api/enforce/status/{exec_id}", headers=a["headers"])
    assert r.status_code == 200 and r.json()["decision"] == "PENDING"

    client.post(f"/api/approvals/{exec_id}", headers=a["headers"], json={"decision": "approve"})
    assert client.get(f"/api/enforce/status/{exec_id}", headers=a["headers"]).json()["decision"] == "ALLOW"


def test_status_reflects_rejection(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _agent_with_gate(client, a["headers"], "wait-rej-" + uuid.uuid4().hex[:6])
    exec_id = _hold(client, a["headers"], agent_id)
    client.post(f"/api/approvals/{exec_id}", headers=a["headers"], json={"decision": "reject"})
    assert client.get(f"/api/enforce/status/{exec_id}", headers=a["headers"]).json()["decision"] == "BLOCK"


def test_status_is_org_scoped(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    agent_id = _agent_with_gate(client, a["headers"], "wait-iso-" + uuid.uuid4().hex[:6])
    exec_id = _hold(client, a["headers"], agent_id)
    # org B can't peek at org A's held action.
    assert client.get(f"/api/enforce/status/{exec_id}", headers=b["headers"]).status_code == 404


def test_sdk_enforce_and_wait_unblocks_on_approve(client, two_orgs, monkeypatch):
    """The SDK helper loops the status endpoint until a decision; drive its
    HTTP + sleep against the TestClient and approve mid-wait."""
    a = two_orgs["org_a"]
    agent_id = _agent_with_gate(client, a["headers"], "sdk-wait-" + uuid.uuid4().hex[:6])
    token = a["headers"]["Authorization"].split(" ", 1)[1]

    # First enforce call → REQUIRE_APPROVAL (records the held row).
    exec_id = _hold(client, a["headers"], agent_id)

    # Route the SDK's urllib calls through the in-process TestClient, and make
    # its sleep approve the pending item on the first tick so the loop resolves.
    approved = {"done": False}

    class _FakeResp:
        def __init__(self, data): self._data = data
        def read(self): import json; return json.dumps(self._data).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout=None):
        # status poll
        return _FakeResp({"execution_id": exec_id, "decision": "ALLOW" if approved["done"] else "PENDING"})

    def fake_sleep(_):
        if not approved["done"]:
            client.post(f"/api/approvals/{exec_id}", headers=a["headers"], json={"decision": "approve"})
            approved["done"] = True

    monkeypatch.setattr(sdk_enforce.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(sdk_enforce, "enforce", lambda *a, **k: {"decision": "REQUIRE_APPROVAL", "execution_id": exec_id})
    import time as _t
    monkeypatch.setattr(_t, "sleep", fake_sleep)

    out = sdk_enforce.enforce_and_wait(agent_id, "stripe", "create_refund", token=token, poll_interval=0.01)
    assert out["decision"] == "ALLOW"
