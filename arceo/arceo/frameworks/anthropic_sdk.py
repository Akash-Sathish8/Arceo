"""Anthropic interceptor — captures tool_use blocks from Messages responses."""

from __future__ import annotations

import time
import functools
from arceo.models import ArceoToolCall, ArceoLLMCall, ArceoTrace, ArceoToolSchema
from arceo.parser import parse_tool_name
from arceo.analysis.risk import infer_risk, infer_verb


def capture_message(response, trace: ArceoTrace, model: str = "", duration_ms: float = 0):
    """Capture tool calls and LLM usage from an Anthropic Messages response."""
    had_tool = False

    if hasattr(response, "content"):
        for block in response.content:
            if getattr(block, "type", None) != "tool_use":
                continue
            had_tool = True
            tool, action = parse_tool_name(block.name)
            args = block.input if isinstance(block.input, dict) else {}
            hints, read_only = infer_risk(tool, action, list(args.keys()))
            tc_obj = ArceoToolCall(
                tool_name=tool, action_name=action,
                arguments=args, argument_keys=list(args.keys()),
                framework="anthropic", model_used=model,
                inferred_verb=infer_verb(action),
                inferred_risk_hints=hints, is_read_only=read_only,
            )
            trace.tool_calls.append(tc_obj)
            if trace._on_tool_call:
                trace._on_tool_call(tc_obj)

    usage = getattr(response, "usage", None)
    in_tok = getattr(usage, "input_tokens", 0) if usage else 0
    out_tok = getattr(usage, "output_tokens", 0) if usage else 0
    resp_model = getattr(response, "model", model)
    trace.llm_calls.append(ArceoLLMCall(
        model=str(resp_model), duration_ms=duration_ms,
        input_tokens=in_tok, output_tokens=out_tok, had_tool_use=had_tool,
    ))


def extract_tools_from_anthropic(tools_param) -> list:
    """Extract ArceoToolSchema from the tools= param passed to create()."""
    schemas = []
    if not tools_param:
        return schemas
    for t in tools_param:
        if not isinstance(t, dict):
            continue
        name = t.get("name", "")
        tool, action = parse_tool_name(name)
        schemas.append(ArceoToolSchema(
            tool_name=tool, action_name=action,
            description=t.get("description", ""),
            parameters=t.get("input_schema", {}),
            framework_metadata={"original_name": name},
        ))
    return schemas


def patch_anthropic(trace: ArceoTrace) -> list:
    """Monkey-patch anthropic.messages.create to intercept responses."""
    patches = []
    try:
        from anthropic.resources import messages
        original = messages.Messages.create

        @functools.wraps(original)
        def patched(self, *args, **kwargs):
            tools_param = kwargs.get("tools")
            if tools_param and not trace.available_tools:
                trace.available_tools = extract_tools_from_anthropic(tools_param)

            start = time.time()
            result = original(self, *args, **kwargs)
            duration = (time.time() - start) * 1000

            model = kwargs.get("model", "")
            capture_message(result, trace, model=model, duration_ms=duration)
            return result

        messages.Messages.create = patched
        patches.append((messages.Messages, "create", original))
    except (ImportError, AttributeError):
        pass
    return patches
