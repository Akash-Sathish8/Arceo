"""Tests for the 4 new features: label transitions, blast radius, conditional policies, sim recommendations."""

import pytest
import os
import json
import tempfile


# ═══════════════════════════════════════════════════════════════════════════════
# 1. RISK-LABEL TRANSITION CHAINS
# ═══════════════════════════════════════════════════════════════════════════════

class TestLabelTransitions:
    """Chain detection uses universal label transitions, not tool-specific patterns."""

    def test_all_transitions_have_required_fields(self):
        from authority.chain_detector import LABEL_TRANSITIONS
        for t in LABEL_TRANSITIONS:
            assert t.id, f"Transition missing id"
            assert t.name, f"{t.id} missing name"
            assert t.severity in ("critical", "high", "medium"), f"{t.id} bad severity: {t.severity}"
            assert t.from_label, f"{t.id} missing from_label"
            assert t.to_label, f"{t.id} missing to_label"

    def test_transitions_cover_all_label_pairs(self):
        """Every dangerous label pair should have at least one transition."""
        from authority.chain_detector import LABEL_TRANSITIONS
        pairs = {(t.from_label, t.to_label) for t in LABEL_TRANSITIONS}
        # These are the critical pairs that must exist
        assert ("touches_pii", "sends_external") in pairs  # exfiltration
        assert ("touches_pii", "moves_money") in pairs      # fraud
        assert ("touches_pii", "deletes_data") in pairs      # destruction
        assert ("moves_money", "moves_money") in pairs       # chained fraud
        assert ("changes_production", "deletes_data") in pairs  # infra destruction
        assert ("deletes_data", "deletes_data") in pairs     # mass wipe

    def test_custom_tool_detected_by_labels(self):
        """A completely custom tool gets chain detection via risk labels."""
        from authority.chain_detector import detect_chains
        from authority.parser import AgentConfig, ToolDef
        from authority.action_mapper import MappedAction

        agent = AgentConfig(id="custom", name="Custom", description="", tools=[
            ToolDef(name="crm", service="CRM", description="", actions=["lookup", "export"]),
        ])
        overrides = {
            "crm": {
                "lookup": MappedAction(tool="crm", service="CRM", action="lookup",
                                       description="", risk_labels=["touches_pii"], reversible=True),
                "export": MappedAction(tool="crm", service="CRM", action="export",
                                       description="", risk_labels=["sends_external"], reversible=False),
            }
        }
        result = detect_chains(agent, action_overrides=overrides)
        chain_ids = [fc.chain.id for fc in result.flagged_chains]
        assert "pii-exfil" in chain_ids

    def test_no_false_positive_for_single_label(self):
        """Agent with only one risk label shouldn't trigger cross-label chains."""
        from authority.chain_detector import detect_chains
        from authority.parser import AgentConfig, ToolDef
        from authority.action_mapper import MappedAction

        agent = AgentConfig(id="reader", name="Reader", description="", tools=[
            ToolDef(name="db", service="DB", description="", actions=["read_users", "read_orders"]),
        ])
        overrides = {
            "db": {
                "read_users": MappedAction(tool="db", service="DB", action="read_users",
                                           description="", risk_labels=["touches_pii"], reversible=True),
                "read_orders": MappedAction(tool="db", service="DB", action="read_orders",
                                            description="", risk_labels=["touches_pii"], reversible=True),
            }
        }
        result = detect_chains(agent, action_overrides=overrides)
        # Should not flag any cross-label chains
        cross_label = [fc for fc in result.flagged_chains if fc.chain.steps[0] != fc.chain.steps[1]]
        assert len(cross_label) == 0


# ═══════════════════════════════════════════════════════════════════════════════
# 2. BLAST RADIUS SCORING
# ═══════════════════════════════════════════════════════════════════════════════

class TestBlastRadiusScoring:
    """Scoring weights by destructiveness and reversibility, not just counts."""

    def test_irreversible_scores_higher_than_reversible(self):
        """An irreversible delete should score higher than a reversible one."""
        from authority.graph import _score_action
        from authority.action_mapper import MappedAction

        reversible = MappedAction(tool="x", service="X", action="delete_item",
                                  description="", risk_labels=["deletes_data"], reversible=True)
        irreversible = MappedAction(tool="x", service="X", action="delete_item",
                                    description="", risk_labels=["deletes_data"], reversible=False)

        assert _score_action(irreversible) > _score_action(reversible)

    def test_read_only_scores_low(self):
        """get_* actions should score much lower than write actions."""
        from authority.graph import _score_action
        from authority.action_mapper import MappedAction

        read = MappedAction(tool="x", service="X", action="get_customer",
                            description="", risk_labels=["touches_pii"], reversible=True)
        write = MappedAction(tool="x", service="X", action="delete_customer",
                             description="", risk_labels=["touches_pii", "deletes_data"], reversible=False)

        assert _score_action(write) > _score_action(read) * 5

    def test_terminate_outscores_five_reads(self):
        """One irreversible terminate_instance should outscore 5 reversible reads."""
        from authority.graph import _score_action
        from authority.action_mapper import MappedAction

        terminate = MappedAction(tool="aws", service="AWS", action="terminate_instance",
                                 description="", risk_labels=["changes_production", "deletes_data"],
                                 reversible=False)
        read = MappedAction(tool="stripe", service="Stripe", action="get_customer",
                            description="", risk_labels=["touches_pii"], reversible=True)

        assert _score_action(terminate) > _score_action(read) * 5

    def test_blast_radius_with_overrides(self):
        """Blast radius should work with custom tool overrides."""
        from authority.graph import calculate_blast_radius
        from authority.parser import AgentConfig, ToolDef
        from authority.action_mapper import MappedAction

        agent = AgentConfig(id="test", name="Test", description="", tools=[
            ToolDef(name="pay", service="Pay", description="", actions=["charge"]),
        ])
        overrides = {
            "pay": {
                "charge": MappedAction(tool="pay", service="Pay", action="charge",
                                       description="", risk_labels=["moves_money"], reversible=False),
            }
        }
        radius = calculate_blast_radius(agent, action_overrides=overrides)
        assert radius.score > 0
        assert radius.moves_money == 1
        assert radius.irreversible_actions == 1


# ═══════════════════════════════════════════════════════════════════════════════
# 3. CONDITIONAL POLICIES
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.fixture(scope="module")
def client():
    """Create a test client with a fresh database."""
    os.environ.setdefault("TESTING", "1")
    import db
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    db.DB_PATH = tmp.name
    tmp.close()
    from main import app
    db.init_db()
    with TestClient(app) as c:
        yield c
    os.unlink(tmp.name)


@pytest.fixture(scope="module")
def auth_headers(client):
    resp = client.post("/api/auth/login", json={"email": "admin@actiongate.io", "password": "admin123"})
    return {"Authorization": f"Bearer {resp.json()['token']}"}


@pytest.fixture(scope="module")
def agent_id(client, auth_headers):
    """Register a test agent."""
    client.post("/api/authority/agents/register", json={
        "name": "Cond Test Agent",
        "tools": [{"name": "stripe", "description": "Pay", "actions": [
            {"name": "create_refund", "description": "Issue refund"},
            {"name": "get_customer", "description": "Lookup"},
        ]}],
    })
    return "cond-test-agent"


from fastapi.testclient import TestClient


class TestConditionalPolicies:
    """Policies with conditions evaluate against action params."""

    def test_create_policy_with_conditions(self, client, auth_headers, agent_id):
        resp = client.post(f"/api/authority/agent/{agent_id}/policies", headers=auth_headers, json={
            "action_pattern": "stripe.create_refund",
            "effect": "BLOCK",
            "reason": "Block large refunds",
            "conditions": [{"field": "amount", "op": "gt", "value": 100}],
        })
        assert resp.status_code == 200
        assert resp.json()["id"] > 0

    def test_conditional_policy_blocks_when_condition_met(self, client, auth_headers, agent_id):
        resp = client.post("/api/enforce", json={
            "agent_id": agent_id,
            "tool": "stripe",
            "action": "create_refund",
            "params": {"amount": 200},
        })
        assert resp.status_code == 200
        assert resp.json()["decision"] == "BLOCK"

    def test_conditional_policy_allows_when_condition_not_met(self, client, auth_headers, agent_id):
        resp = client.post("/api/enforce", json={
            "agent_id": agent_id,
            "tool": "stripe",
            "action": "create_refund",
            "params": {"amount": 50},
        })
        assert resp.status_code == 200
        assert resp.json()["decision"] == "ALLOW"

    def test_conditional_policy_skipped_when_no_params(self, client, auth_headers, agent_id):
        """If enforce request has no params, conditional policies are skipped."""
        resp = client.post("/api/enforce", json={
            "agent_id": agent_id,
            "tool": "stripe",
            "action": "create_refund",
        })
        assert resp.status_code == 200
        assert resp.json()["decision"] == "ALLOW"

    def test_unconditional_policy_still_works(self, client, auth_headers, agent_id):
        """An unconditional BLOCK policy should always match."""
        client.post(f"/api/authority/agent/{agent_id}/policies", headers=auth_headers, json={
            "action_pattern": "stripe.get_customer",
            "effect": "BLOCK",
            "reason": "Block all lookups",
        })
        resp = client.post("/api/enforce", json={
            "agent_id": agent_id,
            "tool": "stripe",
            "action": "get_customer",
        })
        assert resp.status_code == 200
        assert resp.json()["decision"] == "BLOCK"

    def test_conditions_listed_in_policy_response(self, client, auth_headers, agent_id):
        resp = client.get(f"/api/authority/agent/{agent_id}/policies", headers=auth_headers)
        assert resp.status_code == 200
        policies = resp.json()["policies"]
        conditional = [p for p in policies if p["conditions"]]
        assert len(conditional) > 0
        assert conditional[0]["conditions"][0]["field"] == "amount"

    def test_invalid_condition_op_rejected(self, client, auth_headers, agent_id):
        resp = client.post(f"/api/authority/agent/{agent_id}/policies", headers=auth_headers, json={
            "action_pattern": "stripe.create_refund",
            "effect": "BLOCK",
            "reason": "Bad op",
            "conditions": [{"field": "amount", "op": "invalid_op", "value": 100}],
        })
        assert resp.status_code == 400

    def test_multiple_conditions_all_must_match(self, client, auth_headers, agent_id):
        """Multiple conditions act as AND — all must be true."""
        # Create a new agent to avoid policy conflicts
        client.post("/api/authority/agents/register", json={
            "name": "Multi Cond Agent",
            "tools": [{"name": "pay", "description": "Pay", "actions": [
                {"name": "transfer", "description": "Wire transfer"},
            ]}],
        })
        client.post("/api/authority/agent/multi-cond-agent/policies", headers=auth_headers, json={
            "action_pattern": "pay.transfer",
            "effect": "BLOCK",
            "reason": "Block large external transfers",
            "conditions": [
                {"field": "amount", "op": "gt", "value": 1000},
                {"field": "destination", "op": "eq", "value": "external"},
            ],
        })
        # Both conditions met — should BLOCK
        resp = client.post("/api/enforce", json={
            "agent_id": "multi-cond-agent",
            "tool": "pay",
            "action": "transfer",
            "params": {"amount": 5000, "destination": "external"},
        })
        assert resp.json()["decision"] == "BLOCK"

        # Only one condition met — should ALLOW
        resp = client.post("/api/enforce", json={
            "agent_id": "multi-cond-agent",
            "tool": "pay",
            "action": "transfer",
            "params": {"amount": 5000, "destination": "internal"},
        })
        assert resp.json()["decision"] == "ALLOW"


# ═══════════════════════════════════════════════════════════════════════════════
# 4. SIMULATION-BASED RECOMMENDATIONS
# ═══════════════════════════════════════════════════════════════════════════════

class TestSimulationRecommendations:
    """Recommendations should reference specific actions/chains from the trace."""

    def _make_trace(self, steps):
        from sandbox.models import SimulationTrace, TraceStep
        trace = SimulationTrace(
            simulation_id="test", agent_id="test", agent_name="Test",
            scenario_id="test", scenario_name="Test", prompt="test",
        )
        for i, (tool, action, decision) in enumerate(steps):
            trace.steps.append(TraceStep(
                step_index=i, tool=tool, action=action, params={},
                enforce_decision=decision, enforce_policy=None, result={},
            ))
        return trace

    def test_chain_recommendation_references_specific_steps(self):
        """When a chain is detected, recommendation should name the actions."""
        from sandbox.analyzer import analyze_trace
        trace = self._make_trace([
            ("stripe", "get_customer", "ALLOW"),      # touches_pii
            ("email", "send_email", "ALLOW"),          # sends_external
        ])
        report = analyze_trace(trace)
        chain_recs = [r for r in report.recommendations if r.actionable and "Chain" in r.message]
        assert len(chain_recs) > 0
        assert "send_email" in chain_recs[0].message

    def test_delete_recommendation_says_block(self):
        """Delete actions should recommend BLOCK, not just approval."""
        from sandbox.analyzer import analyze_trace
        trace = self._make_trace([
            ("stripe", "delete_customer", "ALLOW"),
        ])
        report = analyze_trace(trace)
        delete_recs = [r for r in report.recommendations if r.actionable and "delet" in r.message.lower()]
        assert len(delete_recs) > 0
        assert delete_recs[0].effect == "BLOCK"

    def test_money_recommendation_says_approval(self):
        """Money-moving actions should recommend REQUIRE_APPROVAL."""
        from sandbox.analyzer import analyze_trace
        trace = self._make_trace([
            ("stripe", "create_refund", "ALLOW"),
        ])
        report = analyze_trace(trace)
        money_recs = [r for r in report.recommendations if r.actionable and "money" in r.message.lower()]
        assert len(money_recs) > 0
        assert money_recs[0].effect == "REQUIRE_APPROVAL"

    def test_blocked_steps_dont_generate_action_recs(self):
        """Blocked steps shouldn't generate 'block this' recommendations."""
        from sandbox.analyzer import analyze_trace
        trace = self._make_trace([
            ("stripe", "delete_customer", "BLOCK"),
        ])
        report = analyze_trace(trace)
        action_recs = [r for r in report.recommendations if r.actionable]
        assert len(action_recs) == 0

    def test_clean_trace_gets_positive_message(self):
        """A trace with no violations should get a positive recommendation."""
        from sandbox.analyzer import analyze_trace
        trace = self._make_trace([
            ("zendesk", "get_ticket", "ALLOW"),
        ])
        report = analyze_trace(trace)
        messages = [r.message for r in report.recommendations]
        assert any("No violations" in m or "within policy" in m for m in messages)

    def test_recommendation_deduplicates_chain_and_label(self):
        """If a chain rec already covers an action, don't duplicate it as a label rec."""
        from sandbox.analyzer import analyze_trace
        trace = self._make_trace([
            ("stripe", "get_customer", "ALLOW"),
            ("email", "send_email", "ALLOW"),
        ])
        report = analyze_trace(trace)
        # send_email should appear in chain rec OR label rec, not both
        send_recs = [r for r in report.recommendations if r.actionable and r.action_pattern == "email.send_email"]
        assert len(send_recs) == 1


# ═══════════════════════════════════════════════════════════════════════════════
# 5. CONDITION EVALUATION UNIT TESTS
# ═══════════════════════════════════════════════════════════════════════════════

class TestConditionEvaluation:
    """Unit tests for the _evaluate_conditions function."""

    def _eval(self, conditions, params):
        # Import from main
        import sys
        sys.path.insert(0, ".")
        from main import _evaluate_conditions
        return _evaluate_conditions(conditions, params)

    def test_gt(self):
        assert self._eval([{"field": "amount", "op": "gt", "value": 100}], {"amount": 200}) is True
        assert self._eval([{"field": "amount", "op": "gt", "value": 100}], {"amount": 50}) is False

    def test_gte(self):
        assert self._eval([{"field": "amount", "op": "gte", "value": 100}], {"amount": 100}) is True
        assert self._eval([{"field": "amount", "op": "gte", "value": 100}], {"amount": 99}) is False

    def test_lt(self):
        assert self._eval([{"field": "amount", "op": "lt", "value": 100}], {"amount": 50}) is True
        assert self._eval([{"field": "amount", "op": "lt", "value": 100}], {"amount": 200}) is False

    def test_lte(self):
        assert self._eval([{"field": "amount", "op": "lte", "value": 100}], {"amount": 100}) is True

    def test_eq(self):
        assert self._eval([{"field": "tier", "op": "eq", "value": "enterprise"}], {"tier": "enterprise"}) is True
        assert self._eval([{"field": "tier", "op": "eq", "value": "enterprise"}], {"tier": "free"}) is False

    def test_neq(self):
        assert self._eval([{"field": "tier", "op": "neq", "value": "enterprise"}], {"tier": "free"}) is True

    def test_contains(self):
        assert self._eval([{"field": "email", "op": "contains", "value": "@external"}], {"email": "user@external.com"}) is True
        assert self._eval([{"field": "email", "op": "contains", "value": "@external"}], {"email": "user@internal.com"}) is False

    def test_in_op(self):
        assert self._eval([{"field": "status", "op": "in", "value": ["active", "trial"]}], {"status": "active"}) is True
        assert self._eval([{"field": "status", "op": "in", "value": ["active", "trial"]}], {"status": "expired"}) is False

    def test_not_in(self):
        assert self._eval([{"field": "status", "op": "not_in", "value": ["blocked", "banned"]}], {"status": "active"}) is True

    def test_missing_field_fails(self):
        assert self._eval([{"field": "amount", "op": "gt", "value": 100}], {"other": 200}) is False

    def test_multiple_conditions_and(self):
        conditions = [
            {"field": "amount", "op": "gt", "value": 100},
            {"field": "currency", "op": "eq", "value": "USD"},
        ]
        assert self._eval(conditions, {"amount": 200, "currency": "USD"}) is True
        assert self._eval(conditions, {"amount": 200, "currency": "EUR"}) is False
        assert self._eval(conditions, {"amount": 50, "currency": "USD"}) is False
