"""Example: OpenAI SDK agent with ActionGate enforcement.

Proves ActionGate is LLM-agnostic — works with GPT-4o, not just Claude.

Shows both SANDBOX mode (free, mock APIs) and LIVE mode (real APIs, enforcement applies).

SANDBOX MODE — default, free, good for development:
  - Tool calls go to ActionGate's mock APIs
  - No real API keys needed beyond OPENAI_API_KEY

LIVE MODE — real APIs, enforcement still applies:
  - Tool calls hit real Stripe, Zendesk, etc.
  - ActionGate checks policies BEFORE each real call
  - Blocked calls never reach the real API

Usage:
    # Sandbox mode (default):
    export OPENAI_API_KEY=sk-...
    python examples/openai_sdk_agent.py

    # Live mode:
    export OPENAI_API_KEY=sk-...
    export ACTIONGATE_MODE=live
    python examples/openai_sdk_agent.py

Requires: pip install openai httpx
"""

import json
import os
import httpx

try:
    from openai import OpenAI
except ImportError:
    print("Install openai: pip install openai")
    exit(1)

ACTIONGATE_URL = os.getenv("ACTIONGATE_URL", "http://localhost:8000")
MODE = os.getenv("ACTIONGATE_MODE", "sandbox")  # "sandbox" or "live"

# ── Tools in OpenAI function-calling format ──────────────────────────────

TOOLS = [
    {"type": "function", "function": {
        "name": "stripe__get_customer",
        "description": "Look up a Stripe customer by ID.",
        "parameters": {
            "type": "object",
            "properties": {"customer_id": {"type": "string"}},
            "required": ["customer_id"],
        },
    }},
    {"type": "function", "function": {
        "name": "stripe__list_payments",
        "description": "List recent payments for a customer.",
        "parameters": {
            "type": "object",
            "properties": {"customer_id": {"type": "string"}},
            "required": ["customer_id"],
        },
    }},
    {"type": "function", "function": {
        "name": "stripe__create_refund",
        "description": "Issue a refund for a payment.",
        "parameters": {
            "type": "object",
            "properties": {
                "payment_id": {"type": "string"},
                "amount": {"type": "number"},
            },
            "required": ["payment_id"],
        },
    }},
    {"type": "function", "function": {
        "name": "zendesk__get_ticket",
        "description": "Get a support ticket.",
        "parameters": {
            "type": "object",
            "properties": {"ticket_id": {"type": "string"}},
            "required": ["ticket_id"],
        },
    }},
    {"type": "function", "function": {
        "name": "zendesk__update_ticket",
        "description": "Update a ticket.",
        "parameters": {
            "type": "object",
            "properties": {
                "ticket_id": {"type": "string"},
                "status": {"type": "string"},
                "comment": {"type": "string"},
            },
            "required": ["ticket_id"],
        },
    }},
    {"type": "function", "function": {
        "name": "email__send_email",
        "description": "Send an email.",
        "parameters": {
            "type": "object",
            "properties": {
                "to": {"type": "string"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to", "subject", "body"],
        },
    }},
]


# ── Step 1: Register agent with ActionGate ───────────────────────────────

def register_agent():
    resp = httpx.post(f"{ACTIONGATE_URL}/api/authority/agents/register", json={
        "name": "OpenAI SDK Agent",
        "description": "Support agent using OpenAI GPT-4o",
        "tools": [
            {"name": "stripe", "description": "Payments", "actions": [
                {"name": "get_customer", "description": "Lookup"},
                {"name": "list_payments", "description": "List payments"},
                {"name": "create_refund", "description": "Issue refund"},
            ]},
            {"name": "zendesk", "description": "Tickets", "actions": [
                {"name": "get_ticket", "description": "Get ticket"},
                {"name": "update_ticket", "description": "Update ticket"},
            ]},
            {"name": "email", "description": "Email", "actions": [
                {"name": "send_email", "description": "Send email"},
            ]},
        ],
    })
    data = resp.json()
    print(f"Registered: {data['id']} (blast radius score: {data['blast_radius'].get('score', '?')})")
    return data["id"]


# ── Step 2a: Sandbox tool execution (mocks, free) ────────────────────────

def create_session(agent_id):
    resp = httpx.post(f"{ACTIONGATE_URL}/mock/session", json={"agent_id": agent_id})
    return resp.json()["session_id"]


def call_tool_sandbox(agent_id, session_id, tool_name, params):
    parts = tool_name.split("__", 1)
    tool, action = (parts[0], parts[1]) if len(parts) == 2 else (tool_name, tool_name)
    resp = httpx.post(
        f"{ACTIONGATE_URL}/mock/{tool}/{action}",
        json=params,
        headers={"X-Session-ID": session_id, "X-Agent-ID": agent_id},
    )
    return resp.json()


# ── Step 2b: Live tool execution (real APIs, enforcement still applies) ──

# Session context is tracked here so requires_prior conditions work correctly.
_live_session_context: list[str] = []

# Real tool functions — replace these lambdas with actual SDK calls.
# ActionGate checks enforcement BEFORE calling these. Blocked calls never run.
def _make_live_tools(agent_id: str) -> dict:
    return {
        "stripe.get_customer": lambda p: {"id": p["customer_id"], "name": "Bob Smith", "email": "bob@example.com"},
        "stripe.list_payments": lambda p: {"payments": [{"id": "py_001", "amount": 99.0}]},
        # To use real Stripe: lambda p: stripe.Customer.retrieve(p["customer_id"])
        "stripe.create_refund": lambda p: {"id": "re_001", "amount": p.get("amount"), "status": "succeeded"},
        "zendesk.get_ticket": lambda p: {"id": p["ticket_id"], "subject": "Billing issue", "status": "open"},
        "zendesk.update_ticket": lambda p: {"id": p["ticket_id"], "status": p.get("status", "updated")},
        "email.send_email": lambda p: {"message_id": "msg_001", "status": "sent", "to": p["to"]},
    }


def call_tool_live(agent_id, tool_name, params):
    """Check enforcement, then call real tool function if allowed."""
    parts = tool_name.split("__", 1)
    tool, action = (parts[0], parts[1]) if len(parts) == 2 else (tool_name, tool_name)
    action_key = f"{tool}.{action}"

    # Check enforcement — passes params and session context for conditional policies
    enforce_resp = httpx.post(f"{ACTIONGATE_URL}/api/enforce", json={
        "agent_id": agent_id,
        "tool": tool,
        "action": action,
        "params": params,
        "session_context": list(_live_session_context),
    })
    enforce = enforce_resp.json()
    decision = enforce.get("decision", "ALLOW")

    if decision == "BLOCK":
        print(f"  BLOCKED: {action_key} — {enforce.get('message', 'Blocked by policy')}")
        return {
            "blocked": True,
            "action": action_key,
            "reason": enforce.get("message", "Blocked by ActionGate policy"),
        }

    if decision == "REQUIRE_APPROVAL":
        print(f"  PENDING APPROVAL: {action_key} — {enforce.get('message', 'Requires approval')}")
        return {
            "pending_approval": True,
            "action": action_key,
            "reason": enforce.get("message", "Action requires human approval before proceeding"),
        }

    # ALLOW — call the real function
    live_tools = _make_live_tools(agent_id)
    fn = live_tools.get(action_key)
    if not fn:
        return {"error": f"No live implementation registered for {action_key}"}

    result = fn(params)
    _live_session_context.append(action_key)
    return result


# ── Step 3: Unified dispatcher ───────────────────────────────────────────

def call_tool(agent_id, session_id, tool_name, params):
    if MODE == "live":
        return call_tool_live(agent_id, tool_name, params)
    else:
        return call_tool_sandbox(agent_id, session_id, tool_name, params)


# ── Step 4: Agent loop ───────────────────────────────────────────────────

def run_agent(agent_id, session_id, prompt):
    client = OpenAI()
    messages = [
        {"role": "system", "content": "You are a customer support agent. Use tools to resolve issues. "
                                      "If a tool is blocked or requires approval, inform the user and stop that action."},
        {"role": "user", "content": prompt},
    ]
    print(f"\nUser: {prompt}\n")

    for turn in range(10):
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            tools=TOOLS,
        )

        choice = response.choices[0]
        messages.append(choice.message)

        if choice.message.content:
            print(f"Agent: {choice.message.content}")

        if choice.finish_reason != "tool_calls":
            break

        for tool_call in choice.message.tool_calls:
            fn = tool_call.function
            params = json.loads(fn.arguments)
            print(f"  Tool: {fn.name}({json.dumps(params)})")

            result = call_tool(agent_id, session_id, fn.name, params)
            print(f"  Result: {json.dumps(result)[:120]}")

            # Feed blocked/pending responses back to GPT so it can explain to user
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": json.dumps(result),
            })


# ── Step 5: Print trace (sandbox only) ──────────────────────────────────

def print_trace(session_id):
    if MODE == "live":
        print(f"\nSession context (actions taken): {_live_session_context}")
        return

    resp = httpx.get(f"{ACTIONGATE_URL}/mock/session/{session_id}/trace")
    trace = resp.json()
    print(f"\n{'='*60}")
    print(f"TRACE: {trace['total_steps']} steps")
    print(f"{'='*60}")
    for step in trace["steps"]:
        decision = step.get("enforce_decision", "?")
        icon = "✓" if decision == "ALLOW" else "✗" if decision == "BLOCK" else "⏸"
        print(f"  {icon} {step['tool']}.{step['action']} → {decision}")


# ── Main ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"Mode: {MODE.upper()}")
    print(f"ActionGate: {ACTIONGATE_URL}\n")

    agent_id = register_agent()

    if MODE == "sandbox":
        session_id = create_session(agent_id)
        print(f"Sandbox session: {session_id}")
    else:
        session_id = None
        print("Live mode: enforcement checks real APIs")

    run_agent(
        agent_id, session_id,
        "Customer Bob Smith (cust_2091) says he was charged twice. "
        "Look up his account, verify, refund the duplicate, update ticket #4822, email him."
    )

    print_trace(session_id)
