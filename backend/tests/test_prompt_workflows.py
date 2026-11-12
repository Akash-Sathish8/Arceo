"""Prompt library phase 4: stacked prompts, summed cost, taint-propagated danger."""

from __future__ import annotations

import pytest

SUMMARIZE = {"title": "Summarize email", "body": "Summarize this email in 3 bullets:\n{{email}}",
             "variables": {"email": {"expected_tokens": 400}}, "expected_output_tokens": 80}
REPLY = {"title": "Reply and refund", "body": "Using these notes:\n{{notes}}\nSend a reply to the customer "
         "and issue a refund if the notes say they asked for one.", "expected_output_tokens": 200}
TAGLINE = {"title": "Tagline", "body": "Write a tagline for {{product_name}}.", "expected_output_tokens": 20}


def _mk(client, org, spec):
    r = client.post("/api/prompts", headers=org["headers"], json=spec)
    assert r.status_code == 200, r.text
    return r.json()


def _two_step(a_id, b_id):
    return {
        "inputs": [{"name": "customer_email", "expected_tokens": 400}],
        "steps": [
            {"prompt_id": a_id, "input_map": {"email": {"from": "input", "name": "customer_email"}}},
            {"prompt_id": b_id, "input_map": {"notes": {"from": "step", "step": 0}}},
        ],
    }


def test_cost_is_the_sum_and_feeds_output_forward(client, two_orgs):
    a = two_orgs["org_a"]
    s1, s2 = _mk(client, a, SUMMARIZE), _mk(client, a, REPLY)
    r = client.post("/api/prompt-workflows/score", headers=a["headers"], json=_two_step(s1["id"], s2["id"]))
    assert r.status_code == 200, r.text
    haiku = next(m for m in r.json()["cost"]["models"] if m["model"] == "claude-haiku-4-5")
    steps = haiku["steps"]
    assert haiku["usd_per_run"] == pytest.approx(sum(s["usd_per_run"] for s in steps), rel=1e-6)
    # Step 2's input includes exactly step 1's 80 declared output tokens.
    assert steps[1]["input_tokens"] >= 80
    assert steps[0]["output_tokens"] == 80


def test_taint_crosses_steps_and_makes_a_chain(client, two_orgs):
    a = two_orgs["org_a"]
    s1, s2 = _mk(client, a, SUMMARIZE), _mk(client, a, REPLY)
    d = client.post("/api/prompt-workflows/score", headers=a["headers"],
                    json=_two_step(s1["id"], s2["id"])).json()["danger"]
    chains = [x for x in d["reasons"] if x["factor"] == "chain"]
    assert any(x["evidence"] == "step 1 -> step 2" for x in chains)
    assert d["band"] == "critical"


def test_trusted_input_does_not_taint(client, two_orgs):
    a = two_orgs["org_a"]
    t, s2 = _mk(client, a, TAGLINE), _mk(client, a, REPLY)
    spec = {"inputs": [{"name": "product_name", "untrusted": False}],
            "steps": [{"prompt_id": t["id"], "input_map": {"product_name": {"from": "input", "name": "product_name"}}},
                      {"prompt_id": s2["id"], "input_map": {"notes": {"from": "step", "step": 0}}}]}
    d = client.post("/api/prompt-workflows/score", headers=a["headers"], json=spec).json()["danger"]
    assert not [x for x in d["reasons"] if x["evidence"] == "step 1 -> step 2"]


def test_validation(client, two_orgs):
    a = two_orgs["org_a"]
    s1 = _mk(client, a, SUMMARIZE)
    bad_forward = {"inputs": [], "steps": [{"prompt_id": s1["id"], "input_map": {"email": {"from": "step", "step": 0}}}]}
    r = client.post("/api/prompt-workflows/score", headers=a["headers"], json=bad_forward)
    assert r.status_code == 400 and "EARLIER" in r.json()["detail"]
    bad_var = {"inputs": [], "steps": [{"prompt_id": s1["id"], "input_map": {"nope": {"from": "input", "name": "x"}}}]}
    assert client.post("/api/prompt-workflows/score", headers=a["headers"], json=bad_var).status_code == 400


def test_cannot_use_another_orgs_private_prompt(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    s1 = _mk(client, a, SUMMARIZE)
    spec = {"inputs": [], "steps": [{"prompt_id": s1["id"]}]}
    r = client.post("/api/prompt-workflows/score", headers=b["headers"], json=spec)
    assert r.status_code == 400 and "not found" in r.json()["detail"]
    # Once it's public, B can build on it.
    client.post(f"/api/prompts/{s1['id']}/publish", headers=a["headers"], json={})
    assert client.post("/api/prompt-workflows/score", headers=b["headers"], json=spec).status_code == 200


def test_crud_and_publish_rules(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    s1, s2 = _mk(client, a, SUMMARIZE), _mk(client, a, REPLY)
    wf = client.post("/api/prompt-workflows", headers=a["headers"],
                     json={"title": "Inbox to refund", **_two_step(s1["id"], s2["id"])}).json()
    assert wf["owned"] and wf["danger_summary"]["band"] == "critical"
    assert client.get(f"/api/prompt-workflows/{wf['id']}", headers=b["headers"]).status_code == 404
    # Community publish needs every step prompt public first.
    r = client.post(f"/api/prompt-workflows/{wf['id']}/publish", headers=a["headers"], json={})
    assert r.status_code == 409
    for s in (s1, s2):
        client.post(f"/api/prompts/{s['id']}/publish", headers=a["headers"], json={"acknowledge_risk": True})
    assert client.post(f"/api/prompt-workflows/{wf['id']}/publish", headers=a["headers"], json={}).status_code == 200
    got = client.get(f"/api/prompt-workflows/{wf['id']}", headers=b["headers"]).json()
    assert got["owned"] is False and "org_id" not in got
    assert wf["id"] in [w["id"] for w in client.get("/api/prompt-workflows?scope=public", headers=b["headers"]).json()["workflows"]]
    assert client.delete(f"/api/prompt-workflows/{wf['id']}", headers=b["headers"]).status_code == 404
    assert client.delete(f"/api/prompt-workflows/{wf['id']}", headers=a["headers"]).status_code == 200
