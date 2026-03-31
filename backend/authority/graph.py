"""Authority graph — maps agents → tools → actions → risk labels.

Blast radius scoring weights by destructiveness and reversibility,
not just label counts. An irreversible terminate_instance outscores
5 reversible get_* calls.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import networkx as nx

from authority.action_mapper import get_mapped_actions, MappedAction
from authority.parser import AgentConfig, load_all_agents


@dataclass
class BlastRadius:
    agent_id: str
    agent_name: str
    total_actions: int
    moves_money: int
    touches_pii: int
    deletes_data: int
    sends_external: int
    changes_production: int
    irreversible_actions: int
    score: float  # 0-100, higher = more dangerous
    risk_breakdown: dict = field(default_factory=dict)


def build_agent_graph(agent: AgentConfig, action_overrides: dict | None = None) -> nx.DiGraph:
    """Build a directed graph: agent → tools → actions → risk labels.

    If action_overrides is provided, use it instead of ACTION_CATALOG.
    Format: {tool_name: {action_name: MappedAction, ...}, ...}
    """
    G = nx.DiGraph()

    agent_node = f"agent:{agent.id}"
    G.add_node(agent_node, type="agent", label=agent.name, description=agent.description)

    for tool in agent.tools:
        tool_node = f"tool:{tool.name}"
        G.add_node(tool_node, type="tool", label=tool.service, description=tool.description)
        G.add_edge(agent_node, tool_node, relation="has_tool")

        if action_overrides and tool.name in action_overrides:
            actions = list(action_overrides[tool.name].values())
        else:
            actions = get_mapped_actions(tool.name)
        for action in actions:
            action_node = f"action:{tool.name}.{action.action}"
            G.add_node(
                action_node,
                type="action",
                label=action.action,
                description=action.description,
                reversible=action.reversible,
                risk_labels=action.risk_labels,
            )
            G.add_edge(tool_node, action_node, relation="exposes")

            for label in action.risk_labels:
                risk_node = f"risk:{label}"
                G.add_node(risk_node, type="risk", label=label)
                G.add_edge(action_node, risk_node, relation="has_risk")

    return G


# ── Per-action danger score ──────────────────────────────────────────────
# Each action gets scored individually based on its labels + reversibility.
# This means one irreversible delete outscores many reversible reads.

LABEL_WEIGHTS = {
    "moves_money": 12,
    "touches_pii": 4,
    "deletes_data": 15,
    "sends_external": 7,
    "changes_production": 12,
}

IRREVERSIBLE_MULTIPLIER = 2.0
READ_PREFIXES = ("get_", "list_", "read_", "search_", "query_", "check_",
                 "describe_", "fetch_", "lookup_", "find_", "show_")


def _is_read_only(action_name: str) -> bool:
    """Check if an action is read-only, handling service-prefixed names.

    Handles both 'get_customer' and 'stripe_get_customer'.
    """
    lower = action_name.lower()
    # Direct match
    if lower.startswith(READ_PREFIXES):
        return True
    # Service-prefixed: stripe_get_customer, netsuite_get_customer_balance
    parts = lower.split("_", 1)
    if len(parts) == 2 and parts[1].startswith(READ_PREFIXES):
        return True
    # Deeper prefix: aws_ec2_describe_instances
    for i in range(len(lower)):
        if lower[i] == "_":
            rest = lower[i + 1:]
            if rest.startswith(READ_PREFIXES):
                return True
    return False


def _score_action(action: MappedAction) -> float:
    """Score a single action by its labels, reversibility, and read/write nature.

    Read-only actions score minimally even if they touch PII (reading PII is
    lower risk than writing/sending it). Irreversible write actions get a
    multiplier. Actions with no risk labels score 0.
    """
    if _is_read_only(action.action):
        return sum(LABEL_WEIGHTS.get(l, 0) for l in action.risk_labels) * 0.15

    base = sum(LABEL_WEIGHTS.get(l, 0) for l in action.risk_labels)

    if not action.reversible:
        base *= IRREVERSIBLE_MULTIPLIER

    return base


def calculate_blast_radius(agent: AgentConfig, action_overrides: dict | None = None) -> BlastRadius:
    """Calculate blast radius with realistic scoring.

    Accounts for:
    - Per-action scoring (labels + reversibility + read/write)
    - Danger density (% of actions that are dangerous vs total)
    - Diminishing returns (20th dangerous action adds less than 1st)
    - Scaled for enterprise agents with 15-30+ tools
    """
    all_actions: list[MappedAction] = []
    for tool in agent.tools:
        if action_overrides and tool.name in action_overrides:
            all_actions.extend(action_overrides[tool.name].values())
        else:
            all_actions.extend(get_mapped_actions(tool.name))

    total = len(all_actions)
    moves_money = sum(1 for a in all_actions if "moves_money" in a.risk_labels)
    touches_pii = sum(1 for a in all_actions if "touches_pii" in a.risk_labels)
    deletes_data = sum(1 for a in all_actions if "deletes_data" in a.risk_labels)
    sends_external = sum(1 for a in all_actions if "sends_external" in a.risk_labels)
    changes_prod = sum(1 for a in all_actions if "changes_production" in a.risk_labels)
    irreversible = sum(1 for a in all_actions if not a.reversible)

    # Score each action individually
    action_scores = sorted((_score_action(a) for a in all_actions), reverse=True)

    # Diminishing returns: each subsequent dangerous action contributes less
    # 1st action: 100%, 2nd: 90%, 3rd: 82%, ... converges
    weighted_total = 0.0
    for i, score in enumerate(action_scores):
        decay = 1.0 / (1 + i * 0.12)  # gentle decay
        weighted_total += score * decay

    # Danger density: what fraction of actions are write + risky?
    dangerous_count = sum(1 for a in all_actions if not _is_read_only(a.action) and a.risk_labels)
    density = dangerous_count / max(total, 1)

    # Blend: raw score (what can go wrong) + density (how concentrated the danger is)
    # An agent with 3 dangerous tools out of 3 is scarier than 3 out of 30
    raw_normalized = min(100.0, (weighted_total / 800) * 100)
    density_bonus = density * 20  # up to +20 for an all-dangerous agent

    score = min(100.0, round(raw_normalized + density_bonus, 1))

    return BlastRadius(
        agent_id=agent.id,
        agent_name=agent.name,
        total_actions=total,
        moves_money=moves_money,
        touches_pii=touches_pii,
        deletes_data=deletes_data,
        sends_external=sends_external,
        changes_production=changes_prod,
        irreversible_actions=irreversible,
        score=score,
        risk_breakdown={
            "moves_money": moves_money,
            "touches_pii": touches_pii,
            "deletes_data": deletes_data,
            "sends_external": sends_external,
            "changes_production": changes_prod,
        },
    )


def graph_to_dict(G: nx.DiGraph) -> dict:
    """Convert a NetworkX graph to a JSON-serializable dict for the frontend."""
    nodes = []
    for node_id, data in G.nodes(data=True):
        nodes.append({
            "id": node_id,
            **{k: v for k, v in data.items()},
        })

    edges = []
    for src, dst, data in G.edges(data=True):
        edges.append({
            "source": src,
            "target": dst,
            "relation": data.get("relation", ""),
        })

    return {"nodes": nodes, "edges": edges}


def get_all_blast_radii() -> list[BlastRadius]:
    """Calculate blast radius for all agents."""
    agents = load_all_agents()
    return [calculate_blast_radius(a) for a in agents]
