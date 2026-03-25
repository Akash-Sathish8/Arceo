"""Phase 1: Agent config parser — reads tool definitions from agent configs."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ToolDef:
    name: str
    service: str
    description: str
    actions: list[str] = field(default_factory=list)


@dataclass
class AgentConfig:
    id: str
    name: str
    description: str
    tools: list[ToolDef] = field(default_factory=list)


def parse_agent_config(raw: dict) -> AgentConfig:
    """Parse a raw agent config dict into an AgentConfig."""
    tools = []
    for t in raw.get("tools", []):
        tools.append(ToolDef(
            name=t["name"],
            service=t["service"],
            description=t["description"],
            actions=t.get("actions", []),
        ))
    return AgentConfig(
        id=raw["id"],
        name=raw["name"],
        description=raw["description"],
        tools=tools,
    )


# ── Sample Agent Configs ────────────────────────────────────────────────────

SAMPLE_CONFIGS = [
    {
        "id": "support-agent",
        "name": "Customer Support Agent",
        "description": "Handles customer tickets — lookups, refunds, account changes, and outbound communication.",
        "tools": [
            {
                "name": "zendesk",
                "service": "Zendesk",
                "description": "Customer support ticketing system",
                "actions": [
                    "get_ticket", "update_ticket", "close_ticket", "create_ticket",
                    "add_comment", "assign_ticket", "list_tickets", "delete_ticket",
                ],
            },
            {
                "name": "stripe",
                "service": "Stripe",
                "description": "Payment processing and billing",
                "actions": [
                    "get_customer", "list_payments", "get_invoice",
                    "create_refund", "create_charge", "update_subscription",
                    "cancel_subscription", "delete_customer",
                ],
            },
            {
                "name": "salesforce",
                "service": "Salesforce",
                "description": "CRM — customer records and account data",
                "actions": [
                    "query_contacts", "get_account", "update_record",
                    "create_record", "delete_record", "query_opportunities",
                    "add_note", "get_contact_history",
                ],
            },
            {
                "name": "email",
                "service": "SendGrid",
                "description": "Outbound email to customers",
                "actions": [
                    "send_email", "send_template_email", "list_templates",
                    "get_email_status",
                ],
            },
        ],
    },
    {
        "id": "devops-agent",
        "name": "DevOps Agent",
        "description": "Manages deployments, incidents, infrastructure, and team notifications.",
        "tools": [
            {
                "name": "github",
                "service": "GitHub",
                "description": "Source code and CI/CD",
                "actions": [
                    "list_repos", "get_pull_request", "merge_pull_request",
                    "create_branch", "delete_branch", "trigger_workflow",
                    "get_workflow_status", "create_release", "rollback_release",
                ],
            },
            {
                "name": "aws",
                "service": "AWS",
                "description": "Cloud infrastructure management",
                "actions": [
                    "list_instances", "start_instance", "stop_instance",
                    "terminate_instance", "scale_service", "get_logs",
                    "update_security_group", "create_snapshot", "delete_snapshot",
                    "update_env_vars",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "Team communication",
                "actions": [
                    "send_message", "send_channel_message", "create_channel",
                    "list_channels", "upload_file",
                ],
            },
            {
                "name": "pagerduty",
                "service": "PagerDuty",
                "description": "Incident management and on-call",
                "actions": [
                    "create_incident", "acknowledge_incident", "resolve_incident",
                    "get_oncall", "escalate_incident", "list_incidents",
                ],
            },
        ],
    },
    {
        "id": "sales-agent",
        "name": "Sales Agent",
        "description": "Manages leads, outreach, meetings, and pipeline updates.",
        "tools": [
            {
                "name": "hubspot",
                "service": "HubSpot",
                "description": "CRM and sales pipeline",
                "actions": [
                    "get_contact", "create_contact", "update_contact",
                    "delete_contact", "list_deals", "update_deal",
                    "create_deal", "get_company", "query_contacts",
                    "add_note", "get_contact_activity",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "Internal team communication",
                "actions": [
                    "send_message", "send_channel_message", "list_channels",
                    "upload_file",
                ],
            },
            {
                "name": "gmail",
                "service": "Gmail",
                "description": "Email outreach to prospects",
                "actions": [
                    "send_email", "read_inbox", "search_emails",
                    "create_draft", "send_draft", "list_threads",
                    "get_thread",
                ],
            },
            {
                "name": "calendly",
                "service": "Calendly",
                "description": "Meeting scheduling",
                "actions": [
                    "list_events", "create_invite_link", "cancel_event",
                    "get_availability", "list_event_types",
                ],
            },
        ],
    },
]


def load_all_agents() -> list[AgentConfig]:
    """Load all sample agent configs."""
    return [parse_agent_config(c) for c in SAMPLE_CONFIGS]
