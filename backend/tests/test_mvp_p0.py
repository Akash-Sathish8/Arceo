"""Regression tests for the two P0 MVP-readiness fixes (2026-07-06 sweep).

1. The `demo` magic-email reset must NOT run outside DEMO_MODE (it was an
   unauthenticated all-tenant DELETE).
2. A sandbox-applied BLOCK must get real priority so it wins over a broad ALLOW
   at enforcement (it was defaulting to priority 0 = fail-open).
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


# ── Fix #1: demo wipe gated behind DEMO_MODE ─────────────────────────────────

def test_demo_email_does_not_wipe_or_login_without_demo_mode(client, monkeypatch):
    monkeypatch.delenv("DEMO_MODE", raising=False)
    h = _auth(client, "keeper@example.com")
    r = client.post("/api/authority/agents", headers=h, json={"name": "keeper", "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text

    # Anonymous "demo" login must NOT succeed as admin and must NOT wipe.
    r = client.post("/api/auth/login", json={"email": "demo", "password": "x"})
    assert r.status_code != 200, "demo email logged in without DEMO_MODE — reset is reachable in prod"

    agents = client.get("/api/authority/agents", headers=h).json()["agents"]
    assert any(a["id"] == "keeper" for a in agents), "tenant data was wiped without DEMO_MODE"


def test_demo_email_resets_in_demo_mode(client, monkeypatch):
    monkeypatch.setenv("DEMO_MODE", "true")
    h = _auth(client, "demo-tenant@example.com")
    client.post("/api/authority/agents", headers=h, json={"name": "tobewiped", "tools": [STRIPE_TOOL]})

    # Trigger the demo reset. The admin re-login inside the endpoint may 401 when
    # the instance was NOT booted with DEMO_MODE (the seeded admin pw is random
    # then) — but the wipe runs first and commits, which is the branch we assert.
    client.post("/api/auth/login", json={"email": "demo", "password": "x"})

    agents = client.get("/api/authority/agents", headers=h).json()["agents"]
    assert agents == [], "demo reset did not clear agents in DEMO_MODE"


# ── Fix #2: applied BLOCK gets priority and wins over a broad ALLOW ───────────

def test_applied_block_beats_broad_allow(client):
    h = _auth(client, "policy@example.com")
    r = client.post("/api/authority/agents", headers=h, json={"name": "refunder", "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text
    agent_id = "refunder"

    # A broad ALLOW (priority 10 via create_policy).
    r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=h,
                    json={"action_pattern": "stripe.*", "effect": "ALLOW"})
    assert r.status_code == 200, r.text

    # Apply a recommended BLOCK via the sandbox path (the bug: priority defaulted to 0).
    r = client.post("/api/sandbox/apply-policy", headers=h,
                    json={"agent_id": agent_id, "action_pattern": "stripe.create_refund", "effect": "BLOCK"})
    assert r.status_code == 200, r.text

    # The applied BLOCK must carry priority 100, not 0.
    policies = client.get(f"/api/authority/agent/{agent_id}/policies", headers=h).json()["policies"]
    applied = next(p for p in policies if p["effect"] == "BLOCK")
    assert applied["priority"] == 100, f"applied BLOCK priority was {applied['priority']} (fail-open)"

    # End-to-end: enforcement must BLOCK the refund despite the broad ALLOW.
    r = client.post("/api/enforce", headers=h,
                    json={"agent_id": agent_id, "tool": "stripe", "action": "create_refund"})
    assert r.status_code == 200, r.text
    assert r.json()["decision"] == "BLOCK", f"refund was {r.json()['decision']} — applied BLOCK lost to ALLOW"
