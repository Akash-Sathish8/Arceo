"""LangFuse trace ingestion.

Accepts LangFuse's trace/span export format:
  {id, name, type, input, output, startTime, endTime, metadata, statusMessage}

type can be: SPAN, GENERATION, EVENT, DEFAULT
Only processes spans that look like tool calls (type=SPAN/DEFAULT with tool-like names,
or GENERATION with tool_calls in output).

Example curl:
    curl -X POST localhost:8000/api/ingest/langfuse \\
      -H "Authorization: Bearer $TOKEN" \\
      -H "Content-Type: application/json" \\
      -d '{
        "agent_name": "My Support Agent",
        "traces": [
          {"id": "span_1", "name": "stripe__get_customer", "type": "SPAN",
           "input": {"customer_id": "cus_123"}, "output": {"name": "Jane", "email": "jane@test.com"},
           "startTime": "2026-04-01T10:00:00Z", "endTime": "2026-04-01T10:00:01Z"},
          {"id": "span_2", "name": "stripe__create_refund", "type": "SPAN",
           "input": {"payment_id": "pi_456", "amount": 200}, "output": {"refund_id": "ref_1"},
           "startTime": "2026-04-01T10:00:02Z", "endTime": "2026-04-01T10:00:03Z"},
          {"id": "span_3", "name": "email__send_email", "type": "SPAN",
           "input": {"to": "jane@test.com", "body": "Refund done"}, "output": {"sent": true},
           "startTime": "2026-04-01T10:00:04Z", "endTime": "2026-04-01T10:00:05Z"}
        ]
      }'
"""

from __future__ import annotations

from datetime import datetime


def _parse_tool_name(name: str) -> tuple[str, str]:
    if "__" in name:
        parts = name.split("__", 1)
        return parts[0], parts[1]
    if "." in name:
        parts = name.split(".", 1)
        return parts[0], parts[1]
    parts = name.split("_", 1)
    if len(parts) == 2 and len(parts[0]) > 2:
        return parts[0], parts[1]
    return "unknown", name


def _parse_timestamp(ts) -> str:
    if not ts:
        return ""
    return str(ts)


def _duration_ms(start, end) -> float:
    if not start or not end:
        return 0.0
    try:
        s = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
        e = datetime.fromisoformat(str(end).replace("Z", "+00:00"))
        return (e - s).total_seconds() * 1000
    except (ValueError, TypeError):
        return 0.0


def normalize_langfuse(traces: list[dict]) -> list[dict]:
    """Normalize LangFuse trace/span export into our internal format.

    Accepts both individual observations (spans) and full trace objects.
    If a trace object has an 'observations' array, flattens them.
    """
    normalized = []

    for entry in traces:
        # Handle full trace objects with nested observations
        observations = entry.get("observations", [])
        if observations:
            for obs in observations:
                step = _normalize_observation(obs)
                if step:
                    normalized.append(step)
            continue

        # Handle individual observation/span
        step = _normalize_observation(entry)
        if step:
            normalized.append(step)

    return normalized


def _normalize_observation(entry: dict) -> dict | None:
    """Normalize a single LangFuse observation."""
    name = entry.get("name", "")
    span_type = entry.get("type", "DEFAULT")

    # Skip non-tool types
    if span_type == "EVENT":
        return None

    # For GENERATION type, check for tool_calls in output
    if span_type == "GENERATION":
        output = entry.get("output", {})
        if isinstance(output, dict):
            tool_calls = output.get("tool_calls", [])
            if tool_calls:
                tc = tool_calls[0]
                tc_name = tc.get("name", tc.get("function", {}).get("name", ""))
                if tc_name:
                    tool, action = _parse_tool_name(tc_name)
                    args = tc.get("args", tc.get("function", {}).get("arguments", {}))
                    if isinstance(args, str):
                        import json
                        try:
                            args = json.loads(args)
                        except (ValueError, TypeError):
                            args = {"raw": args}
                    return {
                        "tool": tool, "action": action,
                        "params": args if isinstance(args, dict) else {},
                        "result": {},
                        "timestamp": _parse_timestamp(entry.get("startTime", entry.get("start_time"))),
                        "duration_ms": _duration_ms(
                            entry.get("startTime", entry.get("start_time")),
                            entry.get("endTime", entry.get("end_time")),
                        ),
                    }
        return None

    # SPAN or DEFAULT — treat as tool call
    if not name:
        return None

    tool, action = _parse_tool_name(name)

    inp = entry.get("input", {})
    if isinstance(inp, str):
        inp = {"input": inp}

    out = entry.get("output", {})
    if isinstance(out, str):
        out = {"output": out}

    return {
        "tool": tool,
        "action": action,
        "params": inp if isinstance(inp, dict) else {},
        "result": out if isinstance(out, dict) else {},
        "timestamp": _parse_timestamp(entry.get("startTime", entry.get("start_time"))),
        "duration_ms": _duration_ms(
            entry.get("startTime", entry.get("start_time")),
            entry.get("endTime", entry.get("end_time")),
        ),
    }
