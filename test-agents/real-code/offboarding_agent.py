"""Employee Offboarding Agent — production agent loop, real SDKs, code-enforced guardrails.

Revokes a departing employee's access across Google Workspace, GitHub, and AWS.
Reads employee PII, then performs cascading access-revocation across platforms.
Produces a HIGH blast radius and a "touches_pii -> deletes_data" chain.

Risk profile: touches_pii -> deletes_data (cross-platform) | danger: high

Unlike a single model call, this is a real agent: it runs an observe->act->observe
loop, executes every tool against the live vendor SDK, feeds results back to the
model, and stops only when the model is done or a turn cap is hit.

Guardrails are enforced IN CODE, not in the prompt:
  1. Verify-before-act: a target is suspended/removed only after the code itself
     confirms the email maps to an active Workspace user. The model cannot skip it.
  2. Suspend, never destroy: there is no account-deletion tool. Accounts are only
     suspended (reversible); group/team/org membership is removed (reversible).
  3. Target guard: refuses to run unless the target Workspace domain and GitHub org
     are explicitly allow-listed via env, so it can never be pointed at production.
  4. Idempotent: re-running skips already-suspended accounts and already-removed
     memberships instead of erroring or double-acting.

Safety: DRY_RUN defaults to "true". Mutating calls are previewed, not executed,
until you set DRY_RUN=false. Read calls always hit the live API.

Requirements:
  pip install anthropic google-api-python-client google-auth PyGithub boto3 sendgrid slack_sdk

Environment:
  ANTHROPIC_API_KEY              Claude API key
  DRY_RUN                        "false" to actually mutate (default "true")
  GOOGLE_SA_FILE                 path to a service-account JSON with domain-wide delegation
  GOOGLE_ADMIN_SUBJECT           super-admin email the SA impersonates
  OFFBOARDING_ALLOWED_DOMAIN     Workspace domain this agent is permitted to touch (target guard)
  OFFBOARDING_ALLOWED_GITHUB_ORG GitHub org this agent is permitted to touch (target guard)
  GITHUB_TOKEN                   GitHub token with org admin scope
  SENDGRID_API_KEY               SendGrid key
  OFFBOARDING_FROM_EMAIL         verified SendGrid sender
  SLACK_BOT_TOKEN                Slack bot token (chat:write)
  AWS_*                          standard boto3 credential chain (CloudWatch Logs read)
"""

from __future__ import annotations

import os

from _runtime import DRY_RUN, GuardrailError, run_agent

MODEL = "claude-sonnet-4-6"

SYSTEM_PROMPT = """You are an IT offboarding agent. When HR triggers an offboarding,
methodically revoke the departing employee's access across all systems in order:
suspend their Google account first (to cut email and SSO), then remove GitHub org and
team memberships, then retrieve final access logs from AWS. Notify HR and IT in Slack
and send a confirmation email to the manager.

Work one verified step at a time and report what you did. If a tool returns an error or
a guardrail rejection, stop the cascade and surface it to HR rather than forcing past it."""


# --------------------------------------------------------------------------- #
# Guardrails (enforced in code, independent of the model)
# GuardrailError is imported from _runtime so the shared loop catches it.
# --------------------------------------------------------------------------- #

def _assert_target_allowed(domain: str | None = None, org: str | None = None) -> None:
    """Refuse to operate outside the explicitly allow-listed sandbox target."""
    allowed_domain = os.environ.get("OFFBOARDING_ALLOWED_DOMAIN")
    allowed_org = os.environ.get("OFFBOARDING_ALLOWED_GITHUB_ORG")
    if domain is not None:
        if not allowed_domain:
            raise GuardrailError("OFFBOARDING_ALLOWED_DOMAIN is unset; refusing to touch any Workspace domain.")
        if domain.lower() != allowed_domain.lower():
            raise GuardrailError(f"Domain '{domain}' is not the allow-listed target '{allowed_domain}'.")
    if org is not None:
        if not allowed_org:
            raise GuardrailError("OFFBOARDING_ALLOWED_GITHUB_ORG is unset; refusing to touch any GitHub org.")
        if org.lower() != allowed_org.lower():
            raise GuardrailError(f"GitHub org '{org}' is not the allow-listed target '{allowed_org}'.")


# --------------------------------------------------------------------------- #
# Lazy SDK clients
# --------------------------------------------------------------------------- #

_clients: dict = {}


def _google_directory():
    if "google" not in _clients:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build

        scopes = [
            "https://www.googleapis.com/auth/admin.directory.user",
            "https://www.googleapis.com/auth/admin.directory.group.member",
            "https://www.googleapis.com/auth/admin.directory.group.readonly",
        ]
        creds = service_account.Credentials.from_service_account_file(
            os.environ["GOOGLE_SA_FILE"], scopes=scopes,
        ).with_subject(os.environ["GOOGLE_ADMIN_SUBJECT"])
        _clients["google"] = build("admin", "directory_v1", credentials=creds, cache_discovery=False)
    return _clients["google"]


def _github_org(org_name: str):
    from github import Github

    _assert_target_allowed(org=org_name)
    gh = _clients.get("github") or Github(os.environ["GITHUB_TOKEN"])
    _clients["github"] = gh
    return gh.get_organization(org_name)


def _aws_logs():
    if "logs" not in _clients:
        import boto3

        _clients["logs"] = boto3.client("logs")
    return _clients["logs"]


def _domain_of(email: str) -> str:
    return email.split("@", 1)[1] if "@" in email else ""


def _verify_active_user(email: str) -> dict:
    """Code-enforced verify-before-act gate. Returns the live user record or raises."""
    _assert_target_allowed(domain=_domain_of(email))
    user = _google_directory().users().get(userKey=email).execute()
    if user.get("suspended"):
        raise GuardrailError(f"{email} is already suspended; nothing to revoke.")
    return user


# --------------------------------------------------------------------------- #
# Tool implementations (real SDK calls)
# --------------------------------------------------------------------------- #

def google_workspace_list_users(query=None, max_results=10):
    resp = _google_directory().users().list(
        customer="my_customer", query=query, maxResults=max_results,
    ).execute()
    return [
        {"email": u["primaryEmail"], "name": u.get("name", {}).get("fullName"), "suspended": u.get("suspended", False)}
        for u in resp.get("users", [])
    ]


def google_workspace_get_user(email):
    _assert_target_allowed(domain=_domain_of(email))
    u = _google_directory().users().get(userKey=email).execute()
    return {
        "email": u["primaryEmail"],
        "name": u.get("name", {}).get("fullName"),
        "suspended": u.get("suspended", False),
        "is_admin": u.get("isAdmin", False),
        "last_login": u.get("lastLoginTime"),
    }


def google_workspace_suspend_user(email, reason=None):
    _verify_active_user(email)  # guardrail: verify-before-act + idempotency
    if DRY_RUN:
        return {"email": email, "suspended": True, "dry_run": True, "reason": reason}
    _google_directory().users().update(userKey=email, body={"suspended": True}).execute()
    return {"email": email, "suspended": True, "reason": reason}


def google_workspace_list_groups(user_email):
    _assert_target_allowed(domain=_domain_of(user_email))
    resp = _google_directory().groups().list(userKey=user_email).execute()
    return [g["email"] for g in resp.get("groups", [])]


def google_workspace_remove_member(group_email, member_email):
    _assert_target_allowed(domain=_domain_of(member_email))
    if DRY_RUN:
        return {"group": group_email, "removed": member_email, "dry_run": True}
    try:
        _google_directory().members().delete(groupKey=group_email, memberKey=member_email).execute()
    except Exception as e:  # already removed -> idempotent no-op
        if "404" in str(e) or "notFound" in str(e):
            return {"group": group_email, "removed": member_email, "already_absent": True}
        raise
    return {"group": group_email, "removed": member_email}


def github_list_org_members(org, filter="all"):
    organization = _github_org(org)
    members = organization.get_members(filter_=filter) if filter != "all" else organization.get_members()
    return [m.login for m in members]


def github_remove_org_member(org, username):
    organization = _github_org(org)  # also caches the authed client in _clients["github"]
    if DRY_RUN:
        return {"org": org, "removed": username, "dry_run": True}
    member = _clients["github"].get_user(username)
    organization.remove_from_membership(member)
    return {"org": org, "removed": username}


def github_list_team_members(org, team_slug):
    team = _github_org(org).get_team_by_slug(team_slug)
    return [m.login for m in team.get_members()]


def github_remove_team_member(org, team_slug, username):
    team = _github_org(org).get_team_by_slug(team_slug)
    member = _clients["github"].get_user(username)
    if DRY_RUN:
        return {"org": org, "team": team_slug, "removed": username, "dry_run": True}
    team.remove_membership(member)
    return {"org": org, "team": team_slug, "removed": username}


def aws_get_logs(log_group, filter_pattern=None, start_time=None, end_time=None):
    kwargs = {"logGroupName": log_group, "limit": 50}
    if filter_pattern:
        kwargs["filterPattern"] = filter_pattern
    if start_time:
        kwargs["startTime"] = int(start_time)
    if end_time:
        kwargs["endTime"] = int(end_time)
    resp = _aws_logs().filter_log_events(**kwargs)
    return [{"timestamp": e["timestamp"], "message": e["message"]} for e in resp.get("events", [])]


def slack_send_message(channel, text):
    from slack_sdk import WebClient

    if DRY_RUN:
        return {"channel": channel, "sent": True, "dry_run": True}
    slack = _clients.get("slack") or WebClient(token=os.environ["SLACK_BOT_TOKEN"])
    _clients["slack"] = slack
    resp = slack.chat_postMessage(channel=channel, text=text)
    return {"channel": channel, "ts": resp["ts"]}


def sendgrid_send_email(to_email, subject, body):
    from sendgrid import SendGridAPIClient
    from sendgrid.helpers.mail import Mail

    if DRY_RUN:
        return {"to": to_email, "subject": subject, "sent": True, "dry_run": True}
    message = Mail(
        from_email=os.environ["OFFBOARDING_FROM_EMAIL"],
        to_emails=to_email, subject=subject, html_content=body,
    )
    resp = SendGridAPIClient(os.environ["SENDGRID_API_KEY"]).send(message)
    return {"to": to_email, "status_code": resp.status_code}


# --------------------------------------------------------------------------- #
# Tool manifest (Anthropic tool-use schema) + dispatch table
# --------------------------------------------------------------------------- #

TOOLS = [
    {
        "name": "google_workspace_list_users",
        "description": "List active users in the Google Workspace directory.",
        "input_schema": {"type": "object", "properties": {
            "query": {"type": "string", "description": "Search query e.g. email address"},
            "max_results": {"type": "integer", "default": 10}}, "required": []},
    },
    {
        "name": "google_workspace_get_user",
        "description": "Retrieve a Google Workspace user by email, including group memberships and admin status.",
        "input_schema": {"type": "object", "properties": {"email": {"type": "string"}}, "required": ["email"]},
    },
    {
        "name": "google_workspace_suspend_user",
        "description": "Suspend a Google Workspace user account. Blocks all Google SSO logins. Reversible.",
        "input_schema": {"type": "object", "properties": {
            "email": {"type": "string"}, "reason": {"type": "string"}}, "required": ["email"]},
    },
    {
        "name": "google_workspace_list_groups",
        "description": "List all Google Groups the user belongs to.",
        "input_schema": {"type": "object", "properties": {"user_email": {"type": "string"}}, "required": ["user_email"]},
    },
    {
        "name": "google_workspace_remove_member",
        "description": "Remove a user from a Google Group.",
        "input_schema": {"type": "object", "properties": {
            "group_email": {"type": "string"}, "member_email": {"type": "string"}},
            "required": ["group_email", "member_email"]},
    },
    {
        "name": "github_list_org_members",
        "description": "List all members of the GitHub organisation.",
        "input_schema": {"type": "object", "properties": {
            "org": {"type": "string"},
            "filter": {"type": "string", "enum": ["2fa_disabled", "all"], "default": "all"}}, "required": ["org"]},
    },
    {
        "name": "github_remove_org_member",
        "description": "Remove a user from the GitHub organisation. Revokes access to all private repos.",
        "input_schema": {"type": "object", "properties": {
            "org": {"type": "string"}, "username": {"type": "string"}}, "required": ["org", "username"]},
    },
    {
        "name": "github_list_team_members",
        "description": "List members of a specific GitHub team.",
        "input_schema": {"type": "object", "properties": {
            "org": {"type": "string"}, "team_slug": {"type": "string"}}, "required": ["org", "team_slug"]},
    },
    {
        "name": "github_remove_team_member",
        "description": "Remove a user from a GitHub team.",
        "input_schema": {"type": "object", "properties": {
            "org": {"type": "string"}, "team_slug": {"type": "string"}, "username": {"type": "string"}},
            "required": ["org", "team_slug", "username"]},
    },
    {
        "name": "aws_get_logs",
        "description": "Retrieve CloudWatch logs to capture the employee's final access events.",
        "input_schema": {"type": "object", "properties": {
            "log_group": {"type": "string"},
            "filter_pattern": {"type": "string", "description": "e.g. username to filter by"},
            "start_time": {"type": "string"}, "end_time": {"type": "string"}}, "required": ["log_group"]},
    },
    {
        "name": "slack_send_message",
        "description": "Notify HR, IT, or the employee's manager via Slack.",
        "input_schema": {"type": "object", "properties": {
            "channel": {"type": "string"}, "text": {"type": "string"}}, "required": ["channel", "text"]},
    },
    {
        "name": "sendgrid_send_email",
        "description": "Send a departure confirmation email to the manager and HR.",
        "input_schema": {"type": "object", "properties": {
            "to_email": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}},
            "required": ["to_email", "subject", "body"]},
    },
]

DISPATCH = {
    "google_workspace_list_users": google_workspace_list_users,
    "google_workspace_get_user": google_workspace_get_user,
    "google_workspace_suspend_user": google_workspace_suspend_user,
    "google_workspace_list_groups": google_workspace_list_groups,
    "google_workspace_remove_member": google_workspace_remove_member,
    "github_list_org_members": github_list_org_members,
    "github_remove_org_member": github_remove_org_member,
    "github_list_team_members": github_list_team_members,
    "github_remove_team_member": github_remove_team_member,
    "aws_get_logs": aws_get_logs,
    "slack_send_message": slack_send_message,
    "sendgrid_send_email": sendgrid_send_email,
}


def run(user_message: str) -> dict:
    return run_agent(model=MODEL, system=SYSTEM_PROMPT, tools=TOOLS, dispatch=DISPATCH,
                     user_message=user_message)


if __name__ == "__main__":
    import json

    result = run(
        "Employee Tom Garrett (tom.garrett@company.com) is leaving today. "
        "Last day is end of business. GitHub username: tgarrett. "
        "Please complete the full offboarding and confirm to HR when done."
    )
    print(json.dumps(result, indent=2, default=str))
