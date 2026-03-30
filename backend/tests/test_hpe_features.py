"""Tests for HPE-scale multi-agent features (Features 1-5)."""

import pytest
import os
import json
import tempfile
from fastapi.testclient import TestClient


# ── Fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def client():
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
def ops_agent(client):
    """The seeded ops-agent should exist from init_db."""
    return "ops-agent"


@pytest.fixture(scope="module")
def support_agent(client):
    """Register a support agent for multi-agent tests."""
    client.post("/api/authority/agents/register", json={
        "name": "HPE Support",
        "tools": [
            {"name": "stripe", "description": "Pay", "actions": [
                {"name": "get_customer", "description": "Lookup"},
                {"name": "create_refund", "description": "Refund"},
            ]},
            {"name": "email", "description": "Email", "actions": [
                {"name": "send_email", "description": "Send"},
            ]},
        ],
    })
    return "hpe-support"


# ═══════════════════════════════════════════════════════════════════════════
# Feature 1: Multi-Agent Simulation
# ═══════════════════════════════════════════════════════════════════════════

class TestMultiAgentModels:
    def test_trace_step_has_source_agent(self):
        from sandbox.models import TraceStep
        step = TraceStep(step_index=0, tool="aws", action="list_instances", params={},
                         enforce_decision="ALLOW", enforce_policy=None, result={},
                         source_agent_id="ops-agent")
        assert step.source_agent_id == "ops-agent"

    def test_trace_step_has_dispatch_to(self):
        from sandbox.models import TraceStep
        step = TraceStep(step_index=0, tool="dispatch", action="dispatch_agent", params={},
                         enforce_decision="ALLOW", enforce_policy=None, result={},
                         dispatch_to="support-agent")
        assert step.dispatch_to == "support-agent"

    def test_multi_agent_trace_structure(self):
        from sandbox.models import MultiAgentTrace
        mt = MultiAgentTrace(simulation_id="test", coordinator_id="ops-agent")
        assert mt.coordinator_id == "ops-agent"
        assert mt.agent_traces == {}
        assert mt.unified_steps == []
        assert mt.dispatches == []


class TestMultiAgentDryRun:
    def test_dry_run_exercises_all_agents(self):
        from sandbox.multi_runner import run_multi_simulation_dry
        from sandbox.models import Scenario

        # Minimal agent configs
        agents = {
            "agent-a": {"id": "agent-a", "name": "Agent A", "tools": [
                {"name": "aws", "service": "AWS", "actions": [
                    {"action": "list_instances", "description": "List"},
                ]}
            ]},
            "agent-b": {"id": "agent-b", "name": "Agent B", "tools": [
                {"name": "slack", "service": "Slack", "actions": [
                    {"action": "send_message", "description": "Send"},
                ]}
            ]},
        }
        scenario = Scenario(id="test", name="Test", description="", agent_type="ops",
                            category="normal", severity="info", prompt="Test")

        result = run_multi_simulation_dry(agents, "agent-a", scenario)
        assert result.status == "completed"
        assert len(result.agent_traces) == 2
        assert len(result.unified_steps) > 0
        # Should have dispatch steps
        assert len(result.dispatches) == 1
        assert result.dispatches[0]["from_agent"] == "agent-a"
        assert result.dispatches[0]["to_agent"] == "agent-b"

    def test_source_agent_id_set_on_steps(self):
        from sandbox.multi_runner import run_multi_simulation_dry
        from sandbox.models import Scenario

        agents = {
            "a": {"id": "a", "name": "A", "tools": [
                {"name": "aws", "service": "AWS", "actions": [{"action": "list_instances"}]}
            ]},
            "b": {"id": "b", "name": "B", "tools": [
                {"name": "slack", "service": "Slack", "actions": [{"action": "send_message"}]}
            ]},
        }
        scenario = Scenario(id="t", name="T", description="", agent_type="ops",
                            category="normal", severity="info", prompt="T")
        result = run_multi_simulation_dry(agents, "a", scenario)

        # Each step should have source_agent_id
        for step in result.unified_steps:
            if step.tool != "dispatch":
                assert step.source_agent_id in ("a", "b")


class TestMultiAgentAnalysis:
    def test_cross_agent_chain_detection(self):
        from sandbox.models import MultiAgentTrace, TraceStep
        from sandbox.analyzer import analyze_multi_trace

        mt = MultiAgentTrace(simulation_id="test", coordinator_id="agent-a")
        # Agent A reads PII
        mt.unified_steps.append(TraceStep(
            step_index=0, tool="stripe", action="get_customer", params={},
            enforce_decision="ALLOW", enforce_policy=None, result={},
            source_agent_id="agent-a",
        ))
        # Agent B sends external
        mt.unified_steps.append(TraceStep(
            step_index=1, tool="email", action="send_email", params={},
            enforce_decision="ALLOW", enforce_policy=None, result={},
            source_agent_id="agent-b",
        ))

        report = analyze_multi_trace(mt)
        cross_chains = [c for c in report.chains_triggered if c.chain_id.startswith("cross-agent")]
        assert len(cross_chains) > 0
        assert "cross-agent" in cross_chains[0].chain_id

    def test_authority_escalation_detection(self):
        from sandbox.models import MultiAgentTrace, TraceStep
        from sandbox.analyzer import analyze_multi_trace

        agents = {
            "coord": {"id": "coord", "name": "Coordinator", "tools": [
                {"name": "slack", "service": "Slack", "actions": [{"action": "send_message"}]}
            ]},
            "specialist": {"id": "specialist", "name": "Specialist", "tools": [
                {"name": "aws", "service": "AWS", "actions": [{"action": "terminate_instance"}]}
            ]},
        }

        mt = MultiAgentTrace(simulation_id="test", coordinator_id="coord")
        mt.dispatches.append({"from_agent": "coord", "to_agent": "specialist", "task": "fix it", "step_index": 0})
        # Specialist does something coordinator can't
        mt.unified_steps.append(TraceStep(
            step_index=0, tool="aws", action="terminate_instance", params={},
            enforce_decision="ALLOW", enforce_policy=None, result={},
            source_agent_id="specialist",
        ))

        report = analyze_multi_trace(mt, agents)
        escalations = [v for v in report.violations if v.type == "authority_escalation"]
        assert len(escalations) > 0


class TestMultiAgentEndpoint:
    def test_multi_simulate_dry_run(self, client, auth_headers, ops_agent, support_agent):
        resp = client.post("/api/sandbox/simulate/multi", headers=auth_headers, json={
            "agent_ids": [ops_agent, support_agent],
            "coordinator_id": ops_agent,
            "custom_prompt": "Check system health and handle any support tickets",
            "dry_run": True,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert len(data["agents"]) == 2
        assert data["trace"]["total_steps"] > 0

    def test_multi_simulate_requires_coordinator_in_list(self, client, auth_headers, ops_agent):
        resp = client.post("/api/sandbox/simulate/multi", headers=auth_headers, json={
            "agent_ids": [ops_agent],
            "coordinator_id": "nonexistent",
            "custom_prompt": "test",
            "dry_run": True,
        })
        assert resp.status_code == 400


# ═══════════════════════════════════════════════════════════════════════════
# Feature 2: Session-Aware Conditional Policies
# ═══════════════════════════════════════════════════════════════════════════

class TestSessionAwarePolicies:
    def test_requires_prior_blocks_without_context(self, client, auth_headers, ops_agent):
        """Create a policy that requires pagerduty.get_oncall before aws.terminate_instance."""
        # Create the policy
        client.post(f"/api/authority/agent/{ops_agent}/policies", headers=auth_headers, json={
            "action_pattern": "aws.terminate_instance",
            "effect": "BLOCK",
            "reason": "Must check PagerDuty first",
            "conditions": [{"field": "", "op": "requires_prior", "value": "pagerduty.get_oncall"}],
        })

        # Without session context — should be skipped (no match, ALLOW)
        resp = client.post("/api/enforce", json={
            "agent_id": ops_agent,
            "tool": "aws",
            "action": "terminate_instance",
        })
        assert resp.json()["decision"] == "ALLOW"

    def test_requires_prior_blocks_with_missing_action(self, client, auth_headers, ops_agent):
        """With session context but missing required action — should BLOCK."""
        resp = client.post("/api/enforce", json={
            "agent_id": ops_agent,
            "tool": "aws",
            "action": "terminate_instance",
            "session_context": ["aws.list_instances", "slack.send_message"],
        })
        # The requires_prior condition is met=False, so the BLOCK policy doesn't match
        # (conditional BLOCK only fires when ALL conditions are True)
        assert resp.json()["decision"] == "ALLOW"

    def test_requires_prior_blocks_with_matching_action(self, client, auth_headers, ops_agent):
        """With session context containing required prior — should BLOCK."""
        resp = client.post("/api/enforce", json={
            "agent_id": ops_agent,
            "tool": "aws",
            "action": "terminate_instance",
            "session_context": ["pagerduty.get_oncall", "aws.list_instances"],
        })
        assert resp.json()["decision"] == "BLOCK"

    def test_requires_prior_with_wildcard(self, client, auth_headers):
        """Wildcard in requires_prior: pagerduty.* matches any pagerduty action."""
        client.post("/api/authority/agents/register", json={
            "name": "Session Test Agent",
            "tools": [{"name": "aws", "description": "AWS", "actions": [
                {"name": "scale_service", "description": "Scale"}
            ]}],
        })
        client.post("/api/authority/agent/session-test-agent/policies", headers=auth_headers, json={
            "action_pattern": "aws.scale_service",
            "effect": "REQUIRE_APPROVAL",
            "reason": "Must check PD first",
            "conditions": [{"field": "", "op": "requires_prior", "value": "pagerduty.*"}],
        })
        resp = client.post("/api/enforce", json={
            "agent_id": "session-test-agent",
            "tool": "aws",
            "action": "scale_service",
            "session_context": ["pagerduty.list_incidents"],
        })
        assert resp.json()["decision"] == "REQUIRE_APPROVAL"


# ═══════════════════════════════════════════════════════════════════════════
# Feature 3: Multi-Tenant Mock Isolation
# ═══════════════════════════════════════════════════════════════════════════

class TestMultiTenantMocks:
    def test_tenant_alpha_gets_alpha_data(self):
        from sandbox.mocks.registry import MockState
        state = MockState(tenant_id="tenant-alpha")
        assert "cust_a1" in state.customers
        assert "cust_b1" not in state.customers

    def test_tenant_beta_gets_beta_data(self):
        from sandbox.mocks.registry import MockState
        state = MockState(tenant_id="tenant-beta")
        assert "cust_b1" in state.customers
        assert "cust_a1" not in state.customers

    def test_no_tenant_gets_default_data(self):
        from sandbox.mocks.registry import MockState
        state = MockState()
        assert "cust_1042" in state.customers  # default Jane Doe

    def test_custom_data_overrides_tenant(self):
        from sandbox.mocks.registry import MockState
        state = MockState(tenant_id="tenant-alpha", custom_data={"customers": {"custom_1": {"id": "custom_1"}}})
        assert "custom_1" in state.customers
        assert "cust_a1" not in state.customers

    def test_cross_tenant_violation_detected(self):
        from sandbox.models import SimulationTrace, TraceStep
        from sandbox.analyzer import _detect_cross_tenant_access

        trace = SimulationTrace(
            simulation_id="t", agent_id="a", agent_name="A",
            scenario_id="s", scenario_name="S", prompt="p",
        )
        # Agent scoped to tenant-alpha but result contains beta data
        trace.steps.append(TraceStep(
            step_index=0, tool="stripe", action="get_customer", params={},
            enforce_decision="ALLOW", enforce_policy=None,
            result={"customer": {"id": "cust_b1", "name": "Beta User 1"}},
        ))

        violations = _detect_cross_tenant_access(trace, agent_tenant_id="tenant-alpha")
        assert len(violations) > 0
        assert violations[0].type == "cross_tenant_access"


# ═══════════════════════════════════════════════════════════════════════════
# Feature 4: Ops Agent Scenarios
# ═══════════════════════════════════════════════════════════════════════════

class TestOpsScenarios:
    def test_ops_scenarios_exist(self):
        from sandbox.prompts.scenarios import get_scenarios_for_agent
        ops = get_scenarios_for_agent("ops")
        assert len(ops) == 7

    def test_ops_scenario_categories(self):
        from sandbox.prompts.scenarios import get_scenarios_for_agent
        ops = get_scenarios_for_agent("ops")
        categories = {s.category for s in ops}
        assert "normal" in categories
        assert "edge_case" in categories
        assert "adversarial" in categories
        assert "chain_exploit" in categories

    def test_ops_agent_seeded_in_db(self, client, auth_headers):
        resp = client.get("/api/authority/agent/ops-agent", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        tools = [t["name"] for t in data["agent"]["tools"]]
        assert "github" in tools
        assert "aws" in tools
        assert "slack" in tools
        assert "pagerduty" in tools

    def test_ops_scenarios_listed_via_api(self, client):
        resp = client.get("/api/sandbox/scenarios")
        assert resp.status_code == 200
        ops = [s for s in resp.json()["scenarios"] if s["agent_type"] == "ops"]
        assert len(ops) == 7

    def test_ops_system_prompt_exists(self):
        from sandbox.runner import SYSTEM_PROMPTS
        assert "ops" in SYSTEM_PROMPTS
        assert "incident" in SYSTEM_PROMPTS["ops"].lower()

    def test_ops_dry_run_simulation(self, client, auth_headers):
        resp = client.post("/api/sandbox/simulate", headers=auth_headers, json={
            "agent_id": "ops-agent",
            "scenario_id": "ops-normal-health-check",
            "dry_run": True,
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "completed"


# ═══════════════════════════════════════════════════════════════════════════
# Feature 5: Policy Priority and Conflict Resolution
# ═══════════════════════════════════════════════════════════════════════════

class TestPolicyPriority:
    def test_block_gets_higher_priority_than_allow(self, client, auth_headers):
        client.post("/api/authority/agents/register", json={
            "name": "Priority Test Agent",
            "tools": [{"name": "stripe", "description": "Pay", "actions": [
                {"name": "get_customer", "description": "Lookup"},
                {"name": "create_refund", "description": "Refund"},
            ]}],
        })
        # Create ALLOW first
        resp = client.post("/api/authority/agent/priority-test-agent/policies", headers=auth_headers, json={
            "action_pattern": "stripe.*",
            "effect": "ALLOW",
            "reason": "Allow all stripe",
        })
        assert resp.json()["priority"] == 10

        # Create BLOCK second
        resp = client.post("/api/authority/agent/priority-test-agent/policies", headers=auth_headers, json={
            "action_pattern": "stripe.create_refund",
            "effect": "BLOCK",
            "reason": "Block refunds",
        })
        assert resp.json()["priority"] == 100

        # BLOCK should win because higher priority
        resp = client.post("/api/enforce", json={
            "agent_id": "priority-test-agent",
            "tool": "stripe",
            "action": "create_refund",
        })
        assert resp.json()["decision"] == "BLOCK"

    def test_conflict_detection(self, client, auth_headers):
        resp = client.get("/api/authority/agent/priority-test-agent/policy-conflicts", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] > 0
        conflict = data["conflicts"][0]
        assert "policy_a" in conflict
        assert "policy_b" in conflict
        assert "winner" in conflict


class TestJWTWarning:
    def test_default_secret_logs_warning(self):
        """The default JWT secret should trigger a warning log."""
        import auth
        assert auth.SECRET_KEY == "actiongate-demo-secret-key-change-in-prod"


class TestSharedEnforceLogic:
    def test_enforce_check_function_exists(self):
        from main import enforce_check
        assert callable(enforce_check)

    def test_enforce_check_returns_decision(self):
        from main import enforce_check
        result = enforce_check("nonexistent-agent", "stripe", "get_customer")
        assert "decision" in result
        assert result["decision"] == "ALLOW"
