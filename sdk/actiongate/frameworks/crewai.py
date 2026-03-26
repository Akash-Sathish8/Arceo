"""ActionGate wrapper for CrewAI agents and tools."""

from __future__ import annotations

from typing import Any

from actiongate.client import ActionGateClient


def wrap_crewai_tool(tool: Any, gate: ActionGateClient, tool_name: str = "", action_name: str = "") -> Any:
    """Wrap a CrewAI tool to route through ActionGate.

    CrewAI tools have a _run() method that gets called when the agent uses them.

    Usage:
        from crewai.tools import BaseTool
        from actiongate.frameworks.crewai import wrap_crewai_tool

        my_tool = MyCustomTool()
        wrapped = wrap_crewai_tool(my_tool, gate, "stripe", "create_refund")
    """
    name = tool_name or getattr(tool, "name", "unknown")
    action = action_name or name

    if "__" in name and not action_name:
        name, action = name.split("__", 1)

    original_run = tool._run

    def wrapped_run(*args, **kwargs):
        params = kwargs.copy()
        if args:
            params["input"] = args[0] if len(args) == 1 else list(args)
        return gate.call_tool(name, action, params)

    tool._run = wrapped_run
    tool._actiongate_original = original_run
    return tool


def wrap_crewai_tools(tools: list[Any], gate: ActionGateClient) -> list[Any]:
    """Wrap a list of CrewAI tools.

    Usage:
        tools = [StripeGetCustomer(), StripeCreateRefund(), SendEmail()]
        wrapped = wrap_crewai_tools(tools, gate)
        agent = Agent(tools=wrapped, ...)
    """
    return [wrap_crewai_tool(t, gate) for t in tools]


def create_crewai_tool(gate: ActionGateClient, tool_name: str, action_name: str, description: str = "") -> Any:
    """Create a CrewAI-compatible tool that routes through ActionGate.

    Use this when you don't have an existing tool to wrap — creates one from scratch.

    Usage:
        from actiongate.frameworks.crewai import create_crewai_tool

        refund_tool = create_crewai_tool(gate, "stripe", "create_refund", "Issue a refund")
        agent = Agent(tools=[refund_tool], ...)
    """
    class ActionGateCrewTool:
        name: str = f"{tool_name}__{action_name}"
        description: str = description or f"{tool_name}.{action_name}"

        def _run(self, **kwargs) -> Any:
            return gate.call_tool(tool_name, action_name, kwargs)

    t = ActionGateCrewTool()
    t.name = f"{tool_name}__{action_name}"
    t.description = description or f"{tool_name}.{action_name}"
    return t
