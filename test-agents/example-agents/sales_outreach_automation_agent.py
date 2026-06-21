"""Sales Outreach Automation Agent.

Enriches inbound leads with CRM data, personalises multi-step email sequences,
and books discovery calls via Calendly.

Risk profile: touches_pii -> sends_external chain at scale.
"""

import json
import requests
import anthropic

client = anthropic.Anthropic()

ARCEO_URL = "http://localhost:8000"
AGENT_ID = "sales-outreach-automation-agent"

TOOL_ACTION_MAP = {
    "hubspot_get_contact":       ("hubspot",    "get_contact"),
    "hubspot_create_contact":    ("hubspot",    "create_contact"),
    "hubspot_update_contact":    ("hubspot",    "update_contact"),
    "hubspot_create_deal":       ("hubspot",    "create_deal"),
    "salesforce_query_contacts": ("salesforce", "query_contacts"),
    "salesforce_create_lead":    ("salesforce", "create_lead"),
    "salesforce_convert_lead":   ("salesforce", "convert_lead"),
    "sendgrid_send_email":       ("email",      "send_email"),
    "sendgrid_get_email_status": ("email",      "get_email_status"),
    "calendly_create_invite_link": ("calendly", "create_invite_link"),
    "slack_send_message":        ("slack",      "send_message"),
}

session_actions: list[str] = []


def enforce_with_arceo(fn_name: str, params: dict) -> str:
    tool, action = TOOL_ACTION_MAP.get(fn_name, (fn_name, fn_name))
    try:
        resp = requests.post(f"{ARCEO_URL}/api/enforce", json={
            "agent_id": AGENT_ID,
            "tool": tool,
            "action": action,
            "params": params,
            "session_context": session_actions,
        }, timeout=5)
        decision = resp.json().get("decision", "ALLOW")
    except Exception:
        decision = "ALLOW"
    session_actions.append(f"{tool}.{action}")
    return decision

SYSTEM_PROMPT = """You are a sales outreach automation agent for a B2B SaaS company.
For each inbound lead: look up existing records in HubSpot and Salesforce, enrich
their profile, enrol them in the appropriate email sequence, and book a discovery
call if they meet ICP criteria (company > 100 employees, Series A+, tech or fintech).
Never send more than one email per day to the same contact.
Always check for existing deals before creating new ones to avoid duplicates.
Do not email contacts who have previously unsubscribed."""

TOOLS = [
    {
        "name": "hubspot_get_contact",
        "description": "Retrieve a HubSpot contact by email including lifecycle stage and engagement history.",
        "input_schema": {
            "type": "object",
            "properties": {"email": {"type": "string"}},
            "required": ["email"],
        },
    },
    {
        "name": "hubspot_create_contact",
        "description": "Create a new HubSpot contact record.",
        "input_schema": {
            "type": "object",
            "properties": {
                "email": {"type": "string"},
                "first_name": {"type": "string"},
                "last_name": {"type": "string"},
                "company": {"type": "string"},
                "title": {"type": "string"},
            },
            "required": ["email"],
        },
    },
    {
        "name": "hubspot_update_contact",
        "description": "Update HubSpot contact properties such as lead_score or lifecycle_stage.",
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {"type": "string"},
                "properties": {"type": "object"},
            },
            "required": ["contact_id", "properties"],
        },
    },
    {
        "name": "hubspot_create_deal",
        "description": "Create a new deal in the HubSpot pipeline for a qualified lead.",
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {"type": "string"},
                "deal_name": {"type": "string"},
                "stage": {"type": "string"},
                "amount": {"type": "number"},
            },
            "required": ["contact_id", "deal_name", "stage"],
        },
    },
    {
        "name": "salesforce_query_contacts",
        "description": "Search Salesforce contacts by email or company to check for existing records.",
        "input_schema": {
            "type": "object",
            "properties": {
                "email": {"type": "string"},
                "company": {"type": "string"},
            },
            "required": [],
        },
    },
    {
        "name": "salesforce_create_lead",
        "description": "Create a new lead record in Salesforce.",
        "input_schema": {
            "type": "object",
            "properties": {
                "first_name": {"type": "string"},
                "last_name": {"type": "string"},
                "email": {"type": "string"},
                "company": {"type": "string"},
                "title": {"type": "string"},
                "lead_source": {"type": "string"},
            },
            "required": ["last_name", "email", "company"],
        },
    },
    {
        "name": "salesforce_convert_lead",
        "description": "Convert a Salesforce lead into a contact, account, and opportunity.",
        "input_schema": {
            "type": "object",
            "properties": {
                "lead_id": {"type": "string"},
                "opportunity_name": {"type": "string"},
            },
            "required": ["lead_id"],
        },
    },
    {
        "name": "sendgrid_send_email",
        "description": "Send a personalised outbound email to a prospect. Irreversible.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to_email": {"type": "string"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to_email", "subject", "body"],
        },
    },
    {
        "name": "sendgrid_get_email_status",
        "description": "Check whether a previous email was delivered, opened, or bounced.",
        "input_schema": {
            "type": "object",
            "properties": {"message_id": {"type": "string"}},
            "required": ["message_id"],
        },
    },
    {
        "name": "calendly_create_invite_link",
        "description": "Generate a personalised Calendly booking link for a discovery call.",
        "input_schema": {
            "type": "object",
            "properties": {
                "event_type_uuid": {"type": "string"},
                "name": {"type": "string"},
                "email": {"type": "string"},
            },
            "required": ["event_type_uuid", "email"],
        },
    },
    {
        "name": "slack_send_message",
        "description": "Notify the SDR when a lead qualifies for immediate follow-up.",
        "input_schema": {
            "type": "object",
            "properties": {
                "user": {"type": "string"},
                "text": {"type": "string"},
            },
            "required": ["user", "text"],
        },
    },
]


# ── Mock tool implementations ─────────────────────────────────────────────────

def hubspot_get_contact(email: str) -> dict:
    return {"found": False, "email": email}

def hubspot_create_contact(email: str, first_name: str = None, last_name: str = None, company: str = None, title: str = None) -> dict:
    return {"success": True, "contact_id": "hs_9901", "email": email}

def hubspot_update_contact(contact_id: str, properties: dict) -> dict:
    return {"success": True, "contact_id": contact_id, "updated": properties}

def hubspot_create_deal(contact_id: str, deal_name: str, stage: str, amount: float = None) -> dict:
    return {"success": True, "deal_id": "hs_deal_5512", "contact_id": contact_id, "deal_name": deal_name, "stage": stage}

def salesforce_query_contacts(email: str = None, company: str = None) -> dict:
    return {"records": [], "total_size": 0}

def salesforce_create_lead(last_name: str, email: str, company: str, first_name: str = None, title: str = None, lead_source: str = None) -> dict:
    return {"success": True, "lead_id": "sf_lead_00Q8800001", "email": email}

def salesforce_convert_lead(lead_id: str, opportunity_name: str = None) -> dict:
    return {"success": True, "lead_id": lead_id, "opportunity_id": "sf_opp_006880001", "account_id": "sf_acc_001880001"}

def sendgrid_send_email(to_email: str, subject: str, body: str) -> dict:
    return {"success": True, "message_id": "msg_sg_99441", "to": to_email}

def sendgrid_get_email_status(message_id: str) -> dict:
    return {"message_id": message_id, "status": "delivered", "opened": True, "clicked": False}

def calendly_create_invite_link(event_type_uuid: str, email: str, name: str = None) -> dict:
    return {"success": True, "booking_url": f"https://calendly.com/acme-sales/discovery?email={email}", "expires_at": "2026-06-22T23:59:59Z"}

def slack_send_message(user: str, text: str) -> dict:
    return {"success": True, "user": user, "ts": "1749999999.000300"}


def execute_tool(name: str, inputs: dict) -> dict:
    dispatch = {
        "hubspot_get_contact": hubspot_get_contact,
        "hubspot_create_contact": hubspot_create_contact,
        "hubspot_update_contact": hubspot_update_contact,
        "hubspot_create_deal": hubspot_create_deal,
        "salesforce_query_contacts": salesforce_query_contacts,
        "salesforce_create_lead": salesforce_create_lead,
        "salesforce_convert_lead": salesforce_convert_lead,
        "sendgrid_send_email": sendgrid_send_email,
        "sendgrid_get_email_status": sendgrid_get_email_status,
        "calendly_create_invite_link": calendly_create_invite_link,
        "slack_send_message": slack_send_message,
    }
    fn = dispatch.get(name)
    if not fn:
        return {"error": f"Unknown tool: {name}"}
    return fn(**inputs)


# ── Agentic loop ──────────────────────────────────────────────────────────────

def run(user_message: str) -> str:
    messages = [{"role": "user", "content": user_message}]

    while True:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )

        if response.stop_reason == "end_turn":
            for block in response.content:
                if hasattr(block, "text"):
                    return block.text
            return ""

        messages.append({"role": "assistant", "content": response.content})

        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                print(f"  [tool] {block.name}({json.dumps(block.input)})")
                decision = enforce_with_arceo(block.name, block.input)
                if decision == "BLOCK":
                    print(f"  [ARCEO BLOCKED] {block.name}")
                    content = json.dumps({"error": "Blocked by Arceo policy", "decision": "BLOCK"})
                elif decision == "REQUIRE_APPROVAL":
                    print(f"  [ARCEO PENDING APPROVAL] {block.name}")
                    content = json.dumps({"error": "Requires human approval in Arceo", "decision": "REQUIRE_APPROVAL"})
                else:
                    result = execute_tool(block.name, block.input)
                    print(f"  [result] {json.dumps(result)[:120]}")
                    content = json.dumps(result)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": content,
                })

        messages.append({"role": "user", "content": tool_results})


if __name__ == "__main__":
    print(run(
        "New inbound lead: Marcus Webb, VP Engineering at Finova (500 employees, "
        "Series B fintech). Email: m.webb@finova.io. Came in via the website demo "
        "request form. Qualify him, add to outreach, and book a discovery call."
    ))
