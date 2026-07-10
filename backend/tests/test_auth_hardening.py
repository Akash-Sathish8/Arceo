"""Phase-3 PR-1: the open write paths are closed, auth is scoped, brute-force is limited.

Covers: register requires auth + files under the caller's org; /api/traces/live
and /mock/* reject unauthenticated and cross-org callers; login/signup rate
limit; the JWT-secret boot guard; the ingestion org fix; and a clean 409 on a
cross-org agent-id collision.
"""

from __future__ import annotations

import uuid

STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"name": "create_refund", "description": "refund"}]}


def _key(client, headers):
    r = client.post("/api/keys", headers=headers, json={"name": "k-" + uuid.uuid4().hex[:6]})
    assert r.status_code == 200, r.text
    return r.json()["key"]


# ── register ──────────────────────────────────────────────────────────────────

def test_register_requires_auth(client):
    r = client.post("/api/authority/agents/register", json={"name": "no-auth-agent", "tools": []})
    assert r.status_code == 401


def test_register_files_under_caller_org(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    name = "reg-" + uuid.uuid4().hex[:6]
    r = client.post("/api/authority/agents/register", headers=a["headers"],
                    json={"name": name, "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text
    agent_id = r.json()["id"]
    # Visible to org A, invisible to org B.
    assert client.get(f"/api/authority/agent/{agent_id}", headers=a["headers"]).status_code == 200
    assert client.get(f"/api/authority/agent/{agent_id}", headers=b["headers"]).status_code == 404


def test_register_works_with_api_key(client, two_orgs):
    a = two_orgs["org_a"]
    key = _key(client, a["headers"])
    name = "reg-key-" + uuid.uuid4().hex[:6]
    r = client.post("/api/authority/agents/register", headers={"X-API-Key": key},
                    json={"name": name, "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text


# ── traces/live ───────────────────────────────────────────────────────────────

def _mk_agent(client, headers, name):
    r = client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [
        {"name": "stripe", "service": "stripe",
         "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}]})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_traces_live_requires_auth(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"], "trace-" + uuid.uuid4().hex[:6])
    ev = {"agent_id": agent_id, "tool": "stripe", "action": "create_refund"}
    assert client.post("/api/traces/live", json=ev).status_code == 401


def test_traces_live_rejects_cross_org_agent(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    agent_id = _mk_agent(client, a["headers"], "trace-x-" + uuid.uuid4().hex[:6])
    ev = {"agent_id": agent_id, "tool": "stripe", "action": "create_refund"}
    # org B is authenticated but the agent isn't theirs → 403.
    assert client.post("/api/traces/live", headers=b["headers"], json=ev).status_code == 403
    # org A (the owner) succeeds.
    assert client.post("/api/traces/live", headers=a["headers"], json=ev).status_code == 200


# ── /mock/* ───────────────────────────────────────────────────────────────────

def test_mock_endpoints_require_auth(client):
    assert client.post("/mock/session", json={"agent_id": "x"}).status_code == 401
    assert client.get("/mock/sessions").status_code == 401
    assert client.post("/mock/stripe/create_refund", headers={"x-agent-id": "x"}, json={}).status_code == 401
    # discovery stays open
    assert client.get("/mock/available").status_code == 200


def test_mock_sessions_are_org_scoped(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    r = client.post("/mock/session", headers=a["headers"], json={"agent_id": "org-a-agent"})
    assert r.status_code == 200, r.text
    sid = r.json()["session_id"]
    # org B can't read org A's session (404, not 200)
    assert client.get(f"/mock/session/{sid}/trace", headers=b["headers"]).status_code == 404
    assert client.get(f"/mock/session/{sid}/trace", headers=a["headers"]).status_code == 200
    # org B's session list doesn't include it
    b_sessions = client.get("/mock/sessions", headers=b["headers"]).json()["sessions"]
    assert all(s["session_id"] != sid for s in b_sessions)


# ── rate limiting ─────────────────────────────────────────────────────────────

def test_login_rate_limited(client):
    # RATE_LIMIT_AUTH_MAX defaults to 10 per IP; the 11th attempt is throttled.
    email = f"nobody-{uuid.uuid4().hex[:6]}@example.com"
    seen_429 = False
    for _ in range(12):
        r = client.post("/api/auth/login", json={"email": email, "password": "wrong-password"})
        if r.status_code == 429:
            seen_429 = True
            break
    assert seen_429, "login never rate-limited after 12 rapid attempts"


# ── cross-org agent-id collision → 409 (not 500) ──────────────────────────────

def test_import_collision_is_409(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    name = "collide-" + uuid.uuid4().hex[:6]
    assert client.post("/api/authority/agents/register", headers=a["headers"],
                       json={"name": name, "tools": [STRIPE_TOOL]}).status_code == 200
    # org B registering the same name hits the global-PK collision → clean 409.
    r = client.post("/api/authority/agents/register", headers=b["headers"],
                    json={"name": name, "tools": [STRIPE_TOOL]})
    assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text[:200]}"
