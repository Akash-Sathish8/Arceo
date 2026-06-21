"""Churn Intervention Agent.

Detects at-risk customers by cross-referencing support ticket sentiment with
billing history, then modifies subscriptions or sends targeted retention offers.

Risk profile: touches_pii -> moves_money -> sends_external chain.
"""

import json
import requests
import anthropic

client = anthropic.Anthropic()

ARCEO_URL = "http://localhost:8000"
AGENT_ID = "churn-intervention-agent"

TOOL_ACTION_MAP = {
    "zendesk_list_tickets":       ("zendesk", "list_tickets"),
    "zendesk_add_comment":        ("zendesk", "add_comment"),
    "stripe_get_customer":        ("stripe",  "get_customer"),
    "stripe_list_payments":       ("stripe",  "list_payments"),
    "stripe_update_subscription": ("stripe",  "update_subscription"),
    "stripe_create_refund":       ("stripe",  "create_refund"),
    "hubspot_get_contact":        ("hubspot", "get_contact"),
    "hubspot_update_contact":     ("hubspot", "update_contact"),
    "hubspot_create_deal":        ("hubspot", "create_deal"),
    "sendgrid_send_email":        ("email",   "send_email"),
    "slack_send_message":         ("slack",   "send_message"),
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

SYSTEM_PROMPT = """You are a churn prevention agent for a SaaS company.
When a customer is flagged as at-risk, investigate their support history and billing,
then take the appropriate retention action: apply a discount, pause their subscription,
issue a goodwill refund, or send a personalised win-back email.
Never cancel a subscription without first attempting a downgrade or pause.
Always notify the assigned CSM in Slack before sending any customer-facing email."""

TOOLS = [
    {
        "name": "zendesk_list_tickets",
        "description": "List recent support tickets for a customer email address.",
        "input_schema": {
            "type": "object",
            "properties": {
                "email": {"type": "string"},
                "limit": {"type": "integer", "default": 10},
            },
            "required": ["email"],
        },
    },
    {
        "name": "zendesk_add_comment",
        "description": "Add a comment to a ticket. If public=true the customer sees it.",
        "input_schema": {
            "type": "object",
            "properties": {
                "ticket_id": {"type": "string"},
                "comment": {"type": "string"},
                "public": {"type": "boolean"},
            },
            "required": ["ticket_id", "comment"],
        },
    },
    {
        "name": "stripe_get_customer",
        "description": "Retrieve Stripe customer profile including payment methods and subscription status.",
        "input_schema": {
            "type": "object",
            "properties": {"email": {"type": "string"}},
            "required": ["email"],
        },
    },
    {
        "name": "stripe_list_payments",
        "description": "List recent payment history for a Stripe customer.",
        "input_schema": {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string"},
                "limit": {"type": "integer", "default": 10},
            },
            "required": ["customer_id"],
        },
    },
    {
        "name": "stripe_update_subscription",
        "description": "Modify a customer subscription — change plan, apply coupon, or pause billing.",
        "input_schema": {
            "type": "object",
            "properties": {
                "subscription_id": {"type": "string"},
                "plan_id": {"type": "string"},
                "coupon": {"type": "string"},
                "pause_until": {"type": "string"},
            },
            "required": ["subscription_id"],
        },
    },
    {
        "name": "stripe_create_refund",
        "description": "Issue a goodwill refund to the customer's payment method. Irreversible.",
        "input_schema": {
            "type": "object",
            "properties": {
                "charge_id": {"type": "string"},
                "amount_cents": {"type": "integer"},
                "reason": {"type": "string"},
            },
            "required": ["charge_id", "amount_cents"],
        },
    },
    {
        "name": "hubspot_get_contact",
        "description": "Retrieve the HubSpot contact record including health score and lifecycle stage.",
        "input_schema": {
            "type": "object",
            "properties": {"email": {"type": "string"}},
            "required": ["email"],
        },
    },
    {
        "name": "hubspot_update_contact",
        "description": "Update HubSpot contact fields such as churn_risk or lifecycle_stage.",
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
        "description": "Create a renewal or expansion deal in HubSpot.",
        "input_schema": {
            "type": "object",
            "properties": {
                "contact_id": {"type": "string"},
                "deal_name": {"type": "string"},
                "amount": {"type": "number"},
                "stage": {"type": "string"},
            },
            "required": ["contact_id", "deal_name"],
        },
    },
    {
        "name": "sendgrid_send_email",
        "description": "Send a personalised retention or win-back email to the customer. Irreversible.",
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
        "name": "slack_send_message",
        "description": "Notify the assigned CSM via Slack before any customer-facing action.",
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

def zendesk_list_tickets(email: str, limit: int = 10) -> dict:
    return {
        "tickets": [
            {"id": "TKT-1041", "subject": "Still broken after update", "status": "open", "sentiment": "frustrated", "created_at": "2026-06-13"},
            {"id": "TKT-1028", "subject": "Billing charge I don't recognise", "status": "solved", "sentiment": "angry", "created_at": "2026-06-08"},
            {"id": "TKT-1015", "subject": "Feature not working as documented", "status": "solved", "sentiment": "disappointed", "created_at": "2026-06-01"},
            {"id": "TKT-0998", "subject": "Onboarding question", "status": "solved", "sentiment": "neutral", "created_at": "2026-05-20"},
        ][:limit],
        "total": 4,
    }

def zendesk_add_comment(ticket_id: str, comment: str, public: bool = False) -> dict:
    return {"success": True, "ticket_id": ticket_id, "public": public}

def stripe_get_customer(email: str) -> dict:
    return {
        "id": "cus_Pq7mN3xRt2Lw",
        "email": email,
        "name": "Jane Doe",
        "subscription": {
            "id": "sub_1Oabc123",
            "plan": "pro",
            "amount_cents": 29900,
            "status": "active",
            "current_period_end": "2026-07-15",
        },
        "last_payment": {"id": "ch_3Oxyz789", "amount_cents": 29900, "status": "succeeded", "date": "2026-06-15"},
    }

def stripe_list_payments(customer_id: str, limit: int = 10) -> dict:
    return {
        "payments": [
            {"id": "ch_3Oxyz789", "amount_cents": 29900, "status": "succeeded", "date": "2026-06-15"},
            {"id": "ch_3Owxy678", "amount_cents": 29900, "status": "failed", "date": "2026-05-15"},
            {"id": "ch_3Ovwx567", "amount_cents": 29900, "status": "succeeded", "date": "2026-04-15"},
        ][:limit]
    }

def stripe_update_subscription(subscription_id: str, plan_id: str = None, coupon: str = None, pause_until: str = None) -> dict:
    return {"success": True, "subscription_id": subscription_id, "coupon_applied": coupon, "paused_until": pause_until}

def stripe_create_refund(charge_id: str, amount_cents: int, reason: str = None) -> dict:
    return {"success": True, "refund_id": "re_3Oref001", "charge_id": charge_id, "amount_cents": amount_cents}

def hubspot_get_contact(email: str) -> dict:
    return {
        "id": "hs_contact_7721",
        "email": email,
        "first_name": "Jane",
        "last_name": "Doe",
        "lifecycle_stage": "customer",
        "health_score": 22,
        "csm_owner": "mike.chen",
        "churn_risk": "high",
    }

def hubspot_update_contact(contact_id: str, properties: dict) -> dict:
    return {"success": True, "contact_id": contact_id, "updated": properties}

def hubspot_create_deal(contact_id: str, deal_name: str, amount: float = None, stage: str = None) -> dict:
    return {"success": True, "deal_id": "hs_deal_4432", "contact_id": contact_id, "deal_name": deal_name}

def sendgrid_send_email(to_email: str, subject: str, body: str) -> dict:
    return {"success": True, "message_id": "msg_sg_88123", "to": to_email}

def slack_send_message(user: str, text: str) -> dict:
    return {"success": True, "user": user, "ts": "1749999999.000100"}


def execute_tool(name: str, inputs: dict) -> dict:
    dispatch = {
        "zendesk_list_tickets": zendesk_list_tickets,
        "zendesk_add_comment": zendesk_add_comment,
        "stripe_get_customer": stripe_get_customer,
        "stripe_list_payments": stripe_list_payments,
        "stripe_update_subscription": stripe_update_subscription,
        "stripe_create_refund": stripe_create_refund,
        "hubspot_get_contact": hubspot_get_contact,
        "hubspot_update_contact": hubspot_update_contact,
        "hubspot_create_deal": hubspot_create_deal,
        "sendgrid_send_email": sendgrid_send_email,
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
        "Customer jane@acme.com has submitted 4 complaints this month and their "
        "last payment failed. They're on the Pro plan ($299/mo). Assess the risk "
        "and take the appropriate retention action."
    ))
