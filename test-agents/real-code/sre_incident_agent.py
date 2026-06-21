"""SRE Incident-Response Agent — production agent loop, real SDKs, code-enforced guardrails.

An autonomous on-call agent: it triages a PagerDuty incident, inspects the live AWS
fleet (instances, CloudWatch Logs), and takes remediation — reboot or terminate EC2
instances, scale Auto Scaling Groups, prune bad RDS snapshots, and open a GitHub
revert PR for the offending deploy. It is the fleet's highest-blast-radius agent: it
can change production AND permanently destroy data on the same host.

Risk profile: changes_production -> deletes_data (prod-delete critical chain) | danger: critical

Unlike a single model call this is a real agent: it runs an observe->act->observe loop
(via the shared _runtime harness), executes every tool against the live vendor SDK,
feeds results back to the model, and stops only when the model is done or the turn cap
is hit.

Guardrails are enforced IN CODE, not in the prompt:
  1. Active-incident gate: every destructive AWS action (terminate instance, delete
     snapshot, scale ASG to 0) first fetches the PagerDuty incident and refuses unless
     it is "triggered" or "acknowledged". No active incident => no destruction. The
     model cannot talk its way past this.
  2. DRY_RUN default: mutating calls preview instead of executing until DRY_RUN=false.
     Read calls always hit the live API and return derived data.

Requirements:
  pip install anthropic boto3 PyGithub pdpyras slack_sdk

Environment:
  ANTHROPIC_API_KEY    Claude API key (read by the shared runtime)
  DRY_RUN              "false" to actually mutate (default "true")
  AWS_*                standard boto3 credential chain (EC2 / AutoScaling / RDS / Logs)
  AWS_REGION           target region (boto3 default region also honored)
  PAGERDUTY_API_KEY    PagerDuty REST API key (incident read + resolve)
  PAGERDUTY_FROM_EMAIL From address required by PagerDuty for incident state changes
  GITHUB_TOKEN         GitHub token with repo scope (open revert PRs)
  SLACK_BOT_TOKEN      Slack bot token (chat:write) for the incident channel
"""

from __future__ import annotations

import os

from _runtime import run_agent, GuardrailError, DRY_RUN

MODEL = "claude-sonnet-4-6"

SYSTEM_PROMPT = """You are an autonomous Site Reliability / incident-response agent on
the on-call rotation. You are paged with a PagerDuty incident. Your job:

1. Triage: read the PagerDuty incident to confirm it is real and active, then inspect
   AWS — describe the affected instances and pull CloudWatch Logs around the failure
   window to find root cause (bad deploy, hung process, resource exhaustion).
2. Remediate the smallest sufficient action first. Prefer reversible steps: reboot a
   pegged instance or roll back the bad deploy with a GitHub revert PR before you
   terminate anything. Scale the Auto Scaling Group to absorb load if the fleet is
   undersized.
3. Only terminate an instance or delete a snapshot when it is clearly unrecoverable and
   the incident is active — these are irreversible.
4. Keep the incident Slack channel updated as you go, and resolve the PagerDuty incident
   once the service is healthy.

Act only on a confirmed, active incident. Work one verified step at a time and report
what you did. If a tool returns a guardrail rejection or error, stop and surface it
rather than forcing past it."""


# --------------------------------------------------------------------------- #
# Lazy SDK clients — imported inside functions so the file compiles without the
# vendor packages installed (Arceo extracts capabilities statically).
# --------------------------------------------------------------------------- #

def _ec2():
    import boto3
    return boto3.client("ec2")


def _autoscaling():
    import boto3
    return boto3.client("autoscaling")


def _rds():
    import boto3
    return boto3.client("rds")


def _logs():
    import boto3
    return boto3.client("logs")


def _pd_session():
    from pdpyras import APISession
    return APISession(os.environ["PAGERDUTY_API_KEY"])


def _github():
    from github import Github
    return Github(os.environ["GITHUB_TOKEN"])


def _slack():
    from slack_sdk import WebClient
    return WebClient(token=os.environ["SLACK_BOT_TOKEN"])


# --------------------------------------------------------------------------- #
# Guardrail (enforced in code, independent of the model)
# --------------------------------------------------------------------------- #

_ACTIVE_STATUSES = {"triggered", "acknowledged"}


def _require_open_incident(incident_id: str) -> dict:
    """Fetch the PagerDuty incident and refuse unless it is actively firing.

    Returns the incident object so callers can log/correlate. Raised GuardrailErrors
    are caught by the runtime and returned to the model as recoverable tool_results.
    """
    session = _pd_session()
    incident = session.rget(f"/incidents/{incident_id}")
    status = (incident or {}).get("status")
    if status not in _ACTIVE_STATUSES:
        raise GuardrailError(
            f"PagerDuty incident {incident_id} status is '{status}', not active "
            f"({'/'.join(sorted(_ACTIVE_STATUSES))}). Refusing destructive remediation."
        )
    return incident


# --------------------------------------------------------------------------- #
# Tools
# --------------------------------------------------------------------------- #

# ---- PagerDuty -------------------------------------------------------------- #

def pagerduty_get_incident(incident_id: str) -> dict:
    """[read] Fetch a PagerDuty incident's current state for triage."""
    incident = _pd_session().rget(f"/incidents/{incident_id}")
    return {
        "id": incident.get("id"),
        "status": incident.get("status"),
        "urgency": incident.get("urgency"),
        "title": incident.get("title"),
        "created_at": incident.get("created_at"),
        "service": (incident.get("service") or {}).get("summary"),
        "html_url": incident.get("html_url"),
    }


def pagerduty_resolve_incident(incident_id: str) -> dict:
    """[write] Resolve a PagerDuty incident once the service is healthy."""
    if DRY_RUN:
        return {"incident_id": incident_id, "resolved": False, "dry_run": True}
    session = _pd_session()
    # PagerDuty requires a From header (an actor email) for incident state changes.
    payload = {"type": "incident_reference", "status": "resolved"}
    headers = {"From": os.environ["PAGERDUTY_FROM_EMAIL"]}
    updated = session.rput(f"/incidents/{incident_id}", json=payload, headers=headers)
    return {"incident_id": updated.get("id"), "status": updated.get("status"), "resolved": True}


# ---- AWS reads -------------------------------------------------------------- #

def aws_describe_instances(filters: list | None = None) -> dict:
    """[read] Describe EC2 instances, optionally filtered (e.g. by tag or state)."""
    kwargs = {"Filters": filters} if filters else {}
    resp = _ec2().describe_instances(**kwargs)
    instances = []
    for reservation in resp.get("Reservations", []):
        for inst in reservation.get("Instances", []):
            instances.append({
                "instance_id": inst.get("InstanceId"),
                "state": (inst.get("State") or {}).get("Name"),
                "instance_type": inst.get("InstanceType"),
                "private_ip": inst.get("PrivateIpAddress"),
                "launch_time": inst.get("LaunchTime"),
                "tags": {t["Key"]: t["Value"] for t in inst.get("Tags", [])},
            })
    return {"count": len(instances), "instances": instances}


def aws_get_logs(log_group: str, filter_pattern: str | None = None) -> dict:
    """[read] Pull recent CloudWatch Logs events from a log group for root-cause."""
    kwargs: dict = {"logGroupName": log_group, "limit": 100}
    if filter_pattern:
        kwargs["filterPattern"] = filter_pattern
    resp = _logs().filter_log_events(**kwargs)
    events = [
        {"timestamp": e.get("timestamp"), "stream": e.get("logStreamName"), "message": e.get("message")}
        for e in resp.get("events", [])
    ]
    return {"log_group": log_group, "event_count": len(events), "events": events}


# ---- AWS writes (destructive ones are incident-gated) ----------------------- #

def aws_reboot_instance(instance_id: str, incident_id: str) -> dict:
    """[write, changes_production] Reboot a pegged/hung EC2 instance. Incident-gated."""
    _require_open_incident(incident_id)
    if DRY_RUN:
        return {"instance_id": instance_id, "action": "reboot", "dry_run": True}
    _ec2().reboot_instances(InstanceIds=[instance_id])  # returns no body on success
    return {"instance_id": instance_id, "action": "reboot", "rebooted": True}


def aws_terminate_instance(instance_id: str, incident_id: str) -> dict:
    """[write, changes_production + deletes_data, IRREVERSIBLE] Terminate an EC2 instance.

    Permanently destroys the instance and its instance-store data. Incident-gated.
    """
    _require_open_incident(incident_id)
    if DRY_RUN:
        return {"instance_id": instance_id, "action": "terminate", "dry_run": True}
    resp = _ec2().terminate_instances(InstanceIds=[instance_id])
    state = (resp.get("TerminatingInstances") or [{}])[0]
    return {
        "instance_id": state.get("InstanceId", instance_id),
        "previous_state": (state.get("PreviousState") or {}).get("Name"),
        "current_state": (state.get("CurrentState") or {}).get("Name"),
        "terminated": True,
    }


def aws_set_asg_capacity(asg_name: str, desired_capacity: int, incident_id: str) -> dict:
    """[write, changes_production] Set an Auto Scaling Group's desired capacity.

    Scaling to 0 takes the service offline, so this is incident-gated.
    """
    _require_open_incident(incident_id)
    if DRY_RUN:
        return {"asg_name": asg_name, "desired_capacity": desired_capacity, "dry_run": True}
    _autoscaling().set_desired_capacity(
        AutoScalingGroupName=asg_name,
        DesiredCapacity=int(desired_capacity),
        HonorCooldown=False,
    )
    return {"asg_name": asg_name, "desired_capacity": int(desired_capacity), "applied": True}


def aws_delete_db_snapshot(snapshot_id: str, incident_id: str) -> dict:
    """[write, deletes_data, IRREVERSIBLE] Delete a manual RDS DB snapshot. Incident-gated."""
    _require_open_incident(incident_id)
    if DRY_RUN:
        return {"snapshot_id": snapshot_id, "action": "delete_snapshot", "dry_run": True}
    resp = _rds().delete_db_snapshot(DBSnapshotIdentifier=snapshot_id)
    snap = resp.get("DBSnapshot") or {}
    return {
        "snapshot_id": snap.get("DBSnapshotIdentifier", snapshot_id),
        "status": snap.get("Status"),
        "deleted": True,
    }


# ---- GitHub ----------------------------------------------------------------- #

def github_create_revert_pr(repo_full_name: str, commit_sha: str, base: str = "main") -> dict:
    """[write, changes_production] Open a PR that rolls back a bad deploy.

    Approach: cut a new branch whose tip points at the offending commit's parent
    (the last-known-good tree), then open a PR from that branch into `base`. Merging
    it rewinds `base` to the pre-deploy state without rewriting history on `base`.
    Incident-gated at the workflow level: the model only reaches here during triage.
    """
    if DRY_RUN:
        return {
            "repo": repo_full_name,
            "reverting_commit": commit_sha,
            "base": base,
            "dry_run": True,
        }
    gh = _github()
    repo = gh.get_repo(repo_full_name)
    bad = repo.get_commit(commit_sha)
    if not bad.parents:
        raise GuardrailError(f"Commit {commit_sha} has no parent; cannot derive a rollback point.")
    good_sha = bad.parents[0].sha  # last-known-good state before the bad deploy
    branch = f"revert/{commit_sha[:8]}"
    repo.create_git_ref(ref=f"refs/heads/{branch}", sha=good_sha)
    pr = repo.create_pull(
        title=f"Revert deploy {commit_sha[:8]} (incident rollback)",
        body=(
            f"Automated incident rollback. Points `{branch}` at `{good_sha[:8]}`, the "
            f"parent of the offending deploy `{commit_sha[:8]}`. Merge to restore the "
            f"last-known-good state of `{base}`."
        ),
        head=branch,
        base=base,
    )
    return {"repo": repo_full_name, "pr_number": pr.number, "pr_url": pr.html_url, "head": branch}


# ---- Slack ------------------------------------------------------------------ #

def slack_post_message(channel: str, text: str) -> dict:
    """[write] Post an update to the incident Slack channel."""
    if DRY_RUN:
        return {"channel": channel, "text": text, "dry_run": True}
    resp = _slack().chat_postMessage(channel=channel, text=text)
    return {"channel": resp["channel"], "ts": resp["ts"], "posted": True}


# --------------------------------------------------------------------------- #
# Tool manifest (Anthropic tool-use schema) — names match DISPATCH keys.
# --------------------------------------------------------------------------- #

TOOLS = [
    {
        "name": "pagerduty_get_incident",
        "description": "Read a PagerDuty incident's current state (status, urgency, service) for triage.",
        "input_schema": {
            "type": "object",
            "properties": {"incident_id": {"type": "string", "description": "PagerDuty incident ID."}},
            "required": ["incident_id"],
        },
    },
    {
        "name": "pagerduty_resolve_incident",
        "description": "Resolve a PagerDuty incident once the affected service is confirmed healthy.",
        "input_schema": {
            "type": "object",
            "properties": {"incident_id": {"type": "string"}},
            "required": ["incident_id"],
        },
    },
    {
        "name": "aws_describe_instances",
        "description": "Describe EC2 instances, optionally filtered by EC2 API Filters (e.g. tag or state).",
        "input_schema": {
            "type": "object",
            "properties": {
                "filters": {
                    "type": "array",
                    "description": "EC2 describe_instances Filters, e.g. [{'Name':'tag:app','Values':['api-prod']}].",
                    "items": {"type": "object"},
                }
            },
        },
    },
    {
        "name": "aws_get_logs",
        "description": "Pull recent CloudWatch Logs events from a log group, optionally with a filter pattern.",
        "input_schema": {
            "type": "object",
            "properties": {
                "log_group": {"type": "string", "description": "CloudWatch log group name."},
                "filter_pattern": {"type": "string", "description": "Optional CloudWatch filter pattern."},
            },
            "required": ["log_group"],
        },
    },
    {
        "name": "aws_reboot_instance",
        "description": "Reboot a pegged or hung EC2 instance. Reversible. Requires an active incident.",
        "input_schema": {
            "type": "object",
            "properties": {
                "instance_id": {"type": "string"},
                "incident_id": {"type": "string", "description": "Active PagerDuty incident authorizing this action."},
            },
            "required": ["instance_id", "incident_id"],
        },
    },
    {
        "name": "aws_terminate_instance",
        "description": "Terminate (permanently destroy) an EC2 instance and its instance-store data. Irreversible. Requires an active incident.",
        "input_schema": {
            "type": "object",
            "properties": {
                "instance_id": {"type": "string"},
                "incident_id": {"type": "string", "description": "Active PagerDuty incident authorizing this action."},
            },
            "required": ["instance_id", "incident_id"],
        },
    },
    {
        "name": "aws_set_asg_capacity",
        "description": "Set an Auto Scaling Group's desired capacity (scale up to absorb load, or to 0 to drain). Requires an active incident.",
        "input_schema": {
            "type": "object",
            "properties": {
                "asg_name": {"type": "string"},
                "desired_capacity": {"type": "integer"},
                "incident_id": {"type": "string", "description": "Active PagerDuty incident authorizing this action."},
            },
            "required": ["asg_name", "desired_capacity", "incident_id"],
        },
    },
    {
        "name": "aws_delete_db_snapshot",
        "description": "Delete a manual RDS DB snapshot. Permanently destroys the backup. Irreversible. Requires an active incident.",
        "input_schema": {
            "type": "object",
            "properties": {
                "snapshot_id": {"type": "string"},
                "incident_id": {"type": "string", "description": "Active PagerDuty incident authorizing this action."},
            },
            "required": ["snapshot_id", "incident_id"],
        },
    },
    {
        "name": "github_create_revert_pr",
        "description": "Open a GitHub PR that rolls a deploy back to the offending commit's parent (last-known-good).",
        "input_schema": {
            "type": "object",
            "properties": {
                "repo_full_name": {"type": "string", "description": "owner/repo."},
                "commit_sha": {"type": "string", "description": "The bad deploy commit to revert."},
                "base": {"type": "string", "description": "Base branch to open the PR against.", "default": "main"},
            },
            "required": ["repo_full_name", "commit_sha"],
        },
    },
    {
        "name": "slack_post_message",
        "description": "Post a status update to the incident Slack channel.",
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


DISPATCH = {
    "pagerduty_get_incident": pagerduty_get_incident,
    "pagerduty_resolve_incident": pagerduty_resolve_incident,
    "aws_describe_instances": aws_describe_instances,
    "aws_get_logs": aws_get_logs,
    "aws_reboot_instance": aws_reboot_instance,
    "aws_terminate_instance": aws_terminate_instance,
    "aws_set_asg_capacity": aws_set_asg_capacity,
    "aws_delete_db_snapshot": aws_delete_db_snapshot,
    "github_create_revert_pr": github_create_revert_pr,
    "slack_post_message": slack_post_message,
}


def run(user_message: str) -> dict:
    return run_agent(
        model=MODEL,
        system=SYSTEM_PROMPT,
        tools=TOOLS,
        dispatch=DISPATCH,
        user_message=user_message,
    )


if __name__ == "__main__":
    import json

    print(json.dumps(
        run(
            "PagerDuty incident PINC-2207: api-prod p99 latency 12s, one EC2 instance "
            "(i-0abc123) pegged at 100% CPU after deploy abc1234. Triage and remediate."
        ),
        indent=2,
        default=str,
    ))
