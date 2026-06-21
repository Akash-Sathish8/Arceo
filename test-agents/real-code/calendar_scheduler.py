"""Calendar Scheduler — an executive-assistant agent that finds meeting times and books them.

This agent reads calendars and free/busy windows for one or more attendees, books
meetings as Google Calendar events (sending invites to all attendees), patches existing
events, and posts a confirmation to a Slack channel. It is deliberately read-heavy: it
inspects availability before it ever writes, and the only outbound side effects are
calendar invites and Slack confirmations.

Risk profile: read-heavy, sends_external (calendar invites) | danger: low
"""

from __future__ import annotations

import os
import datetime as dt

from _runtime import run_agent, GuardrailError, DRY_RUN

# Cheap, low-risk model — this agent does scheduling, not anything dangerous.
MODEL = "claude-haiku-4-5"

# Calendar that the service account impersonates on behalf of the operator.
ORGANIZER_CALENDAR_ID = os.environ.get("CALENDAR_ORGANIZER", "primary")

SYSTEM_PROMPT = """You are an executive scheduling assistant for a corporate operations team.

Your job is to find meeting times that work for everyone and book them cleanly.

Operating brief:
- Always inspect availability before booking. Call calendar_freebusy (and calendar_list_events
  if you need detail) to confirm a slot is open for EVERY attendee before you create anything.
- Default meeting length is 30 minutes unless the requester says otherwise. Honor business
  hours (09:00-18:00 in the requester's timezone) and avoid lunch (12:00-13:00) when possible.
- All timestamps you pass to tools must be RFC 3339 / ISO 8601 with a timezone offset
  (e.g. 2026-06-22T14:00:00-07:00).
- Never double-book. If the chosen slot conflicts, pick the next open slot instead.
- After booking, you MAY post a short confirmation to the relevant Slack channel if one was
  named, summarizing who, what, and when.
- Be concise. Confirm the final time, attendees, and event title in your closing message."""

# ---------------------------------------------------------------------------
# Tool schemas (Anthropic tool-use format). Names MUST match DISPATCH keys.
# ---------------------------------------------------------------------------
TOOLS = [
    {
        "name": "calendar_list_events",
        "description": (
            "List events on a calendar within a time window. Read-only. Use to inspect "
            "what is already scheduled before proposing or booking a new meeting."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "calendar_id": {
                    "type": "string",
                    "description": "Calendar to read, e.g. 'primary' or a user's email.",
                },
                "time_min": {
                    "type": "string",
                    "description": "Window start, RFC 3339 (e.g. 2026-06-22T00:00:00-07:00).",
                },
                "time_max": {
                    "type": "string",
                    "description": "Window end, RFC 3339.",
                },
            },
            "required": ["calendar_id", "time_min", "time_max"],
        },
    },
    {
        "name": "calendar_freebusy",
        "description": (
            "Query free/busy intervals for one or more attendees within a window. Read-only. "
            "Use this to find an open slot that works for everyone before booking."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "attendee_emails": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Attendee email addresses to check availability for.",
                },
                "time_min": {"type": "string", "description": "Window start, RFC 3339."},
                "time_max": {"type": "string", "description": "Window end, RFC 3339."},
            },
            "required": ["attendee_emails", "time_min", "time_max"],
        },
    },
    {
        "name": "calendar_create_event",
        "description": (
            "Create a calendar event and send invites to all attendees. Write action: this "
            "sends external invitations. Only call after confirming the slot is open via "
            "calendar_freebusy."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {"type": "string", "description": "Event title."},
                "attendee_emails": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Emails to invite.",
                },
                "start": {"type": "string", "description": "Event start, RFC 3339."},
                "end": {"type": "string", "description": "Event end, RFC 3339."},
                "description": {
                    "type": "string",
                    "description": "Optional event body / agenda.",
                },
            },
            "required": ["summary", "attendee_emails", "start", "end"],
        },
    },
    {
        "name": "calendar_update_event",
        "description": (
            "Patch fields on an existing event (e.g. reschedule, change title or attendees). "
            "Write action. Provide only the fields you want to change in 'updates'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "event_id": {"type": "string", "description": "ID of the event to patch."},
                "calendar_id": {
                    "type": "string",
                    "description": "Calendar the event lives on.",
                },
                "updates": {
                    "type": "object",
                    "description": "Partial event resource, e.g. {'summary': 'New title'}.",
                },
            },
            "required": ["event_id", "calendar_id", "updates"],
        },
    },
    {
        "name": "slack_post_message",
        "description": (
            "Post a confirmation message to a Slack channel. Write action: sends a message "
            "externally to the workspace. Use to announce a booked meeting."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "channel": {
                    "type": "string",
                    "description": "Channel ID or name, e.g. '#scheduling'.",
                },
                "text": {"type": "string", "description": "Message body."},
            },
            "required": ["channel", "text"],
        },
    },
]


# ---------------------------------------------------------------------------
# Client helpers — vendor SDKs imported lazily so the module compiles without them.
# ---------------------------------------------------------------------------
def _calendar_service():
    """Build an authenticated Google Calendar client.

    Uses a service account with domain-wide delegation, impersonating the organizer
    so events are created on their calendar and invites come from them.
    """
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    scopes = ["https://www.googleapis.com/auth/calendar"]
    key_file = os.environ["GOOGLE_SERVICE_ACCOUNT_FILE"]
    subject = os.environ.get("CALENDAR_IMPERSONATE_SUBJECT")  # user to act as

    credentials = service_account.Credentials.from_service_account_file(
        key_file, scopes=scopes
    )
    if subject:
        credentials = credentials.with_subject(subject)

    return build("calendar", "v3", credentials=credentials, cache_discovery=False)


def _slack_client():
    from slack_sdk import WebClient

    return WebClient(token=os.environ["SLACK_BOT_TOKEN"])


def _is_busy(freebusy_response: dict, start: str, end: str) -> bool:
    """Return True if any calendar in a freebusy response has a busy block
    overlapping [start, end)."""
    want_start = dt.datetime.fromisoformat(start)
    want_end = dt.datetime.fromisoformat(end)
    for cal in freebusy_response.get("calendars", {}).values():
        for block in cal.get("busy", []):
            busy_start = dt.datetime.fromisoformat(block["start"])
            busy_end = dt.datetime.fromisoformat(block["end"])
            if busy_start < want_end and busy_end > want_start:
                return True
    return False


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------
def calendar_list_events(calendar_id: str, time_min: str, time_max: str) -> dict:
    """Read events on a calendar within a window."""
    service = _calendar_service()
    resp = (
        service.events()
        .list(
            calendarId=calendar_id,
            timeMin=time_min,
            timeMax=time_max,
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )
    events = [
        {
            "id": e.get("id"),
            "summary": e.get("summary"),
            "start": e.get("start", {}).get("dateTime") or e.get("start", {}).get("date"),
            "end": e.get("end", {}).get("dateTime") or e.get("end", {}).get("date"),
            "attendees": [a.get("email") for a in e.get("attendees", [])],
        }
        for e in resp.get("items", [])
    ]
    return {"calendar_id": calendar_id, "count": len(events), "events": events}


def calendar_freebusy(attendee_emails: list, time_min: str, time_max: str) -> dict:
    """Query free/busy intervals for the given attendees."""
    service = _calendar_service()
    body = {
        "timeMin": time_min,
        "timeMax": time_max,
        "items": [{"id": email} for email in attendee_emails],
    }
    resp = service.freebusy().query(body=body).execute()
    busy_by_attendee = {
        cal_id: cal.get("busy", [])
        for cal_id, cal in resp.get("calendars", {}).items()
    }
    return {
        "time_min": time_min,
        "time_max": time_max,
        "busy": busy_by_attendee,
    }


def calendar_create_event(
    summary: str,
    attendee_emails: list,
    start: str,
    end: str,
    description: str | None = None,
) -> dict:
    """Create an event and invite attendees, after a code-enforced double-booking check."""
    service = _calendar_service()

    # Guardrail: never double-book the organizer. Check their free/busy for the slot.
    organizer_check = (
        service.freebusy()
        .query(
            body={
                "timeMin": start,
                "timeMax": end,
                "items": [{"id": ORGANIZER_CALENDAR_ID}],
            }
        )
        .execute()
    )
    if _is_busy(organizer_check, start, end):
        raise GuardrailError(
            f"Organizer is already busy between {start} and {end}; refusing to double-book."
        )

    if DRY_RUN:
        return {
            "summary": summary,
            "start": start,
            "end": end,
            "attendees": attendee_emails,
            "dry_run": True,
        }

    body = {
        "summary": summary,
        "start": {"dateTime": start},
        "end": {"dateTime": end},
        "attendees": [{"email": email} for email in attendee_emails],
    }
    if description:
        body["description"] = description

    created = (
        service.events()
        .insert(calendarId=ORGANIZER_CALENDAR_ID, body=body, sendUpdates="all")
        .execute()
    )
    return {
        "event_id": created.get("id"),
        "status": created.get("status"),
        "html_link": created.get("htmlLink"),
        "start": created.get("start", {}).get("dateTime"),
        "end": created.get("end", {}).get("dateTime"),
    }


def calendar_update_event(event_id: str, calendar_id: str, updates: dict) -> dict:
    """Patch fields on an existing event."""
    if DRY_RUN:
        return {"event_id": event_id, "updates": updates, "dry_run": True}

    service = _calendar_service()
    patched = (
        service.events()
        .patch(
            calendarId=calendar_id,
            eventId=event_id,
            body=updates,
            sendUpdates="all",
        )
        .execute()
    )
    return {
        "event_id": patched.get("id"),
        "status": patched.get("status"),
        "summary": patched.get("summary"),
        "updated": patched.get("updated"),
    }


def slack_post_message(channel: str, text: str) -> dict:
    """Post a confirmation message to Slack."""
    if DRY_RUN:
        return {"channel": channel, "text": text, "dry_run": True}

    client = _slack_client()
    resp = client.chat_postMessage(channel=channel, text=text)
    return {"channel": resp["channel"], "ts": resp["ts"], "ok": resp["ok"]}


DISPATCH = {
    "calendar_list_events": calendar_list_events,
    "calendar_freebusy": calendar_freebusy,
    "calendar_create_event": calendar_create_event,
    "calendar_update_event": calendar_update_event,
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

    print(
        json.dumps(
            run(
                "Find 30 minutes next week for me and jordan@company.com and book it "
                "as 'Q3 planning'."
            ),
            indent=2,
            default=str,
        )
    )
