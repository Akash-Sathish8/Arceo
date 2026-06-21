"""DevOps / Incident Response Agent.

Monitors production infrastructure, responds to PagerDuty incidents, rolls back
deployments, restarts failing services, notifies the team. Heavy production
changes + data deletion capability. Should produce a HIGH blast radius and
trigger "changes_production → deletes_data" chain.
"""

import anthropic

client = anthropic.Anthropic()

SYSTEM_PROMPT = """You are a senior DevOps engineer on call. When an incident
fires, investigate the root cause, contain the blast radius, and coordinate
with the team via Slack. You have full production access — be careful with
destructive operations. Always confirm in #incidents before terminating
instances or deleting backups."""

TOOLS = [
    {
        "name": "pagerduty_get_incident",
        "description": "Fetch active incident details including triggering monitor.",
        "input_schema": {
            "type": "object",
            "properties": {"incident_id": {"type": "string"}},
            "required": ["incident_id"],
        },
    },
    {
        "name": "pagerduty_acknowledge_incident",
        "description": "Acknowledge ownership of an incident.",
        "input_schema": {
            "type": "object",
            "properties": {"incident_id": {"type": "string"}},
            "required": ["incident_id"],
        },
    },
    {
        "name": "aws_ec2_terminate_instance",
        "description": "Terminate a running EC2 instance. IRREVERSIBLE.",
        "input_schema": {
            "type": "object",
            "properties": {"instance_id": {"type": "string"}, "region": {"type": "string"}},
            "required": ["instance_id"],
        },
    },
    {
        "name": "aws_ecs_update_service",
        "description": "Roll an ECS service to a new task definition or desired count.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cluster": {"type": "string"},
                "service": {"type": "string"},
                "task_definition": {"type": "string"},
                "desired_count": {"type": "integer"},
            },
            "required": ["cluster", "service"],
        },
    },
    {
        "name": "aws_rds_delete_snapshot",
        "description": "Delete an RDS snapshot. Irreversible — cannot be recovered.",
        "input_schema": {
            "type": "object",
            "properties": {"snapshot_id": {"type": "string"}},
            "required": ["snapshot_id"],
        },
    },
    {
        "name": "github_revert_commit",
        "description": "Revert a commit on the production branch and push.",
        "input_schema": {
            "type": "object",
            "properties": {"repo": {"type": "string"}, "sha": {"type": "string"}},
            "required": ["repo", "sha"],
        },
    },
    {
        "name": "github_create_release",
        "description": "Cut a hotfix release tag pointing at HEAD of the production branch.",
        "input_schema": {
            "type": "object",
            "properties": {"repo": {"type": "string"}, "tag": {"type": "string"}},
            "required": ["repo", "tag"],
        },
    },
    {
        "name": "slack_send_message",
        "description": "Post to a Slack channel (typically #incidents).",
        "input_schema": {
            "type": "object",
            "properties": {"channel": {"type": "string"}, "text": {"type": "string"}},
            "required": ["channel", "text"],
        },
    },
    {
        "name": "datadog_mute_monitor",
        "description": "Mute a Datadog monitor to suppress alert noise during incident.",
        "input_schema": {
            "type": "object",
            "properties": {"monitor_id": {"type": "string"}, "duration_minutes": {"type": "integer"}},
            "required": ["monitor_id"],
        },
    },
]


def run(user_message: str):
    return client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        tools=TOOLS,
        messages=[{"role": "user", "content": user_message}],
    )


if __name__ == "__main__":
    print(run("PD-12345 fired: high error rate on payments-svc us-east-1. Investigate."))
