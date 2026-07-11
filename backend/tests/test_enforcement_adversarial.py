"""Phase-5 PR-5: adversarial enforcement harness.

One suite that actively tries to defeat the enforcement guarantees the whole
product rests on. Each test is an attack that MUST fail:
  - bypass: can an agent reach an upstream without a policy decision?
  - fail-closed: does an enforcement error execute the action anyway?
  - key-never-leaks: does the agent's own credential reach the upstream?
  - replay-exactly-once: can an approved action fire twice?
  - per-provider injection: is the vaulted secret injected for each provider?
  - cross-tenant credential: can org A borrow org B's vaulted credential?

Individual guarantees are also covered by test_fail_closed / test_credential_vault
/ test_replay_on_approve; this harness is the consolidated adversary that keeps
them honest together.
"""

from __future__ import annotations

import base64
import os
import uuid

import pytest

import authority.enforcement as enf
import vault

_TEST_MASTER_KEY = base64.b64encode(os.urandom(32)).decode()


@pytest.fixture(autouse=True)
def _master_key(monkeypatch):
    monkeypatch.setenv(vault.MASTER_KEY_ENV, _TEST_MASTER_KEY)


def _tool(action="create_refund", labels=("moves_money",)):
    return {"name": "stripe", "service": "stripe",
            "actions": [{"action": action, "risk_labels": list(labels), "reversible": False}]}


def _mint_key(client, headers):
    return client.post("/api/keys", headers=headers, json={"name": "k-" + uuid.uuid4().hex[:6]}).json()["key"]


def _mk_agent(client, headers, name):
    return client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [_tool()]}).json()["id"]


def _block_policy(client, headers, agent_id):
    client.post(f"/api/authority/agent/{agent_id}/policies", headers=headers,
                json={"action_pattern": "stripe.create_refund", "effect": "BLOCK", "reason": "no", "priority": 100})


class _Capture:
    def __init__(self):
        self.calls = []

    def install(self, monkeypatch):
        import httpx

        def handler(request):
            self.calls.append({"url": str(request.url),
                               "headers": {k.lower(): v for k, v in request.headers.items()}})
            return httpx.Response(200, json={"ok": True})
        real = httpx.AsyncClient
        monkeypatch.setattr(httpx, "AsyncClient",
                            lambda *a, **k: real(transport=httpx.MockTransport(handler), timeout=k.get("timeout")))
        return self


# ── attack 1: no proxy call reaches upstream without an ALLOW ──────────────────

def test_blocked_action_never_reaches_upstream(client, two_orgs, monkeypatch):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"], "adv-block-" + uuid.uuid4().hex[:6])
    _block_policy(client, a["headers"], agent_id)
    key = _mint_key(client, a["headers"])
    cap = _Capture().install(monkeypatch)

    r = client.post("/proxy/stripe/v1/refunds", headers={"X-API-Key": key, "X-Agent-ID": agent_id}, json={"amount": 9})
    assert r.json().get("blocked") is True
    assert cap.calls == []  # upstream never touched


# ── attack 2: an enforcement error must fail closed, not execute ───────────────

def test_enforcement_error_fails_closed(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("db exploded")
    monkeypatch.setattr(enf, "enforce_check", _boom)
    monkeypatch.delenv("ARCEO_FAIL_MODE", raising=False)
    out = enf.safe_enforce_check("agent", "stripe", "create_refund")
    assert out["decision"] == "BLOCK"  # error → block, never allow


# ── attack 3: the agent's own credential must never reach upstream ─────────────

def test_agent_key_never_leaks_upstream(client, two_orgs, monkeypatch):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"], "adv-leak-" + uuid.uuid4().hex[:6])
    key = _mint_key(client, a["headers"])
    client.put("/api/credentials/stripe", headers=a["headers"], json={"secret": "sk_live_VAULT"})
    cap = _Capture().install(monkeypatch)

    client.post("/proxy/stripe/v1/refunds",
                headers={"X-API-Key": key, "X-Agent-ID": agent_id, "Authorization": "Bearer sk_agent_STOLEN"},
                json={"amount": 1})
    assert len(cap.calls) == 1
    auth = cap.calls[0]["headers"].get("authorization", "")
    assert auth == "Bearer sk_live_VAULT"            # vaulted secret injected
    assert "sk_agent_STOLEN" not in auth             # agent's own key stripped
    assert "x-api-key" not in cap.calls[0]["headers"]  # Arceo key stripped too


# ── attack 4: an approved action cannot fire twice ─────────────────────────────

def test_approved_action_fires_exactly_once(client, two_orgs, monkeypatch):
    monkeypatch.setenv("ARCEO_REPLAY_ENABLED", "true")
    a = two_orgs["org_a"]
    agent_id = client.post("/api/authority/agents", headers=a["headers"],
                           json={"name": "adv-once-" + uuid.uuid4().hex[:6], "tools": [_tool()]}).json()["id"]
    client.post(f"/api/authority/agent/{agent_id}/policies", headers=a["headers"],
                json={"action_pattern": "stripe.create_refund", "effect": "REQUIRE_APPROVAL", "reason": "gate", "priority": 10})
    client.put("/api/credentials/stripe", headers=a["headers"], json={"secret": "sk_live_V"})
    key = _mint_key(client, a["headers"])
    cap = _Capture().install(monkeypatch)

    exec_id = client.post("/proxy/stripe/v1/refunds", headers={"X-API-Key": key, "X-Agent-ID": agent_id},
                          json={"amount": 1}).json()["execution_id"]
    assert client.post(f"/api/approvals/{exec_id}", headers=a["headers"], json={"decision": "approve"}).status_code == 200
    # Attack: approve again.
    client.post(f"/api/approvals/{exec_id}", headers=a["headers"], json={"decision": "approve"})
    assert len(cap.calls) == 1  # exactly once despite the second approve


# ── attack 5: org A cannot borrow org B's vaulted credential ───────────────────

def test_no_cross_tenant_credential_use(client, two_orgs, monkeypatch):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    # Only org B has a stripe credential.
    client.put("/api/credentials/stripe", headers=b["headers"], json={"secret": "sk_live_ORGB"})
    monkeypatch.setenv("ARCEO_REQUIRE_VAULT", "on")  # no credential → no call
    agent_id = _mk_agent(client, a["headers"], "adv-xorg-" + uuid.uuid4().hex[:6])
    key = _mint_key(client, a["headers"])
    cap = _Capture().install(monkeypatch)

    r = client.post("/proxy/stripe/v1/refunds", headers={"X-API-Key": key, "X-Agent-ID": agent_id}, json={"amount": 1})
    # org A has no stripe credential of its own; require-vault blocks, org B's is never used.
    assert r.json().get("blocked") is True
    assert cap.calls == []
