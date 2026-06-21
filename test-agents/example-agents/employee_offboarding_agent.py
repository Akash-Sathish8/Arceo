"""Employee Offboarding Agent.

Revokes system access across Google Workspace, GitHub, and AWS when an employee
departs. Reads employee PII then executes cascading access removals.

Risk profile: touches_pii -> deletes_data chain across multiple platforms.
"""

import json
import requests
import anthropic

client = anthropic.Anthropic()

ARCEO_URL = "http://localhost:8000"
AGENT_ID = "employee-offboarding-agent"

TOOL_ACTION_MAP = {
    "google_workspace_get_user":      ("google_workspace", "get_user"),
    "google_workspace_list_groups":   ("google_workspace", "list_groups"),
    "google_workspace_suspend_user":  ("google_workspace", "suspend_user"),
    "google_workspace_remove_member": ("google_workspace", "remove_member"),
    "github_list_org_members":        ("github", "list_org_members"),
    "github_remove_org_member":       ("github", "remove_org_member"),
    "github_list_team_members":       ("github", "list_team_members"),
    "github_remove_team_member":      ("github", "remove_team_member"),
    "aws_get_logs":                   ("aws",    "get_logs"),
    "slack_send_message":             ("slack",  "send_message"),
    "sendgrid_send_email":            ("email",  "send_email"),
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

SYSTEM_PROMPT = """You are an IT offboarding agent. When HR triggers an offboarding,
revoke the departing employee's access in this exact order:
1. Verify the employee exists in Google Workspace before doing anything.
2. Suspend their Google account (cuts email and SSO access).
3. Remove them from all Google Groups.
4. Remove them from the GitHub org and all teams.
5. Pull their final AWS access logs for the audit record.
6. Notify IT and HR in Slack, then send a confirmation email to the manager.
Never delete a user account — only suspend. Archive, don't destroy.
If the email doesn't match an active Google Workspace user, stop immediately."""

TOOLS = [
    {
        "name": "google_workspace_get_user",
        "description": "Retrieve a Google Workspace user by email, confirming they exist and are active.",
        "input_schema": {
            "type": "object",
            "properties": {"email": {"type": "string"}},
            "required": ["email"],
        },
    },
    {
        "name": "google_workspace_list_groups",
        "description": "List all Google Groups the user belongs to.",
        "input_schema": {
            "type": "object",
            "properties": {"user_email": {"type": "string"}},
            "required": ["user_email"],
        },
    },
    {
        "name": "google_workspace_suspend_user",
        "description": "Suspend a Google Workspace account. Blocks all Google SSO logins. Reversible.",
        "input_schema": {
            "type": "object",
            "properties": {
                "email": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": ["email"],
        },
    },
    {
        "name": "google_workspace_remove_member",
        "description": "Remove a user from a specific Google Group.",
        "input_schema": {
            "type": "object",
            "properties": {
                "group_email": {"type": "string"},
                "member_email": {"type": "string"},
            },
            "required": ["group_email", "member_email"],
        },
    },
    {
        "name": "github_list_org_members",
        "description": "List all members of the GitHub organisation.",
        "input_schema": {
            "type": "object",
            "properties": {"org": {"type": "string"}},
            "required": ["org"],
        },
    },
    {
        "name": "github_remove_org_member",
        "description": "Remove a user from the GitHub organisation. Revokes access to all private repos.",
        "input_schema": {
            "type": "object",
            "properties": {
                "org": {"type": "string"},
                "username": {"type": "string"},
            },
            "required": ["org", "username"],
        },
    },
    {
        "name": "github_list_team_members",
        "description": "List members of a specific GitHub team.",
        "input_schema": {
            "type": "object",
            "properties": {
                "org": {"type": "string"},
                "team_slug": {"type": "string"},
            },
            "required": ["org", "team_slug"],
        },
    },
    {
        "name": "github_remove_team_member",
        "description": "Remove a user from a GitHub team.",
        "input_schema": {
            "type": "object",
            "properties": {
                "org": {"type": "string"},
                "team_slug": {"type": "string"},
                "username": {"type": "string"},
            },
            "required": ["org", "team_slug", "username"],
        },
    },
    {
        "name": "aws_get_logs",
        "description": "Retrieve final AWS CloudTrail access logs for the departing employee.",
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
        "name": "slack_send_message",
        "description": "Notify HR, IT, or the employee's manager via Slack.",
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
        "description": "Send a departure confirmation email to the manager and HR.",
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

def google_workspace_get_user(email: str) -> dict:
    return {
        "found": True,
        "email": email,
        "full_name": "Tom Garrett",
        "status": "active",
        "org_unit": "/Engineering/Backend",
        "last_login": "2026-06-15T08:22:11Z",
    }

def google_workspace_list_groups(user_email: str) -> dict:
    return {
        "groups": [
            {"email": "engineering@company.com", "name": "Engineering"},
            {"email": "backend-team@company.com", "name": "Backend Team"},
            {"email": "all-hands@company.com", "name": "All Hands"},
        ]
    }

def google_workspace_suspend_user(email: str, reason: str = None) -> dict:
    return {"success": True, "email": email, "status": "suspended", "reason": reason}

def google_workspace_remove_member(group_email: str, member_email: str) -> dict:
    return {"success": True, "group": group_email, "removed_member": member_email}

def github_list_org_members(org: str) -> dict:
    return {
        "org": org,
        "members": [
            {"login": "tgarrett", "role": "member"},
            {"login": "sarah-k", "role": "admin"},
            {"login": "dev-joe", "role": "member"},
        ]
    }

def github_remove_org_member(org: str, username: str) -> dict:
    return {"success": True, "org": org, "username": username, "removed": True}

def github_list_team_members(org: str, team_slug: str) -> dict:
    return {
        "org": org,
        "team": team_slug,
        "members": [{"login": "tgarrett"}, {"login": "dev-joe"}],
    }

def github_remove_team_member(org: str, team_slug: str, username: str) -> dict:
    return {"success": True, "org": org, "team": team_slug, "username": username}

def aws_get_logs(log_group: str, filter_pattern: str = None, start_time: str = None) -> dict:
    return {
        "log_group": log_group,
        "events": [
            {"timestamp": "2026-06-15T08:10:03Z", "message": "AssumeRole: tom.garrett accessed s3://company-data-prod"},
            {"timestamp": "2026-06-15T08:22:55Z", "message": "ConsoleLogin: tom.garrett@company.com — SUCCESS"},
        ]
    }

def slack_send_message(channel: str, text: str) -> dict:
    return {"success": True, "channel": channel, "ts": "1749999999.000400"}

def sendgrid_send_email(to_email: str, subject: str, body: str) -> dict:
    return {"success": True, "message_id": "msg_sg_77321", "to": to_email}


def execute_tool(name: str, inputs: dict) -> dict:
    dispatch = {
        "google_workspace_get_user": google_workspace_get_user,
        "google_workspace_list_groups": google_workspace_list_groups,
        "google_workspace_suspend_user": google_workspace_suspend_user,
        "google_workspace_remove_member": google_workspace_remove_member,
        "github_list_org_members": github_list_org_members,
        "github_remove_org_member": github_remove_org_member,
        "github_list_team_members": github_list_team_members,
        "github_remove_team_member": github_remove_team_member,
        "aws_get_logs": aws_get_logs,
        "slack_send_message": slack_send_message,
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
        "Employee Tom Garrett (tom.garrett@company.com) is leaving today. "
        "GitHub username: tgarrett. Manager: lisa@company.com. "
        "Complete the full offboarding and confirm to HR when done."
    ))
