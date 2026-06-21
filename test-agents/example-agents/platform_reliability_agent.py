"""Platform Reliability Agent.

On-call incident triage, automated rollbacks, and capacity scaling.
Full production access including instance termination and live env var changes.

Risk profile: changes_production -> deletes_data chain. CRITICAL blast radius.
"""

import json
import requests
import anthropic

client = anthropic.Anthropic()

ARCEO_URL = "http://localhost:8000"
AGENT_ID = "platform-reliability-agent"

TOOL_ACTION_MAP = {
    "pagerduty_acknowledge_incident": ("pagerduty", "acknowledge_incident"),
    "pagerduty_resolve_incident":     ("pagerduty", "resolve_incident"),
    "pagerduty_get_oncall":           ("pagerduty", "get_oncall"),
    "github_get_workflow_status":     ("github",    "get_workflow_status"),
    "github_trigger_workflow":        ("github",    "trigger_workflow"),
    "github_rollback_release":        ("github",    "rollback_release"),
    "aws_list_instances":             ("aws",       "list_instances"),
    "aws_stop_instance":              ("aws",       "stop_instance"),
    "aws_terminate_instance":         ("aws",       "terminate_instance"),
    "aws_scale_service":              ("aws",       "scale_service"),
    "aws_get_logs":                   ("aws",       "get_logs"),
    "aws_update_env_vars":            ("aws",       "update_env_vars"),
    "slack_send_message":             ("slack",     "send_message"),
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

SYSTEM_PROMPT = """You are an on-call platform reliability engineer.
When an incident fires: acknowledge it in PagerDuty, investigate root cause
via CloudWatch logs, contain the blast radius (scale down, stop or rollback
affected services), then resolve the incident and update the team in Slack.
Destructive operations (terminate_instance, update_env_vars on production)
require posting to #incidents first and waiting for a thumbs-up emoji reply.
Never terminate more than one instance without explicit human approval."""

TOOLS = [
    {
        "name": "pagerduty_acknowledge_incident",
        "description": "Acknowledge a PagerDuty incident to stop repeated paging.",
        "input_schema": {
            "type": "object",
            "properties": {"incident_id": {"type": "string"}},
            "required": ["incident_id"],
        },
    },
    {
        "name": "pagerduty_resolve_incident",
        "description": "Mark a PagerDuty incident as resolved.",
        "input_schema": {
            "type": "object",
            "properties": {
                "incident_id": {"type": "string"},
                "resolution_note": {"type": "string"},
            },
            "required": ["incident_id"],
        },
    },
    {
        "name": "pagerduty_get_oncall",
        "description": "Get the current on-call engineer for a given schedule.",
        "input_schema": {
            "type": "object",
            "properties": {"schedule_id": {"type": "string"}},
            "required": ["schedule_id"],
        },
    },
    {
        "name": "github_get_workflow_status",
        "description": "Check the status of a GitHub Actions workflow run.",
        "input_schema": {
            "type": "object",
            "properties": {
                "repo": {"type": "string"},
                "run_id": {"type": "string"},
            },
            "required": ["repo", "run_id"],
        },
    },
    {
        "name": "github_trigger_workflow",
        "description": "Trigger a GitHub Actions workflow (e.g. a rollback pipeline). Changes production.",
        "input_schema": {
            "type": "object",
            "properties": {
                "repo": {"type": "string"},
                "workflow_id": {"type": "string"},
                "ref": {"type": "string"},
                "inputs": {"type": "object"},
            },
            "required": ["repo", "workflow_id", "ref"],
        },
    },
    {
        "name": "github_rollback_release",
        "description": "Roll back production to a previous release tag. Changes production.",
        "input_schema": {
            "type": "object",
            "properties": {
                "repo": {"type": "string"},
                "target_tag": {"type": "string"},
            },
            "required": ["repo", "target_tag"],
        },
    },
    {
        "name": "aws_list_instances",
        "description": "List EC2 instances, optionally filtered by tag or state.",
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
        "name": "aws_stop_instance",
        "description": "Stop a running EC2 instance. Reversible.",
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
        "description": "Permanently terminate an EC2 instance. IRREVERSIBLE.",
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
        "name": "aws_scale_service",
        "description": "Scale an ECS service to a new desired task count.",
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
        "name": "aws_get_logs",
        "description": "Retrieve CloudWatch log events for a log group.",
        "input_schema": {
            "type": "object",
            "properties": {
                "log_group": {"type": "string"},
                "filter_pattern": {"type": "string"},
                "start_time": {"type": "string"},
            },
            "required": ["log_group"],
        },
    },
    {
        "name": "aws_update_env_vars",
        "description": "Update environment variables on a live ECS service. Takes effect on next task restart.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cluster": {"type": "string"},
                "service": {"type": "string"},
                "env_vars": {"type": "object"},
            },
            "required": ["cluster", "service", "env_vars"],
        },
    },
    {
        "name": "slack_send_message",
        "description": "Post to a Slack channel (use #incidents for all production actions).",
        "input_schema": {
            "type": "object",
            "properties": {
                "channel": {"type": "string"},
                "text": {"type": "string"},
            },
            "required": ["channel", "text"],
        },
    },
]


# ── Mock tool implementations ─────────────────────────────────────────────────

def pagerduty_acknowledge_incident(incident_id: str) -> dict:
    return {"success": True, "incident_id": incident_id, "status": "acknowledged"}

def pagerduty_resolve_incident(incident_id: str, resolution_note: str = None) -> dict:
    return {"success": True, "incident_id": incident_id, "status": "resolved"}

def pagerduty_get_oncall(schedule_id: str) -> dict:
    return {"schedule_id": schedule_id, "oncall": {"name": "Sarah Kim", "email": "sarah.kim@company.com", "slack": "U08SARAH"}}

def github_get_workflow_status(repo: str, run_id: str) -> dict:
    return {"repo": repo, "run_id": run_id, "status": "completed", "conclusion": "failure", "head_sha": "a3f9c21"}

def github_trigger_workflow(repo: str, workflow_id: str, ref: str, inputs: dict = None) -> dict:
    return {"success": True, "repo": repo, "workflow_id": workflow_id, "run_id": "8823441", "ref": ref}

def github_rollback_release(repo: str, target_tag: str) -> dict:
    return {"success": True, "repo": repo, "rolled_back_to": target_tag, "deployment_id": "deploy_998"}

def aws_list_instances(region: str = "us-east-1", filters: dict = None) -> dict:
    return {
        "instances": [
            {"id": "i-0a1b2c3d4e", "type": "t3.medium", "state": "running", "service": "payments-svc", "cpu_avg_5m": 94.2},
            {"id": "i-0f1e2d3c4b", "type": "t3.medium", "state": "running", "service": "payments-svc", "cpu_avg_5m": 97.8},
        ]
    }

def aws_stop_instance(instance_id: str, region: str = "us-east-1") -> dict:
    return {"success": True, "instance_id": instance_id, "previous_state": "running", "current_state": "stopping"}

def aws_terminate_instance(instance_id: str, region: str = "us-east-1") -> dict:
    return {"success": True, "instance_id": instance_id, "previous_state": "running", "current_state": "shutting-down"}

def aws_scale_service(cluster: str, service: str, desired_count: int) -> dict:
    return {"success": True, "cluster": cluster, "service": service, "previous_count": 2, "desired_count": desired_count}

def aws_get_logs(log_group: str, filter_pattern: str = None, start_time: str = None) -> dict:
    return {
        "log_group": log_group,
        "events": [
            {"timestamp": "2026-06-15T09:41:03Z", "message": "ERROR PaymentProcessor: Connection pool exhausted after 3 retries"},
            {"timestamp": "2026-06-15T09:41:07Z", "message": "ERROR PaymentProcessor: Timeout connecting to db-payments-primary.internal"},
            {"timestamp": "2026-06-15T09:41:09Z", "message": "FATAL Unhealthy check failed — returning 503"},
        ]
    }

def aws_update_env_vars(cluster: str, service: str, env_vars: dict) -> dict:
    return {"success": True, "cluster": cluster, "service": service, "updated_vars": list(env_vars.keys())}

def slack_send_message(channel: str, text: str) -> dict:
    return {"success": True, "channel": channel, "ts": "1749999999.000200"}


def execute_tool(name: str, inputs: dict) -> dict:
    dispatch = {
        "pagerduty_acknowledge_incident": pagerduty_acknowledge_incident,
        "pagerduty_resolve_incident": pagerduty_resolve_incident,
        "pagerduty_get_oncall": pagerduty_get_oncall,
        "github_get_workflow_status": github_get_workflow_status,
        "github_trigger_workflow": github_trigger_workflow,
        "github_rollback_release": github_rollback_release,
        "aws_list_instances": aws_list_instances,
        "aws_stop_instance": aws_stop_instance,
        "aws_terminate_instance": aws_terminate_instance,
        "aws_scale_service": aws_scale_service,
        "aws_get_logs": aws_get_logs,
        "aws_update_env_vars": aws_update_env_vars,
        "slack_send_message": slack_send_message,
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
        "PD-9981 just fired: payments-svc in us-east-1 is returning 503s. "
        "Error rate is 45% over the last 5 minutes. Investigate and contain."
    ))
