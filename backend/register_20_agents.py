"""Register all 20 enterprise agents, run sweeps, print results."""

import json
import requests
import time

BASE = "http://localhost:8000"

# Login
resp = requests.post(f"{BASE}/api/auth/login", json={"email": "admin@actiongate.io", "password": "admin123"})
TOKEN = resp.json()["token"]
AUTH = {"Authorization": f"Bearer {TOKEN}"}

AGENTS = [
    {
        "name": "GreenLake Orchestrator",
        "description": "Central coordinator that decomposes user intent and delegates to domain agents via MCP",
        "tools": [
            {"name": "orchestration", "description": "Orchestration", "actions": [
                {"name": "decompose_intent", "description": "Break down user request"},
                {"name": "delegate_to_agent", "description": "Dispatch to domain agent"},
                {"name": "synthesize_results", "description": "Combine agent outputs"},
            ]},
        ],
    },
    {
        "name": "GreenLake Network Agent",
        "description": "Aruba CX switch monitoring, anomaly detection, traffic management",
        "tools": [
            {"name": "network_monitoring", "description": "Network Monitoring", "actions": [
                {"name": "get_all_switches", "description": "List all switches"},
                {"name": "get_switch_details", "description": "Get switch info"},
                {"name": "detect_network_anomalies", "description": "Detect anomalies"},
                {"name": "get_network_topology", "description": "Get topology"},
                {"name": "analyze_network_path", "description": "Analyze path"},
            ]},
            {"name": "network_management", "description": "Network Management", "actions": [
                {"name": "propose_traffic_redistribution", "description": "Propose traffic changes"},
            ]},
        ],
    },
    {
        "name": "GreenLake Compute Agent",
        "description": "ProLiant server fleet monitoring, VM provisioning, workload balancing",
        "tools": [
            {"name": "compute_monitoring", "description": "Compute Monitoring", "actions": [
                {"name": "get_all_servers", "description": "List servers"},
                {"name": "get_server_details", "description": "Get server info"},
                {"name": "get_all_vms", "description": "List VMs"},
                {"name": "detect_compute_issues", "description": "Detect issues"},
                {"name": "evaluate_placement", "description": "Evaluate VM placement"},
            ]},
            {"name": "compute_management", "description": "Compute Management", "actions": [
                {"name": "provision_vms", "description": "Provision virtual machines"},
                {"name": "migrate_vm", "description": "Migrate VM to another host"},
            ]},
        ],
    },
    {
        "name": "GreenLake Storage Agent",
        "description": "Alletra storage array monitoring, capacity planning, data protection",
        "tools": [
            {"name": "storage_monitoring", "description": "Storage Monitoring", "actions": [
                {"name": "get_all_storage_arrays", "description": "List arrays"},
                {"name": "get_storage_details", "description": "Get array details"},
                {"name": "detect_storage_issues", "description": "Detect issues"},
                {"name": "analyze_capacity_trend", "description": "Analyze capacity"},
                {"name": "get_cold_data_report", "description": "Cold data report"},
            ]},
            {"name": "data_protection", "description": "Data Protection", "actions": [
                {"name": "audit_data_protection", "description": "Audit data protection compliance"},
            ]},
        ],
    },
    {
        "name": "GreenLake Observability Agent",
        "description": "Cross-domain correlation, root cause analysis, blast radius calculation",
        "tools": [
            {"name": "observability", "description": "Observability", "actions": [
                {"name": "get_infrastructure_health_summary", "description": "Health summary"},
                {"name": "get_active_alerts", "description": "Active alerts"},
                {"name": "get_service_health", "description": "Service health"},
                {"name": "trace_root_cause", "description": "Root cause analysis"},
                {"name": "calculate_blast_radius", "description": "Calculate blast radius"},
                {"name": "correlate_events", "description": "Correlate events"},
                {"name": "get_event_log", "description": "Get event log"},
            ]},
            {"name": "alert_management", "description": "Alert Management", "actions": [
                {"name": "acknowledge_alert", "description": "Acknowledge an alert"},
            ]},
        ],
    },
    {
        "name": "GreenLake FinOps Agent",
        "description": "Cost optimization, right-sizing, spend forecasting",
        "tools": [
            {"name": "cost_analysis", "description": "Cost Analysis", "actions": [
                {"name": "get_cost_summary", "description": "Get cost summary"},
                {"name": "detect_waste", "description": "Detect resource waste"},
                {"name": "generate_optimization_report", "description": "Optimization report"},
                {"name": "forecast_spend", "description": "Forecast spending"},
                {"name": "estimate_provisioning_cost", "description": "Estimate cost"},
            ]},
        ],
    },
    {
        "name": "Tier 1 Support Agent",
        "description": "Handles initial customer inquiries, looks up accounts, issues small refunds",
        "tools": [
            {"name": "zendesk", "description": "Zendesk", "actions": [
                {"name": "get_ticket", "description": "Get ticket"}, {"name": "update_ticket", "description": "Update ticket"},
                {"name": "close_ticket", "description": "Close ticket"}, {"name": "add_comment", "description": "Add comment"},
                {"name": "escalate_ticket", "description": "Escalate ticket"},
            ]},
            {"name": "stripe", "description": "Stripe", "actions": [
                {"name": "get_customer", "description": "Get customer"}, {"name": "get_invoice", "description": "Get invoice"},
                {"name": "create_refund", "description": "Issue refund"},
            ]},
            {"name": "salesforce", "description": "Salesforce", "actions": [
                {"name": "get_contact", "description": "Get contact"}, {"name": "get_case", "description": "Get case"},
                {"name": "update_case", "description": "Update case"},
            ]},
            {"name": "email", "description": "SendGrid", "actions": [
                {"name": "send_email", "description": "Send email"}, {"name": "list_templates", "description": "List templates"},
            ]},
        ],
    },
    {
        "name": "Tier 2 Support Escalation Agent",
        "description": "Handles escalated issues, can modify accounts, issue large refunds, access billing history",
        "tools": [
            {"name": "zendesk", "description": "Zendesk", "actions": [
                {"name": "get_ticket", "description": "Get ticket"}, {"name": "update_ticket", "description": "Update ticket"},
                {"name": "close_ticket", "description": "Close ticket"}, {"name": "merge_tickets", "description": "Merge tickets"},
                {"name": "delete_ticket", "description": "Delete ticket"},
            ]},
            {"name": "stripe", "description": "Stripe", "actions": [
                {"name": "get_customer", "description": "Get customer"}, {"name": "create_refund", "description": "Refund"},
                {"name": "void_invoice", "description": "Void invoice"}, {"name": "update_subscription", "description": "Update sub"},
                {"name": "cancel_subscription", "description": "Cancel sub"}, {"name": "get_balance_transactions", "description": "Balance txns"},
            ]},
            {"name": "salesforce", "description": "Salesforce", "actions": [
                {"name": "get_contact", "description": "Get contact"}, {"name": "update_contact", "description": "Update contact"},
                {"name": "delete_contact", "description": "Delete contact"}, {"name": "get_case", "description": "Get case"},
                {"name": "update_case", "description": "Update case"}, {"name": "close_case", "description": "Close case"},
            ]},
            {"name": "twilio", "description": "Twilio", "actions": [
                {"name": "send_sms", "description": "Send SMS"}, {"name": "make_call", "description": "Make call"},
            ]},
        ],
    },
    {
        "name": "Customer Success Agent",
        "description": "Proactive outreach, health scoring, renewal management",
        "tools": [
            {"name": "salesforce", "description": "Salesforce", "actions": [
                {"name": "get_account", "description": "Get account"}, {"name": "update_account", "description": "Update account"},
                {"name": "get_opportunities", "description": "Get opps"}, {"name": "create_opportunity", "description": "Create opp"},
                {"name": "update_opportunity", "description": "Update opp"},
            ]},
            {"name": "hubspot", "description": "HubSpot", "actions": [
                {"name": "get_contact", "description": "Get contact"}, {"name": "update_contact", "description": "Update contact"},
                {"name": "create_deal", "description": "Create deal"}, {"name": "update_deal", "description": "Update deal"},
                {"name": "log_activity", "description": "Log activity"}, {"name": "get_engagement_history", "description": "Engagement history"},
            ]},
            {"name": "calendly", "description": "Calendly", "actions": [
                {"name": "list_events", "description": "List events"}, {"name": "create_invite", "description": "Create invite"},
                {"name": "cancel_event", "description": "Cancel event"},
            ]},
            {"name": "email", "description": "SendGrid", "actions": [
                {"name": "send_email", "description": "Send email"}, {"name": "create_campaign", "description": "Create campaign"},
                {"name": "get_analytics", "description": "Get analytics"},
            ]},
        ],
    },
    {
        "name": "CI/CD Pipeline Agent",
        "description": "Manages builds, deployments, and rollbacks across environments",
        "tools": [
            {"name": "github", "description": "GitHub", "actions": [
                {"name": "get_repo", "description": "Get repo"}, {"name": "list_pulls", "description": "List PRs"},
                {"name": "merge_pull", "description": "Merge PR"}, {"name": "create_release", "description": "Create release"},
                {"name": "get_workflow_runs", "description": "Get workflows"}, {"name": "trigger_workflow", "description": "Trigger workflow"},
            ]},
            {"name": "aws_ecs", "description": "AWS ECS", "actions": [
                {"name": "list_services", "description": "List services"}, {"name": "update_service", "description": "Update service"},
                {"name": "describe_tasks", "description": "Describe tasks"}, {"name": "stop_task", "description": "Stop task"},
            ]},
            {"name": "aws_ecr", "description": "AWS ECR", "actions": [
                {"name": "list_images", "description": "List images"}, {"name": "delete_image", "description": "Delete image"},
                {"name": "describe_repositories", "description": "Describe repos"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [
                {"name": "send_message", "description": "Send message"}, {"name": "create_channel", "description": "Create channel"},
            ]},
        ],
    },
    {
        "name": "Incident Response Agent",
        "description": "Detects incidents, pages on-call, creates war rooms, manages rollbacks",
        "tools": [
            {"name": "pagerduty", "description": "PagerDuty", "actions": [
                {"name": "create_incident", "description": "Create incident"}, {"name": "acknowledge_incident", "description": "Ack"},
                {"name": "resolve_incident", "description": "Resolve"}, {"name": "get_oncall", "description": "Get on-call"},
                {"name": "escalate", "description": "Escalate"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [
                {"name": "send_message", "description": "Send"}, {"name": "create_channel", "description": "Create channel"},
                {"name": "set_topic", "description": "Set topic"}, {"name": "invite_users", "description": "Invite users"},
            ]},
            {"name": "aws_ecs", "description": "AWS ECS", "actions": [
                {"name": "update_service", "description": "Update"}, {"name": "stop_task", "description": "Stop"},
                {"name": "describe_services", "description": "Describe"},
            ]},
            {"name": "datadog", "description": "Datadog", "actions": [
                {"name": "get_alerts", "description": "Get alerts"}, {"name": "mute_monitor", "description": "Mute"},
                {"name": "create_downtime", "description": "Create downtime"},
            ]},
            {"name": "github", "description": "GitHub", "actions": [
                {"name": "create_release", "description": "Create release"}, {"name": "revert_commit", "description": "Revert"},
                {"name": "get_deployments", "description": "Get deployments"},
            ]},
        ],
    },
    {
        "name": "Database Maintenance Agent",
        "description": "Monitors database health, runs maintenance tasks, manages backups",
        "tools": [
            {"name": "aws_rds", "description": "AWS RDS", "actions": [
                {"name": "describe_instances", "description": "Describe"}, {"name": "create_snapshot", "description": "Create snapshot"},
                {"name": "restore_snapshot", "description": "Restore"}, {"name": "delete_snapshot", "description": "Delete snapshot"},
                {"name": "reboot_instance", "description": "Reboot"}, {"name": "modify_instance", "description": "Modify"},
            ]},
            {"name": "aws_s3", "description": "AWS S3", "actions": [
                {"name": "list_buckets", "description": "List"}, {"name": "put_object", "description": "Put"},
                {"name": "get_object", "description": "Get"}, {"name": "delete_object", "description": "Delete"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [{"name": "send_message", "description": "Send"}]},
            {"name": "pagerduty", "description": "PagerDuty", "actions": [{"name": "create_incident", "description": "Create incident"}]},
        ],
    },
    {
        "name": "Lead Qualification Agent",
        "description": "Scores inbound leads, enriches data, routes to sales reps",
        "tools": [
            {"name": "hubspot", "description": "HubSpot", "actions": [
                {"name": "get_contact", "description": "Get"}, {"name": "create_contact", "description": "Create"},
                {"name": "update_contact", "description": "Update"}, {"name": "get_company", "description": "Get company"},
                {"name": "create_company", "description": "Create company"}, {"name": "update_company", "description": "Update company"},
            ]},
            {"name": "clearbit", "description": "Clearbit", "actions": [
                {"name": "enrich_person", "description": "Enrich person"}, {"name": "enrich_company", "description": "Enrich company"},
            ]},
            {"name": "salesforce", "description": "Salesforce", "actions": [
                {"name": "create_lead", "description": "Create lead"}, {"name": "update_lead", "description": "Update lead"},
                {"name": "convert_lead", "description": "Convert lead"}, {"name": "assign_owner", "description": "Assign owner"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [{"name": "send_message", "description": "Send"}]},
        ],
    },
    {
        "name": "Deal Desk Agent",
        "description": "Generates quotes, applies discounts, manages approvals for enterprise deals",
        "tools": [
            {"name": "salesforce", "description": "Salesforce", "actions": [
                {"name": "get_opportunity", "description": "Get opp"}, {"name": "update_opportunity", "description": "Update opp"},
                {"name": "create_quote", "description": "Create quote"}, {"name": "update_quote", "description": "Update quote"},
                {"name": "get_pricebook", "description": "Get pricebook"},
            ]},
            {"name": "stripe", "description": "Stripe", "actions": [
                {"name": "create_price", "description": "Create price"}, {"name": "create_coupon", "description": "Create coupon"},
                {"name": "create_invoice", "description": "Create invoice"}, {"name": "finalize_invoice", "description": "Finalize invoice"},
            ]},
            {"name": "docusign", "description": "DocuSign", "actions": [
                {"name": "create_envelope", "description": "Create"}, {"name": "send_envelope", "description": "Send"},
                {"name": "get_envelope_status", "description": "Get status"}, {"name": "void_envelope", "description": "Void"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [{"name": "send_message", "description": "Send"}]},
        ],
    },
    {
        "name": "Revenue Operations Agent",
        "description": "Forecasting, pipeline analysis, territory management",
        "tools": [
            {"name": "salesforce", "description": "Salesforce", "actions": [
                {"name": "get_opportunities", "description": "Get opps"}, {"name": "get_forecasts", "description": "Get forecasts"},
                {"name": "update_forecast", "description": "Update forecast"}, {"name": "get_reports", "description": "Get reports"},
                {"name": "run_report", "description": "Run report"}, {"name": "get_dashboards", "description": "Get dashboards"},
            ]},
            {"name": "hubspot", "description": "HubSpot", "actions": [
                {"name": "get_deals", "description": "Get deals"}, {"name": "get_pipeline", "description": "Get pipeline"},
                {"name": "get_analytics", "description": "Get analytics"},
            ]},
            {"name": "stripe", "description": "Stripe", "actions": [
                {"name": "get_balance", "description": "Get balance"}, {"name": "list_charges", "description": "List charges"},
                {"name": "list_subscriptions", "description": "List subs"}, {"name": "get_revenue_report", "description": "Revenue report"},
            ]},
            {"name": "google_sheets", "description": "Google Sheets", "actions": [
                {"name": "read_spreadsheet", "description": "Read"}, {"name": "update_spreadsheet", "description": "Update"},
                {"name": "create_spreadsheet", "description": "Create"},
            ]},
        ],
    },
    {
        "name": "Employee Onboarding Agent",
        "description": "Provisions accounts, sends welcome emails, schedules orientation",
        "tools": [
            {"name": "google_workspace", "description": "Google Workspace", "actions": [
                {"name": "create_user", "description": "Create user"}, {"name": "update_user", "description": "Update user"},
                {"name": "add_to_group", "description": "Add to group"}, {"name": "create_alias", "description": "Create alias"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [
                {"name": "invite_user", "description": "Invite"}, {"name": "send_message", "description": "Send"},
                {"name": "add_to_channel", "description": "Add to channel"},
            ]},
            {"name": "github", "description": "GitHub", "actions": [
                {"name": "add_org_member", "description": "Add member"}, {"name": "add_to_team", "description": "Add to team"},
                {"name": "create_repo", "description": "Create repo"},
            ]},
            {"name": "jira", "description": "Jira", "actions": [
                {"name": "create_issue", "description": "Create issue"}, {"name": "assign_issue", "description": "Assign issue"},
            ]},
            {"name": "email", "description": "SendGrid", "actions": [{"name": "send_email", "description": "Send email"}]},
        ],
    },
    {
        "name": "HR Analytics Agent",
        "description": "Headcount reporting, compensation analysis, attrition modeling",
        "tools": [
            {"name": "bamboohr", "description": "BambooHR", "actions": [
                {"name": "get_employees", "description": "Get employees"}, {"name": "get_directory", "description": "Get directory"},
                {"name": "get_timeoff_requests", "description": "Get time off"}, {"name": "get_compensation", "description": "Get compensation"},
            ]},
            {"name": "google_sheets", "description": "Google Sheets", "actions": [
                {"name": "read_spreadsheet", "description": "Read"}, {"name": "update_spreadsheet", "description": "Update"},
                {"name": "create_spreadsheet", "description": "Create"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [{"name": "send_message", "description": "Send"}]},
            {"name": "email", "description": "SendGrid", "actions": [{"name": "send_email", "description": "Send email"}]},
        ],
    },
    {
        "name": "Security Audit Agent",
        "description": "Scans for misconfigurations, checks compliance, reviews access logs",
        "tools": [
            {"name": "aws_iam", "description": "AWS IAM", "actions": [
                {"name": "list_users", "description": "List users"}, {"name": "list_roles", "description": "List roles"},
                {"name": "list_policies", "description": "List policies"}, {"name": "get_access_advisor", "description": "Access advisor"},
                {"name": "simulate_policy", "description": "Simulate policy"},
            ]},
            {"name": "aws_cloudtrail", "description": "AWS CloudTrail", "actions": [
                {"name": "lookup_events", "description": "Lookup events"}, {"name": "get_trail_status", "description": "Trail status"},
            ]},
            {"name": "aws_s3", "description": "AWS S3", "actions": [
                {"name": "get_bucket_policy", "description": "Get policy"}, {"name": "get_bucket_acl", "description": "Get ACL"},
                {"name": "list_buckets", "description": "List buckets"},
            ]},
            {"name": "aws_ec2", "description": "AWS EC2", "actions": [
                {"name": "describe_security_groups", "description": "Describe SGs"}, {"name": "describe_instances", "description": "Describe instances"},
                {"name": "describe_vpcs", "description": "Describe VPCs"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [{"name": "send_message", "description": "Send"}]},
        ],
    },
    {
        "name": "Access Review Agent",
        "description": "Periodic access reviews, deprovisioning inactive users, enforcing least privilege",
        "tools": [
            {"name": "google_workspace", "description": "Google Workspace", "actions": [
                {"name": "list_users", "description": "List users"}, {"name": "get_user", "description": "Get user"},
                {"name": "suspend_user", "description": "Suspend user"}, {"name": "delete_user", "description": "Delete user"},
                {"name": "list_groups", "description": "List groups"}, {"name": "remove_member", "description": "Remove member"},
            ]},
            {"name": "github", "description": "GitHub", "actions": [
                {"name": "list_org_members", "description": "List members"}, {"name": "remove_org_member", "description": "Remove member"},
                {"name": "list_team_members", "description": "List team"}, {"name": "remove_team_member", "description": "Remove from team"},
            ]},
            {"name": "aws_iam", "description": "AWS IAM", "actions": [
                {"name": "list_users", "description": "List users"}, {"name": "delete_access_key", "description": "Delete key"},
                {"name": "detach_policy", "description": "Detach policy"}, {"name": "remove_user_from_group", "description": "Remove from group"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [{"name": "send_message", "description": "Send"}]},
        ],
    },
    {
        "name": "Accounts Payable Agent",
        "description": "Processes invoices, matches POs, initiates payments",
        "tools": [
            {"name": "quickbooks", "description": "QuickBooks", "actions": [
                {"name": "create_invoice", "description": "Create invoice"}, {"name": "update_invoice", "description": "Update invoice"},
                {"name": "create_payment", "description": "Create payment"}, {"name": "void_payment", "description": "Void payment"},
                {"name": "get_vendors", "description": "Get vendors"}, {"name": "create_vendor", "description": "Create vendor"},
            ]},
            {"name": "stripe", "description": "Stripe", "actions": [
                {"name": "create_payout", "description": "Create payout"}, {"name": "create_transfer", "description": "Create transfer"},
                {"name": "get_balance", "description": "Get balance"},
            ]},
            {"name": "aws_s3", "description": "AWS S3", "actions": [
                {"name": "get_object", "description": "Get"}, {"name": "put_object", "description": "Put"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [{"name": "send_message", "description": "Send"}]},
            {"name": "email", "description": "SendGrid", "actions": [{"name": "send_email", "description": "Send email"}]},
        ],
    },
]

print(f"Registering {len(AGENTS)} agents...")
registered = []

for agent in AGENTS:
    resp = requests.post(f"{BASE}/api/authority/agents/register", json=agent)
    data = resp.json()
    agent_id = data["id"]
    score = data["blast_radius"]["score"]
    registered.append({"id": agent_id, "name": agent["name"], "score": score})
    print(f"  {agent['name']:40s} id={agent_id:35s} score={score:5.1f}")

print(f"\nAll {len(registered)} agents registered. Running sweeps...\n")

# Run dry-run sweep on each agent
for r in registered:
    try:
        resp = requests.post(f"{BASE}/api/sandbox/sweep", headers=AUTH, json={
            "agent_id": r["id"],
            "dry_run": True,
            "categories": ["normal", "edge_case", "adversarial"],
        }, timeout=60)
        if resp.status_code == 200:
            sweep = resp.json()
            print(f"  {r['name']:40s} risk={sweep['overall_risk_score']:5.1f}  scenarios={sweep['total_scenarios']}  "
                  f"violations={len(sweep['all_violations'])}  chains={len(sweep['all_chains'])}")
        else:
            print(f"  {r['name']:40s} sweep failed: {resp.status_code}")
    except Exception as e:
        print(f"  {r['name']:40s} sweep error: {e}")

print(f"\nDone. Open http://localhost:5173 to see all {len(registered)} agents on the dashboard.")
