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
    "moves_money": 15,
    "touches_pii": 5,
    "deletes_data": 18,
    "sends_external": 8,
    "changes_production": 14,
}

IRREVERSIBLE_MULTIPLIER = 2.5
READ_PREFIXES = ("get_", "list_", "read_", "search_", "query_", "check_")


def _score_action(action: MappedAction) -> float:
    """Score a single action by its labels and reversibility.

    Read-only actions get a minimal score. Irreversible write actions
    get a large multiplier. This ensures terminate_instance vastly
    outscores get_customer.
    """
    # Read-only actions contribute minimally
    if action.action.startswith(READ_PREFIXES):
        return sum(LABEL_WEIGHTS.get(l, 0) for l in action.risk_labels) * 0.2

    base = sum(LABEL_WEIGHTS.get(l, 0) for l in action.risk_labels)

    if not action.reversible:
        base *= IRREVERSIBLE_MULTIPLIER

    return base


def calculate_blast_radius(agent: AgentConfig, action_overrides: dict | None = None) -> BlastRadius:
    """Calculate blast radius using per-action danger scoring.

    Each action is scored individually (labels + reversibility + read/write),
    then summed and normalized. This means an agent with one irreversible
    terminate_instance scores higher than an agent with 5 reversible get_* calls.
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

    # Sum per-action scores
    total_score = sum(_score_action(a) for a in all_actions)

    # Normalize: 0-100 scale. Cap assumes a worst-case agent with ~15 high-risk
    # irreversible actions across multiple services (~500 raw).
    score = min(100.0, round((total_score / 500) * 100, 1))

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
