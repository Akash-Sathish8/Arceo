"""ActionGate wrapper for Microsoft AutoGen agents."""

from __future__ import annotations

import json
from typing import Any

from actiongate.client import ActionGateClient


def create_autogen_function(gate: ActionGateClient, tool_name: str, action_name: str, description: str = "") -> dict:
    """Create an AutoGen-compatible function definition that routes through ActionGate.

    AutoGen uses function maps — a dict of {function_name: callable}.
    This creates both the function definition and the callable.

    Usage:
        func_def, func_impl = create_autogen_function(gate, "stripe", "create_refund", "Issue refund")

        # Register with AutoGen
        assistant.register_for_llm(description=func_def["description"])(func_impl)
        user_proxy.register_for_execution()(func_impl)
    """
    func_name = f"{tool_name}__{action_name}"

    def func_impl(**kwargs) -> str:
        result = gate.call_tool(tool_name, action_name, kwargs)
        return json.dumps(result)

    func_impl.__name__ = func_name
    func_impl.__doc__ = description or f"{tool_name}.{action_name}"

    func_def = {
        "name": func_name,
        "description": description or f"{tool_name}.{action_name}",
    }

    return func_def, func_impl


def create_autogen_functions(gate: ActionGateClient, tools: list[dict]) -> list[tuple[dict, callable]]:
    """Create AutoGen functions for a list of tool definitions.

    tools format: [{"tool": "stripe", "action": "create_refund", "description": "..."}]

    Usage:
        functions = create_autogen_functions(gate, [
            {"tool": "stripe", "action": "get_customer", "description": "Look up customer"},
            {"tool": "stripe", "action": "create_refund", "description": "Issue refund"},
        ])
        for func_def, func_impl in functions:
            assistant.register_for_llm(description=func_def["description"])(func_impl)
    """
    return [
        create_autogen_function(gate, t["tool"], t["action"], t.get("description", ""))
        for t in tools
    ]


def wrap_autogen_function_map(function_map: dict[str, callable], gate: ActionGateClient) -> dict[str, callable]:
    """Wrap an existing AutoGen function map to route through ActionGate.

    Usage:
        original_map = {"stripe__get_customer": get_customer_fn, ...}
        wrapped_map = wrap_autogen_function_map(original_map, gate)
    """
    wrapped = {}
    for name, fn in function_map.items():
        if "__" in name:
            tool, action = name.split("__", 1)
        else:
            tool, action = name, name

        def make_wrapper(t, a):
            def wrapper(**kwargs) -> str:
                result = gate.call_tool(t, a, kwargs)
                return json.dumps(result)
            wrapper.__name__ = name
            return wrapper

        wrapped[name] = make_wrapper(tool, action)

    return wrapped
