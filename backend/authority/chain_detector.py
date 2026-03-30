"""Chain detector — finds dangerous action sequences using risk-label transitions.

Instead of hardcoding tool-specific chains, we define universal risk-label
transition rules. Any pair of actions whose risk labels form a dangerous
transition gets flagged — works across every tool, every domain, every company.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from authority.action_mapper import get_mapped_actions, MappedAction
from authority.parser import AgentConfig, load_all_agents


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

    return AgentChainResult(
        agent_id=agent.id,
        agent_name=agent.name,
        flagged_chains=flagged,
    )


def detect_all_chains() -> list[AgentChainResult]:
    """Detect dangerous chains for all agents."""
    agents = load_all_agents()
    return [detect_chains(a) for a in agents]
