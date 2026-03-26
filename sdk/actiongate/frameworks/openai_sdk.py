"""ActionGate wrapper for OpenAI SDK (client.chat.completions.create with function calling)."""

from __future__ import annotations

import json
from typing import Any

from actiongate.client import ActionGateClient


def execute_tool_calls(response: Any, gate: ActionGateClient) -> list[dict]:
    """Execute tool calls from an OpenAI response through ActionGate.

    Takes a chat.completions.create() response, finds function calls,
    routes each through ActionGate's enforce + mock layer.

    Returns a list of tool messages formatted for the next API call.

    Usage:
        response = client.chat.completions.create(...)
        if response.choices[0].message.tool_calls:
            tool_messages = execute_tool_calls(response, gate)
            messages.extend(tool_messages)
    """
    message = response.choices[0].message
    if not message.tool_calls:
        return []

    results = []
    for tc in message.tool_calls:
        name = tc.function.name
        args = json.loads(tc.function.arguments) if tc.function.arguments else {}

        # Parse tool__action name
        if "__" in name:
            tool, action = name.split("__", 1)
        else:
            tool, action = name, name

        result = gate.call_tool(tool, action, args)

        results.append({
            "role": "tool",
            "tool_call_id": tc.id,
            "content": json.dumps(result),
        })

    return results


def run_agent_loop(
    client: Any,
    gate: ActionGateClient,
    tools: list[dict],
    messages: list[dict],
    model: str = "gpt-4o",
    max_turns: int = 10,
) -> dict:
    """Run a complete OpenAI agent loop with ActionGate enforcement.

    Usage:
        from openai import OpenAI
        from actiongate.frameworks.openai_sdk import run_agent_loop

        result = run_agent_loop(
            client=OpenAI(),
            gate=ActionGateClient(agent_id="my-agent"),
            tools=my_function_definitions,
            messages=[{"role": "user", "content": "Handle this..."}],
        )
    """
    all_messages = list(messages)

    for turn in range(max_turns):
        response = client.chat.completions.create(
            model=model, tools=tools, messages=all_messages,
        )

        choice = response.choices[0]
        all_messages.append(choice.message)

        if choice.finish_reason != "tool_calls":
            break

        tool_messages = execute_tool_calls(response, gate)
        all_messages.extend(tool_messages)

    return {
        "messages": all_messages,
        "trace": gate.get_trace(),
    }
