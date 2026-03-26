"""Heuristic risk classifier — auto-assigns risk labels from action names and descriptions."""

from __future__ import annotations

from authority.action_mapper import ACTION_CATALOG, MappedAction


# ── Keyword rules ──────────────────────────────────────────────────────────

KEYWORD_RULES: dict[str, list[str]] = {
    "deletes_data": [
        "delete", "remove", "drop", "purge", "destroy", "truncate", "erase", "wipe",
    ],
    "sends_external": [
        "send", "email", "notify", "post", "message", "sms", "webhook",
        "publish", "broadcast", "alert",
    ],
    "moves_money": [
        "pay", "charge", "refund", "invoice", "transfer", "billing",
        "payout", "debit", "credit", "subscription", "price",
    ],
    "touches_pii": [
        "customer", "user", "contact", "personal", "profile", "account",
        "pii", "address", "phone", "ssn", "identity",
    ],
    "changes_production": [
        "deploy", "merge", "release", "production", "infrastructure",
        "instance", "scale", "terminate", "rollback", "migrate", "provision",
    ],
}

IRREVERSIBLE_KEYWORDS: list[str] = [
    "delete", "send", "terminate", "purge", "destroy", "drop", "cancel", "remove",
]

# PII-indicating schema property names
PII_SCHEMA_KEYS: list[str] = [
    "email", "phone", "name", "address", "ssn", "social_security",
    "date_of_birth", "dob", "first_name", "last_name", "zip", "postal",
]


def _text_matches_keywords(text: str, keywords: list[str]) -> bool:
    """Check if any keyword appears as a substring in the text."""
    text_lower = text.lower()
    return any(kw in text_lower for kw in keywords)


def classify_action(action_name: str, description: str = "") -> tuple[list[str], bool]:
    """Classify an action by its name and description.

    Returns (risk_labels, reversible).
    """
    combined = f"{action_name} {description}".lower()

    risk_labels = []
    for label, keywords in KEYWORD_RULES.items():
        if any(kw in combined for kw in keywords):
            risk_labels.append(label)

    reversible = not any(kw in combined for kw in IRREVERSIBLE_KEYWORDS)

    return risk_labels, reversible


def schema_hints(properties: dict) -> list[str]:
    """Extract extra risk labels by scanning JSON Schema property names.

    For example, if a tool's inputSchema has an "email" or "phone" property,
    that hints at PII access.
    """
    if not properties:
        return []

    extra_labels: set[str] = set()
    prop_names = " ".join(properties.keys()).lower()

    if any(kw in prop_names for kw in PII_SCHEMA_KEYS):
        extra_labels.add("touches_pii")

    return list(extra_labels)


def classify_with_fallback(
    tool_name: str,
    action_name: str,
    description: str = "",
    input_schema: dict | None = None,
) -> MappedAction:
    """Check ACTION_CATALOG first; if not found, use heuristic classifier.

    Optionally accepts an input_schema dict to extract extra hints from
    property names.
    """
    # Try the hardcoded catalog first
    cataloged = ACTION_CATALOG.get(tool_name, {}).get(action_name)
    if cataloged:
        return cataloged

    # Heuristic classification
    risk_labels, reversible = classify_action(action_name, description)

    # Augment with schema hints if provided
    if input_schema:
        props = input_schema.get("properties", {})
        for extra in schema_hints(props):
            if extra not in risk_labels:
                risk_labels.append(extra)

    return MappedAction(
        tool=tool_name,
        service=tool_name.capitalize(),
        action=action_name,
        description=description,
        risk_labels=risk_labels,
        reversible=reversible,
    )
