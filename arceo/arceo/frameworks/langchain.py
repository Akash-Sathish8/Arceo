"""LangChain interceptor — implements BaseCallbackHandler."""

from __future__ import annotations

import time
from arceo.models import ArceoToolCall, ArceoLLMCall, ArceoTrace, ArceoToolSchema
from arceo.parser import parse_tool_name
from arceo.analysis.risk import infer_risk, infer_verb


class ArceoLangChainHandler:
    """LangChain callback handler that captures tool + LLM calls into ArceoTrace."""

    def __init__(self, trace: ArceoTrace):
        self.trace = trace
        self._pending_tools = {}
        self._pending_llms = {}

    def on_tool_start(self, serialized, input_str, *, run_id=None, **kwargs):
        name = serialized.get("name", kwargs.get("name", "unknown"))
        tool, action = parse_tool_name(name)
        args = input_str if isinstance(input_str, dict) else {"input": str(input_str)}
        hints, read_only = infer_risk(tool, action, list(args.keys()))

        self._pending_tools[str(run_id)] = {
            "tool": tool, "action": action, "args": args,
            "hints": hints, "read_only": read_only, "start": time.time(),
        }

    def on_tool_end(self, output, *, run_id=None, **kwargs):
        p = self._pending_tools.pop(str(run_id), None)
        if not p:
            return
        duration = (time.time() - p["start"]) * 1000
        result_str = str(output)[:500] if output else ""
        self.trace.tool_calls.append(ArceoToolCall(
            tool_name=p["tool"], action_name=p["action"],
            arguments=p["args"], argument_keys=list(p["args"].keys()),
            result_summary=result_str, result_type="success",
            duration_ms=duration, framework="langchain",
            inferred_verb=infer_verb(p["action"]),
            inferred_risk_hints=p["hints"], is_read_only=p["read_only"],
        ))

    def on_tool_error(self, error, *, run_id=None, **kwargs):
        p = self._pending_tools.pop(str(run_id), None)
        if not p:
            return
        duration = (time.time() - p["start"]) * 1000
        self.trace.tool_calls.append(ArceoToolCall(
            tool_name=p["tool"], action_name=p["action"],
            arguments=p["args"], result_summary=str(error)[:500],
            result_type="error", duration_ms=duration, framework="langchain",
            inferred_verb=infer_verb(p["action"]),
            inferred_risk_hints=p["hints"], is_read_only=p["read_only"],
        ))

    def on_llm_start(self, serialized, prompts, *, run_id=None, **kwargs):
        model = serialized.get("kwargs", {}).get("model_name", serialized.get("id", ["unknown"])[-1])
        self._pending_llms[str(run_id)] = {"model": str(model), "start": time.time()}

    def on_llm_end(self, response, *, run_id=None, **kwargs):
        p = self._pending_llms.pop(str(run_id), None)
        if not p:
            return
        duration = (time.time() - p["start"]) * 1000
        out_tokens = 0
        had_tool = False
        if hasattr(response, "llm_output") and response.llm_output:
            usage = response.llm_output.get("token_usage", {})
            out_tokens = usage.get("completion_tokens", 0)
        if hasattr(response, "generations"):
            for gen_list in response.generations:
                for gen in gen_list:
                    if hasattr(gen, "message") and hasattr(gen.message, "tool_calls"):
                        if gen.message.tool_calls:
                            had_tool = True
        self.trace.llm_calls.append(ArceoLLMCall(
            model=p["model"], duration_ms=duration,
            output_tokens=out_tokens, had_tool_use=had_tool,
        ))

    def on_llm_error(self, *a, **k): pass
    def on_chain_start(self, *a, **k): pass
    def on_chain_end(self, *a, **k): pass
    def on_chain_error(self, *a, **k): pass
    def on_retry(self, *a, **k): pass


def extract_tools_from_agent(agent_or_tools) -> list:
    """Extract ArceoToolSchema from a LangChain agent's tools list."""
    schemas = []
    tools = getattr(agent_or_tools, "tools", agent_or_tools)
    if not isinstance(tools, (list, tuple)):
        return schemas
    for t in tools:
        name = getattr(t, "name", str(t))
        desc = getattr(t, "description", "")
        tool, action = parse_tool_name(name)
        params = {}
        if hasattr(t, "args_schema") and t.args_schema:
            try:
                params = t.args_schema.schema()
            except Exception:
                pass
        schemas.append(ArceoToolSchema(
            tool_name=tool, action_name=action, description=desc,
            parameters=params, framework_metadata={"original_name": name},
        ))
    return schemas
