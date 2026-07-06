"""Tests for the enterprise threat-primitive taxonomy (2026-07-06).

Covers the 5 labels added beyond the original 5 — changes_access, reads_secrets,
evades_detection, bulk_export, executes_code — and the chains they unlock.
"""

from __future__ import annotations

import os

# Keyword/primitive layers are deterministic and keyless; force the LLM off so
# these assertions never depend on a network call.
os.environ.setdefault("ANTHROPIC_API_KEY", "")

from authority.action_mapper import RISK_LABELS
from authority.graph import LABEL_WEIGHTS, calculate_blast_radius
from authority.chain_detector import LABEL_TRANSITIONS, detect_chains
from authority.parser import AgentConfig, ToolDef
from authority.risk_classifier import VALID_LABELS, classify_with_fallback

NEW_LABELS = {"changes_access", "reads_secrets", "evades_detection",
              "bulk_export", "executes_code"}


def _tool(name: str) -> ToolDef:
    return ToolDef(name=name, service=name, description=name)


def _infra_agent() -> AgentConfig:
    # aws catalog carries the new secret/access/evasion/code actions.
    return AgentConfig(id="a1", name="Infra", description="d",
                       tools=[_tool("aws"), _tool("email"), _tool("salesforce")])


# ── Taxonomy wiring — the silent-drop guardrails ─────────────────────────────

def test_new_labels_registered_everywhere():
    for label in NEW_LABELS:
        assert label in VALID_LABELS, f"{label} missing from VALID_LABELS (LLM/cache would drop it)"
        assert label in RISK_LABELS, f"{label} missing from RISK_LABELS descriptions"


def test_no_unambiguous_keyword_is_dead_locked():
    # Every UNAMBIGUOUS keyword must actually assign its label when it appears in
    # an action name. A keyword that is "locked" but absent from KEYWORD_RULES (and
    # not covered by a primitive/substring) never fires — the dead-lock that made
    # disburse_loan / invoice_customer score $0 exposure.
    from authority.risk_classifier import classify_action, UNAMBIGUOUS_KEYWORDS
    dead = []
    for label, kws in UNAMBIGUOUS_KEYWORDS.items():
        for kw in kws:
            name = kw if "_" in kw else f"{kw}_record"
            if label not in classify_action(name)[0]:
                dead.append(f"{label}:{kw}")
    assert not dead, f"dead-locked unambiguous keywords (locked but never assigned): {dead}"


def test_dangerous_money_verbs_classify_without_llm():
    # No-key/keyword-only path must not miss money movement (was scoring $0).
    from authority.risk_classifier import classify_action
    for a in ("disburse_loan", "wire_funds_to_vendor", "settle_ach_batch",
              "remit_payment", "reimburse_expense", "invoice_customer"):
        assert "moves_money" in classify_action(a)[0], f"{a} missed moves_money"


def test_every_valid_label_has_a_weight():
    # graph.score_action uses LABEL_WEIGHTS.get(l, 0): an unweighted label
    # silently scores zero. Guard against adding a label without a weight.
    for label in VALID_LABELS:
        assert label in LABEL_WEIGHTS, f"{label} has no scoring weight"
        assert LABEL_WEIGHTS[label] > 0


# ── Classification of the new primitives ─────────────────────────────────────

def test_new_primitives_classify():
    cases = {
        ("vault", "get_secret", "Retrieve a secret value"): "reads_secrets",
        ("iam", "grant_role", "Grant a role to a user"): "changes_access",
        ("logging", "disable_cloudtrail", "Disable a CloudTrail audit trail"): "evades_detection",
        ("data", "dump_database", "Dump the entire database to a file"): "bulk_export",
        ("ssm", "run_command", "Run an arbitrary shell command"): "executes_code",
    }
    for (tool, action, desc), expected in cases.items():
        m = classify_with_fallback(tool, action, desc)
        assert expected in m.risk_labels, f"{action} -> {m.risk_labels}, expected {expected}"


# ── Chain detection ──────────────────────────────────────────────────────────

def test_catalog_covers_all_new_labels():
    # Every new label needs at least one catalog action, or its chains never fire
    # for the reference/demo fleet.
    from authority.action_mapper import ACTION_CATALOG
    seen = set()
    for actions in ACTION_CATALOG.values():
        for a in actions.values():
            seen.update(a.risk_labels)
    for label in NEW_LABELS:
        assert label in seen, f"no catalog action carries {label}"


def test_enterprise_chains_fire_on_infra_agent():
    agent = _infra_agent()
    fired = {fc.chain.id for fc in detect_chains(agent).flagged_chains}
    # Privilege escalation, credential exfil, defense evasion, bulk exfil, code exec.
    for expected in ("access-external", "secrets-external", "evade-delete",
                     "delete-evade", "bulk-external", "code-external"):
        assert expected in fired, f"chain {expected} did not fire (fired: {sorted(fired)})"


def test_all_transition_labels_are_valid():
    for t in LABEL_TRANSITIONS:
        assert t.from_label in VALID_LABELS, t.id
        assert t.to_label in VALID_LABELS, t.id


def test_new_labels_feed_blast_radius():
    agent = _infra_agent()
    br = calculate_blast_radius(agent)
    # An infra agent that can read secrets, change access, disable logging, and
    # run code must land critical.
    assert br.score >= 80
    assert br.changes_access > 0
    assert br.reads_secrets > 0
    assert br.evades_detection > 0
    assert br.executes_code > 0
