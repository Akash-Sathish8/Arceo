"""Pre-migration behavioral baseline (Phase 1, A2b).

Locks Phase-1-final behavior — shapes and semantics, not incidental strings —
as the acceptance reference the Phase-2 SQLite→Postgres migration must
preserve. Every assertion here is a contract: if the Postgres cutover changes
any of it, that's a migration bug, not a test to update.

Covers: auth, agent CRUD + detail shape (incl. default_effect), policy CRUD +
enforcement decisions (ALLOW / BLOCK / REQUIRE_APPROVAL / deny-by-default /
bare-* / effect tie-break), proxy auth posture, the approvals lifecycle with
provenance, execution-log shape, and the cross-tenant matrix.
"""

from __future__ import annotations

import uuid

STRIPE_TOOL = {
    "name": "stripe", "service": "stripe",
    "actions": [
        {"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False},
        {"action": "get_customer", "risk_labels": [], "reversible": True},
    ],
}


def _mk_agent(client, headers, name=None):
    name = name or f"baseline-{uuid.uuid4().hex[:8]}"
    r = client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _add_policy(client, headers, agent_id, pattern, effect, priority=10, reason="baseline"):
    r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=headers,
                    json={"action_pattern": pattern, "effect": effect, "reason": reason, "priority": priority})
    assert r.status_code == 200, r.text
    return r.json()


def _enforce(client, headers, agent_id, tool="stripe", action="create_refund", params=None):
    r = client.post("/api/enforce", headers=headers,
                    json={"agent_id": agent_id, "tool": tool, "action": action, "params": params or {}})
    assert r.status_code == 200, r.text
    return r.json()


# ── Auth ──────────────────────────────────────────────────────────────────────

def test_auth_contract(client):
    email = f"baseline-{uuid.uuid4().hex[:8]}@example.com"
    r = client.post("/api/auth/signup", json={"email": email, "password": "pw12345678", "name": "B"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"token", "user"}
    assert set(body["user"]) >= {"id", "email", "name", "role"}
    assert body["user"]["role"] == "admin"  # signup owner is org admin

    assert client.post("/api/auth/signup", json={"email": email, "password": "pw12345678"}).status_code == 409
    assert client.post("/api/auth/signup", json={"email": "not-an-email", "password": "pw12345678"}).status_code == 400
    assert client.post("/api/auth/signup", json={"email": f"x{email}", "password": "short"}).status_code == 400

    r = client.post("/api/auth/login", json={"email": email, "password": "pw12345678"})
    assert r.status_code == 200 and r.json().get("token")
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    me = client.get("/api/auth/me", headers=h)
    assert me.status_code == 200 and me.json()["user"]["email"] == email

    assert client.get("/api/auth/me").status_code == 401  # no token → 401


# ── Agent CRUD + detail shape ─────────────────────────────────────────────────

def test_agent_detail_shape(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"])

    detail = client.get(f"/api/authority/agent/{agent_id}", headers=a["headers"]).json()
    assert set(detail) >= {"agent", "graph", "blast_radius", "chains", "recommendations", "policies", "executions"}
    assert set(detail["agent"]) >= {"id", "name", "description", "created_at", "default_effect", "tools"}
    assert detail["agent"]["default_effect"] == "ALLOW"
    assert isinstance(detail["blast_radius"], dict)

    listing = client.get("/api/authority/agents", headers=a["headers"]).json()["agents"]
    mine = next(ag for ag in listing if ag["id"] == agent_id)
    assert set(mine) >= {"id", "name", "policy_count", "policies_by_effect", "pending_count", "default_effect"}


# ── Enforcement decision semantics ────────────────────────────────────────────

def test_enforcement_decision_matrix(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"])

    # Implicit allow with no policies.
    assert _enforce(client, a["headers"], agent_id)["decision"] == "ALLOW"

    # BLOCK fires; specificity beats effect (exact ALLOW beats broad BLOCK).
    _add_policy(client, a["headers"], agent_id, "stripe.*", "BLOCK", priority=10)
    assert _enforce(client, a["headers"], agent_id)["decision"] == "BLOCK"
    _add_policy(client, a["headers"], agent_id, "stripe.get_customer", "ALLOW", priority=0)
    assert _enforce(client, a["headers"], agent_id, action="get_customer")["decision"] == "ALLOW"

    # Same-breadth effect tie-break: BLOCK wins even at lower priority.
    _add_policy(client, a["headers"], agent_id, "stripe.*", "ALLOW", priority=1000)
    assert _enforce(client, a["headers"], agent_id)["decision"] == "BLOCK"


def test_bare_star_and_require_approval(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"])
    _add_policy(client, a["headers"], agent_id, "*", "REQUIRE_APPROVAL", priority=50)
    out = _enforce(client, a["headers"], agent_id)
    assert out["decision"] == "REQUIRE_APPROVAL"
    assert out["policy"]["action_pattern"] == "*"


def test_deny_by_default_semantics(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"])
    client.put(f"/api/authority/agent/{agent_id}", headers=a["headers"],
               json={"name": "baseline-deny", "default_effect": "DENY"})
    assert _enforce(client, a["headers"], agent_id)["decision"] == "BLOCK"
    _add_policy(client, a["headers"], agent_id, "stripe.get_customer", "ALLOW")
    assert _enforce(client, a["headers"], agent_id, action="get_customer")["decision"] == "ALLOW"


def test_enforce_requires_auth(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"])
    r = client.post("/api/enforce", json={"agent_id": agent_id, "tool": "stripe", "action": "create_refund"})
    assert r.status_code == 401


# ── Proxy auth posture ────────────────────────────────────────────────────────

def test_proxy_401_without_key(client):
    assert client.post("/proxy/stripe/v1/refunds", headers={"X-Agent-ID": "x"}).status_code == 401


# ── Approvals lifecycle ───────────────────────────────────────────────────────

def _pending_ids(client, headers):
    rows = client.get("/api/approvals", headers=headers).json()
    items = rows["approvals"] if isinstance(rows, dict) and "approvals" in rows else rows
    return {int(r["id"]): r for r in items}


def test_approvals_lifecycle_with_provenance(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"])
    _add_policy(client, a["headers"], agent_id, "stripe.create_refund", "REQUIRE_APPROVAL", reason="human gate")

    _enforce(client, a["headers"], agent_id, params={"amount": 500})
    _enforce(client, a["headers"], agent_id, params={"amount": 900})

    pending = _pending_ids(client, a["headers"])
    assert len(pending) >= 2
    sample = next(iter(pending.values()))
    # Provenance contract from PR #33: the queue explains itself — the firing
    # policy is nested, the source labels where the call came from.
    assert sample["agent_id"] == agent_id
    assert (sample.get("policy") or {}).get("action_pattern") == "stripe.create_refund"
    assert sample.get("source") == "runtime"
    assert sample.get("params") == {"amount": 500} or sample.get("params") == {"amount": 900}

    ids = sorted(pending)
    approve_id, reject_id = ids[0], ids[1]
    r = client.post(f"/api/approvals/{approve_id}", headers=a["headers"], json={"decision": "approve"})
    assert r.status_code == 200 and r.json()["status"] == "EXECUTED"
    r = client.post(f"/api/approvals/{reject_id}", headers=a["headers"], json={"decision": "reject", "reason": "no"})
    assert r.status_code == 200 and r.json()["status"] == "BLOCKED"

    # Double-decide → 400; junk decision → 400.
    assert client.post(f"/api/approvals/{approve_id}", headers=a["headers"], json={"decision": "approve"}).status_code == 400
    assert client.post(f"/api/approvals/{reject_id}", headers=a["headers"], json={"decision": "maybe"}).status_code == 400


# ── Execution log shape ───────────────────────────────────────────────────────

def test_executions_shape(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _mk_agent(client, a["headers"])
    _enforce(client, a["headers"], agent_id)
    rows = client.get(f"/api/executions/{agent_id}", headers=a["headers"]).json()
    items = rows["entries"]
    assert items, "an enforce call must write an execution row"
    row = items[0]
    assert set(row) >= {"id", "agent_id", "tool", "action", "status", "source"}
    assert row["source"] == "runtime"


# ── Cross-tenant matrix ───────────────────────────────────────────────────────

def test_cross_org_matrix(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    agent_id = _mk_agent(client, a["headers"])
    _add_policy(client, a["headers"], agent_id, "stripe.create_refund", "REQUIRE_APPROVAL")
    _enforce(client, a["headers"], agent_id)  # org A pending approval

    # Existence itself is tenant data: reads/writes 404, never 200.
    assert client.get(f"/api/authority/agent/{agent_id}", headers=b["headers"]).status_code == 404
    assert client.put(f"/api/authority/agent/{agent_id}", headers=b["headers"],
                      json={"name": "stolen"}).status_code == 404
    assert client.delete(f"/api/authority/agent/{agent_id}", headers=b["headers"]).status_code == 404
    assert client.post(f"/api/authority/agent/{agent_id}/policies", headers=b["headers"],
                       json={"action_pattern": "*", "effect": "ALLOW", "reason": "x"}).status_code == 404

    # Enforce as another org's agent → 403 (auth exists, agent isn't yours).
    r = client.post("/api/enforce", headers=b["headers"],
                    json={"agent_id": agent_id, "tool": "stripe", "action": "create_refund"})
    assert r.status_code == 403

    # Org B sees none of org A's queue or history.
    assert all(row["agent_id"] != agent_id for row in _pending_ids(client, b["headers"]).values())
    listing = client.get("/api/authority/agents", headers=b["headers"]).json()["agents"]
    assert all(ag["id"] != agent_id for ag in listing)
