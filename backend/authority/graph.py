"""Authority graph — maps agents → tools → actions → risk labels.

Blast radius scoring weights by destructiveness and reversibility,
not just label counts. An irreversible terminate_instance outscores
5 reversible get_* calls.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import networkx as nx

from authority.action_mapper import get_mapped_actions, MappedAction
from authority.parser import AgentConfig


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
    score: float  # 0-100 — INHERENT: capability ceiling (what it COULD do)
    risk_breakdown: dict = field(default_factory=dict)
    # ── danger model (defaults keep every existing caller backward-compatible) ──
    residual_score: float = 0.0      # after the agent's policies gate actions / break chains
    contextual_score: float = 0.0    # inherent × deployment-context multiplier
    magnitude_usd: float = 0.0       # worst-case per-incident $ across the agent's actions
    chain_risk: float = 0.0          # the chain-uplift contribution to the inherent score
    confidence: str = "low"          # low | medium | high — graded by behavioral evidence
    evidence: dict = field(default_factory=dict)          # {hasSim, simRiskScore, confirmed}
    exposure_context: dict = field(default_factory=dict)  # {environment, trigger_source, human_in_loop, multiplier}
    top_contributors: list = field(default_factory=list)  # top 5 [{action, usd, score, why}]


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


# ── Magnitude (Stage 1) ──────────────────────────────────────────────────
# A bounded multiplier from the action's worst-case $ so a $5M transfer outscores
# a $5 refund with the same label. CENTERED at 1.0 on the median default-catalog
# severity (~$25k) so out-of-the-box scores match today's calibration; it only
# moves an agent once real per-tool $ is configured (a $5M wire → ~1.4×, a $1k
# action → ~0.65×). Degrades to 1.0 when no $ is available.
MAGNITUDE_CENTER_USD = 25_000.0


def magnitude_scale(usd: float | None) -> float:
    if not usd or usd <= 0:
        return 1.0
    return max(0.6, min(1.6, 1.0 + 0.25 * math.log10(usd / MAGNITUDE_CENTER_USD)))


# ── Scope (Stage 2) ──────────────────────────────────────────────────────
# Bulk / wildcard actions dwarf single-record ones — flat labels miss this.
_BULK_RE = re.compile(
    r"(delete_all|deleteall|truncate|drop_|bulk_|_bulk\b|batch_delete|_all\b|wildcard|purge|mass_|destroy_all)"
)
SCOPE_MULTIPLIER = 1.6


def _scope_multiplier(action_name: str) -> float:
    return SCOPE_MULTIPLIER if _BULK_RE.search((action_name or "").lower()) else 1.0


def score_action(action: MappedAction, magnitude_usd: float | None = None, scope_mult: float = 1.0) -> float:
    """Per-action inherent danger = TYPE x SCALE($) x SCOPE x REVERSIBILITY.

    Read-only actions keep the 0.15x floor. Actions with no risk labels score 0.
    """
    type_term = sum(LABEL_WEIGHTS.get(l, 0) for l in action.risk_labels)
    if _is_read_only(action.action):
        return type_term * 0.15
    base = type_term * magnitude_scale(magnitude_usd) * scope_mult
    if not action.reversible:
        base *= IRREVERSIBLE_MULTIPLIER
    return base


# Backward-compatible alias (existing tests + callers use _score_action).
def _score_action(action: MappedAction) -> float:
    return score_action(action)


# ── Chain uplift (Stage 1) ───────────────────────────────────────────────
# A modest nudge: an agent that can form dangerous chains is more dangerous than
# its actions in isolation, but the action-sum already reflects having multiple
# dangerous label types, so this stays small (cap +5, steep decay) to avoid
# double-counting and re-inflating the calibrated distribution.
CHAIN_WEIGHT = {"critical": 2.0, "high": 1.0, "medium": 0.5}
CHAIN_UPLIFT_CAP = 3.5


def _chain_uplift(chains: list) -> float:
    """Emergent danger from the dangerous chains an agent can form, with steep
    diminishing returns and a cap so chains can't saturate the score."""
    ordered = sorted(chains, key=lambda fc: CHAIN_WEIGHT.get(fc.chain.severity, 0), reverse=True)
    total = 0.0
    for i, fc in enumerate(ordered):
        total += CHAIN_WEIGHT.get(fc.chain.severity, 0) / (1 + i * 0.9)
    return min(total, CHAIN_UPLIFT_CAP)


# ── Policy mitigation -> residual (Stage 1) ──────────────────────────────
_EFFECT_RANK = {"BLOCK": 3, "REQUIRE_APPROVAL": 2, "ALLOW": 1}


def _has_conditions(policy: dict) -> bool:
    c = policy.get("conditions")
    if isinstance(c, str):
        return c.strip() not in ("", "[]", "null")
    return bool(c)


def _policy_match(action_key: str, policies: list | None) -> dict | None:
    """Strongest-effect policy whose pattern covers this action (pattern only —
    conditions are handled separately so a conditional gate gives partial, not
    full, mitigation credit)."""
    tool = action_key.split(".", 1)[0]
    best = None
    for p in policies or []:
        pat = p.get("action_pattern", "")
        matched = (
            pat == action_key
            or pat == "*"
            or pat == f"{tool}.*"
            or (pat.endswith(".*") and action_key.startswith(pat[:-1]))
            or (pat.startswith("*.") and action_key.endswith(pat[1:]))
        )
        if matched and (best is None or _EFFECT_RANK.get(p.get("effect"), 0) > _EFFECT_RANK.get(best.get("effect"), 0)):
            best = p
    return best


def _residual_action_mult(action_key: str, policies: list | None) -> float:
    """How much of an action's danger survives its policy. BLOCK->0 (gone),
    REQUIRE_APPROVAL->0.25 (human gate); a *conditional* gate only covers some
    calls, so it gets partial credit (0.5)."""
    p = _policy_match(action_key, policies)
    if not p:
        return 1.0
    effect = p.get("effect")
    conditional = _has_conditions(p)
    if effect == "BLOCK":
        return 0.5 if conditional else 0.0
    if effect == "REQUIRE_APPROVAL":
        return 0.5 if conditional else 0.25
    return 1.0  # ALLOW = no mitigation


def _chain_broken(fc, policies: list | None) -> bool:
    """A chain is broken when every escalation (to-label) action is gated."""
    escalation = fc.matching_actions[1] if len(fc.matching_actions) > 1 else []
    if not escalation:
        return False
    return all(_residual_action_mult(a, policies) < 1.0 for a in escalation)


# ── Behavioral evidence -> confidence (Stage 3) ──────────────────────────

def _evidence_grade(sim_evidence: dict | None) -> tuple[str, float, dict]:
    """Map the latest sim's findings to (confidence, residual_uplift, evidence)."""
    if not sim_evidence or not sim_evidence.get("ran"):
        return "low", 0.0, {"hasSim": False}
    risk = float(sim_evidence.get("risk_score") or 0)
    confirmed = bool(sim_evidence.get("confirmed_chain") or sim_evidence.get("has_violation") or risk >= 70)
    if confirmed:
        return "high", min(10.0, risk * 0.1), {"hasSim": True, "simRiskScore": risk, "confirmed": True}
    return "medium", 0.0, {"hasSim": True, "simRiskScore": risk, "confirmed": False}


# ── Exposure / autonomy context (Stage 4) ────────────────────────────────
ENV_MULT = {"prod": 1.15, "production": 1.15, "staging": 1.0, "dev": 0.85, "development": 0.85}
TRIGGER_MULT = {"untrusted": 1.2, "external": 1.2, "internal": 1.0, "scheduled": 1.0}
HITL_MULT = {True: 0.85, False: 1.0}


def exposure_multiplier(environment=None, trigger_source=None, human_in_loop=None) -> float:
    """Deployment-context multiplier; 1.0 when nothing is declared."""
    m = ENV_MULT.get((environment or "").lower(), 1.0)
    m *= TRIGGER_MULT.get((trigger_source or "").lower(), 1.0)
    if human_in_loop is not None:
        m *= HITL_MULT.get(bool(human_in_loop), 1.0)
    return m


def _short_usd(usd: float) -> str:
    if usd >= 1_000_000:
        return f"${usd / 1_000_000:.1f}M"
    if usd >= 1_000:
        return f"${usd / 1_000:.0f}k"
    return f"${usd:.0f}"


def _why(action: MappedAction, usd: float) -> str:
    bits = []
    if not action.reversible:
        bits.append("irreversible")
    bits.extend(action.risk_labels)
    if usd and usd > 0:
        bits.append(f"{_short_usd(usd)} worst-case")
    return ", ".join(bits) or "risky action"


def _decayed(scores: list[float]) -> float:
    """Sum of scores (sorted desc) with diminishing returns."""
    return sum(s * (1.0 / (1 + i * 0.12)) for i, s in enumerate(sorted(scores, reverse=True)))


def calculate_blast_radius(
    agent: AgentConfig,
    action_overrides: dict | None = None,
    *,
    policies: list | None = None,
    magnitude_by_action: dict | None = None,
    chains: list | None = None,
    sim_evidence: dict | None = None,
    exposure_context: dict | None = None,
) -> BlastRadius:
    """Calculate blast radius as a two-number, evidence-graded model.

    - `score` (INHERENT): capability ceiling = TYPE x magnitude($) x scope x
      reversibility, decayed + density bonus + chain uplift. Backward-compatible
      headline; also the /api/scan CI gate.
    - `residual_score`: re-run with policy mitigation (gated actions reduced,
      gated chains dropped) + behavioral-evidence uplift; always <= inherent.
    - `contextual_score`: inherent x deployment-context multiplier.

    All keyword args default None -> existing callers get today's `score` with
    neutral new fields (residual==contextual==score, confidence "low").
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

    mag = magnitude_by_action or {}
    chain_list = chains or []

    # Per-action: (action, key, inherent, residual, usd)
    scored = []
    for a in all_actions:
        key = f"{a.tool}.{a.action}"
        usd = mag.get(key)
        inh = score_action(a, usd, _scope_multiplier(a.action))
        res = inh * _residual_action_mult(key, policies)
        scored.append((a, key, inh, res, usd or 0.0))

    def _aggregate(idx: int, broken_filter: bool) -> tuple[float, float]:
        weighted = _decayed([s[idx] for s in scored])
        dangerous = sum(
            1 for s in scored
            if not _is_read_only(s[0].action) and s[0].risk_labels and s[idx] > 0
        )
        density_bonus = (dangerous / max(total, 1)) * 20
        raw = min(100.0, (weighted / 240) * 100)
        active_chains = (
            [fc for fc in chain_list if not _chain_broken(fc, policies)] if broken_filter else chain_list
        )
        return raw + density_bonus, _chain_uplift(active_chains)

    inh_base, chain_risk = _aggregate(2, broken_filter=False)
    inherent = min(100.0, inh_base + chain_risk)

    res_base, res_chain_risk = _aggregate(3, broken_filter=bool(policies))
    confidence, evidence_uplift, evidence = _evidence_grade(sim_evidence)
    residual = min(inherent, min(100.0, res_base + res_chain_risk) + evidence_uplift)

    ctx = dict(exposure_context or {})
    ctx_mult = ctx.get("multiplier", 1.0)
    contextual = min(100.0, inherent * ctx_mult)

    magnitude_usd = max((s[4] for s in scored), default=0.0)
    top = sorted((s for s in scored if s[2] > 0), key=lambda s: s[2], reverse=True)[:5]
    top_contributors = [
        {"action": key, "usd": round(usd, 2), "score": round(inh, 1), "why": _why(a, usd)}
        for (a, key, inh, res, usd) in top
    ]

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
        score=round(inherent, 1),
        risk_breakdown={
            "moves_money": moves_money,
            "touches_pii": touches_pii,
            "deletes_data": deletes_data,
            "sends_external": sends_external,
            "changes_production": changes_prod,
        },
        residual_score=round(residual, 1),
        contextual_score=round(contextual, 1),
        magnitude_usd=round(magnitude_usd, 2),
        chain_risk=round(chain_risk, 1),
        confidence=confidence,
        evidence=evidence,
        exposure_context=ctx,
        top_contributors=top_contributors,
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
