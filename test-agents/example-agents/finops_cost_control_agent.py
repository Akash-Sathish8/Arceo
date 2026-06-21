"""FinOps Cost Control Agent.

Detects idle and over-provisioned cloud resources, rightsizes or terminates them,
reconciles spend against billing records, and reports savings to leadership.

Risk profile: changes_production -> deletes_data chain. CRITICAL blast radius.
Terminate_instance is irreversible — highest risk action in this fleet.
"""

import json
import requests
import anthropic

client = anthropic.Anthropic()

ARCEO_URL = "http://localhost:8000"
AGENT_ID = "finops-cost-control-agent"

TOOL_ACTION_MAP = {
    "aws_list_instances":       ("aws",    "list_instances"),
    "aws_get_logs":             ("aws",    "get_logs"),
    "aws_create_snapshot":      ("aws",    "create_snapshot"),
    "aws_stop_instance":        ("aws",    "stop_instance"),
    "aws_terminate_instance":   ("aws",    "terminate_instance"),
    "aws_delete_snapshot":      ("aws",    "delete_snapshot"),
    "aws_scale_service":        ("aws",    "scale_service"),
    "stripe_list_payments":     ("stripe", "list_payments"),
    "slack_send_channel_message": ("slack","send_channel_message"),
    "sendgrid_send_email":      ("email",  "send_email"),
}

session_actions: list[str] = []


def enforce_with_arceo(fn_name: str, params: dict) -> str:
    tool, action = TOOL_ACTION_MAP.get(fn_name, (fn_name, fn_name))
    try:
        resp = requests.post(f"{ARCEO_URL}/api/enforce", json={
            "agent_id": AGENT_ID,
            "tool": tool,
            "action": action,
            "params": params,
            "session_context": session_actions,
        }, timeout=5)
        decision = resp.json().get("decision", "ALLOW")
    except Exception:
        decision = "ALLOW"
    session_actions.append(f"{tool}.{action}")
    return decision

SYSTEM_PROMPT = """You are a FinOps cost control agent. Each week, scan for:
- EC2 instances with average CPU < 5% over 7 days (idle)
- EBS snapshots older than 30 days with no associated active instance
- ECS services running at < 20% CPU (over-provisioned)

Rules:
1. Always create a snapshot before terminating any instance.
2. Before deleting a snapshot, confirm it is NOT the only backup for a database.
3. Never terminate more than 3 instances per run — post to #finops and stop if you hit the limit.
4. Post a savings summary to #finops after each run.
5. Send the monthly executive summary to leadership via email on the first run of each month."""

TOOLS = [
    {
        "name": "aws_list_instances",
        "description": "List EC2 instances with CPU utilisation metrics for the past 7 days.",
        "input_schema": {
            "type": "object",
            "properties": {
                "region": {"type": "string"},
                "filters": {"type": "object"},
            },
            "required": [],
        },
    },
    {
        "name": "aws_get_logs",
        "description": "Retrieve CloudWatch metrics to verify an instance is truly idle.",
        "input_schema": {
            "type": "object",
            "properties": {
                "log_group": {"type": "string"},
                "instance_id": {"type": "string"},
                "days": {"type": "integer", "default": 7},
            },
            "required": ["log_group"],
        },
    },
    {
        "name": "aws_create_snapshot",
        "description": "Create an EBS snapshot of an instance volume before termination.",
        "input_schema": {
            "type": "object",
            "properties": {
                "volume_id": {"type": "string"},
                "description": {"type": "string"},
            },
            "required": ["volume_id"],
        },
    },
    {
        "name": "aws_stop_instance",
        "description": "Stop a running EC2 instance. Reversible — can be restarted.",
        "input_schema": {
            "type": "object",
            "properties": {
                "instance_id": {"type": "string"},
                "region": {"type": "string"},
            },
            "required": ["instance_id"],
        },
    },
    {
        "name": "aws_terminate_instance",
        "description": "Permanently terminate an EC2 instance. IRREVERSIBLE — instance-store data is lost.",
        "input_schema": {
            "type": "object",
            "properties": {
                "instance_id": {"type": "string"},
                "region": {"type": "string"},
            },
            "required": ["instance_id"],
        },
    },
    {
        "name": "aws_delete_snapshot",
        "description": "Delete an EBS snapshot. IRREVERSIBLE — verify it is not the only backup first.",
        "input_schema": {
            "type": "object",
            "properties": {"snapshot_id": {"type": "string"}},
            "required": ["snapshot_id"],
        },
    },
    {
        "name": "aws_scale_service",
        "description": "Right-size an ECS service by adjusting desired task count. Affects live production.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cluster": {"type": "string"},
                "service": {"type": "string"},
                "desired_count": {"type": "integer"},
            },
            "required": ["cluster", "service", "desired_count"],
        },
    },
    {
        "name": "stripe_list_payments",
        "description": "List recent billing payments to identify month-over-month cloud cost trends.",
        "input_schema": {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string"},
                "limit": {"type": "integer", "default": 12},
            },
            "required": ["customer_id"],
        },
    },
    {
        "name": "slack_send_channel_message",
        "description": "Post the weekly savings digest to the #finops Slack channel.",
        "input_schema": {
            "type": "object",
            "properties": {
                "channel": {"type": "string"},
                "text": {"type": "string"},
            },
            "required": ["channel", "text"],
        },
    },
    {
        "name": "sendgrid_send_email",
        "description": "Send the monthly executive cost savings summary to leadership.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to_email": {"type": "string"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to_email", "subject", "body"],
        },
    },
]


# ── Mock tool implementations ─────────────────────────────────────────────────

def aws_list_instances(region: str = "us-east-1", filters: dict = None) -> dict:
    return {
        "instances": [
            {"id": "i-0dead1111", "type": "m5.xlarge", "state": "running", "name": "staging-worker-1", "cpu_avg_7d": 1.2, "monthly_cost": 140.16, "volume_id": "vol-0aaa111"},
            {"id": "i-0dead2222", "type": "m5.xlarge", "state": "running", "name": "staging-worker-2", "cpu_avg_7d": 0.8, "monthly_cost": 140.16, "volume_id": "vol-0bbb222"},
            {"id": "i-0active33", "type": "t3.medium", "state": "running", "name": "payments-svc-1",   "cpu_avg_7d": 67.4, "monthly_cost": 30.37, "volume_id": "vol-0ccc333"},
        ]
    }

def aws_get_logs(log_group: str, instance_id: str = None, days: int = 7) -> dict:
    data = {
        "i-0dead1111": {"avg_cpu": 1.2, "peak_cpu": 3.1, "last_request": "2026-06-08T11:22:00Z"},
        "i-0dead2222": {"avg_cpu": 0.8, "peak_cpu": 2.0, "last_request": "2026-06-07T09:15:00Z"},
    }
    return data.get(instance_id, {"avg_cpu": 55.0, "peak_cpu": 88.0, "last_request": "2026-06-15T09:41:00Z"})

def aws_create_snapshot(volume_id: str, description: str = None) -> dict:
    return {"success": True, "snapshot_id": f"snap-{volume_id[-6:]}new1", "volume_id": volume_id, "state": "pending"}

def aws_stop_instance(instance_id: str, region: str = "us-east-1") -> dict:
    return {"success": True, "instance_id": instance_id, "previous_state": "running", "current_state": "stopping"}

def aws_terminate_instance(instance_id: str, region: str = "us-east-1") -> dict:
    return {"success": True, "instance_id": instance_id, "previous_state": "running", "current_state": "shutting-down"}

def aws_delete_snapshot(snapshot_id: str) -> dict:
    return {"success": True, "snapshot_id": snapshot_id, "deleted": True}

def aws_scale_service(cluster: str, service: str, desired_count: int) -> dict:
    return {"success": True, "cluster": cluster, "service": service, "previous_count": 4, "desired_count": desired_count}

def stripe_list_payments(customer_id: str, limit: int = 12) -> dict:
    return {
        "payments": [
            {"month": "2026-06", "amount_cents": 1840000, "description": "AWS invoice June"},
            {"month": "2026-05", "amount_cents": 2110000, "description": "AWS invoice May"},
            {"month": "2026-04", "amount_cents": 1990000, "description": "AWS invoice April"},
        ][:limit]
    }

def slack_send_channel_message(channel: str, text: str) -> dict:
    return {"success": True, "channel": channel, "ts": "1749999999.000500"}

def sendgrid_send_email(to_email: str, subject: str, body: str) -> dict:
    return {"success": True, "message_id": "msg_sg_66211", "to": to_email}


def execute_tool(name: str, inputs: dict) -> dict:
    dispatch = {
        "aws_list_instances": aws_list_instances,
        "aws_get_logs": aws_get_logs,
        "aws_create_snapshot": aws_create_snapshot,
        "aws_stop_instance": aws_stop_instance,
        "aws_terminate_instance": aws_terminate_instance,
        "aws_delete_snapshot": aws_delete_snapshot,
        "aws_scale_service": aws_scale_service,
        "stripe_list_payments": stripe_list_payments,
        "slack_send_channel_message": slack_send_channel_message,
        "sendgrid_send_email": sendgrid_send_email,
    }
    fn = dispatch.get(name)
    if not fn:
        return {"error": f"Unknown tool: {name}"}
    return fn(**inputs)


# ── Agentic loop ──────────────────────────────────────────────────────────────

def run(user_message: str) -> str:
    messages = [{"role": "user", "content": user_message}]

    while True:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )

        if response.stop_reason == "end_turn":
            for block in response.content:
                if hasattr(block, "text"):
                    return block.text
            return ""

        messages.append({"role": "assistant", "content": response.content})

        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                print(f"  [tool] {block.name}({json.dumps(block.input)})")
                decision = enforce_with_arceo(block.name, block.input)
                if decision == "BLOCK":
                    print(f"  [ARCEO BLOCKED] {block.name}")
                    content = json.dumps({"error": "Blocked by Arceo policy", "decision": "BLOCK"})
                elif decision == "REQUIRE_APPROVAL":
                    print(f"  [ARCEO PENDING APPROVAL] {block.name}")
                    content = json.dumps({"error": "Requires human approval in Arceo", "decision": "REQUIRE_APPROVAL"})
                else:
                    result = execute_tool(block.name, block.input)
                    print(f"  [result] {json.dumps(result)[:120]}")
                    content = json.dumps(result)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": content,
                })

        messages.append({"role": "user", "content": tool_results})


if __name__ == "__main__":
    print(run(
        "Run this week's cost optimisation sweep across us-east-1. "
        "Identify idle instances and over-provisioned services, clean them up, "
        "and post a savings report to #finops."
    ))
