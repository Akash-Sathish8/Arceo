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
        "reboot", "restart",
    ],
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
]

PII_SCHEMA_KEYS: list[str] = [
    "email", "phone", "name", "address", "ssn", "social_security",
    "date_of_birth", "dob", "first_name", "last_name", "zip", "postal",
]

VALID_LABELS = {"moves_money", "touches_pii", "deletes_data", "sends_external", "changes_production"}


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
            # but drop money/production labels (reading payment history != moving money)
            if is_read and label in ("moves_money", "changes_production"):
                continue
            risk_labels.append(label)

    reversible = is_read or not any(kw in combined for kw in IRREVERSIBLE_KEYWORDS)

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

_llm_cache: dict[str, tuple[list[str], bool]] = {}

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

    # Augment with schema hints
    props = {}
    if input_schema:
        props = input_schema.get("properties", {})
        for extra in schema_hints(props):
            if extra not in risk_labels:
                risk_labels.append(extra)

    # Layer 3: LLM for unknown actions with no keyword matches
    if not risk_labels:
        llm_result = classify_with_llm(action_name, description, props or None)
        if llm_result:
            risk_labels, reversible = llm_result

    return MappedAction(
        tool=tool_name,
        service=tool_name.capitalize(),
        action=action_name,
        description=description,
        risk_labels=risk_labels,
        reversible=reversible,
    )
