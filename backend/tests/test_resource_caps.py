"""PR 2B — bounded resource use (MED-003/004/005/006/008, LOW-015).

These are DoS / cost-amplification guards: a request body size ceiling, input-model
fan-out caps, a shared multi-agent LLM-call budget, per-agent WebSocket connection
caps, and transaction-local DB statement/lock timeouts.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

import main
import shared_state
from db import get_db
from sandbox.multi_runner import _SimBudget, MAX_TOTAL_LLM_CALLS


# ── MED-006: request body size + input model caps ──────────────────────────────

def test_body_size_guard_rejects_oversized(client, monkeypatch):
    monkeypatch.setattr(main, "MAX_BODY_BYTES", 50)
    r = client.post("/api/auth/login", json={"email": "a@b.com", "password": "x" * 500})
    assert r.status_code == 413


def test_scan_request_caps_file_count():
    with pytest.raises(ValidationError):
        main.ScanRequest(files=[{"path": f"f{i}.py", "content": "x"} for i in range(51)])


def test_scan_file_caps_content_length():
    with pytest.raises(ValidationError):
        main.ScanFileInput(path="a.py", content="x" * 200_001)


def test_register_agent_caps_tool_fanout():
    with pytest.raises(ValidationError):
        main.RegisterAgentInput(name="x", tools=[{"name": f"t{i}"} for i in range(201)])


def test_extract_caps_content_length():
    with pytest.raises(ValidationError):
        main.ExtractInput(content="x" * 200_001)


# ── MED-003 / LOW-015: shared multi-agent LLM-call budget ──────────────────────

def test_sim_budget_bounds_total_calls():
    b = _SimBudget(2)
    assert b.take() is True
    assert b.take() is True
    assert b.take() is False  # third call refused
    assert MAX_TOTAL_LLM_CALLS > 0


# ── HIGH-003: the per-request budget is honored by the server-key spenders ───────

def test_run_simulation_stops_when_budget_exhausted(monkeypatch):
    """A single run_simulation given an exhausted budget makes ZERO model calls
    (a sweep shares one budget across all scenarios, so this is how the ceiling bites)."""
    import sandbox.runner as runner
    from sandbox.prompts.scenarios import ALL_SCENARIOS
    calls = {"n": 0}
    monkeypatch.setattr(runner, "_call_llm", lambda *a, **k: calls.__setitem__("n", calls["n"] + 1))
    trace = runner.run_simulation({"id": "a", "name": "A", "tools": []}, ALL_SCENARIOS[0],
                                  budget=runner._SimBudget(0))
    assert calls["n"] == 0
    assert trace.status == "error" and "budget" in (trace.error or "").lower()


def test_run_red_team_stops_when_budget_exhausted(monkeypatch):
    """run_red_team stops issuing attacks once the shared per-request budget is spent,
    so its goals × turns fan-out can't run unbounded on the server key."""
    import sandbox.red_team as rt
    monkeypatch.setattr(rt, "_generate_goals", lambda cfg: [{"attack": "prompt_injection", "target": "x"}] * 5)
    gen = {"n": 0}
    run = {"n": 0}
    monkeypatch.setattr(rt, "_generate_adversarial_input",
                        lambda *a, **k: (gen.__setitem__("n", gen["n"] + 1), "adv")[1])
    monkeypatch.setattr(rt, "_run_agent_with_input",
                        lambda *a, **k: (run.__setitem__("n", run["n"] + 1), ("", []))[1])
    report = rt.run_red_team({"id": "a", "name": "A"}, api_key="test-key", budget=rt._SimBudget(0))
    assert gen["n"] == 0 and run["n"] == 0     # goal loop broke before any attack ran
    assert report.total_attacks == 0


# ── MED-008: per-agent WebSocket connection cap ────────────────────────────────

def test_ws_connection_slot_cap():
    aid = "cap-agent"
    assert all(shared_state.ws_acquire_slot(aid, 3) for _ in range(3))
    assert shared_state.ws_acquire_slot(aid, 3) is False  # 4th over the cap
    shared_state.ws_release_slot(aid)
    assert shared_state.ws_acquire_slot(aid, 3) is True   # freed slot reusable


# ── MED-005: transaction-local statement/lock timeouts ─────────────────────────

def test_db_statement_and_lock_timeouts_applied():
    with get_db() as conn:
        stmt = conn.execute("SHOW statement_timeout").fetchone()["statement_timeout"]
        lock = conn.execute("SHOW lock_timeout").fetchone()["lock_timeout"]
    # Non-zero means a bound is in force (postgres formats e.g. '15s', '5s').
    assert stmt not in ("0", "0ms")
    assert lock not in ("0", "0ms")
