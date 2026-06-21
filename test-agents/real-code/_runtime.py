"""Shared agent runtime for the real-code test fleet.

A real enterprise wouldn't reimplement the agent loop in every agent — it factors
out one harness and every agent imports it. This module is that harness:

  - run_agent(): the observe->act->observe loop, bounded by MAX_TURNS, terminating
    on any non-tool stop reason, plumbing tool_result blocks back to the model.
  - execute_tool(): dispatch with error handling — vendor errors and guardrail
    rejections are returned to the model as recoverable tool_results, never crashes.
  - GuardrailError: raise this from a tool to signal a code-enforced safety rule
    blocked the action (vs an unexpected failure).
  - DRY_RUN: when true (the default), mutating tools should preview instead of
    executing. Read tools always hit the live API.

Each agent file owns its SYSTEM_PROMPT, TOOLS manifest, and tool implementations,
then calls run_agent() with them. That keeps every agent a self-describing unit
for Arceo's per-file capability extraction while sharing one correct loop.
"""

from __future__ import annotations

import json
import logging
import os

import anthropic

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("agent")

DRY_RUN = os.getenv("DRY_RUN", "true").lower() != "false"
MAX_TURNS = int(os.getenv("AGENT_MAX_TURNS", "25"))

_client: anthropic.Anthropic | None = None


def _anthropic() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
    return _client


class GuardrailError(Exception):
    """Raised by a tool when a code-enforced safety rule blocks an action."""


def execute_tool(dispatch: dict, name: str, inputs: dict) -> dict:
    """Run one tool. Never raises — failures come back as structured results."""
    fn = dispatch.get(name)
    if fn is None:
        return {"ok": False, "error": f"unknown tool: {name}"}
    try:
        return {"ok": True, "result": fn(**inputs)}
    except GuardrailError as e:
        log.warning("tool %s blocked by guardrail: %s", name, e)
        return {"ok": False, "guardrail_blocked": True, "error": str(e)}
    except Exception as e:  # surface vendor/SDK errors back to the model
        log.error("tool %s failed: %s", name, e)
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def run_agent(*, model: str, system: str, tools: list, dispatch: dict,
              user_message: str, max_tokens: int = 4096) -> dict:
    """Drive an agent to completion. Returns a structured run record + audit trail."""
    messages = [{"role": "user", "content": user_message}]
    audit: list[dict] = []

    for turn in range(MAX_TURNS):
        resp = _anthropic().messages.create(
            model=model, max_tokens=max_tokens, system=system, tools=tools, messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})

        if resp.stop_reason != "tool_use":  # end_turn, max_tokens, refusal, pause_turn, ...
            text = "".join(b.text for b in resp.content if b.type == "text")
            return {"status": resp.stop_reason, "turns": turn + 1, "summary": text, "audit": audit}

        tool_results = []
        for block in resp.content:
            if block.type != "tool_use":
                continue
            outcome = execute_tool(dispatch, block.name, block.input)
            log.info("[turn %d] %s -> %s", turn + 1, block.name,
                     "ok" if outcome.get("ok") else outcome.get("error"))
            audit.append({"turn": turn + 1, "tool": block.name, "input": block.input, "outcome": outcome})
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": json.dumps(outcome, default=str),
                "is_error": not outcome.get("ok", True),
            })
        messages.append({"role": "user", "content": tool_results})

    return {"status": "max_turns_exceeded", "turns": MAX_TURNS, "audit": audit}
