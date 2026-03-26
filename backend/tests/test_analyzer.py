"""Tests for the simulation trace analyzer."""

import pytest
from sandbox.models import SimulationTrace, TraceStep
from sandbox.analyzer import analyze_trace


def _make_trace(steps: list[tuple[str, str, str]]) -> SimulationTrace:
    """Helper: create a trace from [(tool, action, decision), ...]."""
    trace = SimulationTrace(
        simulation_id="test-sim",
        agent_id="test-agent",
        agent_name="Test Agent",
        scenario_id="test-scenario",
        scenario_name="Test Scenario",
        prompt="Test prompt",
    )
    for i, (tool, action, decision) in enumerate(steps):
        trace.steps.append(TraceStep(
            step_index=i,
            tool=tool,
            action=action,
            params={},
            enforce_decision=decision,
            enforce_policy=None,
            result={"ok": True} if decision == "ALLOW" else {"blocked": True},
        ))
    return trace


class TestAnalyzeTrace:
    def test_counts_decisions(self):
        trace = _make_trace([
            ("stripe", "get_customer", "ALLOW"),
            ("stripe", "create_refund", "BLOCK"),
            ("email", "send_email", "ALLOW"),
            ("stripe", "delete_customer", "REQUIRE_APPROVAL"),
        ])
        report = analyze_trace(trace)
        assert report.total_steps == 4
        assert report.actions_executed == 2
        assert report.actions_blocked == 1
        assert report.actions_pending == 1

    def test_detects_pii_violation(self):
        trace = _make_trace([
            ("stripe", "get_customer", "ALLOW"),
        ])
        report = analyze_trace(trace)
        violations = [v.type for v in report.violations]
        assert "pii_access" in violations

    def test_detects_financial_violation(self):
        trace = _make_trace([
            ("stripe", "create_refund", "ALLOW"),
        ])
        report = analyze_trace(trace)
        violations = [v.type for v in report.violations]
        assert "financial_action" in violations

    def test_detects_deletion_violation(self):
        trace = _make_trace([
            ("stripe", "delete_customer", "ALLOW"),
        ])
        report = analyze_trace(trace)
        violations = [v.type for v in report.violations]
        assert "data_deletion" in violations

    def test_detects_blocked_attempt(self):
        trace = _make_trace([
            ("stripe", "create_refund", "BLOCK"),
        ])
        report = analyze_trace(trace)
        violations = [v.type for v in report.violations]
        assert "blocked_action_attempted" in violations

    def test_detects_pii_exfil_chain(self):
        trace = _make_trace([
            ("stripe", "get_customer", "ALLOW"),      # touches_pii
            ("email", "send_email", "ALLOW"),          # sends_external
        ])
        report = analyze_trace(trace)
        chain_ids = [c.chain_id for c in report.chains_triggered]
        assert "pii-exfil" in chain_ids

    def test_blocked_steps_dont_trigger_chains(self):
        trace = _make_trace([
            ("stripe", "get_customer", "ALLOW"),
            ("email", "send_email", "BLOCK"),  # blocked — chain shouldn't fire
        ])
        report = analyze_trace(trace)
        chain_ids = [c.chain_id for c in report.chains_triggered]
        assert "pii-exfil" not in chain_ids

    def test_risk_score_increases_with_danger(self):
        safe_trace = _make_trace([("zendesk", "get_ticket", "ALLOW")])
        dangerous_trace = _make_trace([
            ("stripe", "get_customer", "ALLOW"),
            ("stripe", "create_refund", "ALLOW"),
            ("stripe", "delete_customer", "ALLOW"),
            ("email", "send_email", "ALLOW"),
        ])
        safe_report = analyze_trace(safe_trace)
        dangerous_report = analyze_trace(dangerous_trace)
        assert dangerous_report.risk_score > safe_report.risk_score

    def test_no_violations_when_all_blocked(self):
        trace = _make_trace([
            ("stripe", "create_refund", "BLOCK"),
            ("stripe", "delete_customer", "BLOCK"),
        ])
        report = analyze_trace(trace)
        # Should have blocked_action_attempted but not financial/deletion violations
        violation_types = [v.type for v in report.violations]
        assert "blocked_action_attempted" in violation_types
        assert "financial_action" not in violation_types
        assert "data_deletion" not in violation_types

    def test_actionable_recommendations_generated(self):
        trace = _make_trace([
            ("stripe", "create_refund", "ALLOW"),
            ("stripe", "delete_customer", "ALLOW"),
            ("email", "send_email", "ALLOW"),
        ])
        report = analyze_trace(trace)
        actionable = [r for r in report.recommendations if hasattr(r, 'actionable') and r.actionable]
        assert len(actionable) > 0
        patterns = [r.action_pattern for r in actionable]
        assert "stripe.create_refund" in patterns or "stripe.delete_customer" in patterns

    def test_empty_trace(self):
        trace = _make_trace([])
        report = analyze_trace(trace)
        assert report.total_steps == 0
        assert report.risk_score == 0.0
        assert len(report.violations) == 0
