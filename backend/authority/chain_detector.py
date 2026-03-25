"""Phase 4: Chain detector — finds dangerous multi-step action sequences."""

from __future__ import annotations

from dataclasses import dataclass, field

from authority.action_mapper import get_mapped_actions, MappedAction
from authority.parser import AgentConfig, load_all_agents


@dataclass
class DangerousChain:
    id: str
    name: str
    description: str
    severity: str  # "critical", "high", "medium"
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


# ── Top 10 Dangerous Chain Patterns ─────────────────────────────────────────

DANGEROUS_CHAINS: list[DangerousChain] = [
    DangerousChain(
        id="pii-exfil",
        name="PII Exfiltration",
        description="Reads PII then sends it externally — data could leave the org",
        severity="critical",
        steps=["touches_pii", "sends_external"],
        risk_tags=["touches_pii", "sends_external"],
    ),
    DangerousChain(
        id="read-refund",
        name="Unsupervised Refund",
        description="Reads payment info then issues refund with no human approval",
        severity="critical",
        steps=["touches_pii", "moves_money"],
        risk_tags=["touches_pii", "moves_money"],
    ),
    DangerousChain(
        id="query-delete",
        name="Query Then Delete",
        description="Queries records then deletes them — bulk deletion risk",
        severity="critical",
        steps=["touches_pii", "deletes_data"],
        risk_tags=["touches_pii", "deletes_data"],
    ),
    DangerousChain(
        id="deploy-no-review",
        name="Unreviewed Deployment",
        description="Merges code and triggers deployment with no human review step",
        severity="high",
        steps=["changes_production", "changes_production"],
        risk_tags=["changes_production"],
    ),
    DangerousChain(
        id="money-notify",
        name="Charge Then Notify",
        description="Creates a charge then sends external notification — auto-billing risk",
        severity="high",
        steps=["moves_money", "sends_external"],
        risk_tags=["moves_money", "sends_external"],
    ),
    DangerousChain(
        id="delete-no-backup",
        name="Delete Without Backup",
        description="Deletes data across multiple systems with no snapshot step",
        severity="critical",
        steps=["deletes_data", "deletes_data"],
        risk_tags=["deletes_data"],
    ),
    DangerousChain(
        id="infra-exposure",
        name="Infrastructure Exposure",
        description="Modifies security groups then sends external message — could leak infra changes",
        severity="high",
        steps=["changes_production", "sends_external"],
        risk_tags=["changes_production", "sends_external"],
    ),
    DangerousChain(
        id="pii-money",
        name="PII Access + Financial Action",
        description="Accesses customer PII then moves money — impersonation/fraud risk",
        severity="critical",
        steps=["touches_pii", "moves_money"],
        risk_tags=["touches_pii", "moves_money"],
    ),
    DangerousChain(
        id="mass-outreach",
        name="Mass External Outreach",
        description="Queries contacts then sends external messages — spam/phishing risk",
        severity="high",
        steps=["touches_pii", "sends_external"],
        risk_tags=["touches_pii", "sends_external"],
    ),
    DangerousChain(
        id="terminate-cascade",
        name="Cascading Termination",
        description="Terminates infrastructure then deletes backups — catastrophic data loss",
        severity="critical",
        steps=["changes_production", "deletes_data"],
        risk_tags=["changes_production", "deletes_data"],
    ),
]


def _get_actions_with_label(actions: list[MappedAction], label: str) -> list[str]:
    """Get action names that have a specific risk label."""
    return [
        f"{a.tool}.{a.action}" for a in actions if label in a.risk_labels
    ]


def detect_chains(agent: AgentConfig) -> AgentChainResult:
    """Detect dangerous action chains available to an agent."""
    # Gather all actions for this agent
    all_actions: list[MappedAction] = []
    for tool in agent.tools:
        all_actions.extend(get_mapped_actions(tool.name))

    # Build a set of risk labels this agent has access to
    available_labels: set[str] = set()
    for a in all_actions:
        available_labels.update(a.risk_labels)

    flagged: list[FlaggedChain] = []

    for chain in DANGEROUS_CHAINS:
        # Check if the agent has actions matching every step in the chain
        step_matches: list[list[str]] = []
        chain_possible = True

        for step_label in chain.steps:
            matching = _get_actions_with_label(all_actions, step_label)
            if not matching:
                chain_possible = False
                break
            step_matches.append(matching)

        # For 2-step chains with the same label, ensure at least 2 distinct actions
        if chain_possible and len(chain.steps) == 2 and chain.steps[0] == chain.steps[1]:
            all_matching = _get_actions_with_label(all_actions, chain.steps[0])
            if len(all_matching) < 2:
                chain_possible = False

        if chain_possible:
            flagged.append(FlaggedChain(
                chain=chain,
                matching_actions=step_matches,
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
