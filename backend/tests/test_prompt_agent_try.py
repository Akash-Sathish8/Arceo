"""Prompt library: try a prompt on one of your own agents (blast radius + efficiency)."""

from __future__ import annotations

import uuid

import pytest

from prompts import agent_try, qa
from sandbox import analyzer, runner

BODY = "Read the customer's email below and reply. If they ask for their money back, issue a refund.\n{{email}}"
AGENT_TOOLS = [
    {"name": "stripe", "service": "stripe",
     "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]},
    {"name": "sendgrid", "service": "sendgrid",
     "actions": [{"action": "send_email", "risk_labels": ["sends_external"], "reversible": False}]},
]


def fake_call(model_key, provider, system, user_text, org_id, max_tokens=1024, api_key=None):
    return {"text": "{}", "input_tokens": 10, "output_tokens": 5, "latency_ms": 1}


class FakeAgentLLM:
    """Turn 1 refunds, turn 2 stops. Records the system prompt and first user message."""

    def __init__(self):
        self.calls = []

    def __call__(self, model, system_prompt, messages, tools, api_key=None):
        self.calls.append({"system": system_prompt, "first_user": messages[0]["content"], "api_key": api_key})
        usage = {"usage": {"input_tokens": 1000, "output_tokens": 100}}
        if len(self.calls) == 1:
            return runner.LLMResponse(text_blocks=[], stop_reason="tool_use", raw=usage, tool_calls=[
                {"id": "t1", "name": "stripe__create_refund", "input": {"amount": 50}}])
        return runner.LLMResponse(text_blocks=[{"type": "text", "text": "Done."}], tool_calls=[],
                                  stop_reason="end_turn", raw=usage)


@pytest.fixture(autouse=True)
def _fakes(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-real")
    monkeypatch.setattr(qa, "call_model", fake_call)


@pytest.fixture()
def org(client):
    from tests.prompt_helpers import signup as _signup_org
    return _signup_org(client, f"try-{uuid.uuid4().hex[:8]}@example.com")


def _agent(client, org, **over) -> str:
    r = client.post("/api/authority/agents", headers=org["headers"], json={
        "name": "support-" + uuid.uuid4().hex[:6], "description": "Answers customer email",
        "tools": AGENT_TOOLS, "simulation_model": "claude-haiku-4-5", "expected_calls_per_day": 100, **over})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _prompt(client, org) -> dict:
    r = client.post("/api/prompts", headers=org["headers"], json={
        "title": "Refund replies", "body": BODY,
        "variables": {"email": {"sample": "I want a refund for order 42.", "untrusted": True}},
        "expected_output_tokens": 300})
    assert r.status_code == 200, r.text
    return r.json()


# ── building ─────────────────────────────────────────────────────────────

def test_modes_build_different_messages():
    prompt = {"id": "p1", "body": "Be terse. {{x}}", "variables": {"x": {"sample": "hello"}}}
    agent = {"id": "a1", "name": "Ops bot", "description": "Runs ops"}
    system, user_msg = agent_try.build_try(prompt, agent, "instructions", None)
    assert system == "Be terse. hello" and "Ops bot" in user_msg
    system, user_msg = agent_try.build_try(prompt, agent, "instructions", "Restart the web tier")
    assert user_msg == "Restart the web tier"
    system, user_msg = agent_try.build_try(prompt, agent, "task", "ignored")
    assert system is None and user_msg == "Be terse. hello"


# ── estimate ─────────────────────────────────────────────────────────────

def test_estimate_is_free_and_bounded_by_the_ceiling(client, org, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("the estimate must not call an LLM")
    monkeypatch.setattr(runner, "_call_llm", boom)
    monkeypatch.setattr(analyzer, "_generate_executive_summary", boom)
    aid, p = _agent(client, org), _prompt(client, org)
    for mode in ("task", "instructions"):
        r = client.post(f"/api/prompts/{p['id']}/agent-try/estimate", headers=org["headers"],
                        json={"agent_id": aid, "mode": mode})
        assert r.status_code == 200, r.text
        d = r.json()
        br = d["blast_radius"]
        assert br["ceiling"]["score"] > 0
        assert 0 <= br["reachable"]["score"] <= br["ceiling"]["score"]
        assert d["efficiency"]["available"] and d["efficiency"]["usd_per_run"] > 0
        assert d["efficiency"]["usd_per_month"] == pytest.approx(d["efficiency"]["usd_per_run"] * 100 * 30, rel=1e-3)
        assert "delta_pct" in d["efficiency"]
    # The untrusted {{email}} meets an agent that can move money and send email.
    assert any("injected" in o["title"] for o in br["overlaps"])


def test_estimate_follows_unsaved_body(client, org):
    aid, p = _agent(client, org), _prompt(client, org)
    r = client.post(f"/api/prompts/{p['id']}/agent-try/estimate", headers=org["headers"],
                    json={"agent_id": aid, "mode": "task", "body": "Just say hi."})
    assert r.status_code == 200 and r.json()["user_message"] == "Just say hi."


def test_estimate_refuses_another_orgs_agent(client, org):
    from tests.prompt_helpers import signup as _signup_org
    other = _signup_org(client, f"try-other-{uuid.uuid4().hex[:8]}@example.com")
    aid, p = _agent(client, other), _prompt(client, org)
    r = client.post(f"/api/prompts/{p['id']}/agent-try/estimate", headers=org["headers"],
                    json={"agent_id": aid, "mode": "task"})
    assert r.status_code == 404


# ── real run ─────────────────────────────────────────────────────────────

def test_run_measures_meters_and_stores(client, org, monkeypatch):
    fake = FakeAgentLLM()
    monkeypatch.setattr(runner, "_call_llm", fake)
    aid, p = _agent(client, org), _prompt(client, org)
    r = client.post(f"/api/prompts/{p['id']}/agent-try/run", headers=org["headers"],
                    json={"agent_id": aid, "mode": "instructions", "task": "Customer wants order 42 refunded"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert fake.calls[0]["system"].startswith("Read the customer's email")
    assert fake.calls[0]["first_user"] == "Customer wants order 42 refunded"
    eff = d["efficiency"]
    assert eff["turns"] == 2 and eff["input_tokens"] == 2000 and eff["output_tokens"] == 200
    assert eff["tool_calls"] == 1 and eff["usd_per_run"] > 0
    assert [a["action"] for a in d["blast_radius"]["actions"]] == ["create_refund"]
    from db import get_db
    with get_db() as conn:
        sim = conn.execute("SELECT scenario_id, run_mode FROM simulations WHERE id = %s",
                           (d["simulation_id"],)).fetchone()
        usage = conn.execute("SELECT kind, key_source FROM prompt_usage WHERE org_id = %s",
                             (org["org_id"],)).fetchall()
    assert sim["scenario_id"] == f"prompt:{p['id']}" and sim["run_mode"] == "live"
    assert [(u["kind"], u["key_source"]) for u in usage] == [("agent_try", "server")]


def test_run_stops_when_free_runs_are_used(client, org, monkeypatch):
    fake = FakeAgentLLM()
    monkeypatch.setattr(runner, "_call_llm", fake)
    monkeypatch.setattr(qa, "FREE_RUNS", 0)
    aid, p = _agent(client, org), _prompt(client, org)
    r = client.post(f"/api/prompts/{p['id']}/agent-try/run", headers=org["headers"],
                    json={"agent_id": aid, "mode": "task"})
    assert r.status_code == 429 and fake.calls == []
