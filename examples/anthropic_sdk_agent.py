"""Example: Pure Anthropic SDK agent tested through ActionGate.

No LangChain, no abstractions — direct Anthropic API with ActionGate enforcement.

This script:
1. Defines a support agent with Stripe, Zendesk, and Email tools
2. Registers it with ActionGate
3. Runs a Claude agent loop with tool calls routed through ActionGate mocks
4. Prints the trace showing what happened

Usage:
    export ANTHROPIC_API_KEY=sk-...
    python examples/anthropic_sdk_agent.py

Requires: pip install anthropic httpx
"""

import json
import anthropic
import httpx

ACTIONGATE_URL = "http://localhost:8000"

# ── Step 1: Define tools as Anthropic tool definitions ───────────────────

TOOLS = [
    {
        "name": "stripe__get_customer",
        "description": "Look up a Stripe customer by ID. Returns name, email, payment info.",
        "input_schema": {
            "type": "object",
            "properties": {"customer_id": {"type": "string", "description": "Stripe customer ID"}},
            "required": ["customer_id"],
        },
    },
    {
        "name": "stripe__list_payments",
        "description": "List recent payments for a customer.",
        "input_schema": {
            "type": "object",
            "properties": {"customer_id": {"type": "string"}},
            "required": ["customer_id"],
        },
    },
    {
        "name": "stripe__create_refund",
        "description": "Issue a refund for a specific payment.",
        "input_schema": {
            "type": "object",
            "properties": {
                "payment_id": {"type": "string"},
                "amount": {"type": "number", "description": "Amount in dollars"},
            },
            "required": ["payment_id"],
        },
    },
    {
        "name": "zendesk__get_ticket",
        "description": "Get a support ticket by ID.",
        "input_schema": {
            "type": "object",
            "properties": {"ticket_id": {"type": "string"}},
            "required": ["ticket_id"],
        },
    },
    {
        "name": "zendesk__update_ticket",
        "description": "Update a ticket's status or add a comment.",
        "input_schema": {
            "type": "object",
            "properties": {
                "ticket_id": {"type": "string"},
                "status": {"type": "string"},
                "comment": {"type": "string"},
            },
            "required": ["ticket_id"],
        },
    },
    {
        "name": "email__send_email",
        "description": "Send an email to a customer.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to": {"type": "string"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to", "subject", "body"],
        },
    },
]


# ── Step 2: Register agent with ActionGate ───────────────────────────────

def register_agent():
    resp = httpx.post(f"{ACTIONGATE_URL}/api/authority/agents/register", json={
        "name": "Anthropic SDK Agent",
        "description": "Support agent using pure Anthropic SDK",
        "tools": [
            {"name": "stripe", "description": "Payments", "actions": [
                {"name": "get_customer", "description": "Look up customer"},
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


# ── Step 3: Create mock session ──────────────────────────────────────────

def create_session(agent_id):
    resp = httpx.post(f"{ACTIONGATE_URL}/mock/session", json={"agent_id": agent_id})
    return resp.json()["session_id"]


# ── Step 4: Execute tool call through ActionGate ─────────────────────────

def call_tool(agent_id, session_id, tool_name, params):
    """Route a tool call through ActionGate mocks with enforcement."""
    # Parse tool__action format
    parts = tool_name.split("__", 1)
    tool, action = (parts[0], parts[1]) if len(parts) == 2 else (tool_name, tool_name)

    resp = httpx.post(
        f"{ACTIONGATE_URL}/mock/{tool}/{action}",
        json=params,
        headers={"X-Session-ID": session_id, "X-Agent-ID": agent_id},
    )
    return resp.json()


# ── Step 5: Run the agent loop ───────────────────────────────────────────

def run_agent(agent_id, session_id, prompt):
    client = anthropic.Anthropic()

    messages = [{"role": "user", "content": prompt}]
    print(f"\nUser: {prompt}\n")

    for turn in range(10):
        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2048,
            system="You are a customer support agent. Use the tools available to resolve customer issues.",
            tools=TOOLS,
            messages=messages,
        )

        # Collect assistant response
        assistant_content = []
        for block in response.content:
            if block.type == "text":
                assistant_content.append({"type": "text", "text": block.text})
                print(f"Agent: {block.text}")
            elif block.type == "tool_use":
                assistant_content.append({
                    "type": "tool_use", "id": block.id,
                    "name": block.name, "input": block.input,
                })
                print(f"  Tool: {block.name}({json.dumps(block.input)})")

        messages.append({"role": "assistant", "content": assistant_content})

        if response.stop_reason == "end_of_turn":
            break

        # Execute tool calls
        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            result = call_tool(agent_id, session_id, block.name, block.input)
            print(f"  Result: {json.dumps(result)[:120]}")
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": json.dumps(result),
            })

        if tool_results:
            messages.append({"role": "user", "content": tool_results})
        else:
            break


# ── Step 6: Print the trace ──────────────────────────────────────────────

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


# ── Main ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    agent_id = register_agent()
    session_id = create_session(agent_id)

    run_agent(
        agent_id, session_id,
        "Customer Bob Smith (cust_2091) says he was charged twice for his March subscription. "
        "Look up his account, verify the duplicate charge, refund the extra payment, "
        "update his support ticket #4822, and send him a confirmation email."
    )

    print_trace(session_id)
