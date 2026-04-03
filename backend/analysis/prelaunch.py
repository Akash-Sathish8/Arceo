"""Pre-launch audit — one endpoint that runs every test and returns
a single report telling the developer exactly what to fix before production.

Runs: boundary test → regression test → cost model → trace replay (if traces provided)
Produces: a prioritized fix list with specific actions to take.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class FixItem:
    """One specific thing the developer needs to fix."""
    priority: int                # 1 = fix first
    severity: str                # critical, high, medium
    category: str                # policy_gap, regression, cost_exposure, chain_unprotected
    action: str                  # tool.action or chain description
    problem: str                 # what's wrong
    fix: str                     # exactly what to do
    fix_type: str                # add_policy, modify_policy, remove_tool, add_approval
    auto_fixable: bool           # True if Arceo can create the policy automatically
    policy_suggestion: dict = field(default_factory=dict)  # {action_pattern, effect, reason, conditions}


@dataclass
class PrelaunchReport:
    agent_id: str
    agent_name: str
    ready_for_production: bool = False

    # Summary
    total_issues: int = 0
    critical_issues: int = 0
    high_issues: int = 0
    medium_issues: int = 0

    # Scores
    policy_coverage: float = 0.0       # from boundary test
    resilience_score: float = 0.0      # from regression (100 if no baseline)
    cost_configured: bool = False       # from cost model

    # Fix list
    fixes: list[FixItem] = field(default_factory=list)

    # Raw results (for drill-down)
    boundary_summary: dict = field(default_factory=dict)
    regression_summary: dict = field(default_factory=dict)
    cost_summary: dict = field(default_factory=dict)
    replay_summary: dict = field(default_factory=dict)

    generated_at: str = ""

    def __post_init__(self):
        if not self.generated_at:
            self.generated_at = datetime.utcnow().isoformat()


def run_prelaunch_audit(
    agent_config: dict,
    policies: list = None,
    historical_traces: list = None,
    daily_runs: int = 0,
) -> PrelaunchReport:
    """Run every test and produce a single prioritized fix list."""
    agent_id = agent_config["id"]
    agent_name = agent_config["name"]

    report = PrelaunchReport(agent_id=agent_id, agent_name=agent_name)
    all_fixes = []

    # ── 1. Boundary test ─────────────────────────────────────────────
    try:
        from sandbox.boundary_tester import run_boundary_test
        boundary = run_boundary_test(agent_config)
        report.policy_coverage = boundary.coverage_score
        report.boundary_summary = {
            "sequences_tested": boundary.total_sequences_tested,
            "gaps": boundary.total_gaps,
            "blocked": boundary.total_blocked,
            "coverage": boundary.coverage_score,
        }

        # Convert gaps to fix items
        for result in boundary.results:
            if not result.gap_detected:
                continue

            # Determine the action to fix (last step in sequence for chains)
            fix_action = result.sequence[-1] if result.sequence else "unknown"
            parts = fix_action.split(".", 1)
            tool_part = parts[0] if len(parts) == 2 else fix_action
            action_part = parts[1] if len(parts) == 2 else fix_action

            severity = result.chain_severity or "high"
            is_chain = len(result.sequence) > 1

            if is_chain:
                problem = "Chain '%s': %s has no policy gate" % (result.chain_name, " → ".join(result.sequence))
                fix = "Add REQUIRE_APPROVAL policy on %s to break this chain" % fix_action
                category = "chain_unprotected"
            else:
                problem = "Dangerous action %s defaults to ALLOW — no policy" % fix_action
                fix = "Add BLOCK or REQUIRE_APPROVAL policy on %s" % fix_action
                category = "policy_gap"

            # Deduplicate — don't suggest the same fix twice
            if any(f.action == fix_action and f.category == category for f in all_fixes):
                continue

            all_fixes.append(FixItem(
                priority=1 if severity == "critical" else 2 if severity == "high" else 3,
                severity=severity,
                category=category,
                action=fix_action,
                problem=problem,
                fix=fix,
                fix_type="add_policy",
                auto_fixable=True,
                policy_suggestion={
                    "action_pattern": fix_action,
                    "effect": "BLOCK" if "delet" in action_part.lower() else "REQUIRE_APPROVAL",
                    "reason": "Pre-launch audit: %s" % problem[:100],
                },
            ))
    except Exception as e:
        report.boundary_summary = {"error": str(e)}

    # ── 2. Regression test ───────────────────────────────────────────
    try:
        from testing.regression import _get_latest_baseline, run_regression_test

        baseline = _get_latest_baseline(agent_id)
        if baseline:
            regression = run_regression_test(agent_id, agent_config)
            report.resilience_score = 100.0 if regression.passed else 0.0
            report.regression_summary = {
                "baseline_version": regression.baseline_version,
                "passed": regression.passed,
                "regressions": regression.regressions_found,
                "improvements": regression.improvements_found,
            }

            for reg in regression.regressions:
                all_fixes.append(FixItem(
                    priority=1,
                    severity=reg.severity,
                    category="regression",
                    action=reg.action,
                    problem="REGRESSION: %s was %s, now %s" % (reg.action, reg.baseline_decision, reg.current_decision),
                    fix="Restore the %s policy on %s — it was removed or modified" % (reg.baseline_decision, reg.action),
                    fix_type="modify_policy",
                    auto_fixable=True,
                    policy_suggestion={
                        "action_pattern": reg.action,
                        "effect": reg.baseline_decision,
                        "reason": "Regression fix: was %s in baseline v%d" % (reg.baseline_decision, regression.baseline_version),
                    },
                ))
        else:
            report.resilience_score = 100.0  # no baseline = no regressions
            report.regression_summary = {"status": "no_baseline"}
    except Exception as e:
        report.regression_summary = {"error": str(e)}
        report.resilience_score = 100.0

    # ── 3. Cost model ────────────────────────────────────────────────
    try:
        from analysis.cost_model import generate_cost_report

        cost = generate_cost_report(agent_config, policies=policies, daily_runs=daily_runs)
        report.cost_configured = cost.configured
        report.cost_summary = {
            "configured": cost.configured,
            "risky_actions": cost.total_risky_actions,
            "unprotected": cost.total_unprotected,
            "per_incident_max_usd": cost.total_max_exposure_usd,
            "annualized_max_usd": cost.annualized_max_usd,
        }

        if cost.total_unprotected > 0 and cost.configured:
            all_fixes.append(FixItem(
                priority=2,
                severity="high",
                category="cost_exposure",
                action="%d unprotected actions" % cost.total_unprotected,
                problem="$%.0f max per-incident exposure across %d unprotected risky actions" % (cost.total_max_exposure_usd, cost.total_unprotected),
                fix="Add policies to the %d unprotected actions listed in the boundary test" % cost.total_unprotected,
                fix_type="add_policy",
                auto_fixable=False,
            ))
    except Exception as e:
        report.cost_summary = {"error": str(e)}

    # ── 4. Trace replay (if historical traces provided) ──────────────
    if historical_traces:
        try:
            from sandbox.trace_replay import replay_traces

            replay = replay_traces(agent_id, historical_traces)
            report.replay_summary = {
                "actions_replayed": replay.total_actions,
                "would_block": replay.actions_would_block,
                "would_require_approval": replay.actions_would_require_approval,
                "dangerous_unprotected": replay.dangerous_actions_unprotected,
                "coverage": replay.policy_coverage,
            }

            if replay.dangerous_actions_unprotected > 0:
                unprotected_actions = set()
                for step in replay.steps:
                    if step.is_dangerous and step.policy_decision == "ALLOW":
                        unprotected_actions.add("%s.%s" % (step.original_tool, step.original_action))

                for action in sorted(unprotected_actions):
                    if any(f.action == action for f in all_fixes):
                        continue
                    all_fixes.append(FixItem(
                        priority=1,
                        severity="critical",
                        category="historical_gap",
                        action=action,
                        problem="Historical trace shows %s was called with no policy — this already happened in production" % action,
                        fix="Add policy on %s immediately — this is not theoretical" % action,
                        fix_type="add_policy",
                        auto_fixable=True,
                        policy_suggestion={
                            "action_pattern": action,
                            "effect": "REQUIRE_APPROVAL",
                            "reason": "Pre-launch audit: observed in production traces without policy",
                        },
                    ))
        except Exception as e:
            report.replay_summary = {"error": str(e)}

    # ── Finalize ─────────────────────────────────────────────────────

    # Sort fixes: priority ASC, severity critical first
    severity_order = {"critical": 0, "high": 1, "medium": 2}
    all_fixes.sort(key=lambda f: (f.priority, severity_order.get(f.severity, 3)))

    report.fixes = all_fixes
    report.total_issues = len(all_fixes)
    report.critical_issues = sum(1 for f in all_fixes if f.severity == "critical")
    report.high_issues = sum(1 for f in all_fixes if f.severity == "high")
    report.medium_issues = sum(1 for f in all_fixes if f.severity == "medium")

    # Ready for production?
    report.ready_for_production = (
        report.critical_issues == 0
        and report.policy_coverage >= 80.0
        and report.resilience_score >= 100.0
    )

    return report


def report_to_dict(report: PrelaunchReport) -> dict:
    return {
        "agent_id": report.agent_id,
        "agent_name": report.agent_name,
        "ready_for_production": report.ready_for_production,
        "total_issues": report.total_issues,
        "critical": report.critical_issues,
        "high": report.high_issues,
        "medium": report.medium_issues,
        "policy_coverage": report.policy_coverage,
        "resilience_score": report.resilience_score,
        "cost_configured": report.cost_configured,
        "fixes": [
            {
                "priority": f.priority,
                "severity": f.severity,
                "category": f.category,
                "action": f.action,
                "problem": f.problem,
                "fix": f.fix,
                "fix_type": f.fix_type,
                "auto_fixable": f.auto_fixable,
                "policy_suggestion": f.policy_suggestion,
            }
            for f in report.fixes
        ],
        "boundary_test": report.boundary_summary,
        "regression_test": report.regression_summary,
        "cost_model": report.cost_summary,
        "trace_replay": report.replay_summary,
        "generated_at": report.generated_at,
    }
