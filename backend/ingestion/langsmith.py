"""LangSmith trace ingestion.

Accepts LangSmith's run export format:
  {id, name, run_type, inputs, outputs, start_time, end_time, extra, error, tags}

Only processes run_type="tool" runs. Extracts tool name from the run name,
arguments from inputs, results from outputs.

Example curl:
    curl -X POST localhost:8000/api/ingest/langsmith \\
      -H "Authorization: Bearer $TOKEN" \\
      -H "Content-Type: application/json" \\
      -d '{
        "agent_name": "My Support Agent",
        "runs": [
          {"id": "run_1", "name": "stripe__get_customer", "run_type": "tool",
           "inputs": {"customer_id": "cus_123"}, "outputs": {"name": "Jane", "email": "jane@test.com"},
           "start_time": "2026-04-01T10:00:00Z", "end_time": "2026-04-01T10:00:01Z"},
          {"id": "run_2", "name": "stripe__create_refund", "run_type": "tool",
           "inputs": {"payment_id": "pi_456", "amount": 200}, "outputs": {"refund_id": "ref_1"},
           "start_time": "2026-04-01T10:00:02Z", "end_time": "2026-04-01T10:00:03Z"},
          {"id": "run_3", "name": "email__send_email", "run_type": "tool",
           "inputs": {"to": "jane@test.com", "body": "Refund processed"}, "outputs": {"sent": true},
           "start_time": "2026-04-01T10:00:04Z", "end_time": "2026-04-01T10:00:04.5Z"}
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
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts).isoformat()
    return str(ts)


def _duration_ms(start, end) -> float:
    if not start or not end:
        return 0.0
    try:
        if isinstance(start, str) and isinstance(end, str):
            s = datetime.fromisoformat(start.replace("Z", "+00:00"))
            e = datetime.fromisoformat(end.replace("Z", "+00:00"))
            return (e - s).total_seconds() * 1000
    except (ValueError, TypeError):
        pass
    return 0.0


def normalize_langsmith(runs: list[dict]) -> list[dict]:
    """Normalize LangSmith run export into our internal format.

    Filters to run_type="tool". Also extracts tool calls from chain/agent runs
    that have tool_calls in their outputs.
    """
    normalized = []

    for run in runs:
        run_type = run.get("run_type", "")

        if run_type == "tool":
            name = run.get("name", "unknown")
            tool, action = _parse_tool_name(name)

            inputs = run.get("inputs", {})
            if isinstance(inputs, str):
                inputs = {"input": inputs}

            outputs = run.get("outputs", {})
            if isinstance(outputs, str):
                outputs = {"output": outputs}

            normalized.append({
                "tool": tool,
                "action": action,
                "params": inputs,
                "result": outputs,
                "timestamp": _parse_timestamp(run.get("start_time")),
                "duration_ms": _duration_ms(run.get("start_time"), run.get("end_time")),
            })

        elif run_type in ("chain", "llm", "agent"):
            # Extract tool calls from outputs if present
            outputs = run.get("outputs", {})
            if isinstance(outputs, dict):
                tool_calls = outputs.get("tool_calls", [])
                for tc in tool_calls:
                    name = tc.get("name", tc.get("function", {}).get("name", ""))
                    if not name:
                        continue
                    tool, action = _parse_tool_name(name)
                    args = tc.get("args", tc.get("function", {}).get("arguments", {}))
                    if isinstance(args, str):
                        import json
                        try:
                            args = json.loads(args)
                        except (ValueError, TypeError):
                            args = {"raw": args}
                    normalized.append({
                        "tool": tool, "action": action,
                        "params": args if isinstance(args, dict) else {},
                        "result": {},
                        "timestamp": _parse_timestamp(run.get("start_time")),
                        "duration_ms": 0.0,
                    })

    return normalized
