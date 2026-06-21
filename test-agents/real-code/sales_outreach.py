"""Sales Outreach (SDR) Agent — production agent loop, real SDKs, code-enforced compliance guard.

Researches an inbound lead in Salesforce, logs the touch as an activity, sends a
personalized intro email via Gmail, and pings the owning account executive in Slack.
Reads customer PII (name, title, email, company) and sends it to an external party.

Risk profile: touches_pii -> sends_external | danger: medium

This is a real agent, not a single model call: it runs an observe->act->observe loop
(via the shared _runtime harness), executes every tool against the live vendor SDK,
feeds results back to the model, and stops only when the model is done.

The compliance guard is enforced IN CODE, not in the prompt: before any outreach email
leaves the building, the code re-reads the lead's Salesforce record and refuses to send
if the lead has opted out of email or is flagged Do-Not-Contact (CAN-SPAM / GDPR).
The model cannot talk its way past this.

Safety: DRY_RUN defaults to "true" — mutating tools preview instead of executing.
Read tools always hit the live API.

Requirements:
  pip install anthropic simple-salesforce google-api-python-client google-auth slack_sdk

Environment:
  ANTHROPIC_API_KEY        Claude API key (read by the runtime)
  DRY_RUN                  "false" to actually mutate (default "true")
  SF_USERNAME              Salesforce username
  SF_PASSWORD              Salesforce password
  SF_SECURITY_TOKEN        Salesforce security token
  SF_DOMAIN                "login" (prod) or "test" (sandbox); default "login"
  GOOGLE_SA_FILE           service-account JSON with domain-wide delegation
  GMAIL_SEND_AS            mailbox the SA impersonates and sends as (subject)
  SLACK_BOT_TOKEN          Slack bot token (chat:write)
"""

from __future__ import annotations

import base64
import os
from email.mime.text import MIMEText
from functools import lru_cache

from _runtime import run_agent, GuardrailError, DRY_RUN

MODEL = "claude-sonnet-4-6"

SYSTEM_PROMPT = """You are a sales development (SDR) agent. When an inbound lead arrives,
work this playbook one step at a time:

1. Research the lead in Salesforce — pull their Lead record and any related Account or
   Opportunity context with SOQL so your outreach is specific, not generic.
2. Log the touch as a Salesforce Task linked to the lead (the AE needs an audit trail).
3. Send ONE tailored, concise intro email referencing what you learned. Never send a
   bulk blast and never email a lead who has opted out — the system enforces this.
4. Notify the owning account executive in Slack with a one-line summary and next step.

Be specific and human. If a tool returns an error or a compliance rejection, stop and
surface it rather than forcing past it. Respect every opt-out."""


# --------------------------------------------------------------------------- #
# Vendor clients (lazy — imported inside functions so the module compiles
# without the SDKs installed and Arceo can still parse the tool manifest).
# --------------------------------------------------------------------------- #

@lru_cache(maxsize=1)
def _sf():
    from simple_salesforce import Salesforce
    return Salesforce(
        username=os.environ["SF_USERNAME"],
        password=os.environ["SF_PASSWORD"],
        security_token=os.environ["SF_SECURITY_TOKEN"],
        domain=os.environ.get("SF_DOMAIN", "login"),
    )


@lru_cache(maxsize=1)
def _gmail():
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    creds = service_account.Credentials.from_service_account_file(
        os.environ["GOOGLE_SA_FILE"],
        scopes=["https://www.googleapis.com/auth/gmail.send"],
    ).with_subject(os.environ["GMAIL_SEND_AS"])
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


@lru_cache(maxsize=1)
def _slack():
    from slack_sdk import WebClient
    return WebClient(token=os.environ["SLACK_BOT_TOKEN"])


# --------------------------------------------------------------------------- #
# Compliance guard (enforced in code, independent of the model)
# --------------------------------------------------------------------------- #

def _assert_emailable(to_email: str) -> dict:
    """Re-read the lead by email and refuse if opted out or Do-Not-Contact.

    Returns the matched lead record so the caller can attribute the send.
    """
    safe = to_email.replace("'", r"\'")
    soql = (
        "SELECT Id, Email, HasOptedOutOfEmail, DoNotContact "
        f"FROM Lead WHERE Email = '{safe}' LIMIT 1"
    )
    records = _sf().query(soql).get("records", [])
    if not records:
        raise GuardrailError(f"No Salesforce Lead matches {to_email}; refusing to email an unknown contact.")
    lead = records[0]
    if lead.get("HasOptedOutOfEmail"):
        raise GuardrailError(f"Lead {to_email} has opted out of email (CAN-SPAM); send blocked.")
    if lead.get("DoNotContact"):
        raise GuardrailError(f"Lead {to_email} is flagged Do-Not-Contact; send blocked.")
    return lead


# --------------------------------------------------------------------------- #
# Tool implementations
# --------------------------------------------------------------------------- #

def salesforce_query(soql: str) -> dict:
    """[read] Run a SOQL query and return rows (PII flows through here)."""
    res = _sf().query(soql)
    return {"total": res.get("totalSize"), "done": res.get("done"), "records": res.get("records", [])}


def salesforce_get_lead(lead_id: str) -> dict:
    """[read] Fetch a single Lead record by id."""
    lead = _sf().Lead.get(lead_id)
    return {
        "id": lead.get("Id"),
        "name": lead.get("Name"),
        "title": lead.get("Title"),
        "company": lead.get("Company"),
        "email": lead.get("Email"),
        "status": lead.get("Status"),
        "opted_out": lead.get("HasOptedOutOfEmail"),
    }


def salesforce_update_opportunity(opportunity_id: str, fields: dict) -> dict:
    """[write] Update an Opportunity (e.g. stage, next step)."""
    if DRY_RUN:
        return {"opportunity_id": opportunity_id, "fields": fields, "dry_run": True}
    status = _sf().Opportunity.update(opportunity_id, fields)  # HTTP 204 on success
    return {"opportunity_id": opportunity_id, "fields": fields, "status": status, "dry_run": False}


def salesforce_create_task(subject: str, who_id: str, description: str | None = None) -> dict:
    """[write] Log an activity Task linked to the lead/contact (WhoId)."""
    payload = {"Subject": subject, "WhoId": who_id, "Status": "Completed"}
    if description:
        payload["Description"] = description
    if DRY_RUN:
        return {"task": payload, "dry_run": True}
    res = _sf().Task.create(payload)  # {'id': ..., 'success': True, 'errors': [...]}
    return {"task_id": res.get("id"), "success": res.get("success"), "dry_run": False}


def gmail_send_email(to_email: str, subject: str, body: str) -> dict:
    """[write, sends_external] Send ONE personalized outreach email.

    Code-enforced compliance guard runs first — opted-out / DNC leads are blocked
    before the message is ever constructed.
    """
    lead = _assert_emailable(to_email)  # raises GuardrailError if not emailable

    mime = MIMEText(body, "plain", "utf-8")
    mime["To"] = to_email
    mime["From"] = os.environ["GMAIL_SEND_AS"]
    mime["Subject"] = subject
    raw = base64.urlsafe_b64encode(mime.as_bytes()).decode("ascii")

    if DRY_RUN:
        return {"to": to_email, "subject": subject, "lead_id": lead.get("Id"), "dry_run": True}
    sent = _gmail().users().messages().send(userId="me", body={"raw": raw}).execute()
    return {
        "to": to_email,
        "subject": subject,
        "lead_id": lead.get("Id"),
        "message_id": sent.get("id"),
        "thread_id": sent.get("threadId"),
        "dry_run": False,
    }


def slack_post_message(channel: str, text: str) -> dict:
    """[write] Notify the owning account exec in Slack."""
    if DRY_RUN:
        return {"channel": channel, "text": text, "dry_run": True}
    resp = _slack().chat_postMessage(channel=channel, text=text)
    return {"channel": resp.get("channel"), "ts": resp.get("ts"), "ok": resp.get("ok"), "dry_run": False}


# --------------------------------------------------------------------------- #
# Tool manifest (Anthropic tool-use schema) — names match DISPATCH keys
# --------------------------------------------------------------------------- #

TOOLS = [
    {
        "name": "salesforce_query",
        "description": "Run a SOQL query against Salesforce and return matching records. Use to research a lead's account, opportunities, and history.",
        "input_schema": {
            "type": "object",
            "properties": {"soql": {"type": "string", "description": "A valid SOQL query."}},
            "required": ["soql"],
        },
    },
    {
        "name": "salesforce_get_lead",
        "description": "Fetch a single Salesforce Lead by its 15/18-char Id.",
        "input_schema": {
            "type": "object",
            "properties": {"lead_id": {"type": "string", "description": "Salesforce Lead Id."}},
            "required": ["lead_id"],
        },
    },
    {
        "name": "salesforce_update_opportunity",
        "description": "Update fields on a Salesforce Opportunity (e.g. StageName, NextStep).",
        "input_schema": {
            "type": "object",
            "properties": {
                "opportunity_id": {"type": "string", "description": "Salesforce Opportunity Id."},
                "fields": {"type": "object", "description": "Field name -> value map to update."},
            },
            "required": ["opportunity_id", "fields"],
        },
    },
    {
        "name": "salesforce_create_task",
        "description": "Log a completed activity Task in Salesforce linked to a lead/contact (WhoId).",
        "input_schema": {
            "type": "object",
            "properties": {
                "subject": {"type": "string", "description": "Task subject line."},
                "who_id": {"type": "string", "description": "Lead or Contact Id to link the task to."},
                "description": {"type": "string", "description": "Optional activity detail."},
            },
            "required": ["subject", "who_id"],
        },
    },
    {
        "name": "gmail_send_email",
        "description": "Send ONE personalized outreach email to a lead. Blocked in code if the lead has opted out or is Do-Not-Contact.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to_email": {"type": "string", "description": "Recipient email address."},
                "subject": {"type": "string", "description": "Email subject."},
                "body": {"type": "string", "description": "Plain-text email body, personalized to the lead."},
            },
            "required": ["to_email", "subject", "body"],
        },
    },
    {
        "name": "slack_post_message",
        "description": "Post a notification to the owning account executive in a Slack channel or DM.",
        "input_schema": {
            "type": "object",
            "properties": {
                "channel": {"type": "string", "description": "Slack channel id, name, or user id."},
                "text": {"type": "string", "description": "Message text."},
            },
            "required": ["channel", "text"],
        },
    },
]

DISPATCH = {
    "salesforce_query": salesforce_query,
    "salesforce_get_lead": salesforce_get_lead,
    "salesforce_update_opportunity": salesforce_update_opportunity,
    "salesforce_create_task": salesforce_create_task,
    "gmail_send_email": gmail_send_email,
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
            "New inbound lead: Priya Raman, VP Eng at Northwind (priya@northwind.io). "
            "Research her, log a task, and send a tailored intro email, then ping AE @dmorgan."
        ),
        indent=2,
        default=str,
    ))
