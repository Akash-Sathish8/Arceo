"""Tool executor — enforce check, mock call, trace capture."""

from __future__ import annotations

import json
from datetime import datetime

import httpx

from sandbox.models import TraceStep
from sandbox.mocks.registry import MockState, call_mock


ENFORCE_URL = "http://localhost:8000/api/enforce"


def execute_tool_call(
    agent_id: str,
    tool: str,
    action: str,
    params: dict,
    state: MockState,
    step_index: int,
    enforce_url: str = ENFORCE_URL,
) -> TraceStep:
    """Execute a single tool call with enforcement and mock.

    1. Call /api/enforce to check policy
    2. If allowed, call the mock function
    3. Return a TraceStep with the full result
    """
    # Step 1: Check enforcement
    enforce_decision = "ALLOW"
    enforce_policy = None

    try:
        resp = httpx.post(
            enforce_url,
            json={"agent_id": agent_id, "tool": tool, "action": action},
            timeout=5.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            enforce_decision = data.get("decision", "ALLOW")
            enforce_policy = data.get("policy")
    except httpx.HTTPError:
        # If enforce endpoint is down, default to ALLOW (sandbox mode)
        pass

    # Step 2: Execute mock if allowed
    result = None
    error = None

    if enforce_decision == "BLOCK":
        result = {"blocked": True, "reason": enforce_policy.get("reason", "Blocked by policy") if enforce_policy else "Blocked"}
    elif enforce_decision == "REQUIRE_APPROVAL":
        result = {"pending_approval": True, "reason": enforce_policy.get("reason", "Requires approval") if enforce_policy else "Requires approval"}
    else:
        try:
            result = call_mock(tool, action, params, state)
        except Exception as e:
            error = str(e)
            result = {"error": str(e)}

    return TraceStep(
        step_index=step_index,
        tool=tool,
        action=action,
        params=params,
        enforce_decision=enforce_decision,
        enforce_policy=enforce_policy,
        result=result,
        error=error,
        timestamp=datetime.utcnow().isoformat(),
    )


def build_tool_definitions(agent_config: dict) -> list[dict]:
    """Convert an ActionGate agent config into Anthropic tool definitions.

    Each tool.action becomes a separate Anthropic tool named "tool__action"
    (double underscore separator to avoid conflicts with action names).
    Uses rich parameter schemas from tool_schemas.py so the LLM knows
    what parameters to pass.
    """
    from sandbox.agents.tool_schemas import TOOL_SCHEMAS

    tools = []
    for tool in agent_config.get("tools", []):
        tool_name = tool["name"]
        service = tool.get("service", tool_name)
        for action in tool.get("actions", []):
            action_name = action["action"] if isinstance(action, dict) else action
            description = action.get("description", "") if isinstance(action, dict) else ""

            tool_key = f"{tool_name}__{action_name}"
            schema = TOOL_SCHEMAS.get(tool_key, {"properties": {}})

            tools.append({
                "name": tool_key,
                "description": f"[{service}] {description}" if description else f"[{service}] {action_name}",
                "input_schema": {
                    "type": "object",
                    "properties": schema.get("properties", {}),
                    "required": schema.get("required", []),
                },
            })
    return tools


def parse_tool_name(anthropic_tool_name: str) -> tuple[str, str]:
    """Parse 'tool__action' back into (tool, action)."""
    parts = anthropic_tool_name.split("__", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return anthropic_tool_name, anthropic_tool_name
