"""Simulate a real company using ActionGate.

Registers 3 agents, has them do realistic work via post-hoc reports,
sets policies, tests enforcement, and shows the full dashboard output.

Run: python3 simulate_company.py
"""

import json
import time
import requests

BASE = "http://localhost:8000"


def heading(text):
    print(f"\n{'='*60}")
    print(f"  {text}")
    print(f"{'='*60}\n")


def step(text):
    print(f"  → {text}")


# ── Step 1: Login ────────────────────────────────────────────────────────

heading("STEP 1: Company admin logs in")

resp = requests.post(f"{BASE}/api/auth/login", json={
    "email": "admin@actiongate.io",
    "password": "admin123",
})
token = resp.json()["token"]
auth = {"Authorization": f"Bearer {token}"}
step(f"Logged in as admin@actiongate.io")


# ── Step 2: Register 3 agents ───────────────────────────────────────────

heading("STEP 2: Register company agents (like SDK auto-register)")

agents = [
    {
        "name": "Acme Support Bot",
        "description": "Handles customer tickets, refunds, and account issues",
        "tools": [
            {"name": "stripe", "description": "Payments", "actions": [
                {"name": "get_customer", "description": "Look up customer details"},
                {"name": "list_payments", "description": "View payment history"},
                {"name": "create_refund", "description": "Issue a refund"},
                {"name": "create_charge", "description": "Charge a customer"},
            ]},
            {"name": "zendesk", "description": "Support tickets", "actions": [
                {"name": "get_ticket", "description": "Read ticket"},
                {"name": "update_ticket", "description": "Update ticket"},
                {"name": "close_ticket", "description": "Close ticket"},
                {"name": "delete_ticket", "description": "Delete ticket"},
            ]},
            {"name": "email", "description": "Email", "actions": [
                {"name": "send_email", "description": "Send email to customer"},
            ]},
        ],
    },
    {
        "name": "Acme Deploy Bot",
        "description": "Manages CI/CD, deployments, and incident response",
        "tools": [
            {"name": "github", "description": "Code & CI", "actions": [
                {"name": "get_pull_request", "description": "View PR"},
                {"name": "merge_pull_request", "description": "Merge PR"},
                {"name": "trigger_workflow", "description": "Run CI/CD"},
                {"name": "create_release", "description": "Create release"},
            ]},
            {"name": "aws", "description": "Infrastructure", "actions": [
                {"name": "list_instances", "description": "List servers"},
                {"name": "scale_service", "description": "Scale up/down"},
                {"name": "terminate_instance", "description": "Kill server"},
                {"name": "update_security_group", "description": "Change firewall"},
                {"name": "delete_snapshot", "description": "Remove backup"},
            ]},
            {"name": "slack", "description": "Notifications", "actions": [
                {"name": "send_message", "description": "Send Slack message"},
            ]},
            {"name": "pagerduty", "description": "Incidents", "actions": [
                {"name": "create_incident", "description": "Create incident"},
                {"name": "resolve_incident", "description": "Resolve incident"},
            ]},
        ],
    },
    {
        "name": "Acme Sales Bot",
        "description": "Manages leads, outreach, and pipeline",
        "tools": [
            {"name": "hubspot", "description": "CRM", "actions": [
                {"name": "get_contact", "description": "Look up contact"},
                {"name": "create_contact", "description": "Add contact"},
                {"name": "update_contact", "description": "Update contact"},
                {"name": "delete_contact", "description": "Remove contact"},
                {"name": "list_deals", "description": "View deals"},
                {"name": "update_deal", "description": "Update deal stage"},
            ]},
            {"name": "gmail", "description": "Email", "actions": [
                {"name": "send_email", "description": "Send outreach email"},
                {"name": "read_inbox", "description": "Check replies"},
            ]},
            {"name": "calendly", "description": "Scheduling", "actions": [
                {"name": "create_invite_link", "description": "Create meeting link"},
                {"name": "list_events", "description": "View upcoming meetings"},
            ]},
        ],
    },
]

for agent in agents:
    resp = requests.post(f"{BASE}/api/authority/agents/register", json=agent)
    data = resp.json()
    step(f"{agent['name']}: score={data['blast_radius']['score']}, status={data['status']}")


# ── Step 3: View dashboard ──────────────────────────────────────────────

heading("STEP 3: Company views their agents on dashboard")

resp = requests.get(f"{BASE}/api/authority/agents", headers=auth)
for a in resp.json()["agents"]:
    chains_text = f"{a['chain_count']} chains ({a['critical_chains']} critical)" if a['chain_count'] else "no chains"
    step(f"{a['name']:25s}  score={a['blast_radius']['score']:5.1f}  {chains_text}")


# ── Step 4: Agents report their work (post-hoc) ─────────────────────────

heading("STEP 4: Agents run and report what they did")

# Support bot handles 3 tickets
support_report = {
    "agent_id": "acme-support-bot",
    "actions": [
        # Ticket 1: normal refund
        {"tool": "zendesk", "action": "get_ticket", "params": {"ticket_id": "T-5001"},
         "result": {"ticket": {"subject": "Double charged", "requester": "jane@acme-customer.com"}}},
        {"tool": "stripe", "action": "get_customer", "params": {"email": "jane@acme-customer.com"},
         "result": {"customer": {"id": "cust_901", "name": "Jane Smith", "email": "jane@acme-customer.com", "phone": "555-0101"}}},
        {"tool": "stripe", "action": "list_payments", "params": {"customer_id": "cust_901"},
         "result": {"payments": [{"id": "pay_201", "amount": 79.99}, {"id": "pay_202", "amount": 79.99}]}},
        {"tool": "stripe", "action": "create_refund", "params": {"payment_id": "pay_202", "amount": 79.99},
         "result": {"refund": {"id": "ref_101", "amount": 79.99, "status": "succeeded"}}},
        {"tool": "email", "action": "send_email",
         "params": {"to": "jane@acme-customer.com", "subject": "Your refund", "body": "Hi Jane Smith, we've refunded $79.99 to your card ending 4242."},
         "result": {"sent": True}},
        {"tool": "zendesk", "action": "close_ticket", "params": {"ticket_id": "T-5001"},
         "result": {"status": "closed"}},

        # Ticket 2: another refund (volume!)
        {"tool": "zendesk", "action": "get_ticket", "params": {"ticket_id": "T-5002"},
         "result": {"ticket": {"subject": "Wrong item", "requester": "bob@acme-customer.com"}}},
        {"tool": "stripe", "action": "get_customer", "params": {"email": "bob@acme-customer.com"},
         "result": {"customer": {"id": "cust_902", "name": "Bob Jones", "email": "bob@acme-customer.com"}}},
        {"tool": "stripe", "action": "create_refund", "params": {"payment_id": "pay_305", "amount": 149.99},
         "result": {"refund": {"id": "ref_102", "amount": 149.99, "status": "succeeded"}}},
        {"tool": "email", "action": "send_email",
         "params": {"to": "bob@acme-customer.com", "subject": "Refund processed", "body": "Hi Bob Jones, $149.99 refunded."},
         "result": {"sent": True}},

        # Ticket 3: big refund
        {"tool": "stripe", "action": "create_refund", "params": {"payment_id": "pay_410", "amount": 899.00},
         "result": {"refund": {"id": "ref_103", "amount": 899.00, "status": "succeeded"}}},
        {"tool": "email", "action": "send_email",
         "params": {"to": "enterprise@bigcorp.com", "subject": "Refund", "body": "Your $899.00 refund is processed."},
         "result": {"sent": True}},
    ],
}

resp = requests.post(f"{BASE}/api/report", json=support_report)
data = resp.json()
step(f"Support Bot: risk={data['risk_score']}, violations={data['violations']}, chains={data['chains']}, data_flows={data['data_flows']}, volume={data['volume_violations']}")
print(f"\n  Executive Summary:\n  {data['executive_summary']}\n")

# Deploy bot does a release
deploy_report = {
    "agent_id": "acme-deploy-bot",
    "actions": [
        {"tool": "github", "action": "get_pull_request", "params": {"pr": 142},
         "result": {"title": "Fix auth bug", "mergeable": True, "approvals": 2}},
        {"tool": "github", "action": "merge_pull_request", "params": {"pr": 142},
         "result": {"merged": True, "sha": "abc123"}},
        {"tool": "github", "action": "trigger_workflow", "params": {"workflow": "deploy-prod"},
         "result": {"run_id": 9001, "status": "in_progress"}},
        {"tool": "aws", "action": "scale_service", "params": {"service": "api", "desired_count": 6},
         "result": {"previous": 3, "current": 6}},
        {"tool": "slack", "action": "send_message",
         "params": {"channel": "#deploys", "text": "Deployed v2.4.1 — auth bug fix. Scaled API to 6 instances."},
         "result": {"sent": True}},
    ],
}

resp = requests.post(f"{BASE}/api/report", json=deploy_report)
data = resp.json()
step(f"Deploy Bot:  risk={data['risk_score']}, violations={data['violations']}, chains={data['chains']}")

# Sales bot does outreach
sales_report = {
    "agent_id": "acme-sales-bot",
    "actions": [
        {"tool": "hubspot", "action": "get_contact", "params": {"email": "cto@prospect.io"},
         "result": {"name": "Sarah Chen", "email": "cto@prospect.io", "company": "TechCorp", "phone": "555-9999"}},
        {"tool": "gmail", "action": "send_email",
         "params": {"to": "cto@prospect.io", "subject": "Quick question", "body": "Hi Sarah, saw TechCorp raised Series B..."},
         "result": {"sent": True}},
        {"tool": "hubspot", "action": "update_deal", "params": {"deal_id": "D-100", "stage": "outreach_sent"},
         "result": {"updated": True}},
        {"tool": "calendly", "action": "create_invite_link", "params": {"event_type": "30min-demo"},
         "result": {"link": "https://calendly.com/acme/demo-sarah"}},
    ],
}

resp = requests.post(f"{BASE}/api/report", json=sales_report)
data = resp.json()
step(f"Sales Bot:   risk={data['risk_score']}, violations={data['violations']}, chains={data['chains']}")


# ── Step 5: Set policies based on findings ───────────────────────────────

heading("STEP 5: Admin sets policies based on what they saw")

policies = [
    {"agent": "acme-support-bot", "pattern": "stripe.create_refund", "effect": "REQUIRE_APPROVAL",
     "reason": "3 refunds in one session — require human approval",
     "conditions": [{"field": "amount", "op": "gt", "value": 100}]},
    {"agent": "acme-support-bot", "pattern": "email.send_email", "effect": "REQUIRE_APPROVAL",
     "reason": "PII flowed into emails — gate external sends"},
    {"agent": "acme-deploy-bot", "pattern": "aws.terminate_instance", "effect": "BLOCK",
     "reason": "Never allow automated instance termination"},
    {"agent": "acme-deploy-bot", "pattern": "aws.delete_snapshot", "effect": "BLOCK",
     "reason": "Never delete backups automatically"},
]

for p in policies:
    body = {"action_pattern": p["pattern"], "effect": p["effect"], "reason": p["reason"]}
    if "conditions" in p:
        body["conditions"] = p["conditions"]
    resp = requests.post(f"{BASE}/api/authority/agent/{p['agent']}/policies", headers=auth, json=body)
    step(f"{p['effect']:20s} {p['agent']}  →  {p['pattern']}")


# ── Step 6: Test enforcement ─────────────────────────────────────────────

heading("STEP 6: Test that policies actually enforce")

tests = [
    {"agent_id": "acme-support-bot", "tool": "stripe", "action": "create_refund", "params": {"amount": 50}},
    {"agent_id": "acme-support-bot", "tool": "stripe", "action": "create_refund", "params": {"amount": 200}},
    {"agent_id": "acme-support-bot", "tool": "email", "action": "send_email", "params": {}},
    {"agent_id": "acme-deploy-bot", "tool": "aws", "action": "terminate_instance", "params": {}},
    {"agent_id": "acme-deploy-bot", "tool": "github", "action": "merge_pull_request", "params": {}},
    {"agent_id": "acme-sales-bot", "tool": "gmail", "action": "send_email", "params": {}},
]

for t in tests:
    resp = requests.post(f"{BASE}/api/enforce", json=t)
    d = resp.json()
    decision = d["decision"]
    icon = "✓" if decision == "ALLOW" else "✗" if decision == "BLOCK" else "⏸"
    params_str = f" (amount={t['params']['amount']})" if "amount" in t.get("params", {}) else ""
    step(f"{icon} {decision:20s} {t['agent_id']}  {t['tool']}.{t['action']}{params_str}")


# ── Step 7: Run a sandbox simulation ─────────────────────────────────────

heading("STEP 7: Run sandbox simulation on support bot")

resp = requests.post(f"{BASE}/api/sandbox/simulate", headers=auth, json={
    "agent_id": "acme-support-bot",
    "custom_prompt": "A customer says they were charged $500 for something they didn't buy. Handle it.",
    "dry_run": True,
})
sim = resp.json()
step(f"Status: {sim['status']}")
step(f"Steps: {sim['trace']['total_steps']}, Executed: {sim['report']['actions_executed']}, Blocked: {sim['report']['actions_blocked']}")
step(f"Risk score: {sim['report']['risk_score']}")
step(f"Violations: {len(sim['report']['violations'])}")
step(f"Chains: {len(sim['report']['chains_triggered'])}")

if sim['report'].get('executive_summary'):
    print(f"\n  Executive Summary:\n  {sim['report']['executive_summary']}")


# ── Done ─────────────────────────────────────────────────────────────────

heading("DONE — Open http://localhost:5173 to see the dashboard")
print("  You'll see:")
print("  • 3 agents with blast radius scores and chain detection")
print("  • Post-hoc reports in the simulation history")
print("  • Policies enforcing on the support and deploy bots")
print("  • A dry-run simulation with violations and recommendations")
print()
