"""Tool executor — enforce check, mock call, trace capture."""

from __future__ import annotations

from datetime import datetime

from authority.enforcement import enforce_check
from sandbox.models import TraceStep
from sandbox.mocks.registry import MockState, call_mock


def execute_tool_call(
    agent_id: str,
    tool: str,
    action: str,
    params: dict,
    state: MockState,
    step_index: int,
    session_context: list[str] | None = None,
    approval_mode: str = "pause",
) -> TraceStep:
    """Execute a single tool call with enforcement and mock.

    1. Check policy via enforce_check (includes params for conditional
       policies and session_context for requires_prior conditions)
    2. If allowed, call the mock function
    3. If REQUIRE_APPROVAL, behaviour depends on approval_mode:
         "pause"  — record as pending, return message telling agent to wait
         "allow"  — auto-approve: execute mock, record as ALLOW
         "deny"   — treat as BLOCK
    4. Return a TraceStep with the full result
    """
    # Step 1: Check enforcement — in-process, same engine the API endpoint
    # uses. This was an HTTP call to /api/enforce; when that endpoint gained
    # auth, the credential-less 401 fell through as ALLOW, so every simulated
    # action executed with policies silently ignored. It also never sent
    # params, so conditional (e.g. amount-based) policies never fired in sims.
    try:
        data = enforce_check(agent_id, tool, action, params or None, session_context or [])
        enforce_decision = data.get("decision", "ALLOW")
        enforce_policy = data.get("policy")
    except Exception:
        # Fail CLOSED: an enforcement failure is an UNKNOWN outcome, not a
        # pass. Mark ERROR and skip the mock so the sim never silently
        # under-blocks a dangerous action.
        enforce_decision = "ERROR"
        enforce_policy = None

    # Step 2: Execute mock based on decision + approval_mode
    result = None
    error = None

    if enforce_decision == "BLOCK":
        result = {"blocked": True, "reason": enforce_policy.get("reason", "Blocked by policy") if enforce_policy else "Blocked"}
    elif enforce_decision == "REQUIRE_APPROVAL":
        if approval_mode == "allow":
            # Auto-approve: execute the mock as if approval was pre-granted
            try:
                result = call_mock(tool, action, params, state)
            except Exception as e:
                error = str(e)
                result = {"error": str(e)}
            enforce_decision = "ALLOW"  # rewrite so trace shows it as executed
            enforce_policy = {**(enforce_policy or {}), "_auto_approved": True}
        elif approval_mode == "deny":
            # Treat REQUIRE_APPROVAL as a hard block in this simulation
            result = {"blocked": True, "reason": "(approval denied — simulation deny mode)"}
            enforce_decision = "BLOCK"
        else:
            # "pause" — realistic: return pending status, runner will halt the loop
            reason = enforce_policy.get("reason", "Requires approval") if enforce_policy else "Requires approval"
            result = {
                "pending_approval": True,
                "reason": reason,
                "simulation_note": (
                    "This action requires human approval. "
                    "The request has been submitted. Do not retry — wait for approval before continuing."
                ),
            }
    elif enforce_decision == "ERROR":
        # Enforcement was unreachable — do NOT execute the mock; surface the error.
        error = "enforce endpoint unavailable"
        result = {"error": True, "reason": "Enforcement unavailable — action not executed"}
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
