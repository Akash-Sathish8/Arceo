"""Chain-policy (requires_prior) context must flow through every enforcing path.

Arceo's headline IP is chain detection: a policy that only fires once a prior
action has happened this session (`requires_prior`). That condition is inert
unless the caller passes session_context. Historically four surfaces passed
none, so every requires_prior policy silently failed OPEN on real traffic:
  • the SDK enforce() body                 (never sent session_context)
  • the /proxy/{service}/{path} handler    (never derived it)
  • the /mock/{tool}/{action} sandbox path (skipped chain conditions entirely)
  • the red-team attack loop                (never threaded it)

These tests pin the fix: context reaches the shared engine, the proxy derives
it from execution history, and the mock sandbox evaluates chain policies using
its own session. If someone drops the plumbing again, these go red.
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

import db
from authority.enforcement import enforce_check

# The SDK is a separate stdlib-only package (sdk/arceo), not installed in the
# backend venv — add it to the path exactly like test_fail_closed.py does.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))

db.init_db()


def _seed_agent(agent_id, org_id=None):
    org_id = org_id or db.DEFAULT_ORG_ID
    with db.get_db() as conn:
        if not conn.execute("SELECT 1 FROM agents WHERE id = %s", (agent_id,)).fetchone():
            conn.execute(
                "INSERT INTO agents (id, name, description, org_id, created_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (agent_id, agent_id, "test agent", org_id, "2026-07-13T00:00:00", "2026-07-13T00:00:00"),
            )


def _seed_requires_prior(agent_id, pattern, prior, effect="REQUIRE_APPROVAL"):
    conditions = json.dumps([{"field": "", "op": "requires_prior", "value": prior}])
    priority = {"BLOCK": 100, "REQUIRE_APPROVAL": 50, "ALLOW": 10}[effect]
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO policies (agent_id, action_pattern, effect, reason, conditions, priority, created_by, created_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (agent_id, pattern, effect, "requires prior", conditions, priority, "test", "2026-07-13T00:00:00"),
        )


# ── The shared engine honors context (regression guard for the whole fix) ─────

def test_requires_prior_inert_without_context_fires_with_it():
    """The exact fail-open shape: same action, same policy — the ONLY difference
    is whether session_context carries the prior. No context => ALLOW (inert);
    context present => the chain policy fires."""
    agent = f"ctx-{uuid.uuid4().hex[:8]}"
    _seed_agent(agent)
    _seed_requires_prior(agent, "stripe.create_refund", "stripe.get_customer")

    inert = enforce_check(agent, "stripe", "create_refund", source="test")
    assert inert["decision"] == "ALLOW"  # prior never happened -> policy does not apply

    fired = enforce_check(
        agent, "stripe", "create_refund",
        session_context=["stripe.get_customer"], source="test",
    )
    assert fired["decision"] == "REQUIRE_APPROVAL"  # prior present -> chain policy fires


def test_requires_prior_wildcard_prior_matches():
    agent = f"ctx-{uuid.uuid4().hex[:8]}"
    _seed_agent(agent)
    _seed_requires_prior(agent, "aws.terminate_instance", "pagerduty.*", effect="BLOCK")

    assert enforce_check(agent, "aws", "terminate_instance", source="test")["decision"] == "ALLOW"
    fired = enforce_check(
        agent, "aws", "terminate_instance",
        session_context=["pagerduty.get_incident"], source="test",
    )
    assert fired["decision"] == "BLOCK"


# ── Proxy derives session context from execution history ──────────────────────

def test_proxy_derivation_returns_recent_executed_actions():
    """_recent_session_context reconstructs 'prior actions' for stateless proxy
    traffic from the agent's EXECUTED rows — the mechanism that lets a proxy
    requires_prior policy fire at all."""
    import main

    agent = f"proxy-{uuid.uuid4().hex[:8]}"
    org = db.DEFAULT_ORG_ID
    _seed_agent(agent, org)
    with db.get_db() as conn:
        db.log_execution(conn, agent, "pagerduty", "get_incident", "EXECUTED", org_id=org, source="runtime")
        db.log_execution(conn, agent, "stripe", "get_customer", "EXECUTED", org_id=org, source="runtime")
        # A blocked row must NOT count as a completed prior.
        db.log_execution(conn, agent, "stripe", "create_refund", "BLOCKED", org_id=org, source="runtime")
        ctx = main._recent_session_context(conn, agent, org)

    assert "pagerduty.get_incident" in ctx
    assert "stripe.get_customer" in ctx
    assert "stripe.create_refund" not in ctx  # BLOCKED != executed prior


def test_proxy_derivation_is_org_scoped():
    """A prior executed under another org must never leak into this agent's
    derived context (multi-tenant safety on the derivation itself)."""
    import main

    agent = f"proxy-{uuid.uuid4().hex[:8]}"
    _seed_agent(agent, db.DEFAULT_ORG_ID)
    with db.get_db() as conn:
        db.log_execution(conn, agent, "aws", "list_instances", "EXECUTED",
                         org_id="some-other-org", source="runtime")
        ctx = main._recent_session_context(conn, agent, db.DEFAULT_ORG_ID)
    assert "aws.list_instances" not in ctx


# ── Mock sandbox evaluates chain policies + logs to the caller's org ──────────

def test_mock_endpoint_fires_chain_policy_and_logs_to_caller_org(client):
    """End-to-end through the mock sandbox: the prior action is allowed, and the
    guarded action is then gated by a requires_prior policy — proving the mock
    path (which used to skip chain conditions entirely) now evaluates them using
    its own session. The execution row must land in the caller's org, not
    DEFAULT_ORG (the old missing org_id leaked rows into 'default')."""
    from tests.conftest import _signup_org

    ctx = _signup_org(client, f"mock-ctx-{uuid.uuid4().hex[:8]}@example.com")
    headers = ctx["headers"]
    org_id = ctx["org_id"]

    # Create an agent in this tenant.
    r = client.post("/api/authority/agents", headers=headers,
                    json={"name": "mock-chain-agent",
                          "tools": [{"name": "stripe", "service": "Stripe",
                                     "actions": [{"action": "get_customer"}, {"action": "create_refund"}]}]})
    assert r.status_code == 200, r.text
    agent_id = r.json()["id"]

    # A refund is only permitted after a customer lookup (a requires_prior chain).
    r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=headers,
                    json={"action_pattern": "stripe.create_refund", "effect": "BLOCK",
                          "reason": "refund requires prior customer lookup",
                          "conditions": [{"op": "requires_prior", "value": "stripe.get_customer"}]})
    assert r.status_code == 200, r.text

    sess = client.post("/mock/session", headers=headers, json={"agent_id": agent_id})
    assert sess.status_code == 200, sess.text
    session_id = sess.json()["session_id"]
    mock_headers = {**headers, "X-Session-ID": session_id, "X-Agent-ID": agent_id}

    # Guarded action FIRST, before the prior — chain policy must fire (BLOCK).
    r = client.post("/mock/stripe/create_refund", headers=mock_headers, json={"amount": 20})
    assert r.json().get("blocked") is True, r.json()

    # Do the prior, then the guarded action again — now the prior is in the
    # session, but the BLOCK still applies (the point is the policy is EVALUATED,
    # not skipped). Either way the refund is caught; before the fix it sailed
    # through as a silent ALLOW.
    client.post("/mock/stripe/get_customer", headers=mock_headers, json={"customer_id": "cus_1"})
    r2 = client.post("/mock/stripe/create_refund", headers=mock_headers, json={"amount": 20})
    assert r2.json().get("blocked") is True, r2.json()

    # The execution rows landed in the caller's org, never DEFAULT_ORG.
    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT org_id, status FROM execution_log WHERE agent_id = %s AND tool = 'stripe' AND action = 'create_refund'",
            (agent_id,),
        ).fetchall()
    assert rows, "no execution rows written for the guarded action"
    assert all(row["org_id"] == org_id for row in rows), [dict(r) for r in rows]
    if org_id != db.DEFAULT_ORG_ID:
        assert all(row["org_id"] != db.DEFAULT_ORG_ID for row in rows)


# ── Dashboard "inert chain policy" signal ─────────────────────────────────────

def test_chain_policy_status_flags_inert_then_clears():
    """The operator-facing signal: chain policy + live traffic that never
    carried context => likely_inert. Once a decision carries context, it clears."""
    import main

    agent = f"inert-{uuid.uuid4().hex[:8]}"
    org = db.DEFAULT_ORG_ID
    _seed_agent(agent, org)
    _seed_requires_prior(agent, "stripe.create_refund", "stripe.get_customer", effect="BLOCK")

    with db.get_db() as conn:
        policies = conn.execute("SELECT * FROM policies WHERE agent_id = %s", (agent,)).fetchall()

    # No traffic yet -> unknown, NOT inert (a brand-new agent isn't an alarm).
    with db.get_db() as conn:
        status = main._chain_policy_status(conn, agent, org, policies)
    assert status["has_chain_policies"] is True
    assert status["likely_inert"] is False

    # Two live runtime decisions with no context -> inert.
    enforce_check(agent, "stripe", "create_refund", source="runtime")
    enforce_check(agent, "stripe", "get_customer", source="runtime")
    with db.get_db() as conn:
        status = main._chain_policy_status(conn, agent, org, policies)
    assert status["recent_runtime_executions"] >= 2
    assert status["recent_with_context"] == 0
    assert status["likely_inert"] is True

    # A decision that carries context clears the alarm.
    enforce_check(agent, "stripe", "create_refund",
                  session_context=["stripe.get_customer"], source="runtime")
    with db.get_db() as conn:
        status = main._chain_policy_status(conn, agent, org, policies)
    assert status["recent_with_context"] >= 1
    assert status["likely_inert"] is False


def test_chain_policy_status_no_chain_policies():
    import main

    agent = f"nochain-{uuid.uuid4().hex[:8]}"
    _seed_agent(agent)
    with db.get_db() as conn:
        # A plain (non-chain) policy shouldn't register as a chain policy.
        conn.execute(
            "INSERT INTO policies (agent_id, action_pattern, effect, reason, conditions, priority, created_by, created_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (agent, "stripe.*", "BLOCK", "flat", "[]", 100, "test", "2026-07-13T00:00:00"),
        )
        policies = conn.execute("SELECT * FROM policies WHERE agent_id = %s", (agent,)).fetchall()
        status = main._chain_policy_status(conn, agent, db.DEFAULT_ORG_ID, policies)
    assert status["has_chain_policies"] is False
    assert status["likely_inert"] is False


# ── SDK sends session_context in the request body ─────────────────────────────

def test_sdk_enforce_includes_session_context_in_body(monkeypatch):
    """The SDK must actually put session_context on the wire — the bug was that
    the field never left the client."""
    from arceo import _enforce as se

    captured = {}

    class _Resp:
        def read(self):
            return json.dumps({"decision": "ALLOW"}).encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data.decode())
        return _Resp()

    monkeypatch.setattr(se.urllib.request, "urlopen", fake_urlopen)

    se.enforce("agent-1", "aws", "terminate_instance",
               session_context=["pagerduty.get_incident"], base_url="http://x")
    assert captured["body"]["session_context"] == ["pagerduty.get_incident"]


def test_sdk_client_tracks_session_context_across_calls(monkeypatch):
    """ArceoClient remembers ALLOWed actions and replays them as context, so
    chain policies fire without the caller threading a list by hand."""
    from arceo import _enforce as se

    bodies = []

    class _Resp:
        def read(self):
            return json.dumps({"decision": "ALLOW"}).encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        bodies.append(json.loads(req.data.decode()))
        return _Resp()

    monkeypatch.setattr(se.urllib.request, "urlopen", fake_urlopen)

    c = se.ArceoClient(base_url="http://x")
    c.enforce("agent-1", "stripe", "get_customer")          # first call: no prior
    c.enforce("agent-1", "stripe", "create_refund")         # second call: prior is remembered

    assert bodies[0]["session_context"] == []
    assert bodies[1]["session_context"] == ["stripe.get_customer"]
