"""CrewAI interceptor — hooks into step_callback."""

from __future__ import annotations

from arceo.models import ArceoToolCall, ArceoTrace, ArceoToolSchema
from arceo.parser import parse_tool_name
from arceo.analysis.risk import infer_risk, infer_verb


def make_step_callback(trace: ArceoTrace):
    """Returns a CrewAI step_callback that captures tool calls."""
    def callback(step_output):
        tool_raw = getattr(step_output, "tool", None)
        if not tool_raw:
            return
        tool, action = parse_tool_name(tool_raw)
        args = getattr(step_output, "tool_input", {})
        if isinstance(args, str):
            args = {"input": args}
        output = getattr(step_output, "output", None)
        result_str = str(output)[:500] if output else ""
        hints, read_only = infer_risk(tool, action, list(args.keys()) if isinstance(args, dict) else [])

        trace.tool_calls.append(ArceoToolCall(
            tool_name=tool, action_name=action,
            arguments=args if isinstance(args, dict) else {"input": str(args)},
            result_summary=result_str, result_type="success",
            framework="crewai",
            inferred_verb=infer_verb(action),
            inferred_risk_hints=hints, is_read_only=read_only,
        ))
    return callback


def extract_tools_from_crew(crew) -> list:
    """Extract ArceoToolSchema from all agents in a Crew."""
    schemas = []
    seen = set()
    agents = getattr(crew, "agents", [])
    for agent in agents:
        for t in getattr(agent, "tools", []):
            name = getattr(t, "name", str(t))
            if name in seen:
                continue
            seen.add(name)
            tool, action = parse_tool_name(name)
            schemas.append(ArceoToolSchema(
                tool_name=tool, action_name=action,
                description=getattr(t, "description", ""),
                framework_metadata={"agent_role": getattr(agent, "role", "")},
            ))
    return schemas
