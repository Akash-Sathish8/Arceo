"""Phase 3: Authority graph — maps agents → tools → actions → risk labels."""

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


def build_agent_graph(agent: AgentConfig) -> nx.DiGraph:
    """Build a directed graph: agent → tools → actions → risk labels."""
    G = nx.DiGraph()

    agent_node = f"agent:{agent.id}"
    G.add_node(agent_node, type="agent", label=agent.name, description=agent.description)

    for tool in agent.tools:
        tool_node = f"tool:{tool.name}"
        G.add_node(tool_node, type="tool", label=tool.service, description=tool.description)
        G.add_edge(agent_node, tool_node, relation="has_tool")

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


def calculate_blast_radius(agent: AgentConfig) -> BlastRadius:
    """Calculate the blast radius for an agent."""
    all_actions: list[MappedAction] = []
    for tool in agent.tools:
        all_actions.extend(get_mapped_actions(tool.name))

    total = len(all_actions)
    moves_money = sum(1 for a in all_actions if "moves_money" in a.risk_labels)
    touches_pii = sum(1 for a in all_actions if "touches_pii" in a.risk_labels)
    deletes_data = sum(1 for a in all_actions if "deletes_data" in a.risk_labels)
    sends_external = sum(1 for a in all_actions if "sends_external" in a.risk_labels)
    changes_prod = sum(1 for a in all_actions if "changes_production" in a.risk_labels)
    irreversible = sum(1 for a in all_actions if not a.reversible)

    # Score: weighted sum normalized to 0-100
    raw = (
        moves_money * 15
        + touches_pii * 8
        + deletes_data * 12
        + sends_external * 6
        + changes_prod * 10
        + irreversible * 5
    )
    # Normalize: assume max reasonable raw ~300
    score = min(100.0, round((raw / 300) * 100, 1))

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
