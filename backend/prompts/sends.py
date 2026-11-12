"""The send inbox: "send this prompt to my agent" (plan §5).

A person fills in a prompt's blanks and presses Send. The filled text waits
here, private to that one user, until their connected agent fetches it over
MCP (get_sent_prompt or the `sent` prompt). Each send:

  * is delivered at most once, newest first. claim_next() marks it delivered and returns it
    in one statement (UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)
    RETURNING), so two agents asking at the same moment never both get it. If the
    answer is then lost on the network the send is gone; the person sends again.
  * expires 24 hours after it was made, delivered or not.
  * stores its text through the encryption seam (encryption.split), exactly like
    qa_runs.output / output_enc: the filled text can carry pasted customer
    content. Once delivered, only the short preview the Connect page shows is
    kept. Rows are purged KEEP_DAYS after they expire, by the daily retention
    job (purge_expired, run with the LLM-capture sweep) and by the sender's next send.

Filling follows the template rules with one difference from the Use dialog: a
blank with no value (missing, or only spaces) stays written as `{{name}}`, so the
agent can see there's something to ask for instead of a silent gap. A value goes
into EVERY copy of its blank, so 100,000 characters into a body with 20,000 copies
of one blank would be 2 GB: fill_checked() works out the size first and refuses
anything over MAX_TEXT_CHARS before building it. Every path that fills (REST send,
MCP get_prompt and prompts/get) uses it.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional

import db
import encryption
import shared_state
from db import get_db

from . import store
from .template import VAR_RE, variables_in

logger = logging.getLogger("arceo.prompts.sends")

TTL = timedelta(hours=24)
# Same key and window as POST /api/prompts/{id}/use, so filling a prompt in and
# sending it (or running it from an agent) within ten minutes is one use, not two.
USE_COUNT_TTL = 600
KEEP_DAYS = 7
MAX_VALUES_CHARS = 100_000          # everything a person fills in, names included
MAX_TEXT_CHARS = 300_000            # the filled prompt (a value can appear more than once)
MAX_WAITING_PER_USER = 50
PREVIEW_CHARS = 140
MAX_LISTED = 50

TEST_TITLE = "Connection test"
TEST_TEXT = ("This is a test from Arceo Prompts to check that your agent is connected. "
             "Reply with one short line: \"Arceo is connected.\" "
             "Don't run any commands or change any files.")


class SendError(Exception):
    """A send that can't be made, with an HTTP status and a plain message."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def values_size(values: Optional[dict]) -> int:
    return sum(len(str(k)) + len(str(v)) for k, v in (values or {}).items())


def check_values(values: Optional[dict]) -> None:
    if values_size(values) > MAX_VALUES_CHARS:
        raise SendError(413, f"That's too much text. Keep what you fill in under {MAX_VALUES_CHARS:,} characters.")


def _given(values: dict, name: str) -> Optional[str]:
    v = values.get(name)
    return v if isinstance(v, str) and v.strip() else None


TOO_LONG = "That prompt is too long once it's filled in. Fill in less text, or use a blank fewer times."


def filled_size(body: str, values: Optional[dict]) -> int:
    """len(fill(body, values)), worked out without building the text."""
    values = values or {}
    total = len(body or "")
    for m in VAR_RE.finditer(body or ""):
        v = _given(values, m.group(1))
        if v is not None:
            total += len(v) - (m.end() - m.start())
    return total


def fill_checked(body: str, values: Optional[dict], limit: int = MAX_TEXT_CHARS) -> str:
    """fill(), refused (SendError 413) before anything is built when the result would be over `limit`."""
    if filled_size(body, values) > limit:
        raise SendError(413, TOO_LONG)
    return fill(body, values)


def fill(body: str, values: Optional[dict]) -> str:
    """Put each value in its blank. One pass, so a value that itself contains
    `{{x}}` is never filled again."""
    values = values or {}

    def _sub(m):
        v = _given(values, m.group(1))
        return v if v is not None else m.group(0)

    return VAR_RE.sub(_sub, body or "")


def unfilled(body: str, values: Optional[dict]) -> list[str]:
    """Blanks in `body` that `values` leaves empty, in first-appearance order."""
    values = values or {}
    return [n for n in variables_in(body or "") if _given(values, n) is None]


def still_blank(text: str, body: Optional[str]) -> list[str]:
    """Blanks of `body` still written as `{{name}}` in the sent `text`.

    Only names the prompt itself declares count, so pasted content that happens
    to contain `{{something}}` (template code, say) is never mistaken for a blank
    the person forgot."""
    left = set(variables_in(text or ""))
    return [n for n in variables_in(body or "") if n in left]


def count_use(prompt_id: str, user_id: str) -> None:
    """One use per person per prompt per USE_COUNT_TTL (the key POST /use shares).

    The increment runs in the 'system' RLS context. A public prompt belongs to
    another org; under the production database role the caller's org context
    can read that row (public_read) but not update it, so the count silently
    stayed put. Callers have already passed the visibility check, and the
    statement only adds one to use_count by id. A lost count never fails a send.
    """
    try:
        if not shared_state.should_fire_once(f"prompt-use:{prompt_id}:{user_id}", USE_COUNT_TTL):
            return
        ctx = db.current_org.set("system")
        try:
            store.increment_use(prompt_id)
        finally:
            db.current_org.reset(ctx)
    except Exception as e:  # noqa: BLE001
        logger.warning("prompt use count skipped (%s)", type(e).__name__)


def create(user_id: str, org_id: str, prompt_id: Optional[str], title: Optional[str], text: str) -> dict:
    """Queue `text` for the user's agent. Returns {id, expires_at}."""
    if len(text) > MAX_TEXT_CHARS:
        raise SendError(413, TOO_LONG)
    now = datetime.utcnow()
    created_at, expires_at = now.isoformat(), (now + TTL).isoformat()
    text_plain, text_enc = encryption.split(text)
    send_id = store.new_id("ps")
    with get_db() as conn:
        conn.execute("DELETE FROM prompt_sends WHERE user_id = %s AND org_id = %s AND expires_at < %s",
                     (user_id, org_id, (now - timedelta(days=KEEP_DAYS)).isoformat()))
        waiting = conn.execute(
            "SELECT COUNT(*) AS n FROM prompt_sends WHERE user_id = %s AND org_id = %s "
            "AND delivered_at IS NULL AND expires_at > %s", (user_id, org_id, created_at),
        ).fetchone()["n"]
        if waiting >= MAX_WAITING_PER_USER:
            raise SendError(429, f"Your agent already has {MAX_WAITING_PER_USER} prompts waiting. "
                                 "Ask it to run your Arceo prompt, or wait for older ones to expire.")
        conn.execute(
            "INSERT INTO prompt_sends (id, org_id, user_id, prompt_id, title, text, text_enc, created_at, "
            "expires_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (send_id, org_id, user_id, prompt_id, (title or "")[:200], text_plain, text_enc,
             created_at, expires_at),
        )
    return {"id": send_id, "expires_at": expires_at}


def claim_next(user_id: str, org_id: str) -> Optional[dict]:
    """The user's NEWEST waiting, unexpired send, marked delivered. None if nothing waits.

    Newest first, so "run my Arceo prompt" runs what the person just sent, not
    something they sent hours ago and forgot. Older sends keep waiting; each
    later ask takes the next newest, and anything never picked up expires.

    Decrypts inside the same transaction: if the text can't be read, the claim
    rolls back and the send stays waiting rather than vanishing unread. The
    stored text is then cut down to the preview the Connect page lists: the
    full filled prompt (maybe with pasted customer content) isn't kept once
    the agent has it.
    """
    now = store.now()
    with get_db() as conn:
        row = conn.execute(
            "UPDATE prompt_sends SET delivered_at = %s "
            "WHERE id = (SELECT id FROM prompt_sends "
            "            WHERE user_id = %s AND org_id = %s AND delivered_at IS NULL AND expires_at > %s "
            "            ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE SKIP LOCKED) "
            "AND delivered_at IS NULL "
            "RETURNING id, prompt_id, title, text, text_enc, created_at, delivered_at, expires_at",
            (now, user_id, org_id, now),
        ).fetchone()
        if row is None:
            return None
        out = encryption.hydrate(dict(row), "text")
        kept_plain, kept_enc = encryption.split(preview(out.get("text")))
        conn.execute("UPDATE prompt_sends SET text = %s, text_enc = %s WHERE id = %s",
                     (kept_plain, kept_enc, out["id"]))
        return out


def purge_expired(conn, now: Optional[datetime] = None) -> int:
    """Delete every send, anyone's, that expired more than KEEP_DAYS ago. Run by the daily
    retention job in the 'system' context (sends are private to their org under RLS)."""
    cutoff = ((now or datetime.utcnow()) - timedelta(days=KEEP_DAYS)).isoformat()
    cur = conn.execute("DELETE FROM prompt_sends WHERE expires_at < %s", (cutoff,))
    return int(cur.rowcount or 0)


def status(row: dict, now: Optional[str] = None) -> str:
    if row.get("delivered_at"):
        return "delivered"
    return "expired" if (row.get("expires_at") or "") <= (now or store.now()) else "waiting"


def preview(text: Optional[str]) -> str:
    flat = " ".join((text or "").split())
    return flat if len(flat) <= PREVIEW_CHARS else flat[:PREVIEW_CHARS - 1].rstrip() + "…"


def list_recent(user_id: str, org_id: str, limit: int = 20) -> list[dict]:
    """The caller's newest sends with their status and a short preview, never the full text."""
    limit = max(1, min(int(limit), MAX_LISTED))
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, prompt_id, title, text, text_enc, created_at, delivered_at, expires_at "
            "FROM prompt_sends WHERE user_id = %s AND org_id = %s ORDER BY created_at DESC, id DESC LIMIT %s",
            (user_id, org_id, limit),
        ).fetchall()
    now = store.now()
    out = []
    for r in rows:
        r = encryption.hydrate(dict(r), "text")
        text = r.pop("text", None)
        out.append({**r, "preview": preview(text), "status": status(r, now)})
    return out
