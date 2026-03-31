"""Smart tool name parser — normalizes every format into tool_name + action_name."""

from __future__ import annotations

import re

KNOWN_SERVICES = {
    "stripe", "gmail", "sendgrid", "ses", "mailgun", "aws", "gcp", "azure",
    "slack", "salesforce", "zendesk", "hubspot", "github", "gitlab", "bitbucket",
    "pagerduty", "twilio", "datadog", "jira", "linear", "notion", "airtable",
    "shopify", "square", "paypal", "braintree", "docusign", "calendly",
    "quickbooks", "bamboohr", "okta", "auth0", "clearbit", "segment",
    "amplitude", "mixpanel", "snowflake", "bigquery", "redis", "mongo",
    "postgres", "mysql", "supabase", "vercel", "netlify", "heroku",
    "cloudflare", "pinecone", "weaviate", "intercom", "freshdesk", "front",
    "google", "microsoft", "oracle", "sap",
    # Compound services
    "aws_ec2", "aws_s3", "aws_rds", "aws_iam", "aws_ecs", "aws_ecr",
    "aws_cloudtrail", "aws_lambda",
    "google_workspace", "google_sheets", "google_drive", "google_calendar",
}

_STRIP_SUFFIXES = {"tool", "action", "function", "api", "client", "service", "handler"}


def parse_tool_name(raw: str) -> tuple[str, str]:
    """Parse any tool name format into (tool_name, action_name).

    Handles:
      stripe_create_refund       → (stripe, create_refund)
      Stripe.CreateRefund        → (stripe, create_refund)
      create_refund              → (unknown, create_refund)
      stripe:refund:create       → (stripe, refund_create)
      StripeCreateRefundTool     → (stripe, create_refund)
      gmail_send_message         → (gmail, send_message)
      aws_ec2_terminate_instances → (aws_ec2, terminate_instances)
      terminate-instances        → (unknown, terminate_instances)
      SearchAPI                  → (unknown, search)
    """
    if not raw:
        return "unknown", "unknown"

    # Handle double-underscore separator (our own format)
    if "__" in raw:
        parts = raw.split("__", 1)
        return _clean(parts[0]), _clean(parts[1])

    # Handle dot separator
    if "." in raw:
        parts = raw.split(".", 1)
        return _clean(parts[0]), _to_snake(parts[1])

    # Handle colon separator
    if ":" in raw:
        parts = raw.split(":")
        return _clean(parts[0]), "_".join(_clean(p) for p in parts[1:])

    # Handle hyphen separator
    if "-" in raw and "_" not in raw:
        normalized = raw.replace("-", "_").lower()
        return _split_by_service(normalized)

    # Handle CamelCase
    if any(c.isupper() for c in raw[1:]):
        snake = _to_snake(raw)
        return _split_by_service(snake)

    # Handle underscore-separated
    return _split_by_service(raw.lower())


def _split_by_service(snake: str) -> tuple[str, str]:
    """Split a snake_case string, checking for known service prefixes."""
    # Strip known suffixes
    parts = snake.split("_")
    while parts and parts[-1] in _STRIP_SUFFIXES:
        parts.pop()
    if not parts:
        return "unknown", snake

    snake = "_".join(parts)

    # Try compound services first (aws_ec2, google_workspace)
    for svc in sorted(KNOWN_SERVICES, key=len, reverse=True):
        if snake.startswith(svc + "_") and len(snake) > len(svc) + 1:
            action = snake[len(svc) + 1:]
            return svc, action

    # Single-word service
    first = parts[0]
    if first in KNOWN_SERVICES and len(parts) > 1:
        return first, "_".join(parts[1:])

    return "unknown", snake


def _to_snake(name: str) -> str:
    """Convert CamelCase/PascalCase to snake_case."""
    # Insert underscore before uppercase letters
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1_\2', name)
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', s)
    return s.lower().strip("_")


def _clean(s: str) -> str:
    """Lowercase and strip whitespace."""
    return s.strip().lower().replace("-", "_").replace(" ", "_")
