"""Tool wrappers — intercept LangChain tool calls and route through ActionGate."""

from __future__ import annotations

from typing import Any, Optional

from actiongate.client import ActionGateClient


def _parse_tool_action(name: str) -> tuple[str, str]:
    """Parse a tool name into (tool, action).

    Handles: "stripe__get_customer", "stripe_get_customer", "get_customer"
    """
    if "__" in name:
        parts = name.split("__", 1)
        return parts[0], parts[1]
    return name, name


class ActionGateTool:
    """A proxy tool that routes calls through ActionGate instead of the real API.

    Compatible with LangChain's tool interface — has name, description, invoke().
    """

    def __init__(self, original_tool: Any, gate: ActionGateClient, tool_name: str | None = None, action_name: str | None = None):
        self._original = original_tool
        self._gate = gate

        # Preserve original tool metadata
        self.name = getattr(original_tool, "name", "unknown")
        self.description = getattr(original_tool, "description", "")
        self.args_schema = getattr(original_tool, "args_schema", None)
        self.return_direct = getattr(original_tool, "return_direct", False)

        # Parse tool/action from name
        if tool_name and action_name:
            self._tool_name = tool_name
            self._action_name = action_name
        else:
            self._tool_name, self._action_name = _parse_tool_action(self.name)

    def invoke(self, input_data: Any, config: Any = None, **kwargs) -> Any:
        """Route the call through ActionGate."""
        params = input_data if isinstance(input_data, dict) else {"input": str(input_data)}
        return self._gate.call_tool(self._tool_name, self._action_name, params)

    def run(self, *args, **kwargs) -> Any:
        """Compatibility with older LangChain .run() interface."""
        params = kwargs.copy()
        if args:
            params["input"] = args[0] if len(args) == 1 else list(args)
        return self._gate.call_tool(self._tool_name, self._action_name, params)

    def __call__(self, *args, **kwargs):
        return self.run(*args, **kwargs)

    def __repr__(self):
        return f"ActionGateTool({self._tool_name}.{self._action_name})"


def wrap_tool(tool: Any, gate: ActionGateClient, tool_name: str | None = None, action_name: str | None = None) -> ActionGateTool:
    """Wrap a single tool to route through ActionGate.

    Works with LangChain BaseTool, @tool functions, or any object with a name.
    """
    return ActionGateTool(tool, gate, tool_name, action_name)


def wrap_tools(tools: list[Any], gate: ActionGateClient) -> list[ActionGateTool]:
    """Wrap a list of tools to route through ActionGate.

    Usage:
        gate = ActionGateClient(agent_id="my-agent")
        wrapped = wrap_tools(my_langchain_tools, gate)
    """
    return [wrap_tool(t, gate) for t in tools]
