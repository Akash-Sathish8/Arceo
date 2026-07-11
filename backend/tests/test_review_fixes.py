"""Regression tests for the Phase 3-5 adversarial-review fixes.

- RBAC middleware must NOT block an agent (valid X-API-Key) even when a bearer
  JWT for a non-editor is also present (the SDK sends both).
- An approved action whose replay FAILS must leave an honest audit: the
  execution row must not say EXECUTED/ALLOW when nothing happened upstream.
"""

from __future__ import annotations

import base64
import os
import uuid

import pytest

import authority.enforcement as enf
import main as main_mod
import vault
from db import get_db

STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}
_TEST_MASTER_KEY = base64.b64encode(os.urandom(32)).decode()


@pytest.fixture(autouse=True)
def _master_key(monkeypatch):
    monkeypatch.setenv(vault.MASTER_KEY_ENV, _TEST_MASTER_KEY)


# ── RBAC: agent auth (API key) beats a stray bearer ───────────────────────────

def test_enforce_works_with_key_plus_viewer_bearer(client, roles):
    """An agent with BOTH a viewer JWT and a valid API key must still enforce —
    the key wins, the middleware must not 403 on the viewer role."""
    admin, viewer = roles["admin"], roles["viewer"]
    agent_id = client.post("/api/authority/agents", headers=admin["headers"],
                           json={"name": "rk-" + uuid.uuid4().hex[:6], "tools": [STRIPE_TOOL]}).json()["id"]
    key = client.post("/api/keys", headers=admin["headers"], json={"name": "k"}).json()["key"]

    # Send BOTH the viewer bearer and the API key (what the SDK does when both
    # env vars are set). Pre-fix this 403'd on the viewer role.
    r = client.post("/api/enforce",
                    headers={"X-API-Key": key, "Authorization": viewer["headers"]["Authorization"]},
                    json={"agent_id": agent_id, "tool": "stripe", "action": "create_refund"})
    assert r.status_code == 200, r.text
    assert r.json()["decision"] in ("ALLOW", "BLOCK", "REQUIRE_APPROVAL")


def test_viewer_bearer_alone_still_blocked_on_config(client, roles):
    # Sanity: without a key, a viewer is still 403 on a config mutation.
    viewer = roles["viewer"]
    r = client.post("/api/authority/agents", headers=viewer["headers"],
                    json={"name": "x", "tools": [STRIPE_TOOL]})
    assert r.status_code == 403


# ── replay-failure honesty ────────────────────────────────────────────────────

def _held(client, headers):
    agent_id = client.post("/api/authority/agents", headers=headers,
                           json={"name": "rf-" + uuid.uuid4().hex[:6], "tools": [STRIPE_TOOL]}).json()["id"]
    client.post(f"/api/authority/agent/{agent_id}/policies", headers=headers,
                json={"action_pattern": "stripe.create_refund", "effect": "REQUIRE_APPROVAL", "reason": "g", "priority": 10})
    client.put("/api/credentials/stripe", headers=headers, json={"secret": "sk_live_V"})
    key = client.post("/api/keys", headers=headers, json={"name": "k"}).json()["key"]
    r = client.post("/proxy/stripe/v1/refunds", headers={"X-API-Key": key, "X-Agent-ID": agent_id}, json={"amount": 1})
    return r.json()["execution_id"]


def test_failed_replay_is_not_recorded_as_executed(client, roles, monkeypatch):
    monkeypatch.setenv("ARCEO_REPLAY_ENABLED", "true")
    admin = roles["admin"]
    exec_id = _held(client, admin["headers"])

    # Make the upstream forward fail.
    def _boom(*a, **k):
        raise TimeoutError("upstream down")
    monkeypatch.setattr(main_mod, "_vault_forward", _boom)

    r = client.post(f"/api/approvals/{exec_id}", headers=admin["headers"], json={"decision": "approve"})
    assert r.status_code == 200
    assert r.json()["replay"]["status"] == "replay_failed"
    # The audit must NOT claim the action executed — it didn't.
    assert r.json()["status"] == "BLOCKED"
    with get_db() as conn:
        row = conn.execute("SELECT status, detail FROM execution_log WHERE id = %s", (exec_id,)).fetchone()
    assert row["status"] == "BLOCKED"
    assert "Replay replay_failed" in row["detail"]
    # The SDK status endpoint therefore reports BLOCK, not ALLOW, to a waiter.
    s = client.get(f"/api/enforce/status/{exec_id}", headers=admin["headers"])
    assert s.json()["decision"] == "BLOCK"


def test_successful_replay_records_executed(client, roles, monkeypatch, capsys):
    monkeypatch.setenv("ARCEO_REPLAY_ENABLED", "true")
    admin = roles["admin"]
    exec_id = _held(client, admin["headers"])

    import httpx
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda *a, **k: real(transport=httpx.MockTransport(lambda req: httpx.Response(200, json={"ok": 1})),
                                             timeout=k.get("timeout")))
    r = client.post(f"/api/approvals/{exec_id}", headers=admin["headers"], json={"decision": "approve"})
    assert r.json()["replay"]["status"] == "replayed" and r.json()["status"] == "EXECUTED"
    with get_db() as conn:
        assert conn.execute("SELECT status FROM execution_log WHERE id = %s", (exec_id,)).fetchone()["status"] == "EXECUTED"
