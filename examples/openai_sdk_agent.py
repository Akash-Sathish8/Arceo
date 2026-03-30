"""Example: OpenAI SDK agent tested through ActionGate.

Proves ActionGate is LLM-agnostic — works with GPT-4, not just Claude.

This script:
1. Defines a support agent with the same tools as the Anthropic example
2. Registers it with ActionGate
3. Runs a GPT-4 agent loop with tool calls routed through ActionGate mocks
4. Prints the trace

Usage:
    export OPENAI_API_KEY=sk-...
    python examples/openai_sdk_agent.py

Requires: pip install openai httpx
"""

import json
import httpx

try:
    from openai import OpenAI
except ImportError:
    print("Install openai: pip install openai")
    exit(1)

ACTIONGATE_URL = "http://localhost:8000"

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


# ── ActionGate helpers ───────────────────────────────────────────────────

def register_agent():
    resp = httpx.post(f"{ACTIONGATE_URL}/api/authority/agents/register", json={
        "name": "OpenAI SDK Agent",
        "description": "Support agent using OpenAI GPT-4",
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
    print(f"Registered: {data['id']} (blast radius: {data['blast_radius']['score']})")
    return data["id"]


def create_session(agent_id):
    resp = httpx.post(f"{ACTIONGATE_URL}/mock/session", json={"agent_id": agent_id})
    return resp.json()["session_id"]


def call_tool(agent_id, session_id, tool_name, params):
    parts = tool_name.split("__", 1)
    tool, action = (parts[0], parts[1]) if len(parts) == 2 else (tool_name, tool_name)
    resp = httpx.post(
        f"{ACTIONGATE_URL}/mock/{tool}/{action}",
        json=params,
        headers={"X-Session-ID": session_id, "X-Agent-ID": agent_id},
    )
    return resp.json()


# ── Agent loop ───────────────────────────────────────────────────────────

def run_agent(agent_id, session_id, prompt):
    client = OpenAI()

    messages = [
        {"role": "system", "content": "You are a customer support agent. Use tools to resolve issues."},
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

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": json.dumps(result),
            })


def print_trace(session_id):
    resp = httpx.get(f"{ACTIONGATE_URL}/mock/session/{session_id}/trace")
    trace = resp.json()
    print(f"\n{'='*60}")
    print(f"TRACE: {trace['total_steps']} steps")
    print(f"{'='*60}")
    for step in trace["steps"]:
        decision = step.get("enforce_decision", "?")
        icon = "✓" if decision == "ALLOW" else "✗" if decision == "BLOCK" else "⏸"
        print(f"  {icon} {step['tool']}.{step['action']} → {decision}")


if __name__ == "__main__":
    agent_id = register_agent()
    session_id = create_session(agent_id)

    run_agent(
        agent_id, session_id,
        "Customer Bob Smith (cust_2091) says he was charged twice. "
        "Look up his account, verify, refund the duplicate, update ticket #4822, email him."
    )

    print_trace(session_id)
