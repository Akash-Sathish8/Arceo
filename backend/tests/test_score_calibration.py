"""Blast-radius calibration guards: ORDERING and coarse bands, never exact values.

Runs under conftest's fixture-replay LLM stub (deterministic, keyless). If a
weight/normalizer change moves the reference fleet out of its intended
placement, these fail — rerun evals/calibrate_fleet.py and retune.
"""

from __future__ import annotations

from authority.chain_detector import detect_chains
from authority.graph import CHAIN_UPLIFT_CAP, CHAIN_WEIGHT, calculate_blast_radius, _chain_uplift
from authority.parser import load_all_agents
from authority.risk_classifier import classify_with_fallback

from evals.calibrate_fleet import INFRA_MAX_ACTIONS, NOTE_TAKER_ACTIONS, _synthetic


def _score(config, overrides):
    chains = detect_chains(config, overrides)
    br = calculate_blast_radius(config, overrides, chains=chains.flagged_chains)
    return br, chains


def _score_fleet_agent(agent_id: str):
    agent = next(a for a in load_all_agents() if a.id == agent_id)
    overrides = {
        t.name: {a: classify_with_fallback(t.name, a, "") for a in t.actions}
        for t in agent.tools
    }
    return _score(agent, overrides)


def test_note_taker_is_low_with_no_chains():
    config, overrides = _synthetic("note-taker", "Note Taker", "notion", NOTE_TAKER_ACTIONS)
    br, chains = _score(config, overrides)
    assert br.score < 15, f"harmless note-taker scored {br.score}"
    assert len(chains.flagged_chains) == 0, "note-taker must not flag dangerous chains"


def test_max_danger_infra_is_critical():
    config, overrides = _synthetic("infra-max", "Infra Max", "infra", INFRA_MAX_ACTIONS)
    br, chains = _score(config, overrides)
    assert br.score > 80, f"max-danger infra scored only {br.score}"
    assert any(fc.chain.severity == "critical" for fc in chains.flagged_chains)


def test_fleet_ordering_is_stable():
    """The core promise: obviously-different agents rank correctly."""
    note, _ = _score(*_synthetic("note-taker", "Note Taker", "notion", NOTE_TAKER_ACTIONS))
    infra, _ = _score(*_synthetic("infra-max", "Infra Max", "infra", INFRA_MAX_ACTIONS))
    revops, _ = _score_fleet_agent("revenue-ops-agent")
    support, _ = _score_fleet_agent("support-agent")
    incident, _ = _score_fleet_agent("incident-response-agent")
    tier2, _ = _score_fleet_agent("support-tier2-agent")

    assert note.score < revops.score < support.score < incident.score < tier2.score <= infra.score


def test_tier1_support_lands_medium():
    br, _ = _score_fleet_agent("support-agent")
    assert 30 <= br.score < 60, f"tier-1 support at {br.score} left the medium window"


def test_band_always_agrees_with_displayed_score():
    """The band must be derived from the ROUNDED score: an inherent 59.6
    displays as 60, and "60 / medium" is a visible contradiction."""
    from authority.graph import score_band

    for agent_id in ("support-agent", "incident-response-agent", "support-tier2-agent",
                     "accounts-payable-agent", "revenue-ops-agent"):
        br, chains = _score_fleet_agent(agent_id)
        crit = sum(1 for fc in chains.flagged_chains if fc.chain.severity == "critical")
        assert br.band == score_band(br.score, crit), (
            f"{agent_id}: displayed score {br.score} but band {br.band}"
        )


def test_chain_uplift_is_meaningful_but_capped():
    class _FC:
        def __init__(self, sev):
            self.chain = type("C", (), {"severity": sev})()

    # One critical chain must move the score materially (audit: cap was 3.5 —
    # the marquee detection was cosmetic).
    assert _chain_uplift([_FC("critical")]) == CHAIN_WEIGHT["critical"] >= 6.0
    # ...but many chains cannot saturate the score.
    many = [_FC("critical")] * 10
    assert _chain_uplift(many) == CHAIN_UPLIFT_CAP <= 12.0