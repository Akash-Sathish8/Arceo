"""Deployment state on the fleet list.

The product's whole claim is "before you put it in production", and until now
the fleet page could not tell you which side of that line an agent was on.

State is decided by observed traffic, not by the `environment` field someone
typed at registration — the same measured-vs-declared discipline the provenance
chips already follow. Where the two disagree, that disagreement is the finding.
"""

from __future__ import annotations

import uuid

from db import get_db, current_org, log_audit


def _agent(client, headers, environment=None) -> str:
    payload = {"name": f"dep-{uuid.uuid4().hex[:6]}", "tools": []}
    if environment:
        payload["environment"] = environment
    r = client.post("/api/authority/agents", headers=headers, json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    return body["agent"]["id"] if "agent" in body else body["id"]


def _row(client, headers, agent_id) -> dict:
    r = client.get("/api/authority/agents", headers=headers)
    assert r.status_code == 200, r.text
    match = [a for a in r.json()["agents"] if a["id"] == agent_id]
    assert match, f"{agent_id} missing from the fleet list"
    return match[0]


def _log_llm_call(agent_id: str, org_id: str, n: int = 1) -> None:
    token = current_org.set(org_id)
    try:
        with get_db() as conn:
            for _ in range(n):
                log_audit(conn, None, agent_id, "LLM_CALL", "anthropic:claude-sonnet-4-6",
                          "{}", org_id)
    finally:
        current_org.reset(token)


def test_an_agent_that_has_never_run_is_pre_deployment(client, roles):
    aid = _agent(client, roles["admin"]["headers"])
    row = _row(client, roles["admin"]["headers"], aid)

    assert row["deployment_state"] == "pre_deployment"
    assert row["live_calls_7d"] == 0
    assert row["last_execution_at"] is None
    assert row["deployment_mismatch"] is None


def test_captured_traffic_alone_makes_an_agent_deployed(client, roles):
    """Traffic counts even with no execution_log row: an agent calling an LLM
    through the SDK is running, whether or not it has hit the enforcement API."""
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    _log_llm_call(aid, admin["org_id"], n=3)

    row = _row(client, admin["headers"], aid)
    assert row["deployment_state"] == "deployed"
    assert row["live_calls_7d"] == 3


def test_declared_prod_with_no_traffic_reads_as_stalled(client, roles):
    aid = _agent(client, roles["admin"]["headers"], environment="prod")
    row = _row(client, roles["admin"]["headers"], aid)

    assert row["deployment_state"] == "pre_deployment"
    assert row["deployment_mismatch"] == "stalled"


def test_declared_dev_under_live_load_reads_as_ungoverned(client, roles):
    """The governance finding this split surfaces for free: production traffic
    on an agent nobody signed off as production."""
    admin = roles["admin"]
    aid = _agent(client, admin["headers"], environment="dev")
    _log_llm_call(aid, admin["org_id"], n=2)

    row = _row(client, admin["headers"], aid)
    assert row["deployment_state"] == "deployed"
    assert row["deployment_mismatch"] == "ungoverned"


def test_one_org_traffic_never_counts_toward_another(client, two_orgs):
    """The fleet count is a single GROUP BY over audit_log — it has to stay
    org-scoped, or one tenant's traffic would deploy another tenant's agent."""
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    a_id = _agent(client, a["headers"])
    _log_llm_call(a_id, a["org_id"], n=4)

    assert _row(client, a["headers"], a_id)["live_calls_7d"] == 4
    b_rows = client.get("/api/authority/agents", headers=b["headers"]).json()["agents"]
    assert all(r["live_calls_7d"] == 0 for r in b_rows), b_rows


def test_agent_detail_reports_the_same_verdict_as_the_fleet_list(client, roles):
    """Two screens, one verdict. If these ever diverge the product contradicts
    itself about the one thing its positioning rests on."""
    admin = roles["admin"]
    aid = _agent(client, admin["headers"], environment="dev")
    _log_llm_call(aid, admin["org_id"], n=2)

    listed = _row(client, admin["headers"], aid)
    detail = client.get(f"/api/authority/agent/{aid}", headers=admin["headers"])
    assert detail.status_code == 200, detail.text
    d = detail.json()["agent"]

    assert d["deployment_state"] == listed["deployment_state"] == "deployed"
    assert d["deployment_mismatch"] == listed["deployment_mismatch"] == "ungoverned"
    assert d["live_calls_7d"] == listed["live_calls_7d"] == 2
    assert d["environment"] == "dev"
