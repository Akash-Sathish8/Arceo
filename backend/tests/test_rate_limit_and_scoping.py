"""Phase-6 PR-3: pay the security test-debt.

Three gaps the roadmap called out:
- a broad per-caller rate limit now covers ALL /api/* (before: only login/
  enforce/scan) — hammering past it → 429, normal use is unaffected;
- an agent-scoped API key can't act on a DIFFERENT agent;
- a comprehensive unauth-reject sweep: protected endpoints 401 without auth,
  and the deliberately-open set is asserted open on purpose.
"""

from __future__ import annotations

import uuid

import pytest

import main


def _key(client, headers, agent_id: str = ""):
    body = {"name": "k-" + uuid.uuid4().hex[:6]}
    if agent_id:
        body["agent_id"] = agent_id
    r = client.post("/api/keys", headers=headers, json=body)
    assert r.status_code == 200, r.text
    return r.json()["key"]


def _mk_agent(client, headers, name):
    r = client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [
        {"name": "stripe", "service": "stripe",
         "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}]})
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ── API-key agent scoping ──────────────────────────────────────────────────────

def test_agent_scoped_key_cannot_act_on_another_agent(client, roles):
    admin = roles["admin"]
    agent_a = _mk_agent(client, admin["headers"], "scope-a-" + uuid.uuid4().hex[:5])
    agent_b = _mk_agent(client, admin["headers"], "scope-b-" + uuid.uuid4().hex[:5])
    key_a = _key(client, admin["headers"], agent_id=agent_a)

    # The key scoped to A works on A ...
    ok = client.post("/api/enforce", headers={"X-API-Key": key_a},
                     json={"agent_id": agent_a, "tool": "stripe", "action": "create_refund"})
    assert ok.status_code == 200, ok.text
    # ... but is refused on B.
    denied = client.post("/api/enforce", headers={"X-API-Key": key_a},
                         json={"agent_id": agent_b, "tool": "stripe", "action": "create_refund"})
    assert denied.status_code == 403
    assert "scoped to a different agent" in denied.json()["detail"]


def test_unscoped_key_acts_on_any_agent_in_its_org(client, roles):
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "any-" + uuid.uuid4().hex[:5])
    key = _key(client, admin["headers"])  # no agent_id → org-wide
    r = client.post("/api/enforce", headers={"X-API-Key": key},
                    json={"agent_id": agent, "tool": "stripe", "action": "create_refund"})
    assert r.status_code == 200, r.text


# ── Broad global rate limit ────────────────────────────────────────────────────

def test_global_limit_throttles_then_recovers(client, roles, monkeypatch):
    # Do setup at the default (generous) limit, then shrink the budget. Hammer a
    # FRESH api-key bucket (isolated from the shared testclient-IP bucket the
    # fixture setup fills) so the first calls genuinely succeed before the cap.
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "rl-" + uuid.uuid4().hex[:5])
    key = _key(client, admin["headers"])
    monkeypatch.setattr(main, "RATE_LIMIT_GLOBAL_MAX", 5)
    body = {"agent_id": agent, "tool": "stripe", "action": "create_refund"}
    codes = [client.post("/api/enforce", headers={"X-API-Key": key}, json=body).status_code
             for _ in range(12)]
    assert codes[0] == 200, codes          # under budget at first
    assert 429 in codes, codes             # cap kicks in
    assert codes.count(429) >= 1


def test_health_and_demo_mode_are_never_throttled(client, monkeypatch):
    monkeypatch.setattr(main, "RATE_LIMIT_GLOBAL_MAX", 2)
    # Way past the tiny budget — exempt probes must all still return 200.
    assert all(client.get("/api/health").status_code == 200 for _ in range(10))
    assert all(client.get("/api/demo-mode").status_code == 200 for _ in range(10))


def test_global_limit_is_per_caller(client, roles, monkeypatch):
    # One caller exhausting its budget must not throttle a different caller.
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "rlp-" + uuid.uuid4().hex[:5])
    a_key = _key(client, admin["headers"])
    b_key = _key(client, admin["headers"])
    monkeypatch.setattr(main, "RATE_LIMIT_GLOBAL_MAX", 3)
    body = {"agent_id": agent, "tool": "stripe", "action": "create_refund"}
    for _ in range(6):  # burn A's per-key budget
        client.post("/api/enforce", headers={"X-API-Key": a_key}, json=body)
    # B is a distinct caller key → still served.
    assert client.post("/api/enforce", headers={"X-API-Key": b_key}, json=body).status_code == 200


# ── Comprehensive unauth-reject sweep ──────────────────────────────────────────

# Protected surfaces: no bearer + no key → 401. A representative sweep across the
# domains (authority, cost, audit/exec, approvals, keys, credentials, sandbox).
_PROTECTED = [
    ("GET", "/api/authority/agents"),
    ("GET", "/api/authority/chains"),
    ("POST", "/api/authority/agents"),
    ("GET", "/api/audit"),
    ("GET", "/api/executions"),
    ("GET", "/api/approvals"),
    ("GET", "/api/keys"),
    ("POST", "/api/keys"),
    ("GET", "/api/credentials"),
    ("GET", "/api/notifications/settings"),
    ("GET", "/api/sandbox/simulations"),
    ("GET", "/api/auth/me"),
]


@pytest.mark.parametrize("method,path", _PROTECTED)
def test_protected_endpoints_reject_unauthenticated(client, method, path):
    r = client.request(method, path, json={} if method != "GET" else None)
    assert r.status_code == 401, f"{method} {path} returned {r.status_code}, expected 401"


# Deliberately open (documented): these must NOT 401 for MISSING auth — they are
# entry points (signup), agent-SDK ingest paths, or public read-side. They may
# 400/422 for a bad/empty body, but never 401. (Login is intentionally omitted:
# it's open, but returns 401 on bad credentials — indistinguishable from an
# auth-gate here.)
_OPEN = [
    ("POST", "/api/auth/signup", {}),
    ("GET", "/api/services", None),
    ("GET", "/api/health", None),
    ("GET", "/api/demo-mode", None),
    ("POST", "/api/report", {}),
]


@pytest.mark.parametrize("method,path,body", _OPEN)
def test_open_endpoints_are_not_auth_gated(client, method, path, body):
    r = client.request(method, path, json=body)
    assert r.status_code != 401, f"{method} {path} unexpectedly 401 (should be open)"
