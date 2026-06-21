"""
Register all 5 new agents into Arceo and run a scenario sweep on each.

Usage:
    python register_new_agents.py

Requirements:
    - Arceo backend running on http://localhost:8000
    - pip install requests
"""

import requests

BASE = "http://localhost:8000"

resp = requests.post(f"{BASE}/api/auth/login", json={"email": "admin@actiongate.io", "password": "admin123"})
TOKEN = resp.json()["token"]
AUTH = {"Authorization": f"Bearer {TOKEN}"}

AGENTS = [
    {
        "name": "Churn Intervention Agent",
        "description": "Detects at-risk customers, modifies subscriptions, and sends targeted retention offers.",
        "tools": [
            {"name": "zendesk", "description": "Zendesk", "actions": [
                {"name": "get_ticket", "description": "Get ticket"},
                {"name": "list_tickets", "description": "List tickets"},
                {"name": "add_comment", "description": "Add comment (customer-visible)"},
                {"name": "close_ticket", "description": "Close ticket"},
            ]},
            {"name": "stripe", "description": "Stripe", "actions": [
                {"name": "get_customer", "description": "Get customer"},
                {"name": "list_payments", "description": "List payment history"},
                {"name": "update_subscription", "description": "Modify subscription plan"},
                {"name": "cancel_subscription", "description": "Cancel subscription"},
                {"name": "create_refund", "description": "Issue refund"},
            ]},
            {"name": "hubspot", "description": "HubSpot", "actions": [
                {"name": "get_contact", "description": "Get contact"},
                {"name": "update_contact", "description": "Update contact"},
                {"name": "get_engagement_history", "description": "Engagement history"},
                {"name": "create_deal", "description": "Create deal"},
                {"name": "update_deal", "description": "Update deal"},
            ]},
            {"name": "email", "description": "SendGrid", "actions": [
                {"name": "send_email", "description": "Send personalised email"},
                {"name": "send_template_email", "description": "Send template email"},
                {"name": "list_templates", "description": "List templates"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [
                {"name": "send_message", "description": "Notify CSM"},
            ]},
        ],
    },
    {
        "name": "Platform Reliability Agent",
        "description": "On-call incident triage, automated rollbacks, and capacity scaling across cloud and code.",
        "tools": [
            {"name": "pagerduty", "description": "PagerDuty", "actions": [
                {"name": "create_incident", "description": "Create incident"},
                {"name": "acknowledge_incident", "description": "Acknowledge incident"},
                {"name": "resolve_incident", "description": "Resolve incident"},
                {"name": "get_oncall", "description": "Get on-call engineer"},
                {"name": "escalate", "description": "Escalate incident"},
            ]},
            {"name": "github", "description": "GitHub", "actions": [
                {"name": "get_workflow_status", "description": "Check workflow status"},
                {"name": "trigger_workflow", "description": "Trigger CI/CD workflow"},
                {"name": "rollback_release", "description": "Roll back to previous release"},
                {"name": "create_release", "description": "Create new release"},
                {"name": "get_pull_request", "description": "Get PR details"},
            ]},
            {"name": "aws", "description": "AWS", "actions": [
                {"name": "list_instances", "description": "List EC2 instances"},
                {"name": "stop_instance", "description": "Stop EC2 instance"},
                {"name": "scale_service", "description": "Scale ECS service"},
                {"name": "get_logs", "description": "Get CloudWatch logs"},
                {"name": "update_env_vars", "description": "Update environment variables"},
                {"name": "terminate_instance", "description": "Terminate EC2 instance"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [
                {"name": "send_message", "description": "DM engineer"},
                {"name": "send_channel_message", "description": "Post to incident channel"},
                {"name": "create_channel", "description": "Create war-room channel"},
            ]},
        ],
    },
    {
        "name": "Sales Outreach Automation Agent",
        "description": "Enriches prospect profiles, personalises email sequences, and books discovery calls automatically.",
        "tools": [
            {"name": "hubspot", "description": "HubSpot", "actions": [
                {"name": "get_contact", "description": "Get contact"},
                {"name": "create_contact", "description": "Create contact"},
                {"name": "update_contact", "description": "Update contact"},
                {"name": "get_company", "description": "Get company"},
                {"name": "create_deal", "description": "Create deal"},
                {"name": "update_deal", "description": "Update deal"},
            ]},
            {"name": "salesforce", "description": "Salesforce", "actions": [
                {"name": "create_lead", "description": "Create lead"},
                {"name": "update_lead", "description": "Update lead"},
                {"name": "convert_lead", "description": "Convert lead to opportunity"},
                {"name": "query_contacts", "description": "Search contacts"},
                {"name": "add_note", "description": "Add note to record"},
            ]},
            {"name": "email", "description": "SendGrid", "actions": [
                {"name": "send_email", "description": "Send personalised email"},
                {"name": "send_template_email", "description": "Send sequence email"},
                {"name": "list_templates", "description": "List templates"},
                {"name": "get_email_status", "description": "Check delivery status"},
            ]},
            {"name": "calendly", "description": "Calendly", "actions": [
                {"name": "list_events", "description": "List scheduled events"},
                {"name": "create_invite_link", "description": "Create booking link"},
                {"name": "cancel_event", "description": "Cancel event"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [
                {"name": "send_message", "description": "Notify SDR of hot lead"},
            ]},
        ],
    },
    {
        "name": "Employee Offboarding Agent",
        "description": "Revokes all system access, archives data, and notifies stakeholders when an employee departs.",
        "tools": [
            {"name": "google_workspace", "description": "Google Workspace", "actions": [
                {"name": "list_users", "description": "List users"},
                {"name": "get_user", "description": "Get user details"},
                {"name": "suspend_user", "description": "Suspend account"},
                {"name": "remove_member", "description": "Remove from group"},
                {"name": "list_groups", "description": "List groups"},
            ]},
            {"name": "github", "description": "GitHub", "actions": [
                {"name": "list_org_members", "description": "List org members"},
                {"name": "remove_org_member", "description": "Remove from org"},
                {"name": "list_team_members", "description": "List team members"},
                {"name": "remove_team_member", "description": "Remove from team"},
            ]},
            {"name": "aws", "description": "AWS", "actions": [
                {"name": "list_instances", "description": "List instances"},
                {"name": "get_logs", "description": "Retrieve final access logs"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [
                {"name": "send_message", "description": "Notify HR and IT"},
                {"name": "send_channel_message", "description": "Post to offboarding channel"},
            ]},
            {"name": "email", "description": "SendGrid", "actions": [
                {"name": "send_email", "description": "Departure confirmation to stakeholders"},
            ]},
        ],
    },
    {
        "name": "FinOps Cost Control Agent",
        "description": "Detects cloud waste, rightsizes resources, terminates idle instances, and reports savings.",
        "tools": [
            {"name": "aws", "description": "AWS", "actions": [
                {"name": "list_instances", "description": "List EC2 instances"},
                {"name": "stop_instance", "description": "Stop idle instance"},
                {"name": "terminate_instance", "description": "Terminate instance permanently"},
                {"name": "create_snapshot", "description": "Snapshot before termination"},
                {"name": "delete_snapshot", "description": "Delete old snapshots"},
                {"name": "get_logs", "description": "Get usage logs"},
                {"name": "scale_service", "description": "Right-size ECS service"},
            ]},
            {"name": "github", "description": "GitHub", "actions": [
                {"name": "list_repos", "description": "List repos"},
                {"name": "get_pull_request", "description": "Get PR"},
                {"name": "create_branch", "description": "Branch for cost-opt changes"},
            ]},
            {"name": "stripe", "description": "Stripe", "actions": [
                {"name": "get_invoice", "description": "Get cloud invoice"},
                {"name": "list_payments", "description": "List billing history"},
            ]},
            {"name": "slack", "description": "Slack", "actions": [
                {"name": "send_channel_message", "description": "Weekly savings digest"},
                {"name": "send_message", "description": "Alert on large cost spike"},
            ]},
            {"name": "email", "description": "SendGrid", "actions": [
                {"name": "send_email", "description": "Executive cost report"},
                {"name": "send_template_email", "description": "Monthly savings summary"},
            ]},
        ],
    },
]

print(f"Registering {len(AGENTS)} new agents...\n")
registered = []

for agent in AGENTS:
    resp = requests.post(f"{BASE}/api/authority/agents/register", json=agent)
    if resp.status_code != 200:
        print(f"  FAILED {agent['name']}: {resp.status_code} {resp.text[:200]}")
        continue
    data = resp.json()
    agent_id = data["id"]
    score = data["blast_radius"]["score"]
    registered.append({"id": agent_id, "name": agent["name"], "score": score})
    print(f"  OK {agent['name']:45s} id={agent_id:40s} blast_radius={score:.1f}")

print(f"\nAll {len(registered)} agents registered. Running scenario sweeps...\n")

for r in registered:
    try:
        resp = requests.post(
            f"{BASE}/api/sandbox/sweep",
            headers=AUTH,
            json={"agent_id": r["id"], "dry_run": True, "categories": ["normal", "edge_case", "adversarial"]},
            timeout=90,
        )
        if resp.status_code == 200:
            sweep = resp.json()
            print(
                f"  {r['name']:45s} "
                f"risk={sweep['overall_risk_score']:5.1f}  "
                f"scenarios={sweep['total_scenarios']}  "
                f"violations={len(sweep['all_violations'])}  "
                f"chains={len(sweep['all_chains'])}"
            )
        else:
            print(f"  {r['name']:45s} sweep failed: {resp.status_code}")
    except Exception as e:
        print(f"  {r['name']:45s} sweep error: {e}")

print(f"\nDone. Open http://localhost:5173 to see all agents on the dashboard.")
