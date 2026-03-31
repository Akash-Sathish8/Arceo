"""Vanilla interceptor — @arceo.tool decorator for custom agent loops."""

from __future__ import annotations

import time
import functools
from arceo.models import ArceoToolCall, ArceoToolSchema
from arceo.parser import parse_tool_name
from arceo.analysis.risk import infer_risk, infer_verb
from arceo.tracing.context import get_trace

_registered_tools = {}


def tool(service="", risk="", name=""):
    """Decorator that registers a function as a monitored tool.

    @arceo.tool(service="stripe", risk="moves_money")
    def create_refund(customer_id, amount):
        ...
    """
    def decorator(fn):
        tool_name = name or fn.__name__
        _registered_tools[tool_name] = {"service": service, "risk": risk, "fn": fn}

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            trace = get_trace()
            t, a = parse_tool_name(tool_name)
            if service:
                t = service

            call_args = kwargs.copy()
            if args:
                import inspect
                try:
                    sig = inspect.signature(fn)
                    params = list(sig.parameters.keys())
                    for i, v in enumerate(args):
                        if i < len(params):
                            call_args[params[i]] = v
                except (ValueError, TypeError):
                    pass

            hints, read_only = infer_risk(t, a, list(call_args.keys()))
            if risk and risk not in hints:
                hints.append(risk)

            start = time.time()
            try:
                result = fn(*args, **kwargs)
                duration = (time.time() - start) * 1000
                result_str = str(result)[:500] if result else ""

                if trace:
                    trace.tool_calls.append(ArceoToolCall(
                        tool_name=t, action_name=a,
                        arguments=call_args, argument_keys=list(call_args.keys()),
                        result_summary=result_str, result_type="success",
                        duration_ms=duration, framework="vanilla",
                        inferred_verb=infer_verb(a),
                        inferred_risk_hints=hints, is_read_only=read_only,
                    ))
                return result
            except Exception as e:
                duration = (time.time() - start) * 1000
                if trace:
                    trace.tool_calls.append(ArceoToolCall(
                        tool_name=t, action_name=a,
                        arguments=call_args, result_summary=str(e)[:500],
                        result_type="error", duration_ms=duration, framework="vanilla",
                        inferred_verb=infer_verb(a),
                        inferred_risk_hints=hints, is_read_only=read_only,
                    ))
                raise

        wrapper._arceo_tool = True
        wrapper._arceo_schema = ArceoToolSchema(
            tool_name=service or parse_tool_name(tool_name)[0],
            action_name=parse_tool_name(tool_name)[1],
            description=fn.__doc__ or "",
            framework_metadata={"risk_hint": risk},
        )
        return wrapper
    return decorator


def get_registered_schemas() -> list:
    """Get ArceoToolSchema for all @tool-decorated functions."""
    schemas = []
    for name, info in _registered_tools.items():
        t, a = parse_tool_name(name)
        if info["service"]:
            t = info["service"]
        schemas.append(ArceoToolSchema(
            tool_name=t, action_name=a,
            framework_metadata={"risk_hint": info["risk"]},
        ))
    return schemas
