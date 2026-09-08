"""Boundary tester — enumerate dangerous action sequences an agent can take and
check which ones the policy engine catches vs which ones slip through.

This is a penetration test for AI agent policies. It doesn't simulate behavior —
it tests dangerous paths and reports the gaps. For large agents the 2- and
3-step combination space is sampled under per-phase caps (to stay fast); the
report exposes `sequences_truncated` so the coverage claim stays honest rather
than implying every path was enumerated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from authority.risk_classifier import classify_action
from authority.chain_detector import LABEL_TRANSITIONS


@dataclass
class BoundaryResult:
    """Result of testing one action or action sequence against policies."""
    sequence: list[str]        # e.g. ["stripe.get_customer", "email.send_email"]
    sequence_length: int
    policy_decisions: list[str]  # e.g. ["ALLOW", "BLOCK"]
    matched_policies: list       # policy that matched each step, or None
    risk_labels: list[list[str]] # risk labels per step
    chain_name: str = ""         # if this sequence matches a dangerous transition
    chain_severity: str = ""     # critical, high, medium
    gap_detected: bool = False   # True if a dangerous sequence gets fully ALLOW'd
    gap_reason: str = ""


@dataclass
class BoundaryReport:
    """Full boundary test report for an agent."""
    agent_id: str
    agent_name: str
    total_sequences_tested: int = 0
    sequences_truncated: int = 0  # combinations dropped by per-phase sampling caps
    total_gaps: int = 0
    total_blocked: int = 0
    total_partial: int = 0       # some steps blocked, some not
    coverage_score: float = 0.0  # 0-100, higher = better policy coverage
    results: list[BoundaryResult] = field(default_factory=list)
    gaps_by_severity: dict = field(default_factory=dict)
    tested_at: str = ""

    def __post_init__(self):
        if not self.tested_at:
            self.tested_at = datetime.utcnow().isoformat()


def _get_agent_actions(agent_config: dict) -> list[dict]:
    """Extract all actions with their risk labels from an agent config."""
    actions = []
    for tool in agent_config.get("tools", []):
        tool_name = tool["name"]
        for action in tool.get("actions", []):
            action_name = action["action"] if isinstance(action, dict) else action
            description = action.get("description", "") if isinstance(action, dict) else ""
            db_labels = action.get("risk_labels", []) if isinstance(action, dict) else []

            # Use DB labels if available, otherwise classify
            if db_labels:
                labels = db_labels
                reversible = action.get("reversible", True) if isinstance(action, dict) else True
            else:
                labels, reversible = classify_action(action_name, description)

            actions.append({
                "key": f"{tool_name}.{action_name}",
                "tool": tool_name,
                "action": action_name,
                "labels": labels,
                "reversible": reversible,
            })
    return actions


def _check_policy(agent_id: str, tool: str, action: str, session_context: list = None) -> dict:
    """Check a single action against the policy engine. Returns decision + matched policy."""
    try:
        from main import enforce_check
        result = enforce_check(agent_id, tool, action, session_context=session_context, source="boundary_test")
        return {
            "decision": result.get("decision", "ALLOW"),
            "policy": result.get("policy"),
        }
    except Exception:
        return {"decision": "ALLOW", "policy": None}


def _is_dangerous(labels: list[str]) -> bool:
    """Check if an action's labels indicate danger."""
    dangerous_labels = {"moves_money", "deletes_data", "changes_production", "sends_external",
                        "changes_access", "reads_secrets", "evades_detection", "bulk_export",
                        "executes_code"}
    return bool(set(labels) & dangerous_labels)


def _is_read_only(action_name: str) -> bool:
    """Check if action is read-only."""
    prefixes = ("get_", "list_", "read_", "search_", "query_", "check_", "describe_", "fetch_")
    lower = action_name.lower()
    if lower.startswith(prefixes):
        return True
    # Handle service-prefixed names
    parts = lower.split("_", 1)
    if len(parts) == 2:
        return parts[1].startswith(prefixes)
    return False


PAIR_CAP = 20          # 2-step pairs tested per transition
READ_CAP = 10          # PII reads considered in 3-step chains
DANGER_CAP = 10        # dangerous actions considered in 3-step chains
ESC_CAP = 5            # escalation actions considered in 3-step chains


def run_boundary_test(agent_config: dict) -> BoundaryReport:
    """Run a boundary test on an agent.

    Tests:
    1. Every single dangerous action
    2. 2-step chains matching a label transition (sampled at PAIR_CAP per transition)
    3. 3-step read→dangerous→escalate chains (sampled under READ/DANGER/ESC caps)

    For large agents the 2- and 3-step spaces are sampled; the count of
    combinations not enumerated is reported as `sequences_truncated`.
    """
    agent_id = agent_config["id"]
    agent_name = agent_config["name"]
    actions = _get_agent_actions(agent_config)

    report = BoundaryReport(agent_id=agent_id, agent_name=agent_name)
    truncated = 0

    # Phase 1: Test every single dangerous action
    for a in actions:
        if not _is_dangerous(a["labels"]) or _is_read_only(a["action"]):
            continue

        check = _check_policy(agent_id, a["tool"], a["action"])

        result = BoundaryResult(
            sequence=[a["key"]],
            sequence_length=1,
            policy_decisions=[check["decision"]],
            matched_policies=[check["policy"]],
            risk_labels=[a["labels"]],
        )

        if check["decision"] == "ALLOW" and not a["reversible"]:
            result.gap_detected = True
            result.gap_reason = f"Irreversible action {a['key']} ({', '.join(a['labels'])}) has no policy, so it defaults to ALLOW"
        elif check["decision"] == "ALLOW" and _is_dangerous(a["labels"]):
            result.gap_detected = True
            result.gap_reason = f"Dangerous action {a['key']} ({', '.join(a['labels'])}) has no policy"

        report.results.append(result)

    # Phase 2: Test every 2-step chain matching label transitions
    label_to_actions: dict[str, list[dict]] = {}
    for a in actions:
        for label in a["labels"]:
            label_to_actions.setdefault(label, []).append(a)

    for transition in LABEL_TRANSITIONS:
        from_actions = label_to_actions.get(transition.from_label, [])
        to_actions = label_to_actions.get(transition.to_label, [])

        if not from_actions or not to_actions:
            continue

        # For same-label transitions, need distinct actions
        if transition.from_label == transition.to_label:
            pairs = [(a, b) for a in from_actions for b in to_actions if a["key"] != b["key"]]
        else:
            pairs = [(a, b) for a in from_actions for b in to_actions]

        # Cap pairs to avoid combinatorial explosion (count what we skip)
        if len(pairs) > PAIR_CAP:
            truncated += len(pairs) - PAIR_CAP
        for a, b in pairs[:PAIR_CAP]:
            session_context = [a["key"]]
            check_a = _check_policy(agent_id, a["tool"], a["action"])
            check_b = _check_policy(agent_id, b["tool"], b["action"], session_context=session_context)

            result = BoundaryResult(
                sequence=[a["key"], b["key"]],
                sequence_length=2,
                policy_decisions=[check_a["decision"], check_b["decision"]],
                matched_policies=[check_a["policy"], check_b["policy"]],
                risk_labels=[a["labels"], b["labels"]],
                chain_name=transition.name,
                chain_severity=transition.severity,
            )

            # Gap: both steps ALLOW in a dangerous chain
            if check_a["decision"] == "ALLOW" and check_b["decision"] == "ALLOW":
                result.gap_detected = True
                result.gap_reason = f"Chain '{transition.name}' ({transition.severity}): {a['key']} → {b['key']}. Both steps are allowed and no policy catches this sequence"
            # Partial: first step allowed, second blocked — chain partially covered
            elif check_a["decision"] == "ALLOW" and check_b["decision"] != "ALLOW":
                pass  # Second step is gated — chain is covered
            elif check_a["decision"] != "ALLOW":
                pass  # First step blocked — chain can't start

            report.results.append(result)

    # Phase 3: Test 3-step escalation chains (read PII → dangerous → escalate)
    read_pii_actions = [a for a in actions if _is_read_only(a["action"]) and "touches_pii" in a["labels"]]
    dangerous_actions = [a for a in actions if _is_dangerous(a["labels"]) and not _is_read_only(a["action"])]
    escalation_actions = [a for a in actions if "sends_external" in a["labels"] or "deletes_data" in a["labels"]]

    # Approximate count of 3-step triples the sampling caps excluded. It's a
    # rough figure (the real loop also skips same-key danger/escalation triples,
    # which these raw products don't model) — enough to flag "not exhaustive".
    full_triples = len(read_pii_actions) * len(dangerous_actions) * len(escalation_actions)
    capped_triples = (
        min(len(read_pii_actions), READ_CAP)
        * min(len(dangerous_actions), DANGER_CAP)
        * min(len(escalation_actions), ESC_CAP)
    )
    truncated += max(0, full_triples - capped_triples)

    for read_a in read_pii_actions[:READ_CAP]:
        for danger_a in dangerous_actions[:DANGER_CAP]:
            for esc_a in escalation_actions[:ESC_CAP]:
                if esc_a["key"] == danger_a["key"]:
                    continue

                session_ctx_1 = [read_a["key"]]
                session_ctx_2 = [read_a["key"], danger_a["key"]]

                check_1 = _check_policy(agent_id, read_a["tool"], read_a["action"])
                check_2 = _check_policy(agent_id, danger_a["tool"], danger_a["action"], session_context=session_ctx_1)
                check_3 = _check_policy(agent_id, esc_a["tool"], esc_a["action"], session_context=session_ctx_2)

                all_allow = all(c["decision"] == "ALLOW" for c in [check_1, check_2, check_3])

                result = BoundaryResult(
                    sequence=[read_a["key"], danger_a["key"], esc_a["key"]],
                    sequence_length=3,
                    policy_decisions=[check_1["decision"], check_2["decision"], check_3["decision"]],
                    matched_policies=[check_1["policy"], check_2["policy"], check_3["policy"]],
                    risk_labels=[read_a["labels"], danger_a["labels"], esc_a["labels"]],
                    chain_name="3-step escalation",
                    chain_severity="critical",
                )

                if all_allow:
                    result.gap_detected = True
                    result.gap_reason = (
                        f"3-step escalation: {read_a['key']} (PII read) → {danger_a['key']} "
                        f"({', '.join(danger_a['labels'])}) → {esc_a['key']} ({', '.join(esc_a['labels'])}) "
                        f"and the entire chain is unprotected"
                    )

                report.results.append(result)

    # Compute summary
    report.total_sequences_tested = len(report.results)
    report.sequences_truncated = truncated
    report.total_gaps = sum(1 for r in report.results if r.gap_detected)
    report.total_blocked = sum(1 for r in report.results if all(d != "ALLOW" for d in r.policy_decisions))
    report.total_partial = sum(1 for r in report.results if not r.gap_detected and any(d == "ALLOW" for d in r.policy_decisions) and any(d != "ALLOW" for d in r.policy_decisions))

    # Coverage score: what % of dangerous sequences have at least one policy catching them
    dangerous_sequences = [r for r in report.results if r.chain_severity or any(_is_dangerous(l) for l in r.risk_labels)]
    covered = sum(1 for r in dangerous_sequences if not r.gap_detected)
    report.coverage_score = round((covered / max(len(dangerous_sequences), 1)) * 100, 1)

    # Gaps by severity
    for r in report.results:
        if r.gap_detected:
            sev = r.chain_severity or "high"
            report.gaps_by_severity.setdefault(sev, []).append({
                "sequence": r.sequence,
                "reason": r.gap_reason,
            })

    return report


def report_to_dict(report: BoundaryReport) -> dict:
    """Convert report to JSON-serializable dict."""
    return {
        "agent_id": report.agent_id,
        "agent_name": report.agent_name,
        "total_sequences_tested": report.total_sequences_tested,
        "sequences_truncated": report.sequences_truncated,
        "total_gaps": report.total_gaps,
        "total_blocked": report.total_blocked,
        "total_partial": report.total_partial,
        "coverage_score": report.coverage_score,
        "gaps_by_severity": report.gaps_by_severity,
        "tested_at": report.tested_at,
        "results": [
            {
                "sequence": r.sequence,
                "sequence_length": r.sequence_length,
                "policy_decisions": r.policy_decisions,
                "matched_policies": r.matched_policies,
                "risk_labels": r.risk_labels,
                "chain_name": r.chain_name,
                "chain_severity": r.chain_severity,
                "gap_detected": r.gap_detected,
                "gap_reason": r.gap_reason,
            }
            for r in report.results
        ],
    }
