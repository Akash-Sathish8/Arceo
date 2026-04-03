"""Trace replay — evaluate historical traces against current policies.

Accepts traces in multiple formats:
  - LangSmith Run export (run_type, name, inputs, outputs, start_time)
  - LangFuse span export (name, input, output, startTime)
  - Simple format [{tool, action, params, result, timestamp}]

For each action in the trace, runs it through the policy engine
exactly as if it were a live enforcement check. Returns what the
policy would have decided — without calling any external APIs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class ReplayStep:
    """One action from the trace with the policy decision overlaid."""
    original_tool: str
    original_action: str
    original_params: dict
    original_result: dict
    original_timestamp: str

    policy_decision: str         # ALLOW, BLOCK, REQUIRE_APPROVAL
    matched_policy: dict | None  # the policy that matched, if any
    risk_labels: list[str]
    is_dangerous: bool
    would_have_changed: bool     # True if the policy would have altered the outcome


@dataclass
class ReplayReport:
    agent_id: str
    total_actions: int = 0
    actions_would_allow: int = 0
    actions_would_block: int = 0
    actions_would_require_approval: int = 0
    dangerous_actions_unprotected: int = 0  # dangerous + ALLOW = gap
    steps: list[ReplayStep] = field(default_factory=list)
    policy_coverage: float = 0.0  # % of dangerous actions with policies
    replayed_at: str = ""

    def __post_init__(self):
        if not self.replayed_at:
            self.replayed_at = datetime.utcnow().isoformat()


# ── Format detection and normalization ───────────────────────────────────

def _normalize_traces(raw_traces: list[dict]) -> list[dict]:
    """Normalize traces from any supported format into a standard shape.

    Returns: [{"tool": str, "action": str, "params": dict, "result": dict, "timestamp": str}]
    """
    normalized = []

    for entry in raw_traces:
        # Detect format and extract fields
        step = _try_langsmith(entry) or _try_langfuse(entry) or _try_simple(entry)
        if step:
            normalized.append(step)

    return normalized


def _try_langsmith(entry: dict) -> dict | None:
    """Parse LangSmith Run export format.

    LangSmith runs have: id, name, run_type, inputs, outputs, start_time, end_time
    Tool runs have run_type="tool", name=tool_name, inputs=args, outputs=result
    """
    run_type = entry.get("run_type")
    if run_type != "tool":
        # Also accept chain/llm runs that contain tool calls in outputs
        if run_type in ("chain", "llm", "agent"):
            return _extract_tool_from_langsmith_chain(entry)
        return None

    name = entry.get("name", "")
    tool, action = _parse_tool_name(name)

    inputs = entry.get("inputs", {})
    if isinstance(inputs, str):
        inputs = {"input": inputs}

    outputs = entry.get("outputs", {})
    if isinstance(outputs, str):
        outputs = {"output": outputs}

    timestamp = entry.get("start_time", entry.get("start_time", ""))
    if isinstance(timestamp, (int, float)):
        timestamp = datetime.fromtimestamp(timestamp).isoformat()

    return {
        "tool": tool,
        "action": action,
        "params": inputs,
        "result": outputs,
        "timestamp": str(timestamp),
    }


def _extract_tool_from_langsmith_chain(entry: dict) -> dict | None:
    """Extract tool call from a LangSmith chain/agent run's outputs."""
    outputs = entry.get("outputs", {})
    if not isinstance(outputs, dict):
        return None

    # LangChain agent outputs sometimes contain tool call info
    tool_calls = outputs.get("tool_calls", [])
    if tool_calls and isinstance(tool_calls, list):
        tc = tool_calls[0]  # take first tool call
        name = tc.get("name", tc.get("function", {}).get("name", ""))
        tool, action = _parse_tool_name(name)
        args = tc.get("args", tc.get("function", {}).get("arguments", {}))
        if isinstance(args, str):
            import json
            try:
                args = json.loads(args)
            except (ValueError, TypeError):
                args = {"raw": args}
        return {
            "tool": tool, "action": action, "params": args,
            "result": {}, "timestamp": str(entry.get("start_time", "")),
        }

    return None


def _try_langfuse(entry: dict) -> dict | None:
    """Parse LangFuse span export format.

    LangFuse spans have: name, input, output, startTime, endTime, type
    """
    if "startTime" not in entry and "start_time" not in entry:
        return None
    if "input" not in entry:
        return None

    name = entry.get("name", "")
    span_type = entry.get("type", "")

    # Only process tool/generation spans
    if span_type and span_type not in ("TOOL", "GENERATION", "DEFAULT"):
        return None

    tool, action = _parse_tool_name(name)

    inp = entry.get("input", {})
    if isinstance(inp, str):
        inp = {"input": inp}

    out = entry.get("output", {})
    if isinstance(out, str):
        out = {"output": out}

    timestamp = entry.get("startTime", entry.get("start_time", ""))

    return {
        "tool": tool, "action": action,
        "params": inp, "result": out,
        "timestamp": str(timestamp),
    }


def _try_simple(entry: dict) -> dict | None:
    """Parse simple format: {tool, action, params, result, timestamp}."""
    if "tool" not in entry and "action" not in entry:
        return None

    tool = entry.get("tool", "unknown")
    action = entry.get("action", entry.get("name", "unknown"))

    # Handle combined tool.action format
    if "." in action and tool == "unknown":
        parts = action.split(".", 1)
        tool, action = parts[0], parts[1]

    params = entry.get("params", entry.get("args", entry.get("arguments", {})))
    if isinstance(params, str):
        import json
        try:
            params = json.loads(params)
        except (ValueError, TypeError):
            params = {"raw": params}

    result = entry.get("result", entry.get("output", entry.get("response", {})))
    if isinstance(result, str):
        result = {"output": result}

    timestamp = entry.get("timestamp", entry.get("time", entry.get("ts", "")))

    return {
        "tool": tool, "action": action,
        "params": params if isinstance(params, dict) else {},
        "result": result if isinstance(result, dict) else {},
        "timestamp": str(timestamp),
    }


def _parse_tool_name(name: str) -> tuple[str, str]:
    """Parse tool name into (tool, action)."""
    if "__" in name:
        parts = name.split("__", 1)
        return parts[0], parts[1]
    if "." in name:
        parts = name.split(".", 1)
        return parts[0], parts[1]
    # Try service prefix split
    parts = name.split("_", 1)
    if len(parts) == 2 and len(parts[0]) > 2:
        return parts[0], parts[1]
    return "unknown", name


# ── Replay engine ────────────────────────────────────────────────────────

def replay_traces(
    agent_id: str,
    raw_traces: list[dict],
) -> ReplayReport:
    """Replay historical traces against current policies.

    No external API calls — pure policy evaluation.
    """
    from authority.risk_classifier import classify_action

    normalized = _normalize_traces(raw_traces)
    report = ReplayReport(agent_id=agent_id)

    session_context = []

    for entry in normalized:
        tool = entry["tool"]
        action = entry["action"]
        params = entry["params"]

        # Classify risk
        labels, reversible = classify_action(action, "")
        dangerous_labels = {"moves_money", "deletes_data", "sends_external", "changes_production"}
        is_dangerous = bool(set(labels) & dangerous_labels)

        # Run through policy engine
        try:
            from main import enforce_check
            result = enforce_check(
                agent_id, tool, action,
                params=params or None,
                session_context=session_context or None,
            )
            decision = result.get("decision", "ALLOW")
            matched = result.get("policy")
        except Exception:
            decision = "ALLOW"
            matched = None

        # Track session context for requires_prior
        session_context.append(f"{tool}.{action}")

        # Would this have changed the outcome?
        would_change = (decision != "ALLOW")

        step = ReplayStep(
            original_tool=tool,
            original_action=action,
            original_params=params,
            original_result=entry.get("result", {}),
            original_timestamp=entry.get("timestamp", ""),
            policy_decision=decision,
            matched_policy=matched,
            risk_labels=labels,
            is_dangerous=is_dangerous,
            would_have_changed=would_change,
        )
        report.steps.append(step)

    # Summary
    report.total_actions = len(report.steps)
    report.actions_would_allow = sum(1 for s in report.steps if s.policy_decision == "ALLOW")
    report.actions_would_block = sum(1 for s in report.steps if s.policy_decision == "BLOCK")
    report.actions_would_require_approval = sum(1 for s in report.steps if s.policy_decision == "REQUIRE_APPROVAL")

    dangerous_steps = [s for s in report.steps if s.is_dangerous]
    report.dangerous_actions_unprotected = sum(1 for s in dangerous_steps if s.policy_decision == "ALLOW")

    if dangerous_steps:
        covered = sum(1 for s in dangerous_steps if s.policy_decision != "ALLOW")
        report.policy_coverage = round((covered / len(dangerous_steps)) * 100, 1)
    else:
        report.policy_coverage = 100.0

    return report


def report_to_dict(report: ReplayReport) -> dict:
    return {
        "agent_id": report.agent_id,
        "total_actions": report.total_actions,
        "actions_would_allow": report.actions_would_allow,
        "actions_would_block": report.actions_would_block,
        "actions_would_require_approval": report.actions_would_require_approval,
        "dangerous_actions_unprotected": report.dangerous_actions_unprotected,
        "policy_coverage": report.policy_coverage,
        "replayed_at": report.replayed_at,
        "steps": [
            {
                "tool": s.original_tool,
                "action": s.original_action,
                "params": s.original_params,
                "result": s.original_result,
                "timestamp": s.original_timestamp,
                "policy_decision": s.policy_decision,
                "matched_policy": s.matched_policy,
                "risk_labels": s.risk_labels,
                "is_dangerous": s.is_dangerous,
                "would_have_changed": s.would_have_changed,
            }
            for s in report.steps
        ],
    }
