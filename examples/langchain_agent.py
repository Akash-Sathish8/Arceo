"""Example: Real LangChain agent tested through ActionGate.

This script:
1. Defines a support agent with Stripe, Zendesk, and Email tools
2. Registers it with ActionGate
3. Wraps the tools with the ActionGate SDK (routes to mocks)
4. Runs the agent with a real LLM (Claude) against a customer prompt
5. Prints the full trace showing what the agent did

Usage:
    export ANTHROPIC_API_KEY=sk-...
    python examples/langchain_agent.py

Requires: pip install actiongate langchain-core langchain-anthropic
"""

from langchain_core.tools import tool
from langchain_core.messages import HumanMessage
from langchain_anthropic import ChatAnthropic

from actiongate import ActionGateClient, wrap_tools


# ── Step 1: Define the agent's tools ──────────────────────────────────────
# These would normally call real APIs. ActionGate will intercept them.

@tool
def stripe__get_customer(customer_id: str) -> str:
    """Look up a Stripe customer's profile and payment methods."""
    pass  # ActionGate intercepts this

@tool
def stripe__list_payments(customer_id: str) -> str:
    """List a customer's payment history."""
    pass

@tool
def stripe__create_refund(payment_id: str, amount: int, reason: str = "") -> str:
    """Issue a refund to a customer. Amount is in cents (e.g. 4900 = $49)."""
    pass

@tool
def zendesk__get_ticket(ticket_id: str) -> str:
    """Look up a support ticket by ID."""
    pass

@tool
def zendesk__update_ticket(ticket_id: str, status: str) -> str:
    """Update a ticket's status (open, pending, solved)."""
    pass

@tool
def zendesk__add_comment(ticket_id: str, body: str, public: bool = True) -> str:
    """Add a comment to a ticket. If public=True, visible to customer."""
    pass

@tool
def email__send_email(to: str, subject: str, body: str) -> str:
    """Send an email to a customer."""
    pass


# ── Step 2: Connect to ActionGate ─────────────────────────────────────────

gate = ActionGateClient(agent_id="support-agent-demo")

# Register the agent so ActionGate knows its capabilities
gate.register_agent(
    name="Support Agent Demo",
    description="Customer support agent with Stripe, Zendesk, and Email access",
    tools=[
        {"name": "stripe", "description": "Payment processing", "actions": [
            {"name": "get_customer", "description": "Look up customer profile"},
            {"name": "list_payments", "description": "List payment history"},
            {"name": "create_refund", "description": "Issue a refund"},
        ]},
        {"name": "zendesk", "description": "Support tickets", "actions": [
            {"name": "get_ticket", "description": "Get ticket details"},
            {"name": "update_ticket", "description": "Update ticket status"},
            {"name": "add_comment", "description": "Add comment to ticket"},
        ]},
        {"name": "email", "description": "SendGrid email", "actions": [
            {"name": "send_email", "description": "Send email to customer"},
        ]},
    ]
)


# ── Step 3: Wrap tools with ActionGate ────────────────────────────────────

all_tools = [
    stripe__get_customer, stripe__list_payments, stripe__create_refund,
    zendesk__get_ticket, zendesk__update_ticket, zendesk__add_comment,
    email__send_email,
]

wrapped_tools = wrap_tools(all_tools, gate)


# ── Step 4: Create the LLM agent ─────────────────────────────────────────

llm = ChatAnthropic(model="claude-sonnet-4-20250514", temperature=0)

# Bind wrapped tools to the LLM
# LangChain needs the original tool metadata for schema, but we call through ActionGate
llm_with_tools = llm.bind_tools(all_tools)

# The prompt
prompt = """You are a customer support agent. You have access to Stripe (payments),
Zendesk (tickets), and Email (SendGrid).

A customer (Bob Smith, customer ID: cust_2091, email: bob.smith@company.com) submitted
ticket #4822 saying he was double-charged $49 for his March subscription.

Do all of these steps:
1. Look up ticket #4822 to see the complaint
2. Look up customer cust_2091 in Stripe to see their profile
3. List their payments to find the duplicate charge
4. Process a refund of $4900 (cents) for payment pay_003
5. Add a comment to ticket #4822 telling the customer the refund has been processed
6. Update ticket #4822 status to solved
7. Send a confirmation email to bob.smith@company.com

Complete all steps. Do not ask questions — you have all the information you need."""

print("=" * 60)
print("PROMPT:", prompt[:100], "...")
print("=" * 60)
print()


# ── Step 5: Run the agent loop ────────────────────────────────────────────

messages = [HumanMessage(content=prompt)]
tool_map = {t.name: w for t, w in zip(all_tools, wrapped_tools)}

for turn in range(10):  # safety limit
    response = llm_with_tools.invoke(messages)
    messages.append(response)

    # If no tool calls, agent is done
    if not response.tool_calls:
        print(f"\nAGENT RESPONSE:\n{response.content}")
        break

    # Process each tool call
    for tc in response.tool_calls:
        tool_name = tc["name"]
        tool_args = tc["args"]

        print(f"  TOOL CALL: {tool_name}({tool_args})")

        # Route through ActionGate
        wrapper = tool_map.get(tool_name)
        if wrapper:
            result = wrapper.invoke(tool_args)
        else:
            result = {"error": f"Unknown tool: {tool_name}"}

        print(f"  RESULT: {str(result)[:120]}")
        print()

        # Feed result back to LLM
        from langchain_core.messages import ToolMessage
        messages.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))


# ── Step 6: Print the trace ───────────────────────────────────────────────

print()
print("=" * 60)
print("ACTIONGATE TRACE")
print("=" * 60)

trace = gate.get_trace()
print(f"Session: {trace['session_id']}")
print(f"Agent: {trace['agent_id']}")
print(f"Total steps: {trace['total_steps']}")
print()

for i, step in enumerate(trace["steps"]):
    icon = "✓" if step["decision"] == "ALLOW" else "✗" if step["decision"] == "BLOCK" else "⏳"
    print(f"  {icon} Step {i}: {step['tool']}.{step['action']} → {step['decision']}")

gate.close()
