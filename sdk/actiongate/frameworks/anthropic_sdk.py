"""ActionGate wrapper for raw Anthropic SDK (client.messages.create with tool_use)."""

from __future__ import annotations

import json
from typing import Any

from actiongate.client import ActionGateClient


def wrap_anthropic_client(client: Any, gate: ActionGateClient) -> Any:
    """Wrap an Anthropic client to intercept tool execution.

    This doesn't intercept the API call itself — Claude still reasons normally.
    Instead, it provides a helper to execute tool calls through ActionGate.

    Usage:
        import anthropic
        from actiongate.frameworks.anthropic_sdk import wrap_anthropic_client, execute_tool_calls

        client = anthropic.Anthropic()
        gate = ActionGateClient(agent_id="my-agent")
        wrapped = wrap_anthropic_client(client, gate)

        response = client.messages.create(model="...", tools=tools, messages=messages)
        results = execute_tool_calls(response, gate)
    """
    client._actiongate = gate
    return client


def execute_tool_calls(response: Any, gate: ActionGateClient) -> list[dict]:
    """Execute tool calls from an Anthropic response through ActionGate.

    Takes a messages.create() response, finds tool_use blocks,
    routes each through ActionGate's enforce + mock layer.

    Returns a list of tool results formatted for the next messages.create() call.

    Usage:
        response = client.messages.create(...)
        tool_results = execute_tool_calls(response, gate)
        # Feed back: messages.append({"role": "user", "content": tool_results})
    """
    results = []
    for block in response.content:
        if block.type != "tool_use":
            continue

        # Parse tool__action name
        name = block.name
        if "__" in name:
            tool, action = name.split("__", 1)
        else:
            tool, action = name, name

        params = block.input if isinstance(block.input, dict) else {}
        result = gate.call_tool(tool, action, params)

        results.append({
            "type": "tool_result",
            "tool_use_id": block.id,
            "content": json.dumps(result),
        })

    return results


def run_agent_loop(
    client: Any,
    gate: ActionGateClient,
    tools: list[dict],
    messages: list[dict],
    model: str = "claude-sonnet-4-20250514",
    system: str = "",
    max_turns: int = 10,
) -> dict:
    """Run a complete agent loop: send messages, execute tools, repeat until done.

    Returns {"messages": [...], "trace": {...}}.

    Usage:
        result = run_agent_loop(
            client=anthropic.Anthropic(),
            gate=ActionGateClient(agent_id="my-agent"),
            tools=my_tool_definitions,
            messages=[{"role": "user", "content": "Handle this ticket..."}],
        )
    """
    all_messages = list(messages)

    for turn in range(max_turns):
        kwargs = {"model": model, "max_tokens": 4096, "tools": tools, "messages": all_messages}
        if system:
            kwargs["system"] = system

        response = client.messages.create(**kwargs)

        # Record assistant message
        all_messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_of_turn":
            break

        # Execute tool calls through ActionGate
        tool_results = execute_tool_calls(response, gate)
        if tool_results:
            all_messages.append({"role": "user", "content": tool_results})

    return {
        "messages": all_messages,
        "trace": gate.get_trace(),
    }
