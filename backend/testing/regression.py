"""Regression tester — detects when policy changes make an agent LESS safe.

Stores a baseline of adversarial test results per agent. On re-run, compares
new results against the baseline and flags regressions: any action that was
previously BLOCKED or REQUIRE_APPROVAL but is now ALLOW.

Designed for CI — returns a clear pass/fail with details.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime

from db import get_db


@dataclass
class Regression:
    """A single regression — something that was safe and is now unsafe."""
    action: str               # tool.action
    attack_type: str           # which attack triggered it
    adversarial_input: str     # the prompt that caused it
    baseline_decision: str     # what the policy decided before (BLOCK/REQUIRE_APPROVAL)
    current_decision: str      # what it decides now (ALLOW)
    severity: str              # critical, high, medium


@dataclass
class RegressionReport:
    agent_id: str
    baseline_version: int
    current_version: int
    total_tests: int = 0
    regressions_found: int = 0
    improvements_found: int = 0  # newly blocked actions that were previously allowed
    unchanged: int = 0
    passed: bool = True          # False if any regressions
    regressions: list[Regression] = field(default_factory=list)
    improvements: list[dict] = field(default_factory=list)
    tested_at: str = ""

    def __post_init__(self):
        if not self.tested_at:
            self.tested_at = datetime.utcnow().isoformat()


def _get_latest_baseline(agent_id: str) -> dict | None:
    """Get the most recent baseline for an agent."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM regression_baselines WHERE agent_id = ? ORDER BY version DESC LIMIT 1",
            (agent_id,),
        ).fetchone()
    if not row:
        return None
    return dict(row)


def _get_baseline_history(agent_id: str, limit: int = 20) -> list[dict]:
    """Get regression test history for an agent."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, agent_id, version, status, created_at, "
            "json_extract(result_json, '$.regressions_found') as regressions_found, "
            "json_extract(result_json, '$.improvements_found') as improvements_found, "
            "json_extract(result_json, '$.total_tests') as total_tests "
            "FROM regression_baselines WHERE agent_id = ? ORDER BY version DESC LIMIT ?",
            (agent_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def save_baseline(agent_id: str, test_results: list[dict]) -> dict:
    """Save a new baseline from boundary test or red team results.

    test_results: list of {action, decision, attack_type, adversarial_input, ...}
    """
    # Get current version
    latest = _get_latest_baseline(agent_id)
    version = (latest["version"] + 1) if latest else 1

    baseline_id = uuid.uuid4().hex[:12]
    baseline_json = json.dumps(test_results, default=str)

    with get_db() as conn:
        conn.execute(
            "INSERT INTO regression_baselines (id, agent_id, version, baseline_json, status, created_at) "
            "VALUES (?, ?, ?, ?, 'baseline', ?)",
            (baseline_id, agent_id, version, baseline_json, datetime.utcnow().isoformat()),
        )

    return {"id": baseline_id, "version": version, "tests": len(test_results)}


def create_baseline_from_boundary_test(agent_id: str, agent_config: dict) -> dict:
    """Run a boundary test and save the results as the baseline."""
    from sandbox.boundary_tester import run_boundary_test

    report = run_boundary_test(agent_config)

    # Convert to baseline format: each tested sequence becomes a test case
    test_cases = []
    for r in report.results:
        test_cases.append({
            "sequence": r.sequence,
            "decisions": r.policy_decisions,
            "chain_name": r.chain_name,
            "chain_severity": r.chain_severity,
            "risk_labels": r.risk_labels,
            "gap_detected": r.gap_detected,
        })

    return save_baseline(agent_id, test_cases)


def run_regression_test(agent_id: str, agent_config: dict) -> RegressionReport:
    """Re-run the baseline test suite and compare against the stored baseline.

    Flags regressions: anything that was BLOCKED/REQUIRE_APPROVAL and is now ALLOW.
    """
    from sandbox.boundary_tester import run_boundary_test

    # Get baseline
    latest = _get_latest_baseline(agent_id)
    if not latest:
        raise ValueError(f"No baseline found for agent '{agent_id}'. Run POST /api/regression-test/{agent_id}?create_baseline=true first.")

    baseline_version = latest["version"]
    baseline_tests = json.loads(latest["baseline_json"])

    # Re-run the same boundary test
    current_report = run_boundary_test(agent_config)

    # Build lookup from current results: sequence → decisions
    current_by_seq = {}
    for r in current_report.results:
        key = "|".join(r.sequence)
        current_by_seq[key] = {
            "decisions": r.policy_decisions,
            "gap_detected": r.gap_detected,
            "chain_name": r.chain_name,
            "chain_severity": r.chain_severity,
        }

    # Compare
    new_version = baseline_version + 1
    report = RegressionReport(
        agent_id=agent_id,
        baseline_version=baseline_version,
        current_version=new_version,
    )

    for baseline_test in baseline_tests:
        key = "|".join(baseline_test["sequence"])
        current = current_by_seq.get(key)
        report.total_tests += 1

        if not current:
            # Sequence no longer testable (agent tools changed)
            report.unchanged += 1
            continue

        baseline_decisions = baseline_test["decisions"]
        current_decisions = current["decisions"]

        # Check each step in the sequence
        for i, (old_dec, new_dec) in enumerate(zip(baseline_decisions, current_decisions)):
            if old_dec in ("BLOCK", "REQUIRE_APPROVAL") and new_dec == "ALLOW":
                # REGRESSION: was safe, now unsafe
                severity = baseline_test.get("chain_severity") or "high"
                report.regressions.append(Regression(
                    action=baseline_test["sequence"][i] if i < len(baseline_test["sequence"]) else key,
                    attack_type=baseline_test.get("chain_name", "single_action"),
                    adversarial_input=key,
                    baseline_decision=old_dec,
                    current_decision=new_dec,
                    severity=severity,
                ))
            elif old_dec == "ALLOW" and new_dec in ("BLOCK", "REQUIRE_APPROVAL"):
                # IMPROVEMENT: was unsafe, now safe
                report.improvements.append({
                    "action": baseline_test["sequence"][i] if i < len(baseline_test["sequence"]) else key,
                    "old_decision": old_dec,
                    "new_decision": new_dec,
                })

        if baseline_decisions == current_decisions:
            report.unchanged += 1

    report.regressions_found = len(report.regressions)
    report.improvements_found = len(report.improvements)
    report.passed = report.regressions_found == 0

    # Save this run
    result_json = json.dumps(report_to_dict(report), default=str)
    regressions_json = json.dumps([
        {"action": r.action, "baseline": r.baseline_decision, "current": r.current_decision, "severity": r.severity}
        for r in report.regressions
    ])

    run_id = uuid.uuid4().hex[:12]
    status = "passed" if report.passed else "failed"

    with get_db() as conn:
        conn.execute(
            "INSERT INTO regression_baselines (id, agent_id, version, baseline_json, result_json, regressions_json, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (run_id, agent_id, new_version, latest["baseline_json"], result_json, regressions_json, status, datetime.utcnow().isoformat()),
        )

    return report


def report_to_dict(report: RegressionReport) -> dict:
    return {
        "agent_id": report.agent_id,
        "baseline_version": report.baseline_version,
        "current_version": report.current_version,
        "total_tests": report.total_tests,
        "regressions_found": report.regressions_found,
        "improvements_found": report.improvements_found,
        "unchanged": report.unchanged,
        "passed": report.passed,
        "regressions": [
            {
                "action": r.action,
                "attack_type": r.attack_type,
                "adversarial_input": r.adversarial_input,
                "baseline_decision": r.baseline_decision,
                "current_decision": r.current_decision,
                "severity": r.severity,
            }
            for r in report.regressions
        ],
        "improvements": report.improvements,
        "tested_at": report.tested_at,
    }
