"""Test the @tool decorator and vanilla agent monitoring."""

from arceo import monitor, tool
from arceo.models import ArceoTrace


# Define tools outside tests so they're importable
@tool(service="stripe", risk="touches_pii")
def get_customer(customer_id):
    return {"name": "Alice", "email": "alice@test.com"}


@tool(service="stripe", risk="moves_money")
def create_refund(payment_id, amount):
    return {"refund_id": "ref_1", "amount": amount}


@tool(service="email", risk="sends_external")
def send_email(to, body):
    return {"sent": True}


def test_tool_captures_calls():
    @monitor(local_only=True, verbose=False)
    def agent(prompt):
        get_customer("cust_1")
        create_refund("pay_1", 50)
        send_email("alice@test.com", "refund done")
        return "ok"

    result = agent("test")
    assert result == "ok"

    trace = agent._last_trace
    assert isinstance(trace, ArceoTrace)
    assert len(trace.tool_calls) == 3
    assert trace.tool_calls[0].tool_name == "stripe"
    assert trace.tool_calls[0].action_name == "get_customer"
    assert trace.tool_calls[1].action_name == "create_refund"
    assert trace.tool_calls[2].tool_name == "email"


def test_risk_hints_populated():
    @monitor(local_only=True, verbose=False)
    def agent(prompt):
        get_customer("c1")
        create_refund("p1", 100)
        return "ok"

    agent("test")
    trace = agent._last_trace
    assert "touches_pii" in trace.tool_calls[0].inferred_risk_hints
    assert "moves_money" in trace.tool_calls[1].inferred_risk_hints


def test_chains_detected():
    @monitor(local_only=True, verbose=False)
    def agent(prompt):
        get_customer("c1")
        send_email("alice@test.com", "data")
        return "ok"

    agent("test")
    chains = agent._last_chains
    assert len(chains) > 0
    assert any(c["chain_name"] == "potential_exfiltration" for c in chains)


def test_tool_calls_work_regardless_of_framework():
    """@tool works even if another framework (anthropic, openai) is imported."""
    @monitor(local_only=True, verbose=False)
    def agent(prompt):
        get_customer("c1")
        return "ok"

    agent("test")
    # Tool calls captured regardless of detected framework
    assert len(agent._last_trace.tool_calls) == 1
    assert agent._last_trace.tool_calls[0].tool_name == "stripe"
