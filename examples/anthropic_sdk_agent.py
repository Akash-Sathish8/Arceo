"""Example: Pure Anthropic SDK agent with ActionGate enforcement.

Shows both SANDBOX mode (free, mock APIs) and LIVE mode (real APIs, enforcement applies).

SANDBOX MODE — default, free, good for development and testing:
  - Tool calls go to ActionGate's mock APIs
  - Enforcement policies are checked against mocks
  - No real API keys needed beyond ANTHROPIC_API_KEY

LIVE MODE — real APIs, enforcement still applies:
  - Tool calls hit real Stripe, Zendesk, etc.
  - ActionGate checks policies BEFORE each real call
  - Blocked calls never reach the real API
  - Session context tracked automatically for requires_prior policies

Usage:
    # Sandbox mode (default):
    export ANTHROPIC_API_KEY=sk-ant-...
    python examples/anthropic_sdk_agent.py

    # Live mode:
    export ANTHROPIC_API_KEY=sk-ant-...
    export ACTIONGATE_MODE=live
    export STRIPE_SECRET_KEY=sk_test_...   # optional, for real Stripe calls
    python examples/anthropic_sdk_agent.py

Requires: pip install anthropic httpx
"""

import json
import os
import anthropic
import httpx

ACTIONGATE_URL = os.getenv("ACTIONGATE_URL", "http://localhost:8000")
MODE = os.getenv("ACTIONGATE_MODE", "sandbox")  # "sandbox" or "live"

# ── Tool definitions (Anthropic format) ─────────────────────────────────

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


# ── Step 1: Register agent with ActionGate ───────────────────────────────

def register_agent():
    """Register at startup so ActionGate knows this agent's tools and risk labels."""
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
    print(f"Registered: {data['id']} (blast radius score: {data['blast_radius'].get('score', '?')})")
    return data["id"]


# ── Step 2a: Sandbox tool execution (mocks, free) ────────────────────────

def create_session(agent_id):
    resp = httpx.post(f"{ACTIONGATE_URL}/mock/session", json={"agent_id": agent_id})
    return resp.json()["session_id"]


def call_tool_sandbox(agent_id, session_id, tool_name, params):
    """Route a tool call through ActionGate's mock APIs with enforcement."""
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
# Example policy: "Only allow stripe.create_refund if agent already called zendesk.get_ticket"
_live_session_context: list[str] = []

# Real tool functions — replace these lambdas with actual SDK calls.
# ActionGate checks enforcement BEFORE calling these functions.
# If blocked, the function is never called.
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
        # Policy blocked this — return structured response so LLM can explain to user
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

    # Track in session context so requires_prior policies work for subsequent calls
    _live_session_context.append(action_key)
    print(f"  Session context: {_live_session_context}")

    return result


# ── Step 3: Unified tool dispatcher ─────────────────────────────────────

def call_tool(agent_id, session_id, tool_name, params):
    if MODE == "live":
        return call_tool_live(agent_id, tool_name, params)
    else:
        return call_tool_sandbox(agent_id, session_id, tool_name, params)


# ── Step 4: Agent loop ───────────────────────────────────────────────────

def run_agent(agent_id, session_id, prompt):
    client = anthropic.Anthropic()
    messages = [{"role": "user", "content": prompt}]
    print(f"\nUser: {prompt}\n")

    for turn in range(10):
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=2048,
            system="You are a customer support agent. Use the tools available to resolve customer issues. "
                   "If a tool is blocked or requires approval, inform the user and stop that action.",
            tools=TOOLS,
            messages=messages,
        )

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

        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue

            result = call_tool(agent_id, session_id, block.name, block.input)
            print(f"  Result: {json.dumps(result)[:120]}")

            # Feed blocked/pending responses back to LLM so it can explain to user
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": json.dumps(result),
            })

        if tool_results:
            messages.append({"role": "user", "content": tool_results})
        else:
            break


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
        # SANDBOX: free, uses mock APIs, great for development
        # To set policies, log in to the dashboard at http://localhost:5173
        # or call: POST /api/authority/agent/{agent_id}/policies (requires JWT)
        session_id = create_session(agent_id)
        print(f"Sandbox session: {session_id}")
    else:
        # LIVE: real APIs, enforcement still applies before every call
        # Register real tool functions above in _make_live_tools()
        session_id = None
        print("Live mode: enforcement checks real APIs")

    run_agent(
        agent_id, session_id,
        "Customer Bob Smith (cust_2091) says he was charged twice for his March subscription. "
        "Look up his account, verify the duplicate charge, refund the extra payment, "
        "update his support ticket #4822, and send him a confirmation email."
    )

    print_trace(session_id)
