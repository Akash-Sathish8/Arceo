"""Phase-4 PR-1: REQUIRE_APPROVAL parks a durable, redacted, org-scoped request.

The proxy captures the full HTTP request for replay; the enforce path captures
a decision-gate. Inbound credentials are never stored. The row is linked to the
PENDING_APPROVAL execution_log row and isolated per tenant.
"""

from __future__ import annotations

import json
import uuid

from db import get_db

STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}


def _agent_with_gate(client, headers, name):
    r = client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text
    agent_id = r.json()["id"]
    r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=headers,
                    json={"action_pattern": "stripe.create_refund", "effect": "REQUIRE_APPROVAL",
                          "reason": "needs human sign-off", "priority": 10})
    assert r.status_code == 200, r.text
    return agent_id


def _key(client, headers):
    r = client.post("/api/keys", headers=headers, json={"name": "k-" + uuid.uuid4().hex[:6]})
    assert r.status_code == 200, r.text
    return r.json()["key"]


def test_proxy_require_approval_parks_full_redacted_request(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _agent_with_gate(client, a["headers"], "park-" + uuid.uuid4().hex[:6])
    key = _key(client, a["headers"])

    # The agent sends its OWN Authorization + X-API-Key — neither may be stored.
    r = client.post("/proxy/stripe/v1/refunds",
                    headers={"X-API-Key": key, "X-Agent-ID": agent_id,
                             "Authorization": "Bearer sk_agent_SECRET"},
                    json={"amount": 900, "charge": "ch_1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("pending_approval") is True
    assert body.get("pending_id")

    with get_db() as conn:
        row = conn.execute("SELECT * FROM pending_requests WHERE id = %s", (body["pending_id"],)).fetchone()
    assert row is not None
    assert row["kind"] == "proxy"
    assert row["status"] == "PENDING"
    assert row["service"] == "stripe"
    assert row["method"] == "POST"
    assert row["path"] == "v1/refunds"
    assert row["execution_id"] == body["execution_id"]
    # Redaction: neither the agent's Authorization nor the Arceo X-API-Key stored.
    headers = json.loads(row["headers_json"])
    lowered = {k.lower() for k in headers}
    assert "authorization" not in lowered and "x-api-key" not in lowered
    # But the replayable body IS captured.
    import base64
    assert json.loads(base64.b64decode(row["body"])) == {"amount": 900, "charge": "ch_1"}
    assert row["idempotency_key"]


def test_enforce_require_approval_parks_decision_gate(client, two_orgs):
    a = two_orgs["org_a"]
    agent_id = _agent_with_gate(client, a["headers"], "park-enf-" + uuid.uuid4().hex[:6])
    r = client.post("/api/enforce", headers=a["headers"],
                    json={"agent_id": agent_id, "tool": "stripe", "action": "create_refund",
                          "params": {"amount": 50}})
    assert r.status_code == 200
    assert r.json()["decision"] == "REQUIRE_APPROVAL"
    exec_id = r.json()["execution_id"]
    with get_db() as conn:
        row = conn.execute("SELECT * FROM pending_requests WHERE execution_id = %s", (exec_id,)).fetchone()
    assert row is not None and row["kind"] == "enforce" and row["status"] == "PENDING"


def test_pending_request_is_tagged_with_owning_org(client, two_orgs):
    # The row must carry the AGENT's org (so the FORCE-RLS org_isolation policy —
    # identical to every other tenant table, proven enforcing in
    # test_rls_enforcement.py — scopes it correctly under a non-superuser role).
    a = two_orgs["org_a"]
    agent_id = _agent_with_gate(client, a["headers"], "park-iso-" + uuid.uuid4().hex[:6])
    key = _key(client, a["headers"])
    r = client.post("/proxy/stripe/v1/refunds",
                    headers={"X-API-Key": key, "X-Agent-ID": agent_id},
                    json={"amount": 10})
    pid = r.json()["pending_id"]
    with get_db() as conn:
        got = conn.execute("SELECT org_id FROM pending_requests WHERE id = %s", (pid,)).fetchone()
    assert got["org_id"] == a["org_id"]
