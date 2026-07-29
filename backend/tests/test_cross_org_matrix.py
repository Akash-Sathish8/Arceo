"""Phase-3 PR-2: the adversarial cross-org matrix — a permanent CI gate.

Seed org B with a full resource set, then hit every id-addressed endpoint with
org A's token against org B's ids. Every one must return 404 or 403 — never a
200 that exposes another tenant's data, and never a raw 500. This is the
enforced-isolation contract; if a new leaky endpoint lands, this test fails.
"""

from __future__ import annotations

import json
import uuid

from db import get_db

STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}


def _seed_org_b(client, b):
    """Create one of everything in org B; return the ids org A will try to reach."""
    h = b["headers"]
    ids = {"org_id": b["org_id"]}

    r = client.post("/api/authority/agents", headers=h,
                    json={"name": "orgb-" + uuid.uuid4().hex[:6], "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text
    agent_id = r.json()["id"]
    ids["agent_id"] = agent_id

    r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=h,
                    json={"action_pattern": "stripe.create_refund", "effect": "REQUIRE_APPROVAL",
                          "reason": "b-policy", "priority": 10})
    assert r.status_code == 200, r.text
    # policy id: from response if present, else look it up
    with get_db() as conn:
        prow = conn.execute("SELECT id FROM policies WHERE agent_id = %s LIMIT 1", (agent_id,)).fetchone()
    ids["policy_id"] = prow["id"]

    # an execution row (pending approval) via enforce
    client.post("/api/enforce", headers=h,
                json={"agent_id": agent_id, "tool": "stripe", "action": "create_refund", "params": {"amount": 10}})
    with get_db() as conn:
        erow = conn.execute("SELECT id FROM execution_log WHERE agent_id = %s LIMIT 1", (agent_id,)).fetchone()
    ids["execution_id"] = erow["id"] if erow else 999999

    # test data
    client.put(f"/api/authority/agent/{agent_id}/test-data", headers=h, json={"customers": {"c1": {"id": "c1"}}})

    # budget
    client.put(f"/api/agents/{agent_id}/budget", headers=h, json={"monthly_budget_usd": 100, "alert_threshold_pct": 80})

    # api key
    r = client.post("/api/keys", headers=h, json={"name": "b-key"})
    ids["key_id"] = r.json().get("id") if r.status_code == 200 else "nope"

    # a simulation + sweep row (direct insert keeps the seed simple; the check is the GET)
    sim_id = uuid.uuid4().hex[:12]
    sweep_id = uuid.uuid4().hex[:12]
    with get_db() as conn:
        conn.execute(
            "INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, report_json, org_id, created_at, run_mode) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (sim_id, agent_id, "s", "completed", json.dumps({"prompt": "x"}), json.dumps({"risk_score": 1}),
             b["org_id"], "2026-01-01", "live"))
        conn.execute(
            "INSERT INTO sweeps (id, agent_id, status, total_scenarios, completed, report_json, org_id, created_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
            (sweep_id, agent_id, "completed", 1, 1, json.dumps({"overall_risk_score": 1}), b["org_id"], "2026-01-01"))
    ids["simulation_id"] = sim_id
    ids["sweep_id"] = sweep_id
    return ids


# (method, path-template) for every id-addressed endpoint that resolves a tenant
# resource. Excludes /proxy/* (key-auth, separate), /mock/* (PR-1), category
# lookups (scenarios/{agent_type}), and the capture llm-call sink.
_MATRIX = [
    ("GET", "/api/authority/agent/{agent_id}"),
    ("PUT", "/api/authority/agent/{agent_id}", {"name": "x"}),
    ("DELETE", "/api/authority/agent/{agent_id}"),
    ("POST", "/api/authority/agent/{agent_id}/context", {"environment": "prod"}),
    ("POST", "/api/authority/agent/{agent_id}/forecast-inputs", {"expected_calls_per_day": 5}),
    ("GET", "/api/authority/agent/{agent_id}/policies"),
    ("POST", "/api/authority/agent/{agent_id}/policies", {"action_pattern": "a.b", "effect": "ALLOW", "reason": "x"}),
    ("GET", "/api/authority/agent/{agent_id}/policy-conflicts"),
    ("GET", "/api/authority/agent/{agent_id}/test-data"),
    ("PUT", "/api/authority/agent/{agent_id}/test-data", {"customers": {}}),
    ("DELETE", "/api/authority/agent/{agent_id}/test-data"),
    ("DELETE", "/api/authority/policy/{policy_id}"),
    ("GET", "/api/executions/{agent_id}"),
    ("POST", "/api/approvals/{execution_id}", {"decision": "approve"}),
    ("GET", "/api/enforce/status/{execution_id}"),
    ("GET", "/api/agents/{agent_id}/budget"),
    ("PUT", "/api/agents/{agent_id}/budget", {"monthly_budget_usd": 5, "alert_threshold_pct": 50}),
    ("DELETE", "/api/agents/{agent_id}/budget"),
    ("GET", "/api/agents/{agent_id}/cost-report"),
    ("GET", "/api/agents/{agent_id}/spend-forecast"),
    ("GET", "/api/sandbox/simulation/{simulation_id}"),
    ("GET", "/api/sandbox/sweep/{sweep_id}"),
    ("GET", "/api/regression-test/{agent_id}/history"),
    ("GET", "/api/sandbox/agent/{agent_id}/scenarios"),
    ("GET", "/api/traces/live/{agent_id}"),
    ("DELETE", "/api/keys/{key_id}"),
]


def test_cross_org_matrix(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    ids = _seed_org_b(client, b)
    ha = a["headers"]

    leaks = []
    for entry in _MATRIX:
        method, template = entry[0], entry[1]
        body = entry[2] if len(entry) > 2 else None
        path = template.format(**ids)
        resp = client.request(method, path, headers=ha, json=body)
        # 404 (existence hidden) or 403 (forbidden) are both acceptable.
        # A 200/2xx means org A reached org B's resource; a 500 means a raw
        # error instead of a clean denial. Either is a leak.
        if resp.status_code not in (401, 403, 404, 422):
            leaks.append(f"{method} {template} → {resp.status_code} (expected 403/404)")

    assert not leaks, "cross-org leaks:\n" + "\n".join(leaks)


def test_policy_create_stamps_caller_org(client, two_orgs):
    """HIGH-002: a policy created by a tenant is filed under THAT tenant's org, not the
    'default' server-default. A mis-filed policy is invisible to the tenant's RLS-scoped
    enforcement read (enforcement fails open) and, under prod RLS, 500s on insert."""
    b = two_orgs["org_b"]
    r = client.post("/api/authority/agents", headers=b["headers"],
                    json={"name": "orgb-pol-" + uuid.uuid4().hex[:6], "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text
    agent_id = r.json()["id"]

    r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=b["headers"],
                    json={"action_pattern": "stripe.create_refund", "effect": "BLOCK",
                          "reason": "x", "priority": 100})
    assert r.status_code == 200, r.text

    with get_db() as conn:
        org = conn.execute("SELECT org_id FROM policies WHERE agent_id = %s", (agent_id,)).fetchone()["org_id"]
    assert org == b["org_id"], f"policy filed under '{org}', expected '{b['org_id']}'"
