"""Universal trace format — every framework normalizes into this."""

from __future__ import annotations

import uuid
import time
from dataclasses import dataclass, field


@dataclass
class ArceoToolCall:
    id: str = ""
    timestamp: float = 0.0
    duration_ms: float = 0.0

    tool_name: str = ""        # "stripe", "gmail", "aws_ec2"
    action_name: str = ""      # "create_refund", "send_email"
    full_operation: str = ""   # "stripe.create_refund"

    arguments: dict = field(default_factory=dict)
    argument_keys: list = field(default_factory=list)

    result_summary: str = ""
    result_type: str = "success"  # success, error, timeout, blocked

    framework: str = ""
    model_used: str = ""
    tokens_used: int = 0

    inferred_verb: str = ""
    inferred_risk_hints: list = field(default_factory=list)
    is_read_only: bool = False

    def __post_init__(self):
        if not self.id:
            self.id = uuid.uuid4().hex[:12]
        if not self.timestamp:
            self.timestamp = time.time()
        if not self.full_operation and self.tool_name and self.action_name:
            self.full_operation = f"{self.tool_name}.{self.action_name}"
        if self.arguments and not self.argument_keys:
            self.argument_keys = list(self.arguments.keys())


@dataclass
class ArceoLLMCall:
    id: str = ""
    timestamp: float = 0.0
    duration_ms: float = 0.0
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    had_tool_use: bool = False

    def __post_init__(self):
        if not self.id:
            self.id = uuid.uuid4().hex[:12]
        if not self.timestamp:
            self.timestamp = time.time()


@dataclass
class ArceoToolSchema:
    tool_name: str = ""
    action_name: str = ""
    full_operation: str = ""
    description: str = ""
    parameters: dict = field(default_factory=dict)
    framework_metadata: dict = field(default_factory=dict)

    def __post_init__(self):
        if not self.full_operation and self.tool_name and self.action_name:
            self.full_operation = f"{self.tool_name}.{self.action_name}"


@dataclass
class ArceoTrace:
    trace_id: str = ""
    agent_name: str = "unknown"
    framework: str = ""
    started_at: float = 0.0
    ended_at: float = 0.0

    tool_calls: list = field(default_factory=list)
    llm_calls: list = field(default_factory=list)
    available_tools: list = field(default_factory=list)

    total_tool_calls: int = 0
    total_llm_calls: int = 0
    total_tokens: int = 0
    total_duration_ms: float = 0.0
    unique_tools_used: list = field(default_factory=list)

    input_prompt: str = ""
    output: str = ""

    def __post_init__(self):
        if not self.trace_id:
            self.trace_id = uuid.uuid4().hex[:12]
        if not self.started_at:
            self.started_at = time.time()

    def finalize(self):
        self.ended_at = time.time()
        self.total_duration_ms = (self.ended_at - self.started_at) * 1000
        self.total_tool_calls = len(self.tool_calls)
        self.total_llm_calls = len(self.llm_calls)
        self.total_tokens = sum(c.input_tokens + c.output_tokens for c in self.llm_calls)
        self.unique_tools_used = sorted(set(tc.full_operation for tc in self.tool_calls))

    def to_api_payload(self) -> dict:
        from datetime import datetime
        return {
            "agent_name": self.agent_name,
            "prompt": self.input_prompt or "",
            "started_at": datetime.fromtimestamp(self.started_at).isoformat() if self.started_at else "",
            "completed_at": datetime.fromtimestamp(self.ended_at).isoformat() if self.ended_at else "",
            "steps": [
                {
                    "tool": tc.tool_name, "action": tc.action_name,
                    "params": tc.arguments, "result": {"summary": tc.result_summary},
                    "error": tc.result_summary if tc.result_type == "error" else None,
                    "duration_ms": tc.duration_ms,
                    "timestamp": datetime.fromtimestamp(tc.timestamp).isoformat() if tc.timestamp else "",
                }
                for tc in self.tool_calls
            ],
            "tools_detected": list(set(tc.tool_name for tc in self.tool_calls)),
        }
