"""Arceo SDK — monitor any AI agent's tool calls and get a risk report.

    from arceo import monitor, tool

    @tool(service="stripe", risk="moves_money")
    def create_refund(customer_id, amount):
        ...

    @monitor(verbose=True)
    def my_agent(prompt):
        ...

    # Or local analysis with no agent execution:
    from arceo import analyze_local
    analyze_local(tools=[{"name": "stripe", "actions": ["create_refund"]}])
"""

from arceo.decorator import monitor, analyze_local, ArceoSecurityError
from arceo.client import ArceoClient
from arceo.models import ArceoTrace, ArceoToolCall, ArceoToolSchema, ArceoLLMCall
from arceo.frameworks.vanilla import tool

__all__ = [
    "monitor", "analyze_local", "ArceoSecurityError",
    "ArceoClient", "ArceoTrace", "ArceoToolCall", "ArceoToolSchema", "ArceoLLMCall",
    "tool",
]
__version__ = "0.1.0"
