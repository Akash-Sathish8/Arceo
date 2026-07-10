"""Phase-4 PR-2: approve replays the held request EXACTLY ONCE.

The headline guarantees: approve → the real call fires once through the vault;
a double-approve does not double-fire; reject blocks with no call; the
ARCEO_REPLAY_ENABLED flag gates any external egress; two racing approvers can't
both release.
"""

from __future__ import annotations

import base64
import os
import uuid

import pytest

import vault

STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}
_TEST_MASTER_KEY = base64.b64encode(os.urandom(32)).decode()


@pytest.fixture(autouse=True)
def _master_key(monkeypatch):
    monkeypatch.setenv(vault.MASTER_KEY_ENV, _TEST_MASTER_KEY)


@pytest.fixture(autouse=True)
def _replay_on(monkeypatch):
    monkeypatch.setenv("ARCEO_REPLAY_ENABLED", "true")


class _CaptureClient:
    calls: list[dict] = []

    def __init__(self, *a, **k): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False

    async def request(self, method=None, url=None, headers=None, **k):
        _CaptureClient.calls.append({"method": method, "url": url, "headers": dict(headers or {})})

        class _Resp:
            status_code = 200
            content = b'{"ok": true}'
            headers = {"content-type": "application/json"}
        return _Resp()


@pytest.fixture()
def upstream(monkeypatch):
    import httpx
    _CaptureClient.calls = []
    monkeypatch.setattr(httpx, "AsyncClient", _CaptureClient)
    return _CaptureClient.calls


def _mint_key(client, headers):
    return client.post("/api/keys", headers=headers, json={"name": "k-" + uuid.uuid4().hex[:6]}).json()["key"]


def _setup(client, org, name):
    """Agent + REQUIRE_APPROVAL gate + a vaulted Stripe credential."""
    h = org["headers"]
    agent_id = client.post("/api/authority/agents", headers=h,
                           json={"name": name, "tools": [STRIPE_TOOL]}).json()["id"]
    client.post(f"/api/authority/agent/{agent_id}/policies", headers=h,
                json={"action_pattern": "stripe.create_refund", "effect": "REQUIRE_APPROVAL",
                      "reason": "sign-off", "priority": 10})
    r = client.put("/api/credentials/stripe", headers=h, json={"secret": "sk_live_VAULTED"})
    assert r.status_code == 200, r.text
    return agent_id, _mint_key(client, h)


def _hold(client, key, agent_id):
    """Make a proxy call that gets held; return the execution_id."""
    r = client.post("/proxy/stripe/v1/refunds",
                    headers={"X-API-Key": key, "X-Agent-ID": agent_id, "Authorization": "Bearer sk_agent_LEAK"},
                    json={"amount": 900})
    assert r.status_code == 200 and r.json()["pending_approval"] is True, r.text
    return r.json()["execution_id"]


def test_approve_replays_exactly_once_with_vaulted_secret(client, two_orgs, upstream):
    a = two_orgs["org_a"]
    agent_id, key = _setup(client, a, "replay-" + uuid.uuid4().hex[:6])
    exec_id = _hold(client, key, agent_id)
    assert len(upstream) == 0  # held, nothing forwarded yet

    r = client.post(f"/api/approvals/{exec_id}", headers=a["headers"], json={"decision": "approve"})
    assert r.status_code == 200, r.text
    assert r.json()["replay"]["status"] == "replayed"

    # Exactly one upstream call, with the VAULTED secret (never the agent's), plus idempotency.
    assert len(upstream) == 1
    hdrs = {k.lower(): v for k, v in upstream[0]["headers"].items()}
    assert hdrs["authorization"] == "Bearer sk_live_VAULTED"
    assert "sk_agent_LEAK" not in hdrs.get("authorization", "")
    assert hdrs.get("idempotency-key")


def test_double_approve_does_not_double_fire(client, two_orgs, upstream):
    a = two_orgs["org_a"]
    agent_id, key = _setup(client, a, "double-" + uuid.uuid4().hex[:6])
    exec_id = _hold(client, key, agent_id)

    assert client.post(f"/api/approvals/{exec_id}", headers=a["headers"], json={"decision": "approve"}).status_code == 200
    # Second approve is rejected (already decided) and does NOT replay again.
    r2 = client.post(f"/api/approvals/{exec_id}", headers=a["headers"], json={"decision": "approve"})
    assert r2.status_code == 400
    assert len(upstream) == 1  # still exactly one call


def test_reject_blocks_and_never_forwards(client, two_orgs, upstream):
    a = two_orgs["org_a"]
    agent_id, key = _setup(client, a, "reject-" + uuid.uuid4().hex[:6])
    exec_id = _hold(client, key, agent_id)
    r = client.post(f"/api/approvals/{exec_id}", headers=a["headers"], json={"decision": "reject"})
    assert r.status_code == 200 and r.json()["status"] == "BLOCKED"
    assert len(upstream) == 0


def test_flag_off_records_but_does_not_call(client, two_orgs, upstream, monkeypatch):
    monkeypatch.setenv("ARCEO_REPLAY_ENABLED", "false")
    a = two_orgs["org_a"]
    agent_id, key = _setup(client, a, "flagoff-" + uuid.uuid4().hex[:6])
    exec_id = _hold(client, key, agent_id)
    r = client.post(f"/api/approvals/{exec_id}", headers=a["headers"], json={"decision": "approve"})
    assert r.status_code == 200
    assert r.json()["replay"]["status"] == "skipped"
    assert len(upstream) == 0  # approved for the record, but no live call
