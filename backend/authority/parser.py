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
    # 1 — Customer Support (Tier 1)
    {
        "id": "support-agent",
        "name": "Tier 1 Support Agent",
        "description": "Handles initial customer inquiries, looks up accounts, issues small refunds.",
        "tools": [
            {
                "name": "zendesk",
                "service": "Zendesk",
                "description": "Customer support ticketing system",
                "actions": [
                    "get_ticket", "update_ticket", "close_ticket",
                    "add_comment", "escalate_ticket",
                ],
            },
            {
                "name": "stripe",
                "service": "Stripe",
                "description": "Payment processing and billing",
                "actions": [
                    "get_customer", "get_invoice", "create_refund",
                ],
            },
            {
                "name": "salesforce",
                "service": "Salesforce",
                "description": "CRM — customer records and case management",
                "actions": [
                    "get_contact", "get_case", "update_case",
                ],
            },
            {
                "name": "sendgrid",
                "service": "SendGrid",
                "description": "Outbound transactional email",
                "actions": [
                    "send_email", "list_templates",
                ],
            },
        ],
    },

    # 2 — DevOps / CI-CD
    {
        "id": "devops-agent",
        "name": "CI/CD Pipeline Agent",
        "description": "Manages builds, deployments, and rollbacks across environments.",
        "tools": [
            {
                "name": "github",
                "service": "GitHub",
                "description": "Source code repository and CI/CD workflows",
                "actions": [
                    "get_repo", "list_pulls", "merge_pull", "create_release",
                    "get_workflow_runs", "trigger_workflow",
                ],
            },
            {
                "name": "aws_ecs",
                "service": "AWS ECS",
                "description": "Container orchestration and service management",
                "actions": [
                    "list_services", "update_service", "describe_tasks", "stop_task",
                ],
            },
            {
                "name": "aws_ecr",
                "service": "AWS ECR",
                "description": "Container image registry",
                "actions": [
                    "list_images", "delete_image", "describe_repositories",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "Team notifications and channel management",
                "actions": [
                    "send_message", "create_channel",
                ],
            },
        ],
    },

    # 3 — Sales / CRM
    {
        "id": "sales-agent",
        "name": "Lead Qualification Agent",
        "description": "Scores inbound leads, enriches data, routes to sales reps.",
        "tools": [
            {
                "name": "hubspot",
                "service": "HubSpot",
                "description": "CRM contacts, companies, and deal pipeline",
                "actions": [
                    "get_contact", "create_contact", "update_contact",
                    "get_company", "create_company", "update_company",
                ],
            },
            {
                "name": "salesforce",
                "service": "Salesforce",
                "description": "Lead management and routing",
                "actions": [
                    "create_lead", "update_lead", "convert_lead", "assign_owner",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "Internal team communication",
                "actions": [
                    "send_message",
                ],
            },
        ],
    },

    # 4 — HPE GreenLake Orchestrator
    {
        "id": "greenlake-orchestrator",
        "name": "GreenLake Orchestrator",
        "description": "Central coordinator that decomposes user intent and delegates to domain agents via MCP.",
        "tools": [
            {
                "name": "orchestration",
                "service": "Orchestration",
                "description": "Intent decomposition, agent delegation, and result synthesis",
                "actions": [
                    "decompose_intent", "delegate_to_agent", "synthesize_results",
                ],
            },
        ],
    },

    # 5 — HPE GreenLake Network Agent
    {
        "id": "greenlake-network-agent",
        "name": "GreenLake Network Agent",
        "description": "Aruba CX switch monitoring, anomaly detection, traffic management.",
        "tools": [
            {
                "name": "network_monitoring",
                "service": "Network Monitoring",
                "description": "Switch and topology monitoring with anomaly detection",
                "actions": [
                    "get_all_switches", "get_switch_details", "detect_network_anomalies",
                    "get_network_topology", "analyze_network_path",
                ],
            },
            {
                "name": "network_management",
                "service": "Network Management",
                "description": "Traffic redistribution and network configuration",
                "actions": [
                    "propose_traffic_redistribution",
                ],
            },
        ],
    },

    # 6 — HPE GreenLake Compute Agent
    {
        "id": "greenlake-compute-agent",
        "name": "GreenLake Compute Agent",
        "description": "ProLiant server fleet monitoring, VM provisioning, workload balancing.",
        "tools": [
            {
                "name": "compute_monitoring",
                "service": "Compute Monitoring",
                "description": "Server and VM health monitoring with placement evaluation",
                "actions": [
                    "get_all_servers", "get_server_details", "get_all_vms",
                    "detect_compute_issues", "evaluate_placement",
                ],
            },
            {
                "name": "compute_management",
                "service": "Compute Management",
                "description": "VM provisioning and live migration",
                "actions": [
                    "provision_vms", "migrate_vm",
                ],
            },
        ],
    },

    # 7 — HPE GreenLake Storage Agent
    {
        "id": "greenlake-storage-agent",
        "name": "GreenLake Storage Agent",
        "description": "Alletra storage array monitoring, capacity planning, data protection.",
        "tools": [
            {
                "name": "storage_monitoring",
                "service": "Storage Monitoring",
                "description": "Storage array health, capacity trends, and cold data reporting",
                "actions": [
                    "get_all_storage_arrays", "get_storage_details", "detect_storage_issues",
                    "analyze_capacity_trend", "get_cold_data_report",
                ],
            },
            {
                "name": "data_protection",
                "service": "Data Protection",
                "description": "Data protection policy auditing",
                "actions": [
                    "audit_data_protection",
                ],
            },
        ],
    },

    # 8 — HPE GreenLake Observability Agent
    {
        "id": "greenlake-observability-agent",
        "name": "GreenLake Observability Agent",
        "description": "Cross-domain correlation, root cause analysis, blast radius calculation.",
        "tools": [
            {
                "name": "observability",
                "service": "Observability",
                "description": "Infrastructure health, alerting, root cause, and event correlation",
                "actions": [
                    "get_infrastructure_health_summary", "get_active_alerts", "get_service_health",
                    "trace_root_cause", "calculate_blast_radius", "correlate_events", "get_event_log",
                ],
            },
            {
                "name": "alert_management",
                "service": "Alert Management",
                "description": "Alert acknowledgement and suppression",
                "actions": [
                    "acknowledge_alert",
                ],
            },
        ],
    },

    # 9 — HPE GreenLake FinOps Agent
    {
        "id": "greenlake-finops-agent",
        "name": "GreenLake FinOps Agent",
        "description": "Cost optimization, right-sizing, spend forecasting.",
        "tools": [
            {
                "name": "cost_analysis",
                "service": "Cost Analysis",
                "description": "Cloud cost visibility, waste detection, and spend forecasting",
                "actions": [
                    "get_cost_summary", "detect_waste", "generate_optimization_report",
                    "forecast_spend", "estimate_provisioning_cost",
                ],
            },
        ],
    },

    # 10 — Tier 2 Support Escalation
    {
        "id": "support-tier2-agent",
        "name": "Tier 2 Support Escalation Agent",
        "description": "Handles escalated issues, can modify accounts, issue large refunds, access billing history.",
        "tools": [
            {
                "name": "zendesk",
                "service": "Zendesk",
                "description": "Advanced ticket management including merging and deletion",
                "actions": [
                    "get_ticket", "update_ticket", "close_ticket",
                    "merge_tickets", "delete_ticket",
                ],
            },
            {
                "name": "stripe",
                "service": "Stripe",
                "description": "Full billing operations including subscription changes",
                "actions": [
                    "get_customer", "create_refund", "void_invoice",
                    "update_subscription", "cancel_subscription", "get_balance_transactions",
                ],
            },
            {
                "name": "salesforce",
                "service": "Salesforce",
                "description": "Contact and case management including deletions",
                "actions": [
                    "get_contact", "update_contact", "delete_contact",
                    "get_case", "update_case", "close_case",
                ],
            },
            {
                "name": "twilio",
                "service": "Twilio",
                "description": "SMS and voice communication with customers",
                "actions": [
                    "send_sms", "make_call",
                ],
            },
        ],
    },

    # 11 — Customer Success
    {
        "id": "customer-success-agent",
        "name": "Customer Success Agent",
        "description": "Proactive outreach, health scoring, renewal management.",
        "tools": [
            {
                "name": "salesforce",
                "service": "Salesforce",
                "description": "Account health and opportunity management",
                "actions": [
                    "get_account", "update_account", "get_opportunities",
                    "create_opportunity", "update_opportunity",
                ],
            },
            {
                "name": "hubspot",
                "service": "HubSpot",
                "description": "Contact engagement, deal tracking, and activity logging",
                "actions": [
                    "get_contact", "update_contact", "create_deal",
                    "update_deal", "log_activity", "get_engagement_history",
                ],
            },
            {
                "name": "calendly",
                "service": "Calendly",
                "description": "Meeting scheduling and invite management",
                "actions": [
                    "list_events", "create_invite", "cancel_event",
                ],
            },
            {
                "name": "sendgrid",
                "service": "SendGrid",
                "description": "Email campaigns and engagement analytics",
                "actions": [
                    "send_email", "create_campaign", "get_analytics",
                ],
            },
        ],
    },

    # 12 — Incident Response
    {
        "id": "incident-response-agent",
        "name": "Incident Response Agent",
        "description": "Detects incidents, pages on-call, creates war rooms, manages rollbacks.",
        "tools": [
            {
                "name": "pagerduty",
                "service": "PagerDuty",
                "description": "Incident creation, escalation, and on-call management",
                "actions": [
                    "create_incident", "acknowledge_incident", "resolve_incident",
                    "get_oncall", "escalate",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "War room channels and incident communication",
                "actions": [
                    "send_message", "create_channel", "set_topic", "invite_users",
                ],
            },
            {
                "name": "aws_ecs",
                "service": "AWS ECS",
                "description": "Service rollback and task management during incidents",
                "actions": [
                    "update_service", "stop_task", "describe_services",
                ],
            },
            {
                "name": "datadog",
                "service": "Datadog",
                "description": "Alert management and monitor maintenance windows",
                "actions": [
                    "get_alerts", "mute_monitor", "create_downtime",
                ],
            },
            {
                "name": "github",
                "service": "GitHub",
                "description": "Release management and commit reverts",
                "actions": [
                    "create_release", "revert_commit", "get_deployments",
                ],
            },
        ],
    },

    # 13 — Database Maintenance
    {
        "id": "database-maintenance-agent",
        "name": "Database Maintenance Agent",
        "description": "Monitors database health, runs maintenance tasks, manages backups.",
        "tools": [
            {
                "name": "aws_rds",
                "service": "AWS RDS",
                "description": "Relational database instance and snapshot management",
                "actions": [
                    "describe_instances", "create_snapshot", "restore_snapshot",
                    "delete_snapshot", "reboot_instance", "modify_instance",
                ],
            },
            {
                "name": "aws_s3",
                "service": "AWS S3",
                "description": "Object storage for backup artifacts",
                "actions": [
                    "list_buckets", "put_object", "get_object", "delete_object",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "Maintenance notifications to the DBA team",
                "actions": [
                    "send_message",
                ],
            },
            {
                "name": "pagerduty",
                "service": "PagerDuty",
                "description": "Critical database incident alerting",
                "actions": [
                    "create_incident",
                ],
            },
        ],
    },

    # 14 — Deal Desk
    {
        "id": "deal-desk-agent",
        "name": "Deal Desk Agent",
        "description": "Generates quotes, applies discounts, manages approvals for enterprise deals.",
        "tools": [
            {
                "name": "salesforce",
                "service": "Salesforce",
                "description": "Opportunity and quote management with pricebook access",
                "actions": [
                    "get_opportunity", "update_opportunity", "create_quote",
                    "update_quote", "get_pricebook",
                ],
            },
            {
                "name": "stripe",
                "service": "Stripe",
                "description": "Custom pricing, coupons, and invoice generation",
                "actions": [
                    "create_price", "create_coupon", "create_invoice", "finalize_invoice",
                ],
            },
            {
                "name": "docusign",
                "service": "DocuSign",
                "description": "Contract envelope creation, sending, and status tracking",
                "actions": [
                    "create_envelope", "send_envelope", "get_envelope_status", "void_envelope",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "Deal approval notifications",
                "actions": [
                    "send_message",
                ],
            },
        ],
    },

    # 15 — Revenue Operations
    {
        "id": "revenue-ops-agent",
        "name": "Revenue Operations Agent",
        "description": "Forecasting, pipeline analysis, territory management.",
        "tools": [
            {
                "name": "salesforce",
                "service": "Salesforce",
                "description": "Pipeline opportunities, forecasts, and reports",
                "actions": [
                    "get_opportunities", "get_forecasts", "update_forecast",
                    "get_reports", "run_report",
                ],
            },
            {
                "name": "hubspot",
                "service": "HubSpot",
                "description": "Deal pipeline and engagement analytics",
                "actions": [
                    "get_deals", "get_pipeline", "get_analytics",
                ],
            },
            {
                "name": "stripe",
                "service": "Stripe",
                "description": "Revenue data — charges, subscriptions, and reports",
                "actions": [
                    "get_balance", "list_charges", "list_subscriptions", "get_revenue_report",
                ],
            },
            {
                "name": "google_sheets",
                "service": "Google Sheets",
                "description": "Spreadsheet-based reporting and territory models",
                "actions": [
                    "read_spreadsheet", "update_spreadsheet", "create_spreadsheet",
                ],
            },
        ],
    },

    # 16 — Employee Onboarding
    {
        "id": "hr-onboarding-agent",
        "name": "Employee Onboarding Agent",
        "description": "Provisions accounts, sends welcome emails, schedules orientation.",
        "tools": [
            {
                "name": "google_workspace",
                "service": "Google Workspace",
                "description": "User account provisioning and group membership",
                "actions": [
                    "create_user", "update_user", "add_to_group", "create_alias",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "New hire invitations and channel assignments",
                "actions": [
                    "invite_user", "send_message", "add_to_channel",
                ],
            },
            {
                "name": "github",
                "service": "GitHub",
                "description": "Org membership, team assignments, and repo creation",
                "actions": [
                    "add_org_member", "add_to_team", "create_repo",
                ],
            },
            {
                "name": "jira",
                "service": "Jira",
                "description": "Onboarding task tracking",
                "actions": [
                    "create_issue", "assign_issue",
                ],
            },
            {
                "name": "sendgrid",
                "service": "SendGrid",
                "description": "Welcome and orientation emails",
                "actions": [
                    "send_email",
                ],
            },
        ],
    },

    # 17 — HR Analytics
    {
        "id": "hr-analytics-agent",
        "name": "HR Analytics Agent",
        "description": "Headcount reporting, compensation analysis, attrition modeling.",
        "tools": [
            {
                "name": "bamboohr",
                "service": "BambooHR",
                "description": "Employee directory, time-off, and compensation data",
                "actions": [
                    "get_employees", "get_directory", "get_timeoff_requests", "get_compensation",
                ],
            },
            {
                "name": "google_sheets",
                "service": "Google Sheets",
                "description": "Headcount and attrition model spreadsheets",
                "actions": [
                    "read_spreadsheet", "update_spreadsheet", "create_spreadsheet",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "HR report distribution",
                "actions": [
                    "send_message",
                ],
            },
            {
                "name": "sendgrid",
                "service": "SendGrid",
                "description": "Scheduled HR digest emails",
                "actions": [
                    "send_email",
                ],
            },
        ],
    },

    # 18 — Security Audit
    {
        "id": "security-audit-agent",
        "name": "Security Audit Agent",
        "description": "Scans for misconfigurations, checks compliance, reviews access logs.",
        "tools": [
            {
                "name": "aws_iam",
                "service": "AWS IAM",
                "description": "IAM user, role, and policy analysis",
                "actions": [
                    "list_users", "list_roles", "list_policies",
                    "get_access_advisor", "simulate_policy",
                ],
            },
            {
                "name": "aws_cloudtrail",
                "service": "AWS CloudTrail",
                "description": "API audit log lookup and trail status",
                "actions": [
                    "lookup_events", "get_trail_status",
                ],
            },
            {
                "name": "aws_s3",
                "service": "AWS S3",
                "description": "Bucket policy and ACL inspection",
                "actions": [
                    "get_bucket_policy", "get_bucket_acl", "list_buckets",
                ],
            },
            {
                "name": "aws_ec2",
                "service": "AWS EC2",
                "description": "Security group, instance, and VPC enumeration",
                "actions": [
                    "describe_security_groups", "describe_instances", "describe_vpcs",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "Security finding notifications",
                "actions": [
                    "send_message",
                ],
            },
        ],
    },

    # 19 — Access Review
    {
        "id": "access-review-agent",
        "name": "Access Review Agent",
        "description": "Periodic access reviews, deprovisioning inactive users, enforcing least privilege.",
        "tools": [
            {
                "name": "google_workspace",
                "service": "Google Workspace",
                "description": "User lifecycle management and group membership",
                "actions": [
                    "list_users", "get_user", "suspend_user", "delete_user",
                    "list_groups", "remove_member",
                ],
            },
            {
                "name": "github",
                "service": "GitHub",
                "description": "Org and team membership removal",
                "actions": [
                    "list_org_members", "remove_org_member",
                    "list_team_members", "remove_team_member",
                ],
            },
            {
                "name": "aws_iam",
                "service": "AWS IAM",
                "description": "Access key rotation and policy detachment",
                "actions": [
                    "list_users", "delete_access_key",
                    "detach_policy", "remove_user_from_group",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "Access review summary notifications",
                "actions": [
                    "send_message",
                ],
            },
        ],
    },

    # 20 — Accounts Payable
    {
        "id": "accounts-payable-agent",
        "name": "Accounts Payable Agent",
        "description": "Processes invoices, matches POs, initiates payments.",
        "tools": [
            {
                "name": "quickbooks",
                "service": "QuickBooks",
                "description": "Invoice and payment management with vendor records",
                "actions": [
                    "create_invoice", "update_invoice", "create_payment",
                    "void_payment", "get_vendors", "create_vendor",
                ],
            },
            {
                "name": "stripe",
                "service": "Stripe",
                "description": "Payout and transfer initiation",
                "actions": [
                    "create_payout", "create_transfer", "get_balance",
                ],
            },
            {
                "name": "aws_s3",
                "service": "AWS S3",
                "description": "Invoice document storage and retrieval",
                "actions": [
                    "get_object", "put_object",
                ],
            },
            {
                "name": "slack",
                "service": "Slack",
                "description": "Payment approval and confirmation notifications",
                "actions": [
                    "send_message",
                ],
            },
            {
                "name": "sendgrid",
                "service": "SendGrid",
                "description": "Payment confirmation emails to vendors",
                "actions": [
                    "send_email",
                ],
            },
        ],
    },
]


def load_all_agents() -> list[AgentConfig]:
    """Load all sample agent configs."""
    return [parse_agent_config(c) for c in SAMPLE_CONFIGS]
