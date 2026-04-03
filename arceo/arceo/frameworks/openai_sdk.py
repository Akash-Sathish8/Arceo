"""OpenAI interceptor — captures function calls from chat completions."""

from __future__ import annotations

import json
import time
import functools
from arceo.models import ArceoToolCall, ArceoLLMCall, ArceoTrace, ArceoToolSchema
from arceo.parser import parse_tool_name
from arceo.analysis.risk import infer_risk, infer_verb


def capture_completion(response, trace: ArceoTrace, model: str = "", duration_ms: float = 0):
    """Capture tool calls and LLM usage from an OpenAI ChatCompletion."""
    had_tool = False

    if hasattr(response, "choices"):
        for choice in response.choices:
            msg = getattr(choice, "message", choice)
            tool_calls = getattr(msg, "tool_calls", None)
            if not tool_calls:
                continue
            had_tool = True
            for tc in tool_calls:
                fn = tc.function
                tool, action = parse_tool_name(fn.name)
                try:
                    args = json.loads(fn.arguments) if isinstance(fn.arguments, str) else fn.arguments
                except (json.JSONDecodeError, TypeError):
                    args = {"raw": str(fn.arguments)}
                hints, read_only = infer_risk(tool, action, list(args.keys()))
                tc_obj = ArceoToolCall(
                    tool_name=tool, action_name=action,
                    arguments=args, argument_keys=list(args.keys()),
                    framework="openai", model_used=model,
                    inferred_verb=infer_verb(action),
                    inferred_risk_hints=hints, is_read_only=read_only,
                )
                trace.tool_calls.append(tc_obj)
                if trace._on_tool_call:
                    trace._on_tool_call(tc_obj)

    # LLM call record
    usage = getattr(response, "usage", None)
    in_tok = getattr(usage, "prompt_tokens", 0) if usage else 0
    out_tok = getattr(usage, "completion_tokens", 0) if usage else 0
    resp_model = getattr(response, "model", model)
    trace.llm_calls.append(ArceoLLMCall(
        model=str(resp_model), duration_ms=duration_ms,
        input_tokens=in_tok, output_tokens=out_tok, had_tool_use=had_tool,
    ))


def extract_tools_from_openai(tools_param) -> list:
    """Extract ArceoToolSchema from the tools= param passed to create()."""
    schemas = []
    if not tools_param:
        return schemas
    for t in tools_param:
        fn = t.get("function", t) if isinstance(t, dict) else t
        if not isinstance(fn, dict):
            continue
        name = fn.get("name", "")
        tool, action = parse_tool_name(name)
        schemas.append(ArceoToolSchema(
            tool_name=tool, action_name=action,
            description=fn.get("description", ""),
            parameters=fn.get("parameters", {}),
            framework_metadata={"original_name": name},
        ))
    return schemas


def patch_openai(trace: ArceoTrace) -> list:
    """Monkey-patch openai.chat.completions.create to intercept responses."""
    patches = []
    try:
        from openai.resources.chat import completions
        original = completions.Completions.create

        @functools.wraps(original)
        def patched(self, *args, **kwargs):
            # Extract tool schemas from the tools param
            tools_param = kwargs.get("tools")
            if tools_param and not trace.available_tools:
                trace.available_tools = extract_tools_from_openai(tools_param)

            start = time.time()
            result = original(self, *args, **kwargs)
            duration = (time.time() - start) * 1000

            model = kwargs.get("model", "")
            capture_completion(result, trace, model=model, duration_ms=duration)
            return result

        completions.Completions.create = patched
        patches.append((completions.Completions, "create", original))
    except (ImportError, AttributeError):
        pass
    return patches
