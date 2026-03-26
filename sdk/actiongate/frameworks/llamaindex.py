"""ActionGate wrapper for LlamaIndex agents and tools."""

from __future__ import annotations

import json
from typing import Any

from actiongate.client import ActionGateClient


def create_llamaindex_tool(gate: ActionGateClient, tool_name: str, action_name: str, description: str = "") -> Any:
    """Create a LlamaIndex-compatible FunctionTool that routes through ActionGate.

    Usage:
        from actiongate.frameworks.llamaindex import create_llamaindex_tool

        refund_tool = create_llamaindex_tool(gate, "stripe", "create_refund", "Issue a refund")
        agent = OpenAIAgent.from_tools([refund_tool])
    """
    try:
        from llama_index.core.tools import FunctionTool
    except ImportError:
        from llama_index.tools import FunctionTool

    def tool_fn(**kwargs) -> str:
        result = gate.call_tool(tool_name, action_name, kwargs)
        return json.dumps(result)

    return FunctionTool.from_defaults(
        fn=tool_fn,
        name=f"{tool_name}__{action_name}",
        description=description or f"{tool_name}.{action_name}",
    )


def create_llamaindex_tools(gate: ActionGateClient, tools: list[dict]) -> list:
    """Create LlamaIndex tools for a list of tool definitions.

    tools format: [{"tool": "stripe", "action": "create_refund", "description": "..."}]

    Usage:
        tools = create_llamaindex_tools(gate, [
            {"tool": "stripe", "action": "get_customer", "description": "Look up customer"},
        ])
        agent = OpenAIAgent.from_tools(tools)
    """
    return [
        create_llamaindex_tool(gate, t["tool"], t["action"], t.get("description", ""))
        for t in tools
    ]


def wrap_llamaindex_tool(tool: Any, gate: ActionGateClient, tool_name: str = "", action_name: str = "") -> Any:
    """Wrap an existing LlamaIndex tool to route through ActionGate.

    Usage:
        from actiongate.frameworks.llamaindex import wrap_llamaindex_tool

        wrapped = wrap_llamaindex_tool(my_existing_tool, gate, "stripe", "get_customer")
    """
    try:
        from llama_index.core.tools import FunctionTool
    except ImportError:
        from llama_index.tools import FunctionTool

    name = tool_name or getattr(tool, "name", "unknown")
    action = action_name or name
    if "__" in name and not action_name:
        name, action = name.split("__", 1)

    desc = getattr(tool, "description", "") or f"{name}.{action}"

    def tool_fn(**kwargs) -> str:
        result = gate.call_tool(name, action, kwargs)
        return json.dumps(result)

    return FunctionTool.from_defaults(fn=tool_fn, name=f"{name}__{action}", description=desc)
