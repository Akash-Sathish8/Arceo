"""Phase 2: Action mapper — maps every tool action to risk labels."""

from __future__ import annotations

from dataclasses import dataclass, field

# Risk label definitions
RISK_LABELS = {
    "moves_money": "Can create charges, refunds, or transfer funds",
    "touches_pii": "Accesses or modifies personally identifiable information",
    "deletes_data": "Can permanently remove records or resources",
    "sends_external": "Sends data outside the organization (email, messages to customers)",
    "changes_production": "Modifies live production infrastructure or deployments",
    # ── Enterprise threat primitives (grounded in MITRE ATT&CK / OWASP Agentic) ──
    "changes_access": "Modifies permissions, roles, credential issuance, or account access (IAM grants, admin promotion, password resets, API-key creation)",
    "reads_secrets": "Reads secrets, credentials, tokens, API keys, private keys, or environment variables",
    "evades_detection": "Disables, deletes, or tampers with logging, audit trails, monitoring, or alerting",
    "bulk_export": "Reads or exports data in bulk — mass export, full dumps, or list-all at volume",
    "executes_code": "Runs arbitrary code, shell commands, or SQL",
}

# The labels that make an action "dangerous" for resilience/coverage scoring
# (red team, boundary tester, trace replay). Every risk label EXCEPT touches_pii —
# touching PII is sensitive but, on its own, an expected part of many benign
# agents' jobs, so counting it here would swamp the danger signal with noise
# (exfil-shaped PII flows are caught by chain rules, not this flat set).
# Single source of truth: keeping three private copies in sync is what let the
# red-team set silently fall behind at 4 of 9 labels.
DANGEROUS_LABELS = frozenset({
    "moves_money", "deletes_data", "sends_external", "changes_production",
    "changes_access", "reads_secrets", "evades_detection", "bulk_export",
    "executes_code",
})


@dataclass
class MappedAction:
    tool: str
    service: str
    action: str
    description: str
    risk_labels: list[str] = field(default_factory=list)
    reversible: bool = True
    # Provenance: label -> catalog|primitive|schema|strong_kw|weak_kw|llm, and
    # the strongest overall signal (plus benign markers read/ui, or "none" =
    # unclassifiable). Defaults mean hand-written catalog entries are
    # implicitly source "catalog" with no per-entry edits.
    label_sources: dict = field(default_factory=dict)
    classification_source: str = "catalog"


# ── Hardcoded realistic action mappings ─────────────────────────────────────

ACTION_CATALOG: dict[str, dict[str, MappedAction]] = {
    # ── Stripe ──────────────────────────────────────────────────────────────
    "stripe": {
        "get_customer": MappedAction(
            tool="stripe", service="Stripe", action="get_customer",
            description="Retrieve customer profile and payment methods",
            risk_labels=["touches_pii"], reversible=True,
        ),
        "list_payments": MappedAction(
            tool="stripe", service="Stripe", action="list_payments",
            description="List payment history for a customer",
            risk_labels=["touches_pii"], reversible=True,
        ),
        "get_invoice": MappedAction(
            tool="stripe", service="Stripe", action="get_invoice",
            description="Retrieve a specific invoice",
            risk_labels=[], reversible=True,
        ),
        "create_refund": MappedAction(
            tool="stripe", service="Stripe", action="create_refund",
            description="Issue a refund to a customer's payment method",
            risk_labels=["moves_money"], reversible=False,
        ),
        "create_charge": MappedAction(
            tool="stripe", service="Stripe", action="create_charge",
            description="Charge a customer's payment method",
            risk_labels=["moves_money"], reversible=False,
        ),
        "update_subscription": MappedAction(
            tool="stripe", service="Stripe", action="update_subscription",
            description="Modify a customer's subscription plan",
            risk_labels=["moves_money"], reversible=True,
        ),
        "cancel_subscription": MappedAction(
            tool="stripe", service="Stripe", action="cancel_subscription",
            description="Cancel a customer's subscription",
            risk_labels=["moves_money"], reversible=False,
        ),
        "delete_customer": MappedAction(
            tool="stripe", service="Stripe", action="delete_customer",
            description="Permanently delete a customer and all associated data",
            risk_labels=["deletes_data", "touches_pii"], reversible=False,
        ),
    },

    # ── Zendesk ─────────────────────────────────────────────────────────────
    "zendesk": {
        "get_ticket": MappedAction(
            tool="zendesk", service="Zendesk", action="get_ticket",
            description="Retrieve a support ticket", risk_labels=[], reversible=True,
        ),
        "update_ticket": MappedAction(
            tool="zendesk", service="Zendesk", action="update_ticket",
            description="Update ticket fields or status", risk_labels=[], reversible=True,
        ),
        "close_ticket": MappedAction(
            tool="zendesk", service="Zendesk", action="close_ticket",
            description="Close a support ticket", risk_labels=[], reversible=True,
        ),
        "create_ticket": MappedAction(
            tool="zendesk", service="Zendesk", action="create_ticket",
            description="Create a new support ticket", risk_labels=[], reversible=True,
        ),
        "add_comment": MappedAction(
            tool="zendesk", service="Zendesk", action="add_comment",
            description="Add a comment to a ticket (may be visible to customer)",
            risk_labels=["sends_external"], reversible=False,
        ),
        "assign_ticket": MappedAction(
            tool="zendesk", service="Zendesk", action="assign_ticket",
            description="Assign ticket to an agent", risk_labels=[], reversible=True,
        ),
        "list_tickets": MappedAction(
            tool="zendesk", service="Zendesk", action="list_tickets",
            description="List tickets matching criteria", risk_labels=[], reversible=True,
        ),
        "delete_ticket": MappedAction(
            tool="zendesk", service="Zendesk", action="delete_ticket",
            description="Permanently delete a support ticket",
            risk_labels=["deletes_data"], reversible=False,
        ),
    },

    # ── Salesforce ──────────────────────────────────────────────────────────
    "salesforce": {
        "query_contacts": MappedAction(
            tool="salesforce", service="Salesforce", action="query_contacts",
            description="Search and list customer contacts",
            risk_labels=["touches_pii"], reversible=True,
        ),
        "get_account": MappedAction(
            tool="salesforce", service="Salesforce", action="get_account",
            description="Retrieve account details", risk_labels=["touches_pii"], reversible=True,
        ),
        "update_record": MappedAction(
            tool="salesforce", service="Salesforce", action="update_record",
            description="Update any Salesforce record",
            risk_labels=["touches_pii"], reversible=True,
        ),
        "create_record": MappedAction(
            tool="salesforce", service="Salesforce", action="create_record",
            description="Create a new record in Salesforce",
            risk_labels=["touches_pii"], reversible=True,
        ),
        "delete_record": MappedAction(
            tool="salesforce", service="Salesforce", action="delete_record",
            description="Permanently delete a Salesforce record",
            risk_labels=["deletes_data", "touches_pii"], reversible=False,
        ),
        "query_opportunities": MappedAction(
            tool="salesforce", service="Salesforce", action="query_opportunities",
            description="Search sales opportunities", risk_labels=[], reversible=True,
        ),
        "add_note": MappedAction(
            tool="salesforce", service="Salesforce", action="add_note",
            description="Add a note to a record", risk_labels=[], reversible=True,
        ),
        "get_contact_history": MappedAction(
            tool="salesforce", service="Salesforce", action="get_contact_history",
            description="View contact interaction history",
            risk_labels=["touches_pii"], reversible=True,
        ),
        "bulk_export_contacts": MappedAction(
            tool="salesforce", service="Salesforce", action="bulk_export_contacts",
            description="Export the full contact database to a file",
            risk_labels=["bulk_export", "touches_pii"], reversible=True,
        ),
    },

    # ── SendGrid / Email ────────────────────────────────────────────────────
    "email": {
        "send_email": MappedAction(
            tool="email", service="SendGrid", action="send_email",
            description="Send an email to a customer",
            risk_labels=["sends_external", "touches_pii"], reversible=False,
        ),
        "send_template_email": MappedAction(
            tool="email", service="SendGrid", action="send_template_email",
            description="Send a templated email to a customer",
            risk_labels=["sends_external"], reversible=False,
        ),
        "list_templates": MappedAction(
            tool="email", service="SendGrid", action="list_templates",
            description="List available email templates", risk_labels=[], reversible=True,
        ),
        "get_email_status": MappedAction(
            tool="email", service="SendGrid", action="get_email_status",
            description="Check delivery status of a sent email", risk_labels=[], reversible=True,
        ),
    },

    # ── GitHub ──────────────────────────────────────────────────────────────
    "github": {
        "list_repos": MappedAction(
            tool="github", service="GitHub", action="list_repos",
            description="List repositories", risk_labels=[], reversible=True,
        ),
        "get_pull_request": MappedAction(
            tool="github", service="GitHub", action="get_pull_request",
            description="Get pull request details", risk_labels=[], reversible=True,
        ),
        "merge_pull_request": MappedAction(
            tool="github", service="GitHub", action="merge_pull_request",
            description="Merge a pull request into the target branch",
            risk_labels=["changes_production"], reversible=False,
        ),
        "create_branch": MappedAction(
            tool="github", service="GitHub", action="create_branch",
            description="Create a new git branch", risk_labels=[], reversible=True,
        ),
        "delete_branch": MappedAction(
            tool="github", service="GitHub", action="delete_branch",
            description="Delete a git branch",
            risk_labels=["deletes_data"], reversible=False,
        ),
        "trigger_workflow": MappedAction(
            tool="github", service="GitHub", action="trigger_workflow",
            description="Trigger a CI/CD workflow run",
            risk_labels=["changes_production"], reversible=False,
        ),
        "get_workflow_status": MappedAction(
            tool="github", service="GitHub", action="get_workflow_status",
            description="Check status of a workflow run", risk_labels=[], reversible=True,
        ),
        "create_release": MappedAction(
            tool="github", service="GitHub", action="create_release",
            description="Create a new release tag and deploy",
            risk_labels=["changes_production"], reversible=False,
        ),
        "rollback_release": MappedAction(
            tool="github", service="GitHub", action="rollback_release",
            description="Roll back to a previous release",
            risk_labels=["changes_production"], reversible=False,
        ),
    },

    # ── AWS ─────────────────────────────────────────────────────────────────
    "aws": {
        "list_instances": MappedAction(
            tool="aws", service="AWS", action="list_instances",
            description="List EC2 instances", risk_labels=[], reversible=True,
        ),
        "start_instance": MappedAction(
            tool="aws", service="AWS", action="start_instance",
            description="Start a stopped EC2 instance",
            risk_labels=["changes_production"], reversible=True,
        ),
        "stop_instance": MappedAction(
            tool="aws", service="AWS", action="stop_instance",
            description="Stop a running EC2 instance",
            risk_labels=["changes_production"], reversible=True,
        ),
        "terminate_instance": MappedAction(
            tool="aws", service="AWS", action="terminate_instance",
            description="Permanently terminate an EC2 instance",
            risk_labels=["changes_production", "deletes_data"], reversible=False,
        ),
        "scale_service": MappedAction(
            tool="aws", service="AWS", action="scale_service",
            description="Scale an ECS service up or down",
            risk_labels=["changes_production"], reversible=True,
        ),
        "get_logs": MappedAction(
            tool="aws", service="AWS", action="get_logs",
            description="Retrieve CloudWatch logs", risk_labels=[], reversible=True,
        ),
        "update_security_group": MappedAction(
            tool="aws", service="AWS", action="update_security_group",
            description="Modify firewall rules on a security group",
            risk_labels=["changes_production", "changes_access"], reversible=True,
        ),
        "create_snapshot": MappedAction(
            tool="aws", service="AWS", action="create_snapshot",
            description="Create an EBS snapshot", risk_labels=[], reversible=True,
        ),
        "delete_snapshot": MappedAction(
            tool="aws", service="AWS", action="delete_snapshot",
            description="Delete an EBS snapshot",
            risk_labels=["deletes_data"], reversible=False,
        ),
        "update_env_vars": MappedAction(
            tool="aws", service="AWS", action="update_env_vars",
            description="Update environment variables on a running service",
            risk_labels=["changes_production"], reversible=True,
        ),
        "get_secret": MappedAction(
            tool="aws", service="AWS", action="get_secret",
            description="Read a secret value from Secrets Manager",
            risk_labels=["reads_secrets"], reversible=True,
        ),
        "rotate_secret": MappedAction(
            tool="aws", service="AWS", action="rotate_secret",
            description="Rotate a stored credential or secret",
            risk_labels=["reads_secrets", "changes_access"], reversible=False,
        ),
        "create_access_key": MappedAction(
            tool="aws", service="AWS", action="create_access_key",
            description="Issue a new IAM access key for a user",
            risk_labels=["changes_access", "reads_secrets"], reversible=False,
        ),
        "attach_iam_policy": MappedAction(
            tool="aws", service="AWS", action="attach_iam_policy",
            description="Attach an IAM policy granting permissions to a principal",
            risk_labels=["changes_access", "changes_production"], reversible=True,
        ),
        "disable_cloudtrail": MappedAction(
            tool="aws", service="AWS", action="disable_cloudtrail",
            description="Stop a CloudTrail audit-logging trail",
            risk_labels=["evades_detection", "changes_production"], reversible=True,
        ),
        "run_command": MappedAction(
            tool="aws", service="AWS", action="run_command",
            description="Run an arbitrary shell command on an instance via SSM",
            risk_labels=["executes_code", "changes_production", "deletes_data"],
            reversible=False,
        ),
    },

    # ── Slack ───────────────────────────────────────────────────────────────
    "slack": {
        "send_message": MappedAction(
            tool="slack", service="Slack", action="send_message",
            description="Send a direct message to a user",
            risk_labels=["sends_external"], reversible=False,
        ),
        "send_channel_message": MappedAction(
            tool="slack", service="Slack", action="send_channel_message",
            description="Post a message to a Slack channel",
            risk_labels=["sends_external"], reversible=False,
        ),
        "create_channel": MappedAction(
            tool="slack", service="Slack", action="create_channel",
            description="Create a new Slack channel", risk_labels=[], reversible=True,
        ),
        "list_channels": MappedAction(
            tool="slack", service="Slack", action="list_channels",
            description="List Slack channels", risk_labels=[], reversible=True,
        ),
        "upload_file": MappedAction(
            tool="slack", service="Slack", action="upload_file",
            description="Upload a file to Slack",
            risk_labels=["sends_external"], reversible=False,
        ),
    },

    # ── PagerDuty ───────────────────────────────────────────────────────────
    "pagerduty": {
        "create_incident": MappedAction(
            tool="pagerduty", service="PagerDuty", action="create_incident",
            description="Create a new incident (pages on-call)",
            # Pages on-call (sends_external) AND creates a production incident
            # record / changes incident-management state (changes_production).
            risk_labels=["sends_external", "changes_production"], reversible=False,
        ),
        "acknowledge_incident": MappedAction(
            tool="pagerduty", service="PagerDuty", action="acknowledge_incident",
            description="Acknowledge an active incident", risk_labels=[], reversible=True,
        ),
        "resolve_incident": MappedAction(
            tool="pagerduty", service="PagerDuty", action="resolve_incident",
            description="Mark an incident as resolved", risk_labels=[], reversible=True,
        ),
        "get_oncall": MappedAction(
            tool="pagerduty", service="PagerDuty", action="get_oncall",
            description="Get current on-call schedule", risk_labels=[], reversible=True,
        ),
        "escalate_incident": MappedAction(
            tool="pagerduty", service="PagerDuty", action="escalate_incident",
            description="Escalate incident to next level",
            risk_labels=["sends_external"], reversible=False,
        ),
        "list_incidents": MappedAction(
            tool="pagerduty", service="PagerDuty", action="list_incidents",
            description="List active incidents", risk_labels=[], reversible=True,
        ),
    },

    # ── HubSpot ─────────────────────────────────────────────────────────────
    "hubspot": {
        "get_contact": MappedAction(
            tool="hubspot", service="HubSpot", action="get_contact",
            description="Retrieve a contact record",
            risk_labels=["touches_pii"], reversible=True,
        ),
        "create_contact": MappedAction(
            tool="hubspot", service="HubSpot", action="create_contact",
            description="Create a new contact in the CRM",
            risk_labels=["touches_pii"], reversible=True,
        ),
        "update_contact": MappedAction(
            tool="hubspot", service="HubSpot", action="update_contact",
            description="Update contact fields",
            risk_labels=["touches_pii"], reversible=True,
        ),
        "delete_contact": MappedAction(
            tool="hubspot", service="HubSpot", action="delete_contact",
            description="Permanently delete a contact",
            risk_labels=["deletes_data", "touches_pii"], reversible=False,
        ),
        "list_deals": MappedAction(
            tool="hubspot", service="HubSpot", action="list_deals",
            description="List deals in the pipeline", risk_labels=[], reversible=True,
        ),
        "update_deal": MappedAction(
            tool="hubspot", service="HubSpot", action="update_deal",
            description="Update deal stage or value",
            risk_labels=["moves_money"], reversible=True,
        ),
        "create_deal": MappedAction(
            tool="hubspot", service="HubSpot", action="create_deal",
            description="Create a new deal in the pipeline",
            risk_labels=["moves_money"], reversible=True,
        ),
        "get_company": MappedAction(
            tool="hubspot", service="HubSpot", action="get_company",
            description="Get company details", risk_labels=[], reversible=True,
        ),
        "query_contacts": MappedAction(
            tool="hubspot", service="HubSpot", action="query_contacts",
            description="Search contacts by criteria",
            risk_labels=["touches_pii"], reversible=True,
        ),
        "add_note": MappedAction(
            tool="hubspot", service="HubSpot", action="add_note",
            description="Add a note to a contact or deal", risk_labels=[], reversible=True,
        ),
        "get_contact_activity": MappedAction(
            tool="hubspot", service="HubSpot", action="get_contact_activity",
            description="View activity log for a contact",
            risk_labels=["touches_pii"], reversible=True,
        ),
    },

    # ── Gmail ───────────────────────────────────────────────────────────────
    "gmail": {
        "send_email": MappedAction(
            tool="gmail", service="Gmail", action="send_email",
            description="Send an email to a prospect or customer",
            risk_labels=["sends_external", "touches_pii"], reversible=False,
        ),
        "read_inbox": MappedAction(
            tool="gmail", service="Gmail", action="read_inbox",
            description="Read emails from inbox",
            risk_labels=["touches_pii"], reversible=True,
        ),
        "search_emails": MappedAction(
            tool="gmail", service="Gmail", action="search_emails",
            description="Search emails by query", risk_labels=["touches_pii"], reversible=True,
        ),
        "create_draft": MappedAction(
            tool="gmail", service="Gmail", action="create_draft",
            description="Create an email draft", risk_labels=[], reversible=True,
        ),
        "send_draft": MappedAction(
            tool="gmail", service="Gmail", action="send_draft",
            description="Send a previously created draft",
            risk_labels=["sends_external"], reversible=False,
        ),
        "list_threads": MappedAction(
            tool="gmail", service="Gmail", action="list_threads",
            description="List email threads", risk_labels=[], reversible=True,
        ),
        "get_thread": MappedAction(
            tool="gmail", service="Gmail", action="get_thread",
            description="Get full email thread", risk_labels=["touches_pii"], reversible=True,
        ),
    },

    # ── Calendly ────────────────────────────────────────────────────────────
    "calendly": {
        "list_events": MappedAction(
            tool="calendly", service="Calendly", action="list_events",
            description="List scheduled events", risk_labels=[], reversible=True,
        ),
        "create_invite_link": MappedAction(
            tool="calendly", service="Calendly", action="create_invite_link",
            description="Create a scheduling invite link",
            risk_labels=["sends_external"], reversible=True,
        ),
        "cancel_event": MappedAction(
            tool="calendly", service="Calendly", action="cancel_event",
            description="Cancel a scheduled meeting",
            risk_labels=["sends_external"], reversible=False,
        ),
        "get_availability": MappedAction(
            tool="calendly", service="Calendly", action="get_availability",
            description="Check available time slots", risk_labels=[], reversible=True,
        ),
        "list_event_types": MappedAction(
            tool="calendly", service="Calendly", action="list_event_types",
            description="List configured event types", risk_labels=[], reversible=True,
        ),
    },
}


def get_mapped_actions(tool_name: str) -> list[MappedAction]:
    """Get all mapped actions for a tool."""
    catalog = ACTION_CATALOG.get(tool_name, {})
    return list(catalog.values())


def get_action(tool_name: str, action_name: str) -> MappedAction | None:
    """Get a specific mapped action."""
    return ACTION_CATALOG.get(tool_name, {}).get(action_name)


def compute_risk_coverage(tools: list[dict]) -> dict:
    """How much of this agent's risk picture comes from the deterministic catalog
    vs heuristic/LLM guesses.

    For tools outside ACTION_CATALOG (the recognized services) the risk labels are
    inferred — and unrecognized dangerous actions can land with no labels, which
    contribute 0 to the blast-radius score. So a low recognition ratio means the
    score may UNDERSTATE true exposure. Returns counts + the unrecognized service
    names for disclosure on the agent's risk view.
    """
    # Lazy import — risk_classifier imports this module, so top-level would cycle.
    from authority.risk_classifier import is_effectively_read

    total = 0
    recognized = 0
    unclassified = 0
    llm_classified = 0
    unclassified_list: list[str] = []
    unrecognized_tools: list[str] = []
    for t in tools or []:
        tname = (t.get("name") or "").lower()
        tool_known = tname in ACTION_CATALOG
        if not tool_known:
            label = t.get("service") or t.get("name") or "unknown"
            if label not in unrecognized_tools:
                unrecognized_tools.append(label)
        for a in t.get("actions", []):
            total += 1
            action_name = a.get("action") or ""
            if tool_known and get_action(tname, action_name) is not None:
                recognized += 1
                continue
            source = a.get("classification_source") or "unknown"
            if source == "llm":
                llm_classified += 1
            # "none" = the classifier had no signal at all (vague name, no LLM
            # verdict) — the action contributes 0 to the score while its true
            # risk is unknown. "unknown" rows predate provenance; treat them as
            # unclassified only when they carry zero labels and aren't reads.
            if source == "none" or (
                source == "unknown" and not a.get("risk_labels")
                and not is_effectively_read(action_name)
            ):
                unclassified += 1
                if len(unclassified_list) < 10:
                    unclassified_list.append(f"{tname}.{action_name}")
    return {
        "recognizedActions": recognized,
        "totalActions": total,
        "unrecognizedTools": unrecognized_tools[:6],
        "unclassifiedActions": unclassified,
        "unclassifiedList": unclassified_list,
        "llmClassified": llm_classified,
    }
