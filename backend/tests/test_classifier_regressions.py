"""One regression test per empirical failure from the 2026-07-03 classifier audit.

These run under conftest's fixture-replay LLM stub, so they are deterministic
and keyless. Each test names the audit failure it guards.
"""

from __future__ import annotations

import authority.risk_classifier as rc
from authority.risk_classifier import classify_with_fallback, is_effectively_read


def labels(tool, action, desc=""):
    return set(classify_with_fallback(tool, action, desc).risk_labels)


# ── Audit failure #1: strong-keyword FPs locked in without LLM review ────────

def test_transfer_repository_is_not_money_movement():
    m = classify_with_fallback("github_admin", "transfer_repository",
                               "Transfer a repository to another owner")
    assert "moves_money" not in m.risk_labels
    assert "changes_production" in m.risk_labels


def test_charge_battery_is_benign():
    assert labels("iot", "charge_battery", "Start charging the device battery") == set()


def test_credit_check_is_pii_not_money():
    m = classify_with_fallback("crm", "credit_check", "Run a credit check on an applicant")
    assert "moves_money" not in m.risk_labels
    assert "touches_pii" in m.risk_labels


# ── Audit failure #2: union-never-subtract kept keyword FPs after LLM ran ────

def test_llm_veto_removes_weak_keyword_label():
    assert labels("video", "render_credits",
                  "Render the closing credits sequence of a video") == set()


def test_veto_never_removes_unambiguous_labels_when_llm_unavailable(monkeypatch):
    # LLM unavailable (None) must KEEP keyword labels — fail toward flagging.
    monkeypatch.setattr(rc, "classify_with_llm", lambda *a, **k: None)
    assert "moves_money" in labels("video", "render_credits", "Render the credits")


# ── Audit failure #3: CRUD inflation (harmless note-taker scored 24.5) ───────

def test_note_taker_crud_actions_are_benign():
    for action, desc in [
        ("create_page", "Create a new page in a workspace"),
        ("update_page", "Update properties of an existing page"),
        ("move_page", "Move a page to a different parent page"),
    ]:
        assert labels("notion", action, desc) == set(), f"{action} should be benign"


def test_real_infra_writes_keep_changes_production():
    # The veto must not throw away TRUE generic-write labels.
    assert "changes_production" in labels("dns", "update_dns_record",
                                          "Update a DNS record for a domain")


# ── Audit failure #4: read-prefix holes ──────────────────────────────────────

def test_get_or_create_is_not_a_read():
    assert not is_effectively_read("get_or_create_user")
    assert "touches_pii" in labels("db", "get_or_create_user",
                                   "Fetch a user record, creating one if missing")


def test_search_and_email_is_flagged_external():
    m = classify_with_fallback("support", "search_and_email_results",
                               "Search the knowledge base and email results to the customer")
    assert "sends_external" in m.risk_labels
    assert m.reversible is False


def test_plain_reads_still_read():
    assert is_effectively_read("get_blog_posts")  # "posts" != "post" token
    assert is_effectively_read("list_payment_intents")
    assert is_effectively_read("search")  # bare MCP verb


# ── Audit failure #5: execute_sql was a nondeterministic coin flip ───────────

def test_sql_and_shell_exec_are_deterministic_primitives(monkeypatch):
    # Deterministic even with NO LLM at all.
    monkeypatch.setattr(rc, "classify_with_llm", lambda *a, **k: None)
    for tool, action in [("db", "execute_sql"), ("db", "run_sql"), ("ops", "sudo_command")]:
        m = classify_with_fallback(tool, action, "")
        assert {"changes_production", "deletes_data"} <= set(m.risk_labels), action
        assert m.reversible is False, action


# ── Eval-found bug: "snapshot" UI token was eating infra actions ─────────────

def test_snapshot_infra_actions_not_ui_suppressed():
    assert "deletes_data" in labels("aws_rds", "delete_snapshot",
                                    "Delete a database snapshot")
    assert "changes_production" in labels("aws_rds", "restore_snapshot",
                                          "Restore a database instance from a snapshot")


# ── Audit failure #9: vague names must surface as unclassifiable ─────────────

def test_vague_name_with_llm_is_affirmed_benign():
    m = classify_with_fallback("utils", "helper_task",
                               "Performs miscellaneous workspace tasks")
    assert m.risk_labels == []
    assert m.classification_source == "llm"  # LLM affirmed benign


def test_vague_name_without_llm_is_unclassifiable(monkeypatch):
    monkeypatch.setattr(rc, "classify_with_llm", lambda *a, **k: None)
    m = classify_with_fallback("utils", "helper_task",
                               "Performs miscellaneous workspace tasks")
    assert m.risk_labels == []
    assert m.classification_source == "none"  # surfaced, not silently benign


# ── Veto-empties-labels resets keyword irreversibility ───────────────────────

def test_benign_draft_is_reversible_despite_scary_substring():
    # description contains "sending" -> old code marked it irreversible
    m = classify_with_fallback("email_client", "create_draft",
                               "Create a draft email without sending it")
    assert m.risk_labels == []
    assert m.reversible is True


# ── Provenance plumbing ──────────────────────────────────────────────────────

def test_classification_source_vocabulary():
    assert classify_with_fallback("stripe", "get_customer", "").classification_source == "catalog"
    assert classify_with_fallback("db", "execute_sql", "").classification_source == "primitive"
    assert classify_with_fallback("backup", "delete_all_backups",
                                  "Delete every stored backup").classification_source == "strong_kw"
    assert classify_with_fallback("obs", "get_status", "Get system status").classification_source == "read"


# ── Coverage: unclassifiable actions are counted, not hidden ─────────────────

def test_coverage_counts_unclassified_actions():
    from authority.action_mapper import compute_risk_coverage

    tools = [{
        "name": "utils", "service": "Utils",
        "actions": [
            {"action": "helper_task", "risk_labels": [], "classification_source": "none"},
            {"action": "do_stuff", "risk_labels": [], "classification_source": "none"},
            {"action": "get_status", "risk_labels": [], "classification_source": "read"},
            {"action": "wipe_all", "risk_labels": ["deletes_data"], "classification_source": "strong_kw"},
        ],
    }]
    cov = compute_risk_coverage(tools)
    assert cov["totalActions"] == 4
    assert cov["unclassifiedActions"] == 2
    assert cov["unclassifiedList"] == ["utils.helper_task", "utils.do_stuff"]


def test_coverage_legacy_unknown_rows():
    from authority.action_mapper import compute_risk_coverage

    # Pre-provenance rows: unclassified only when label-free AND not a read.
    tools = [{
        "name": "legacy", "service": "Legacy",
        "actions": [
            {"action": "get_report", "risk_labels": [], "classification_source": "unknown"},
            {"action": "mystery_op", "risk_labels": [], "classification_source": "unknown"},
            {"action": "refund_order", "risk_labels": ["moves_money"], "classification_source": "unknown"},
        ],
    }]
    cov = compute_risk_coverage(tools)
    assert cov["unclassifiedActions"] == 1
    assert cov["unclassifiedList"] == ["legacy.mystery_op"]


def test_low_coverage_caps_confidence():
    import main as app_main

    br = {"confidence": "high"}
    tools = [{
        "name": "utils", "service": "Utils",
        "actions": [
            {"action": "helper_task", "risk_labels": [], "classification_source": "none"},
            {"action": "do_stuff", "risk_labels": [], "classification_source": "none"},
            {"action": "get_status", "risk_labels": [], "classification_source": "read"},
        ],
    }]
    out = app_main._attach_coverage(br, tools)
    assert out["confidence"] == "low"  # 2/3 unclassified > 25%
    assert out["coverage"]["unclassifiedActions"] == 2

# ── Audit failure #9: read verb in a LATER token scored writes at the read floor ──
# _is_read_only fell back to scanning every "_" boundary for an unknown service
# prefix, so any name whose tail began with a read verb was treated as a read:
# delete_search_index matched "search_", scored at the 0.15x floor, and dropped
# out of the danger-density bonus. The most destructive actions were the ones
# most likely to be understated.

import pytest

from authority.graph import _is_read_only, score_action
from authority.action_mapper import MappedAction


@pytest.mark.parametrize("action", [
    "delete_search_index",
    "purge_query_cache",
    "drop_search_table",
    "terminate_query_engine",
    "remove_list_entry",
    "overwrite_get_config",
])
def test_write_verb_before_a_read_verb_is_not_a_read(action):
    assert not _is_read_only(action)


@pytest.mark.parametrize("action", [
    "get_customer",
    "stripe_get_customer",
    "aws_ec2_describe_instances",
    "foo_bar_describe_instances",  # the unknown-prefix case the fallback exists for
    "list_charges",
    "get_blog_posts",
])
def test_genuine_reads_still_read(action):
    assert _is_read_only(action)


@pytest.mark.parametrize("action", ["get_or_create_user", "search_and_email_results"])
def test_write_verb_after_a_read_verb_still_wins(action):
    """The pre-existing suffix override must survive the new prefix check."""
    assert not _is_read_only(action)


def test_destructive_action_is_not_scored_at_the_read_floor():
    """The consequence the boolean exists for: a 0.15x floor on a delete."""
    destructive = MappedAction(
        tool="search", service="Search", action="delete_search_index",
        description="Delete a search index", risk_labels=["deletes_data"],
        reversible=False,
    )
    benign_read = MappedAction(
        tool="search", service="Search", action="get_search_index",
        description="Read a search index", risk_labels=["deletes_data"],
        reversible=False,
    )
    assert score_action(destructive) > score_action(benign_read)


# ── Audit failure #10: plain action verbs left real writes unclassified ──────
# KEYWORD_RULES is tuned for SaaS vocabulary (deploy, refund, provision), so the
# ordinary verbs a connected agent exposes — git_commit, create_team,
# apply_migration, fork_repository — matched nothing and scored 0. The generic
# verb baseline is a FLOOR: it only fires when no tuned rule matched, and lands
# as weak_kw so the LLM still adjudicates it.

from authority.risk_classifier import _classify_keywords, DESTROY_VERBS, WRITE_VERBS


@pytest.mark.parametrize("action", ["git_commit", "create_team", "apply_migration",
                                    "fork_repository", "register_webhook"])
def test_plain_write_verbs_are_no_longer_unclassified(action):
    kw = _classify_keywords(action)
    assert "changes_production" in kw["labels"]
    assert kw["sources"]["changes_production"] == "weak_kw"  # vetoable, not locked


@pytest.mark.parametrize("action", ["scrub_dataset", "expunge_records"])
def test_unmatched_destroy_verbs_fall_through(action):
    """The baseline is a floor, not a catch-all: unknown verbs still reach the LLM."""
    assert _classify_keywords(action)["labels"] == []


def test_baseline_does_not_second_guess_a_tuned_match():
    """Gated on `not labels`, so calibrated classifications are untouched."""
    kw = _classify_keywords("create_refund")
    assert kw["sources"]["moves_money"] == "strong_kw"


def test_baseline_never_fires_on_a_read():
    for action in ("get_customer", "list_charges", "describe_instances"):
        kw = _classify_keywords(action)
        assert "changes_production" not in kw["labels"]
        assert "deletes_data" not in kw["labels"]


def test_destroy_and_write_verbs_are_disjoint():
    assert not (DESTROY_VERBS & WRITE_VERBS)


# ── Catalog: actions real agents expose that had no entry ────────────────────

def test_force_push_is_destructive_not_just_a_production_change():
    """No keyword in the name says a force-push destroys the commits it overwrites."""
    from authority.action_mapper import ACTION_CATALOG

    m = ACTION_CATALOG["github"]["force_push"]
    assert set(m.risk_labels) == {"changes_production", "deletes_data"}
    assert m.reversible is False


@pytest.mark.parametrize("tool,action", [
    ("stripe", "list_charges"), ("salesforce", "update_account"),
    ("salesforce", "create_opportunity"), ("github", "create_pull_request"),
    ("aws", "describe_instances"), ("pagerduty", "get_incident"),
])
def test_new_catalog_entries_resolve_exactly(tool, action):
    """Catalog hits are locked — they must not depend on keywords or the LLM."""
    m = classify_with_fallback(tool, action)
    assert m.action == action


# ── Beta-plan item 1.7 (2026-08-18): reads must not carry deletes_data ───────
# A read whose name or description merely MENTIONS deleted/voided records got
# the deletes_data label (matched against name+description), and because a read
# carrying any label never escalates to the LLM, the label was unvetoable. One
# read carrying touches_pii + deletes_data fires the critical pii-delete chain,
# which is a hard fail in /api/scan — the false positive most likely to appear
# in a customer's first scan.

def test_read_mentioning_voided_records_is_not_deletion():
    m = classify_with_fallback("billing", "list_invoices",
                               "Returns all invoices, excluding voided ones")
    assert "deletes_data" not in m.risk_labels


def test_read_of_deleted_records_is_not_deletion():
    # touches_pii survives (by design); deletes_data must not — this exact
    # shape used to fire pii-delete at critical off a single read.
    m = classify_with_fallback("crm", "list_deleted_contacts",
                               "List contacts currently in the recycle bin")
    assert "touches_pii" in m.risk_labels
    assert "deletes_data" not in m.risk_labels


def test_actual_delete_write_still_flagged():
    m = classify_with_fallback("crm", "delete_contact",
                               "Permanently delete a contact record")
    assert "deletes_data" in m.risk_labels


def test_single_recycle_bin_read_no_longer_fires_pii_delete_chain():
    # End-to-end: the customer-facing symptom. One read carrying touches_pii
    # + a phantom deletes_data fired pii-delete at critical (cross-label
    # transitions need no second action), which is a hard fail in /api/scan.
    from authority.chain_detector import detect_chains
    from authority.parser import AgentConfig, ToolDef

    read = classify_with_fallback("crm", "list_deleted_contacts",
                                  "List contacts currently in the recycle bin")
    agent = AgentConfig(id="a1", name="crm-bot", description="",
                        tools=[ToolDef(name="crm", service="crm", description="",
                                       actions=["list_deleted_contacts"])])
    result = detect_chains(agent, action_overrides={"crm": {"list_deleted_contacts": read}})
    fired = {fc.chain.id for fc in result.flagged_chains}
    assert "pii-delete" not in fired


# ── Beta-plan item 1.7, second half: negation-blind "overwrite" substring ────
# "overwrite" was matched as a raw substring of the description, so a write
# whose description says "never overwrites existing keys" was assigned
# deletes_data with source=primitive + irreversible — locked and unvetoable.

def test_negated_overwrite_description_is_not_deletion():
    m = classify_with_fallback("vault", "write_config",
                               "Adds a new config entry; never overwrites existing keys")
    assert "deletes_data" not in m.risk_labels
    assert m.reversible is True


def test_positive_overwrite_description_is_weak_not_locked():
    # Description-only evidence of overwriting is real signal but vetoable:
    # weak_kw, and it must not lock irreversibility on its own.
    m = classify_with_fallback("fs", "edit_document",
                               "Overwrites the target document in place")
    assert "deletes_data" in m.risk_labels
    assert m.label_sources.get("deletes_data") == "weak_kw"
    assert m.reversible is True


def test_write_file_compound_stays_locked_deletion():
    # Name-anchored evidence keeps the old strength: write_file genuinely
    # destroys the prior contents.
    m = classify_with_fallback("fs", "write_file",
                               "Completely overwrite an existing file")
    assert "deletes_data" in m.risk_labels
    assert m.label_sources.get("deletes_data") == "primitive"
    assert m.reversible is False


def test_overwrite_in_action_name_stays_locked_deletion():
    m = classify_with_fallback("fs", "overwrite_settings",
                               "Replace the settings file")
    assert "deletes_data" in m.risk_labels
    assert m.label_sources.get("deletes_data") == "primitive"
    assert m.reversible is False
