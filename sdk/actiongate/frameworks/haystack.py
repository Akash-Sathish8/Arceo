"""ActionGate wrapper for Haystack (deepset) pipelines and tools."""

from __future__ import annotations

import json
from typing import Any

from actiongate.client import ActionGateClient


def create_haystack_tool(gate: ActionGateClient, tool_name: str, action_name: str, description: str = "") -> Any:
    """Create a Haystack-compatible Tool that routes through ActionGate.

    Usage:
        from actiongate.frameworks.haystack import create_haystack_tool

        tool = create_haystack_tool(gate, "stripe", "create_refund", "Issue a refund")
        agent = Agent(tools=[tool])
    """
    try:
        from haystack.tools import Tool
    except ImportError:
        # Fallback: return a plain callable with metadata
        def tool_fn(**kwargs) -> str:
            result = gate.call_tool(tool_name, action_name, kwargs)
            return json.dumps(result)

        tool_fn.name = f"{tool_name}__{action_name}"
        tool_fn.description = description or f"{tool_name}.{action_name}"
        return tool_fn

    def tool_fn(**kwargs) -> str:
        result = gate.call_tool(tool_name, action_name, kwargs)
        return json.dumps(result)

    return Tool(
        name=f"{tool_name}__{action_name}",
        description=description or f"{tool_name}.{action_name}",
        function=tool_fn,
    )


def create_haystack_tools(gate: ActionGateClient, tools: list[dict]) -> list:
    """Create Haystack tools for a list of tool definitions.

    tools format: [{"tool": "stripe", "action": "create_refund", "description": "..."}]
    """
    return [
        create_haystack_tool(gate, t["tool"], t["action"], t.get("description", ""))
        for t in tools
    ]
