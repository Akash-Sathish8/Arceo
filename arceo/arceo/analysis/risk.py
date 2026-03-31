"""Local risk inference — runs in <10ms, no LLM, no network."""

from __future__ import annotations

VERB_MAP = {
    "get": "read", "list": "read", "read": "read", "describe": "read",
    "fetch": "read", "search": "read", "query": "read", "check": "read",
    "find": "read", "lookup": "read", "show": "read", "view": "read",
    "create": "create", "add": "create", "insert": "create", "post": "create",
    "new": "create", "register": "create", "provision": "create",
    "update": "update", "modify": "update", "patch": "update", "set": "update",
    "edit": "update", "change": "update", "configure": "update",
    "delete": "delete", "remove": "delete", "destroy": "delete", "purge": "delete",
    "drop": "delete", "wipe": "delete", "erase": "delete", "revoke": "delete",
    "send": "send", "email": "send", "notify": "send", "publish": "send",
    "broadcast": "send", "forward": "send", "export": "send", "post": "send",
    "deploy": "execute", "migrate": "execute", "scale": "execute",
    "restart": "execute", "terminate": "execute", "reboot": "execute",
    "rollback": "execute", "trigger": "execute", "merge": "execute",
    "pay": "transact", "charge": "transact", "refund": "transact",
    "transfer": "transact", "payout": "transact", "invoice": "transact",
    "void": "transact", "cancel": "transact",
}

SERVICE_RISK = {
    "stripe": "moves_money", "square": "moves_money", "paypal": "moves_money",
    "braintree": "moves_money", "quickbooks": "moves_money",
    "gmail": "sends_external", "sendgrid": "sends_external", "ses": "sends_external",
    "mailgun": "sends_external", "twilio": "sends_external",
    "salesforce": "touches_pii", "hubspot": "touches_pii", "zendesk": "touches_pii",
    "bamboohr": "touches_pii", "clearbit": "touches_pii", "intercom": "touches_pii",
}

INFRA_SERVICES = {"aws", "gcp", "azure", "aws_ec2", "aws_ecs", "aws_rds", "aws_iam", "aws_s3"}

ARG_HINTS = {
    "touches_pii": {"email", "phone", "ssn", "address", "dob", "date_of_birth",
                     "first_name", "last_name", "name", "social_security", "customer_id"},
    "moves_money": {"amount", "price", "cents", "currency", "total", "subtotal", "payment_id"},
    "sends_external": {"to", "recipient", "destination", "webhook_url", "email_to"},
}

LABEL_TRANSITIONS = [
    ("touches_pii", "sends_external", "potential_exfiltration", "critical"),
    ("touches_pii", "moves_money", "pii_to_financial", "critical"),
    ("touches_pii", "deletes_data", "pii_then_delete", "critical"),
    ("moves_money", "deletes_data", "fraud_and_cover", "critical"),
    ("moves_money", "sends_external", "money_then_external", "high"),
    ("changes_production", "deletes_data", "infrastructure_destruction", "critical"),
    ("changes_production", "changes_production", "cascading_changes", "high"),
    ("deletes_data", "sends_external", "destroy_and_exfil", "high"),
]

READ_PREFIXES = ("get_", "list_", "read_", "describe_", "fetch_", "search_", "query_", "check_", "find_", "show_")


def infer_verb(action_name: str) -> str:
    """Infer the verb category from an action name."""
    lower = action_name.lower()
    for prefix, verb in VERB_MAP.items():
        if lower.startswith(prefix + "_") or lower.startswith(prefix):
            return verb
    return "unknown"


def infer_risk(tool_name: str, action_name: str, arg_keys: list = None) -> tuple[list, bool]:
    """Infer risk hints from tool name, action name, and argument keys.

    Returns (risk_hints, is_read_only). Runs in <1ms.
    """
    hints = set()
    lower_action = action_name.lower()
    lower_tool = tool_name.lower()
    is_read_only = lower_action.startswith(READ_PREFIXES)

    # From verb
    verb = infer_verb(action_name)
    if verb == "delete":
        hints.add("deletes_data")
    elif verb == "send":
        hints.add("sends_external")
    elif verb == "transact":
        hints.add("moves_money")
    elif verb == "execute":
        hints.add("changes_production")

    # From service name
    if lower_tool in SERVICE_RISK:
        hints.add(SERVICE_RISK[lower_tool])
    if lower_tool in INFRA_SERVICES and not is_read_only:
        hints.add("changes_production")

    # From action keywords
    money_words = {"refund", "charge", "pay", "transfer", "payout", "invoice", "billing", "subscription", "price"}
    pii_words = {"customer", "user", "contact", "account", "personal", "profile", "patient", "employee"}
    send_words = {"send", "email", "notify", "message", "sms", "alert", "forward", "export"}
    delete_words = {"delete", "remove", "destroy", "purge", "drop", "wipe", "terminate", "cancel", "revoke"}
    prod_words = {"deploy", "merge", "release", "scale", "restart", "migrate", "provision", "reboot", "rollback"}

    for w in money_words:
        if w in lower_action:
            hints.add("moves_money")
    for w in pii_words:
        if w in lower_action:
            hints.add("touches_pii")
    for w in send_words:
        if w in lower_action:
            hints.add("sends_external")
    for w in delete_words:
        if w in lower_action:
            hints.add("deletes_data")
    for w in prod_words:
        if w in lower_action:
            hints.add("changes_production")

    # From argument keys
    if arg_keys:
        lower_keys = {k.lower() for k in arg_keys}
        for label, hint_keys in ARG_HINTS.items():
            if lower_keys & hint_keys:
                hints.add(label)

    return sorted(hints), is_read_only


def detect_chains_local(tool_calls) -> list:
    """Detect dangerous chains from a sequence of tool calls. No network.

    tool_calls: list of ArceoToolCall objects
    Returns list of chain dicts.
    """
    if len(tool_calls) < 2:
        return []

    # Build (index, risk_hints) pairs
    steps = [(i, set(tc.inferred_risk_hints)) for i, tc in enumerate(tool_calls)]

    chains = []
    seen = set()

    for from_label, to_label, chain_name, severity in LABEL_TRANSITIONS:
        if chain_name in seen:
            continue
        for i, (idx_a, hints_a) in enumerate(steps):
            if from_label not in hints_a:
                continue
            for idx_b, hints_b in steps[i + 1:]:
                if to_label not in hints_b:
                    continue
                # Same label needs different operations
                if from_label == to_label:
                    if tool_calls[idx_a].full_operation == tool_calls[idx_b].full_operation:
                        continue
                chains.append({
                    "chain_name": chain_name,
                    "severity": severity,
                    "from_label": from_label,
                    "to_label": to_label,
                    "steps": [idx_a, idx_b],
                    "from_operation": tool_calls[idx_a].full_operation,
                    "to_operation": tool_calls[idx_b].full_operation,
                })
                seen.add(chain_name)
                break

    return chains
