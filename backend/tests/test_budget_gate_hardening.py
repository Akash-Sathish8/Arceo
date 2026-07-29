"""MED-004 — `_budget_gate` hardening.

PR #126 wired the gate into every server-key spender, but the gate itself was
still an ineffective control: off unless opted in, a no-op for agents with no
budget row, fail-open on internal error, TOCTOU between reading month-to-date
spend and spending, and it resolved the wallet from the caller-supplied
X-Agent-ID rather than the authenticated org.

These tests pin the five fixes. The suite runs with ARCEO_ENV=test (conftest), so
the new default-on behaviour is exercised by asserting on `_budget_enforcement_on`
directly rather than by unsetting the env for the whole app.
"""

from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
import redis
from fastapi import HTTPException

import main
import shared_state


def _mk_agent(client, headers, name):
    r = client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [
        {"name": "stripe", "service": "stripe",
         "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}]})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _key(client, headers, agent_id: str = ""):
    body = {"name": "k-" + uuid.uuid4().hex[:6]}
    if agent_id:
        body["agent_id"] = agent_id
    r = client.post("/api/keys", headers=headers, json=body)
    assert r.status_code == 200, r.text
    return r.json()["key"]


def _set_budget(client, headers, agent_id, usd):
    r = client.put(f"/api/agents/{agent_id}/budget", headers=headers,
                   json={"monthly_budget_usd": usd, "alert_threshold_pct": 80})
    assert r.status_code == 200, r.text


def _llm_call(client, api_key, agent_id):
    return client.post(f"/api/agent/{agent_id}/llm-call", headers={"X-API-Key": api_key},
                       json={"provider": "anthropic", "model": "claude-x", "response": {"ok": True}})


# ── Fix 1: enforce by default outside dev ─────────────────────────────────────

def test_enforcement_defaults_on_outside_dev(monkeypatch):
    """The old gate returned unless ARCEO_BUDGET_ENFORCE was truthy, so every stock
    deployment was warn-only. Unset now means ON anywhere ARCEO_ENV doesn't say dev."""
    monkeypatch.delenv("ARCEO_BUDGET_ENFORCE", raising=False)
    monkeypatch.setattr(main, "_IS_DEV_ENV", False)
    assert main._budget_enforcement_on() is True

    monkeypatch.setattr(main, "_IS_DEV_ENV", True)
    assert main._budget_enforcement_on() is False


@pytest.mark.parametrize("flag,expected", [
    ("1", True), ("true", True), ("on", True),
    ("0", False), ("false", False), ("off", False),
])
def test_explicit_flag_overrides_env_in_both_directions(monkeypatch, flag, expected):
    monkeypatch.setattr(main, "_IS_DEV_ENV", not expected)  # env disagrees with the flag
    monkeypatch.setenv("ARCEO_BUDGET_ENFORCE", flag)
    assert main._budget_enforcement_on() is expected


# ── Fix 2: budgetless agents fall back to an org-level cap ────────────────────

def test_budgetless_agent_is_capped_by_the_org_default(client, roles, monkeypatch):
    """Proxy auto-created agents never get an agent_budgets row, so a per-agent cap
    alone left the highest-volume path uncapped."""
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "orgcap-" + uuid.uuid4().hex[:5])
    key = _key(client, admin["headers"], agent_id=agent)

    monkeypatch.setenv("ARCEO_BUDGET_ENFORCE", "true")
    monkeypatch.setenv("ARCEO_DEFAULT_MONTHLY_BUDGET_USD", "5")
    monkeypatch.setattr(main, "_mtd_spend_from_audit", lambda conn, org_id, agent_id: 9.0)

    r = _llm_call(client, key, agent)
    assert r.status_code == 429, r.text
    assert "workspace" in r.json()["detail"].lower()


def test_budgetless_agent_uncapped_when_no_org_default(client, roles, monkeypatch):
    """Unset ARCEO_DEFAULT_MONTHLY_BUDGET_USD keeps the previous behaviour so the
    change can't surprise a running deployment."""
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "nocap-" + uuid.uuid4().hex[:5])
    key = _key(client, admin["headers"], agent_id=agent)

    monkeypatch.setenv("ARCEO_BUDGET_ENFORCE", "true")
    monkeypatch.delenv("ARCEO_DEFAULT_MONTHLY_BUDGET_USD", raising=False)
    monkeypatch.setattr(main, "_mtd_spend_from_audit", lambda conn, org_id, agent_id: 9_999.0)

    assert _llm_call(client, key, agent).status_code == 200


# ── Fix 3: fail closed ────────────────────────────────────────────────────────

def test_gate_fails_closed_on_internal_error(client, roles, monkeypatch):
    """`except Exception: return` meant a broken gate was an open gate."""
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "failclosed-" + uuid.uuid4().hex[:5])
    _set_budget(client, admin["headers"], agent, 10.0)
    key = _key(client, admin["headers"], agent_id=agent)

    monkeypatch.setenv("ARCEO_BUDGET_ENFORCE", "true")

    def _boom(*a, **k):
        raise RuntimeError("counter backend is confused")

    monkeypatch.setattr(shared_state, "spend_reserve", _boom)
    r = _llm_call(client, key, agent)
    assert r.status_code == 503, r.text
    assert "not made" in r.json()["detail"].lower()


def test_redis_outage_still_enforces_from_the_audit_log(client, roles, monkeypatch):
    """Chosen fallback: an unreachable Redis must not 503 the whole spend path, but
    it must not admit an over-budget call either."""
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "redisdown-" + uuid.uuid4().hex[:5])
    _set_budget(client, admin["headers"], agent, 10.0)
    key = _key(client, admin["headers"], agent_id=agent)

    monkeypatch.setenv("ARCEO_BUDGET_ENFORCE", "true")

    def _down(*a, **k):
        raise redis.ConnectionError("connection refused")

    monkeypatch.setattr(shared_state, "spend_reserve", _down)
    monkeypatch.setattr(main, "_mtd_spend_from_audit", lambda conn, org_id, agent_id: 25.0)
    assert _llm_call(client, key, agent).status_code == 429

    # ...and an under-budget call still goes through while Redis is down.
    monkeypatch.setattr(main, "_mtd_spend_from_audit", lambda conn, org_id, agent_id: 1.0)
    assert _llm_call(client, key, agent).status_code == 200


# ── Fix 4: the wallet is the authenticated org, not the caller's X-Agent-ID ───

def test_budget_row_of_another_org_does_not_gate_this_caller(client, two_orgs, monkeypatch):
    """Org B's agent carries a $10 cap that is already blown. Org A naming that
    agent must be measured against org A's own (absent) wallet, not org B's."""
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    b_agent = _mk_agent(client, b["headers"], "victim-" + uuid.uuid4().hex[:5])
    _set_budget(client, b["headers"], b_agent, 10.0)

    monkeypatch.setenv("ARCEO_BUDGET_ENFORCE", "true")
    monkeypatch.delenv("ARCEO_DEFAULT_MONTHLY_BUDGET_USD", raising=False)
    monkeypatch.setattr(main, "_mtd_spend_from_audit", lambda conn, org_id, agent_id: 999.0)

    # No cap resolves for org A -> the gate is a no-op and does NOT consult org B's
    # budget row. (The call is still rejected downstream by the cross-org check;
    # what matters here is that the gate never reached for the other tenant's wallet.)
    with main.get_db() as conn:
        assert main._budget_caps(conn, b_agent, a["org_id"]) == []
        caps = main._budget_caps(conn, b_agent, b["org_id"])
    assert [c[2] for c in caps] == [10.0], caps


def test_gate_counter_is_scoped_per_org_for_the_default_cap(client, two_orgs, monkeypatch):
    monkeypatch.setenv("ARCEO_DEFAULT_MONTHLY_BUDGET_USD", "5")
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    agent = _mk_agent(client, a["headers"], "scope-" + uuid.uuid4().hex[:5])
    with main.get_db() as conn:
        scope_a = main._budget_caps(conn, agent, a["org_id"])[0][0]
        scope_b = main._budget_caps(conn, agent, b["org_id"])[0][0]
    assert scope_a != scope_b
    assert a["org_id"] in scope_a and b["org_id"] in scope_b


# ── Fix 5: no TOCTOU — the check and the charge are one atomic op ─────────────

def test_concurrent_reservations_cannot_exceed_the_cap():
    """N racing callers against a cap that admits M < N of them: the old read-then-
    spend sequence let them all observe "under budget" and pass. `spend_reserve` is
    a single Redis script, so exactly M are admitted."""
    scope = "test:toctou:" + uuid.uuid4().hex[:8]
    cap, amount = 1.0, 0.1
    shared_state.spend_hydrate(scope, 0.0)

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(
            lambda _: shared_state.spend_reserve(scope, cap, amount)[0], range(40)))

    admitted = results.count("ok")
    assert admitted == 10, results.count("over")          # 1.00 / 0.10, not one more
    assert shared_state.spend_total(scope) == pytest.approx(cap)


def test_settle_corrects_a_reservation_to_the_real_cost():
    scope = "test:settle:" + uuid.uuid4().hex[:8]
    shared_state.spend_hydrate(scope, 0.0)
    status, total = shared_state.spend_reserve(scope, 100.0, main.BUDGET_RESERVE_USD)
    assert status == "ok" and total == pytest.approx(main.BUDGET_RESERVE_USD)

    ticket = {"reserved": main.BUDGET_RESERVE_USD, "scopes": [scope]}
    main._budget_settle(ticket, 0.42)
    assert shared_state.spend_total(scope) == pytest.approx(0.42)

    # Releasing (upstream never ran) returns the counter to where it started.
    shared_state.spend_reserve(scope, 100.0, main.BUDGET_RESERVE_USD)
    main._budget_settle(ticket, 0.0)
    assert shared_state.spend_total(scope) == pytest.approx(0.42)


def test_settle_never_resurrects_an_expired_counter():
    """A settle against a counter that has since expired must not recreate it holding
    only that delta — that would under-count the month and re-open the cap."""
    scope = "test:expired:" + uuid.uuid4().hex[:8]
    main._budget_settle({"reserved": 0.05, "scopes": [scope]}, 5.0)
    assert shared_state.spend_total(scope) is None


def test_cold_counter_is_seeded_from_the_audit_log(client, roles, monkeypatch):
    """First call of the month has no counter; the gate hydrates it from the system
    of record rather than starting the month at zero."""
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "cold-" + uuid.uuid4().hex[:5])
    _set_budget(client, admin["headers"], agent, 10.0)
    key = _key(client, admin["headers"], agent_id=agent)

    monkeypatch.setenv("ARCEO_BUDGET_ENFORCE", "true")
    monkeypatch.setattr(main, "_mtd_spend_from_audit", lambda conn, org_id, agent_id: 12.0)

    # Cold Redis + $12 already spent against a $10 cap -> blocked on the first call.
    assert _llm_call(client, key, agent).status_code == 429


# ── The gate still lets normal traffic through ────────────────────────────────

def test_under_budget_calls_are_recorded_and_the_counter_advances(client, roles, monkeypatch):
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "under-" + uuid.uuid4().hex[:5])
    _set_budget(client, admin["headers"], agent, 100.0)
    key = _key(client, admin["headers"], agent_id=agent)

    monkeypatch.setenv("ARCEO_BUDGET_ENFORCE", "true")
    monkeypatch.setattr(main, "_mtd_spend_from_audit", lambda conn, org_id, agent_id: 0.0)

    assert _llm_call(client, key, agent).status_code == 200
    with main.get_db() as conn:
        scope = main._budget_caps(conn, agent, admin["org_id"])[0][0]
    # The reservation was settled to this call's real cost (0.0 — the stub payload
    # carries no usage), so a no-usage call leaves the counter where it was.
    assert shared_state.spend_total(scope) == pytest.approx(0.0)


def test_server_key_spenders_check_without_reserving(client, roles, monkeypatch):
    """Sandbox/red-team run authenticated and already carry a per-request call
    ceiling, so they read the counter rather than holding a reservation nobody
    settles."""
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "noresv-" + uuid.uuid4().hex[:5])
    _set_budget(client, admin["headers"], agent, 10.0)

    monkeypatch.setenv("ARCEO_BUDGET_ENFORCE", "true")
    monkeypatch.setattr(main, "_mtd_spend_from_audit", lambda conn, org_id, agent_id: 1.0)

    assert main._budget_gate(agent, admin["org_id"]) is None  # no ticket to settle
    with main.get_db() as conn:
        scope = main._budget_caps(conn, agent, admin["org_id"])[0][0]
    assert shared_state.spend_total(scope) == pytest.approx(1.0)  # hydrated, not charged

    monkeypatch.setattr(main, "_mtd_spend_from_audit", lambda conn, org_id, agent_id: 50.0)
    shared_state.spend_adjust(scope, 49.0)
    with pytest.raises(HTTPException) as e:
        main._budget_gate(agent, admin["org_id"])
    assert e.value.status_code == 429
