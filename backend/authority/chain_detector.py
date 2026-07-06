"""Chain detector — finds dangerous action sequences using risk-label transitions.

Instead of hardcoding tool-specific chains, we define universal risk-label
transition rules. Any pair of actions whose risk labels form a dangerous
transition gets flagged — works across every tool, every domain, every company.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from authority.action_mapper import get_mapped_actions, MappedAction
from authority.parser import AgentConfig


@dataclass
class LabelTransition:
    """A dangerous risk-label transition rule."""
    id: str
    name: str
    description: str
    severity: str  # "critical", "high", "medium"
    from_label: str
    to_label: str


@dataclass
class DangerousChain:
    """A detected dangerous chain (kept for API compatibility)."""
    id: str
    name: str
    description: str
    severity: str
    steps: list[str]
    risk_tags: list[str]


@dataclass
class AgentChainResult:
    agent_id: str
    agent_name: str
    flagged_chains: list[FlaggedChain] = field(default_factory=list)


@dataclass
class FlaggedChain:
    chain: DangerousChain
    matching_actions: list[list[str]]  # which specific actions match each step


# ── Universal Risk-Label Transition Rules ────────────────────────────────────
# These cover every tool and domain. The labels are universal; the specific
# tools don't matter.

LABEL_TRANSITIONS: list[LabelTransition] = [
    # PII escalation paths
    LabelTransition("pii-exfil", "PII Exfiltration",
                    "Reads PII then sends it externally — data could leave the org",
                    "critical", "touches_pii", "sends_external"),
    LabelTransition("pii-financial", "PII to Financial Action",
                    "Accesses customer PII then moves money — fraud/impersonation risk",
                    "critical", "touches_pii", "moves_money"),
    LabelTransition("pii-delete", "PII Access Then Deletion",
                    "Queries records then deletes them — targeted destruction risk",
                    "critical", "touches_pii", "deletes_data"),
    LabelTransition("pii-prod", "PII Access Then Production Change",
                    "Reads PII then modifies production — data-driven sabotage risk",
                    "high", "touches_pii", "changes_production"),

    # Financial escalation paths
    LabelTransition("money-external", "Financial Then External Send",
                    "Moves money then sends external notification — covers tracks or auto-billing",
                    "high", "moves_money", "sends_external"),
    LabelTransition("money-money", "Chained Financial Actions",
                    "Multiple money-moving actions in sequence — fraud amplification risk",
                    "critical", "moves_money", "moves_money"),
    LabelTransition("money-delete", "Financial Then Deletion",
                    "Moves money then deletes records — fraud with evidence destruction",
                    "critical", "moves_money", "deletes_data"),

    # Production/infrastructure escalation paths
    LabelTransition("prod-prod", "Cascading Production Changes",
                    "Multiple production changes in sequence — cascading failure risk",
                    "high", "changes_production", "changes_production"),
    LabelTransition("prod-delete", "Production Change Then Deletion",
                    "Modifies production then deletes data — infrastructure destruction",
                    "critical", "changes_production", "deletes_data"),
    LabelTransition("prod-external", "Production Change Then External Send",
                    "Modifies infrastructure then sends externally — could leak infra details",
                    "high", "changes_production", "sends_external"),

    # Deletion escalation paths
    LabelTransition("delete-delete", "Multiple Deletions",
                    "Deletes data across multiple systems — mass wipe risk",
                    "critical", "deletes_data", "deletes_data"),
    LabelTransition("delete-external", "Deletion Then External Send",
                    "Deletes data then sends externally — destroy and exfiltrate",
                    "high", "deletes_data", "sends_external"),

    # External send escalation
    LabelTransition("external-money", "External Send Then Financial",
                    "Sends externally then moves money — social engineering + fraud",
                    "high", "sends_external", "moves_money"),
    LabelTransition("external-prod", "External Send Then Production Change",
                    "Sends externally then modifies production — leak then exploit",
                    "high", "sends_external", "changes_production"),

    # ── Privilege escalation (MITRE TA0004 / OWASP ASI03) ─────────────────────
    LabelTransition("access-money", "Privilege Escalation Then Financial",
                    "Elevates access then moves money — fraud via escalated privilege",
                    "critical", "changes_access", "moves_money"),
    LabelTransition("access-delete", "Privilege Escalation Then Deletion",
                    "Elevates access then deletes data — destruction with new powers",
                    "critical", "changes_access", "deletes_data"),
    LabelTransition("access-prod", "Privilege Escalation Then Production Change",
                    "Elevates access then modifies production — privileged sabotage",
                    "high", "changes_access", "changes_production"),
    LabelTransition("access-external", "Privilege Escalation Then External Send",
                    "Elevates access then sends externally — escalate then exfiltrate",
                    "high", "changes_access", "sends_external"),

    # ── Credential access (MITRE TA0006) ──────────────────────────────────────
    LabelTransition("secrets-external", "Credential Exfiltration",
                    "Reads secrets then sends externally — steal and leak credentials",
                    "critical", "reads_secrets", "sends_external"),
    LabelTransition("secrets-access", "Stolen Credentials Then Privilege Change",
                    "Reads secrets then changes access — use stolen credentials to escalate",
                    "critical", "reads_secrets", "changes_access"),
    LabelTransition("secrets-money", "Credential Access Then Financial",
                    "Reads secrets then moves money — use stolen keys to move funds",
                    "critical", "reads_secrets", "moves_money"),
    LabelTransition("secrets-prod", "Credential Access Then Production Change",
                    "Reads secrets then modifies production — use stolen keys on infrastructure",
                    "high", "reads_secrets", "changes_production"),

    # ── Defense evasion (MITRE TA0005) — fires before AND after a harmful act ──
    LabelTransition("delete-evade", "Deletion Then Log Tampering",
                    "Deletes data then disables logging — destroy and cover tracks",
                    "critical", "deletes_data", "evades_detection"),
    LabelTransition("money-evade", "Financial Then Log Tampering",
                    "Moves money then tampers with audit logs — fraud with evidence destruction",
                    "critical", "moves_money", "evades_detection"),
    LabelTransition("evade-delete", "Detection Disabled Then Deletion",
                    "Disables logging then deletes data — blind the defender then destroy",
                    "critical", "evades_detection", "deletes_data"),
    LabelTransition("evade-external", "Detection Disabled Then Exfiltration",
                    "Disables monitoring then sends externally — blind then steal",
                    "critical", "evades_detection", "sends_external"),
    LabelTransition("prod-evade", "Production Change Then Log Tampering",
                    "Modifies production then disables monitoring — sabotage and hide it",
                    "high", "changes_production", "evades_detection"),
    LabelTransition("access-evade", "Privilege Escalation Then Log Tampering",
                    "Elevates access then disables logging — cover the escalation",
                    "high", "changes_access", "evades_detection"),

    # ── Bulk collection / staging (MITRE TA0009 / insider kill chain) ─────────
    LabelTransition("bulk-external", "Bulk Exfiltration",
                    "Exports data in bulk then sends externally — the classic mass-exfil DLP misses",
                    "critical", "bulk_export", "sends_external"),
    LabelTransition("bulk-delete", "Bulk Collection Then Deletion",
                    "Exports data in bulk then deletes it — steal-then-wipe / ransomware staging",
                    "critical", "bulk_export", "deletes_data"),
    LabelTransition("pii-bulk", "PII Bulk Collection",
                    "Accesses personal data then exports it in bulk — staging personal data",
                    "high", "touches_pii", "bulk_export"),

    # ── Arbitrary code execution (OWASP ASI05) ────────────────────────────────
    # Only the exfil narrative is kept: executes_code co-occurs with
    # changes_production + deletes_data on the same action, so code->money and
    # code->access largely duplicate the prod-* / access-* chains.
    LabelTransition("code-external", "Code Execution Then Exfiltration",
                    "Runs arbitrary code then sends externally — execute then exfiltrate",
                    "critical", "executes_code", "sends_external"),
]


def _transition_to_chain(t: LabelTransition) -> DangerousChain:
    """Convert a LabelTransition to a DangerousChain for API compatibility."""
    return DangerousChain(
        id=t.id,
        name=t.name,
        description=t.description,
        severity=t.severity,
        steps=[t.from_label, t.to_label],
        risk_tags=list(set([t.from_label, t.to_label])),
    )


def _get_actions_with_label(actions: list[MappedAction], label: str) -> list[str]:
    """Get action names that have a specific risk label."""
    return [
        f"{a.tool}.{a.action}" for a in actions if label in a.risk_labels
    ]


def detect_chains(agent: AgentConfig, action_overrides: dict | None = None) -> AgentChainResult:
    """Detect dangerous label transitions available to an agent.

    Checks every label transition rule against the agent's capabilities.
    If the agent has actions with both the from_label and to_label,
    the transition is flagged.
    """
    # Gather all actions for this agent
    all_actions: list[MappedAction] = []
    for tool in agent.tools:
        if action_overrides and tool.name in action_overrides:
            all_actions.extend(action_overrides[tool.name].values())
        else:
            all_actions.extend(get_mapped_actions(tool.name))

    flagged: list[FlaggedChain] = []

    for transition in LABEL_TRANSITIONS:
        from_actions = _get_actions_with_label(all_actions, transition.from_label)
        to_actions = _get_actions_with_label(all_actions, transition.to_label)

        if not from_actions or not to_actions:
            continue

        # For same-label transitions, need at least 2 distinct actions
        if transition.from_label == transition.to_label:
            combined = set(from_actions)
            if len(combined) < 2:
                continue

        flagged.append(FlaggedChain(
            chain=_transition_to_chain(transition),
            matching_actions=[from_actions, to_actions],
        ))

    # Collapse symmetric transitions (money<->external, prod<->external): at the
    # capability level both directions fire on the same unordered label pair, so
    # they double-count the finding and its score uplift. Keep one — the
    # highest-severity direction. Same-label chains (from==to) are inherently
    # unique and pass through.
    _sev_rank = {"critical": 3, "high": 2, "medium": 1}
    deduped: list[FlaggedChain] = []
    pair_index: dict[frozenset, int] = {}
    for fc in flagged:
        a, b = fc.chain.steps[0], fc.chain.steps[1]
        if a == b:
            deduped.append(fc)
            continue
        key = frozenset((a, b))
        if key not in pair_index:
            pair_index[key] = len(deduped)
            deduped.append(fc)
        elif _sev_rank.get(fc.chain.severity, 0) > _sev_rank.get(deduped[pair_index[key]].chain.severity, 0):
            deduped[pair_index[key]] = fc

    return AgentChainResult(
        agent_id=agent.id,
        agent_name=agent.name,
        flagged_chains=deduped,
    )
