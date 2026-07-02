"""Risk classifier — assigns risk labels from action names, descriptions, and schemas.

Three-layer classification:
  1. Hardcoded catalog (exact match, instant)
  2. Keyword heuristics (substring match, instant)
  3. LLM classification (Haiku, cached, accurate)

The LLM layer catches everything keywords miss — archive, export, forward,
revoke, clone, bulk, escalate, etc. Results are cached so each unique action
is only classified once.
"""

from __future__ import annotations

import json
import os
import re
import logging

from authority.action_mapper import ACTION_CATALOG, MappedAction

logger = logging.getLogger(__name__)

# ── Keyword rules (fast path) ────────────────────────────────────────────

KEYWORD_RULES: dict[str, list[str]] = {
    "deletes_data": [
        "delete", "remove", "drop", "purge", "destroy", "truncate", "erase", "wipe",
        "void", "close_period", "revoke",
    ],
    "sends_external": [
        "send", "notify", "message", "sms", "webhook",
        "publish", "broadcast", "alert", "forward", "export",
        "dunning",
    ],
    "moves_money": [
        "pay", "charge", "refund", "transfer",
        "payout", "debit", "credit",
        "create_invoice", "finalize_invoice", "create_refund",
        "create_payment", "void_payment", "create_payout", "create_transfer",
        "retry_payment", "credit_memo", "journal_entry",
    ],
    "touches_pii": [
        "customer", "user", "contact", "personal", "profile",
        "pii", "address", "phone", "ssn", "identity",
        "employee", "patient", "compensation",
    ],
    "changes_production": [
        "deploy", "merge", "release", "production", "infrastructure",
        "instance", "scale", "terminate", "rollback", "migrate", "provision",
        "reboot", "restart", "rotate", "grant", "admin", "decommission",
    ],
}

# High-signal keywords — a match almost certainly means the label is real.
# Everything else in KEYWORD_RULES (broad nouns/verbs like "user", "contact",
# "notify", "message") can match benign actions, so labels backed ONLY by those
# are treated as low-confidence and escalated to the LLM rather than locked in.
STRONG_KEYWORDS: dict[str, list[str]] = {
    "deletes_data": ["delete", "remove", "drop", "purge", "destroy", "truncate",
                     "erase", "wipe", "revoke"],
    "moves_money": ["pay", "charge", "refund", "transfer", "payout", "debit",
                    "credit", "invoice", "payment", "journal_entry", "credit_memo"],
    "changes_production": ["deploy", "release", "terminate", "scale", "provision",
                           "rollback", "migrate", "reboot", "restart", "merge"],
    "sends_external": ["send", "email", "sms", "webhook", "broadcast", "dunning"],
    "touches_pii": ["ssn", "pii", "passport", "patient", "compensation",
                    "social_security", "date_of_birth"],
}

# Read-only action prefixes — these reduce risk even when they match other keywords
# "list_payment_intents" matches "payment" (money keyword) but is a read operation
READ_ACTION_PREFIXES = (
    "get_", "list_", "read_", "search_", "query_", "check_",
    "describe_", "fetch_", "lookup_", "find_", "show_",
)

IRREVERSIBLE_KEYWORDS: list[str] = [
    "delete", "send", "terminate", "purge", "destroy", "drop", "cancel", "remove",
    "void", "finalize", "close_period", "dunning", "forward", "export",
    "truncate", "transfer", "payout", "decommission", "rotate", "revoke",
]

PII_SCHEMA_KEYS: list[str] = [
    # bare "name" removed — it substring-matched filename/username/repo name and
    # flagged infra actions (create_repository, get_label) as touches_pii.
    "email", "phone", "address", "ssn", "social_security",
    "date_of_birth", "dob", "first_name", "last_name", "zip", "postal",
]

VALID_LABELS = {"moves_money", "touches_pii", "deletes_data", "sends_external", "changes_production"}


# ── Agent / dev primitives ───────────────────────────────────────────────────
# The SaaS-flavoured keywords above miss the primitives that matter most for code
# agents: arbitrary shell/code execution, file mutation, and browser automation.
# These are matched on WHOLE TOKENS (so "rm" fires on the action `rm` but not on
# "form"/"transform") plus a few specific multi-word compounds. Arbitrary
# execution is treated as the highest-risk primitive so an LLM miss can never
# under-rate a `bash` tool — the exact gap that let a code agent score "medium".

# Arbitrary code/shell execution → can change prod AND delete data, irreversible.
# NOTE: generic verbs ("execute"/"execution"/"run") are deliberately NOT tokens —
# "Execute a web search" in a description must not read as shell execution. The
# specific tokens below plus the compounds are unambiguous.
CODE_EXEC_TOKENS = {
    "bash", "sh", "zsh", "shell", "exec", "eval",
    "spawn", "subprocess", "popen", "kubectl", "ssh", "terminal", "repl",
}
CODE_EXEC_COMPOUNDS = (
    "run_code", "run_command", "execute_code", "execute_command", "shell_command",
    "code_execution", "code_interpreter", "code_exec", "system_command",
    "arbitrary_code", "command_exec",
)
# File mutation primitives.
FILE_WRITE_TOKENS = {"write", "edit", "patch", "overwrite", "chmod", "chown"}
FILE_WRITE_COMPOUNDS = ("write_file", "edit_file", "create_file", "put_object", "save_file")
FILE_DELETE_TOKENS = {"rm", "rmdir", "unlink", "rmtree"}
FILE_DELETE_COMPOUNDS = ("delete_file", "remove_file", "delete_object")
# Browser/UI automation — interacts with a page; benign on its own, but the LLM
# layer tends to over-label it (e.g. select → deletes_data). Used to suppress
# that escalation, NOT to add labels.
UI_AUTOMATION_TOKENS = {
    "navigate", "click", "hover", "scroll", "screenshot", "select", "fill",
    "type", "press", "goto", "snapshot", "focus", "drag", "puppeteer",
    "playwright", "browser", "evaluate",
}


def _name_has(name: str, tokens: set[str], compounds: tuple = ()) -> bool:
    """Match tokens against the ACTION NAME only (high signal), plus specific
    multi-word compounds. Names drive these decisions, not free-text descriptions
    where generic verbs ("execute a search") cause false positives."""
    toks = set(re.split(r"[^a-z0-9]+", name.lower()))
    if toks & tokens:
        return True
    nl = name.lower()
    return any(c in nl for c in compounds)


def _primitive_labels(action_name: str, description: str, is_read: bool) -> tuple[set[str], bool, bool]:
    """Deterministic labels for agent/dev primitives the SaaS keywords miss.

    Returns (labels, irreversible, is_ui_automation). Arbitrary execution
    (bash/exec/shell/...) maps to changes_production + deletes_data, irreversible.
    Matched on the action NAME (not description) to avoid verb false positives.
    """
    name = action_name
    labels: set[str] = set()
    irreversible = False
    if not is_read and _name_has(name, CODE_EXEC_TOKENS, CODE_EXEC_COMPOUNDS):
        labels.update({"changes_production", "deletes_data"})
        irreversible = True
    if not is_read and _name_has(name, FILE_WRITE_TOKENS, FILE_WRITE_COMPOUNDS):
        labels.add("changes_production")
    if not is_read and _name_has(name, FILE_DELETE_TOKENS, FILE_DELETE_COMPOUNDS):
        labels.add("deletes_data")
        irreversible = True
    is_ui = _name_has(name, UI_AUTOMATION_TOKENS)
    return labels, irreversible, is_ui


def _text_matches_keywords(text: str, keywords: list[str]) -> bool:
    """Check if any keyword appears as a substring in the text."""
    text_lower = text.lower()
    return any(kw in text_lower for kw in keywords)


_KNOWN_PREFIXES = {
    "stripe", "gmail", "sendgrid", "ses", "mailgun", "aws", "slack",
    "salesforce", "zendesk", "hubspot", "github", "pagerduty", "twilio",
    "datadog", "jira", "netsuite", "quickbooks", "bamboohr", "clearbit",
    "docusign", "calendly", "snowflake", "okta", "shopify", "square",
    "paypal", "braintree", "segment", "amplitude", "intercom",
    "aws_ec2", "aws_s3", "aws_rds", "aws_iam", "aws_ecs", "aws_ecr",
    "aws_cloudtrail", "google_workspace", "google_sheets",
}


def _strip_service_prefix(action_name: str) -> str:
    """Strip known service prefixes from MCP-style names.

    stripe_get_customer → get_customer
    netsuite_create_journal_entry → create_journal_entry
    aws_ec2_terminate_instances → terminate_instances
    """
    lower = action_name.lower()
    for svc in sorted(_KNOWN_PREFIXES, key=len, reverse=True):
        if lower.startswith(svc + "_") and len(lower) > len(svc) + 1:
            return lower[len(svc) + 1:]
    return lower


def _is_read_action(action_name: str) -> bool:
    """Check if action is read-only, handling service-prefixed names."""
    stripped = _strip_service_prefix(action_name)
    return stripped.startswith(READ_ACTION_PREFIXES)


def _strong_labels(text: str) -> set[str]:
    """Labels backed by a high-signal keyword — i.e. matches we trust without
    asking the LLM to confirm.

    Single-word keywords match on whole tokens (split on non-alphanumerics) so
    "credit" matches `apply_credit` but NOT `accredit_user`, and "merge" matches
    `merge_branch` but not `submerge_data`. Multi-word keywords (journal_entry)
    keep substring matching since they're already specific.
    """
    text_lower = text.lower()
    tokens = set(re.split(r"[^a-z0-9]+", text_lower))
    found: set[str] = set()
    for label, kws in STRONG_KEYWORDS.items():
        for kw in kws:
            if ("_" in kw and kw in text_lower) or (kw in tokens):
                found.add(label)
                break
    return found


def classify_action(action_name: str, description: str = "") -> tuple[list[str], bool]:
    """Classify an action by keyword heuristics.

    Handles service-prefixed names (stripe_get_customer).
    Read-only actions that match money/PII keywords get those labels
    stripped (reading payment history != moving money).

    Returns (risk_labels, reversible).
    """
    # Strip service prefix for better matching
    stripped = _strip_service_prefix(action_name)
    combined = f"{stripped} {action_name} {description}".lower()
    is_read = _is_read_action(action_name)

    risk_labels = []
    for label, keywords in KEYWORD_RULES.items():
        if any(kw in combined for kw in keywords):
            # Read-only actions: keep PII label (reading PII matters for chain detection)
            # but drop money/production/external-send labels (reading payment history
            # != moving money; a get_/list_ can't send externally even if its
            # description mentions "messages"/"alert"/"webhook").
            if is_read and label in ("moves_money", "changes_production", "sends_external"):
                continue
            risk_labels.append(label)

    # Agent/dev primitives the SaaS keywords miss (bash, exec, file write/delete).
    prim_labels, prim_irreversible, is_ui = _primitive_labels(stripped, description, is_read)
    for lbl in prim_labels:
        if lbl not in risk_labels:
            risk_labels.append(lbl)

    reversible = is_read or not any(kw in combined for kw in IRREVERSIBLE_KEYWORDS)
    if prim_irreversible:
        reversible = False

    # Browser/UI automation (click, select, navigate, screenshot…) is a benign
    # page interaction. Loose substring keyword matches ("drop" inside "dropdown")
    # otherwise mislabel it as deletion/money — the false "critical" we saw on a
    # real repo. Strip the physical-world labels unless a real code-exec/file
    # primitive actually fired.
    if is_ui and not prim_labels:
        risk_labels = [l for l in risk_labels if l not in ("deletes_data", "moves_money", "changes_production")]
        reversible = True

    return risk_labels, reversible


def schema_hints(properties: dict) -> list[str]:
    """Extract extra risk labels by scanning JSON Schema property names."""
    if not properties:
        return []

    extra_labels: set[str] = set()
    prop_names = " ".join(properties.keys()).lower()

    if any(kw in prop_names for kw in PII_SCHEMA_KEYS):
        extra_labels.add("touches_pii")

    return list(extra_labels)


# ── LLM classification (accurate path) ──────────────────────────────────

import threading

_llm_cache: dict[str, tuple[list[str], bool]] = {}
_llm_cache_lock = threading.Lock()

LLM_SYSTEM_PROMPT = """You are a security risk classifier for AI agent tools. Given a tool action, classify its risk.

Return a JSON object with exactly two fields:
- "risk_labels": array of applicable labels from ONLY these values: "moves_money", "touches_pii", "deletes_data", "sends_external", "changes_production"
- "reversible": boolean, false if the action cannot be undone (deletes, sends, terminates)

Rules:
- "moves_money": creates charges, refunds, transfers, invoices, subscriptions, payouts
- "touches_pii": reads/writes personal data (names, emails, phones, addresses, payment info, health records)
- "deletes_data": permanently removes, archives, purges, revokes, or destroys records
- "sends_external": sends emails, SMS, messages, notifications, webhooks, exports data outside the system
- "changes_production": deploys, merges, scales, provisions, modifies infrastructure, changes configs, rotates keys

An action can have 0 or multiple labels. Be conservative — only apply labels that clearly fit.

Return ONLY the JSON object, no explanation."""


def classify_with_llm(action_name: str, description: str = "", schema_props: dict | None = None) -> tuple[list[str], bool] | None:
    """Classify an action using Claude Haiku. Returns (risk_labels, reversible) or None on failure."""
    cache_key = f"{action_name}:{description}"
    with _llm_cache_lock:
        if cache_key in _llm_cache:
            return _llm_cache[cache_key]

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return None

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)

        user_msg = f"Tool action: {action_name}"
        if description:
            user_msg += f"\nDescription: {description}"
        if schema_props:
            user_msg += f"\nInput parameters: {json.dumps(list(schema_props.keys()))}"

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=200,
            system=LLM_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )

        text = response.content[0].text.strip()
        # Parse JSON — handle markdown code blocks
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

        result = json.loads(text)
        labels = [l for l in result.get("risk_labels", []) if l in VALID_LABELS]
        reversible = result.get("reversible", True)

        with _llm_cache_lock:
            _llm_cache[cache_key] = (labels, reversible)
        return labels, reversible

    except Exception as e:
        logger.warning(f"LLM classification failed for {action_name}: {e}")
        return None


# ── Main entry point ─────────────────────────────────────────────────────

def classify_with_fallback(
    tool_name: str,
    action_name: str,
    description: str = "",
    input_schema: dict | None = None,
) -> MappedAction:
    """Three-layer classification: catalog → keywords → LLM.

    1. Hardcoded catalog (exact match for known tools)
    2. Keyword heuristics (fast, covers common patterns)
    3. LLM via Haiku (accurate, catches everything else, cached)
    """
    # Layer 1: Hardcoded catalog
    cataloged = ACTION_CATALOG.get(tool_name, {}).get(action_name)
    if cataloged:
        return cataloged

    # Layer 2: Keyword heuristics
    risk_labels, reversible = classify_action(action_name, description)

    # Augment with schema hints. Explicit PII fields (email/ssn/...) are a
    # high-signal source, so schema labels count as "strong".
    props = {}
    schema_labels: list[str] = []
    if input_schema:
        props = input_schema.get("properties", {})
        schema_labels = schema_hints(props)
        for extra in schema_labels:
            if extra not in risk_labels:
                risk_labels.append(extra)

    # Layer 3: LLM. Escalate not only when keywords found nothing, but also when
    # confidence is LOW — a write action whose labels came only from broad,
    # ambiguous keywords (e.g. "user", "send", "message") and not a high-signal
    # one. Without this, a novel dangerous action that happens to contain a
    # benign substring locks to the (possibly wrong) keyword label forever.
    combined = f"{_strip_service_prefix(action_name)} {action_name} {description}".lower()
    is_read = _is_read_action(action_name)
    # Agent/dev primitives are high-signal: a matched code-exec/file label is
    # trusted (counts as strong) so we never depend on the LLM to flag a `bash`
    # tool. Benign browser automation is suppressed from LLM escalation, which
    # otherwise invents labels (e.g. puppeteer_select → deletes_data).
    prim_labels, _, is_ui = _primitive_labels(_strip_service_prefix(action_name), description, is_read)
    strong = _strong_labels(combined) | set(schema_labels) | prim_labels
    low_confidence = (not risk_labels) or (not is_read and not strong)
    if is_ui and not risk_labels and not prim_labels:
        low_confidence = False

    if low_confidence:
        llm_result = classify_with_llm(action_name, description, props or None)
        if llm_result:
            llm_labels, llm_reversible = llm_result
            # UNION, never subtract: escalation exists to ADD a dangerous label
            # the keywords missed, not to let the LLM strip a label the keyword
            # layer already flagged. Over-flagging is the safe direction for a
            # risk classifier; the keyword labels here already had read-only
            # stripping applied, so reads don't pick up money/prod labels.
            risk_labels = sorted(set(risk_labels) | set(llm_labels))
            # Irreversible if either the LLM or the keyword layer says so.
            reversible = llm_reversible and reversible

    return MappedAction(
        tool=tool_name,
        service=tool_name.capitalize(),
        action=action_name,
        description=description,
        risk_labels=risk_labels,
        reversible=reversible,
    )
