"""ActionGate wrapper for MCP (Model Context Protocol) clients.

Intercepts MCP tool calls and routes them through ActionGate's
enforce + mock layer instead of the real MCP server.
"""

from __future__ import annotations

import json
from typing import Any

from actiongate.client import ActionGateClient


class ActionGateMCPProxy:
    """A proxy that sits between an MCP client and server.

    Instead of calling the real MCP server's tools, routes calls
    through ActionGate for enforcement and mock responses.

    Usage:
        from actiongate.frameworks.mcp import ActionGateMCPProxy

        proxy = ActionGateMCPProxy(
            gate=ActionGateClient(agent_id="my-agent"),
            source="my-mcp-server",
        )

        # Instead of: result = await session.call_tool("send_email", args)
        result = proxy.call_tool("send_email", {"to": "user@test.com", "body": "Hi"})
    """

    def __init__(self, gate: ActionGateClient, source: str = "mcp"):
        self._gate = gate
        self._source = source

    def call_tool(self, tool_name: str, arguments: dict | None = None) -> dict:
        """Call an MCP tool through ActionGate.

        Maps MCP tool names to ActionGate's tool.action format.
        The source name becomes the tool, the MCP tool name becomes the action.
        """
        return self._gate.call_tool(self._source, tool_name, arguments or {})

    def list_tools(self) -> list[str]:
        """List available mock tools from ActionGate."""
        trace = self._gate.get_trace()
        return [f"{s['tool']}.{s['action']}" for s in trace.get("steps", [])]

    def get_trace(self) -> dict:
        """Get the ActionGate trace for this session."""
        return self._gate.get_trace()


def wrap_mcp_session(session: Any, gate: ActionGateClient, source: str = "mcp") -> Any:
    """Wrap an MCP ClientSession to route tool calls through ActionGate.

    Patches the session's call_tool method.

    Usage:
        from mcp.client.session import ClientSession
        from actiongate.frameworks.mcp import wrap_mcp_session

        async with ClientSession(transport) as session:
            wrap_mcp_session(session, gate, source="my-server")
            # Now session.call_tool() goes through ActionGate
            result = await session.call_tool("send_email", {"to": "..."})
    """
    original_call_tool = session.call_tool

    async def wrapped_call_tool(name: str, arguments: dict | None = None):
        result = gate.call_tool(source, name, arguments or {})

        # Check if blocked
        if isinstance(result, dict) and result.get("blocked"):
            raise RuntimeError(f"ActionGate blocked {source}.{name}: {result.get('reason', 'policy')}")

        return result

    session.call_tool = wrapped_call_tool
    session._actiongate_original = original_call_tool
    return session
