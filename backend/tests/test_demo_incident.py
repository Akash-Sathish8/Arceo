"""The incident demo must keep working with no LLM key.

The suite stubs the classifier's LLM layer (conftest), so this reproduces the
exact environment the demo runs in: keyword classification only. If a
classifier or enforcement change alters any of these decisions, the demo
breaks on stage, so the assertions are exact.
"""

import uuid

from demo_incident import (
    AGENT_NAME, EXPECTED_CHAIN_IDS, EXPECTED_DECISIONS, POLICIES, TOOLS, TRACE,
)
from tests.conftest import _signup_org


def _register(client, headers, name):
    r = client.post("/api/authority/agents/register", headers=headers, json={
        "name": name, "description": "incident demo", "tools": TOOLS,
        "environment": "prod", "trigger_source": "untrusted", "human_in_loop": False,
    })
    assert r.status_code == 200, r.text
    return r.json()


def test_manifest_scores_critical_and_names_the_incident_chains(client):
    org = _signup_org(client, f"incident-{uuid.uuid4().hex[:8]}@example.com")
    name = f"{AGENT_NAME} {uuid.uuid4().hex[:6]}"
    reg = _register(client, org["headers"], name)
    assert reg["blast_radius"]["band"] == "critical", reg["blast_radius"]

    detail = client.get(f"/api/authority/agent/{reg['id']}", headers=org["headers"]).json()
    chain_ids = {c["id"] for c in detail["chains"]}
    missing = EXPECTED_CHAIN_IDS - chain_ids
    assert not missing, f"chains missing from the agent page: {missing}; got {sorted(chain_ids)}"
    critical = {c["id"] for c in detail["chains"] if c["severity"] == "critical"}
    assert EXPECTED_CHAIN_IDS <= critical


def test_replay_stops_the_attack_with_the_seeded_policies(client):
    org = _signup_org(client, f"incident-{uuid.uuid4().hex[:8]}@example.com")
    name = f"{AGENT_NAME} {uuid.uuid4().hex[:6]}"
    agent_id = _register(client, org["headers"], name)["id"]

    for p in POLICIES:
        r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=org["headers"], json=p)
        assert r.status_code == 200, r.text

    r = client.post("/api/replay", headers=org["headers"], json={"agent_id": agent_id, "traces": TRACE})
    assert r.status_code == 200, r.text
    report = r.json()
    got = [s["policy_decision"] for s in report["steps"]]
    assert got == EXPECTED_DECISIONS, list(zip(
        [f"{s['tool']}.{s['action']}" for s in report["steps"]], got, EXPECTED_DECISIONS))
    assert report["actions_would_block"] == EXPECTED_DECISIONS.count("BLOCK")
    assert report["actions_would_require_approval"] == EXPECTED_DECISIONS.count("REQUIRE_APPROVAL")

    # The two held steps sit in the approvals queue, tagged as a trace replay.
    q = client.get("/api/approvals", headers=org["headers"]).json()
    held = [a for a in q["approvals"] if a["agent_id"] == agent_id]
    assert {a["action"] for a in held} == {"grant_permission", "create_access_key"}, held
    assert all(a.get("source") == "replay" for a in held), held


def test_replay_without_policies_lets_everything_through(client):
    org = _signup_org(client, f"incident-{uuid.uuid4().hex[:8]}@example.com")
    name = f"{AGENT_NAME} {uuid.uuid4().hex[:6]}"
    agent_id = _register(client, org["headers"], name)["id"]
    r = client.post("/api/replay", headers=org["headers"], json={"agent_id": agent_id, "traces": TRACE})
    assert r.status_code == 200, r.text
    assert all(s["policy_decision"] == "ALLOW" for s in r.json()["steps"])


def test_ingested_trace_shows_the_executed_chains(client):
    org = _signup_org(client, f"incident-{uuid.uuid4().hex[:8]}@example.com")
    name = f"{AGENT_NAME} {uuid.uuid4().hex[:6]}"
    r = client.post("/api/ingest/generic", headers=org["headers"],
                    json={"agent_name": name, "actions": TRACE})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["report"]["chains"] >= 1, body["report"]
    # The stored simulation carries the full chain list the replay page draws.
    sim = client.get(f"/api/sandbox/simulation/{body['simulation_id']}", headers=org["headers"]).json()
    chains = {c["chain_id"] for c in sim["report"]["chains_triggered"]}
    assert chains & {"secrets-external", "code-external", "secrets-access", "evade-external"}, chains
    # Every step of an ingested trace is historical, so nothing is gated.
    assert all(s["enforce_decision"] == "ALLOW" for s in sim["trace"]["steps"])
