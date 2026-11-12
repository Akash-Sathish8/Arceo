"""Personal agent connections: the key a coding agent shows to <origin>/mcp (plan §5).

A person makes one on the Connect page and pastes it into their agent's setup
(`Authorization: Bearer ap_...`). The key:

  * is `ap_` + secrets.token_urlsafe(32) (256 random bits). Only its sha256 is
    stored (prompt_agent_tokens.token_hash, unique); the plain value is returned
    once, by create(), and never again.
  * belongs to ONE user in ONE org and can only reach the prompts product (the
    MCP tools). It is not a login: the REST API never accepts it.
  * stops working when it is revoked, when its user is deactivated
    (users.disabled_at) or deleted, or if the user no longer belongs to the org
    it was made in.

User-facing wording says "connection" or "connection key", never "token".
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

import db
from db import get_db, log_audit

from . import store

PREFIX = "ap_"
# token_urlsafe(32) is 43 characters; accept a little slack, refuse anything that
# couldn't be one of ours before hashing it or touching the database.
_WELL_FORMED = re.compile(r"^ap_[A-Za-z0-9_-]{32,64}$")
MAX_ACTIVE_PER_USER = 20
MAX_LISTED = 100
LABEL_MAX = 80
DEFAULT_LABEL = "My agent"
# last_used_at is a "seen recently" hint for the Connect page, so one write a
# minute per key is plenty and keeps a busy agent from writing on every call.
TOUCH_EVERY = timedelta(seconds=60)

_PUBLIC_COLS = "id, label, created_at, last_used_at, revoked_at"


class LimitReached(Exception):
    """The user already has MAX_ACTIVE_PER_USER working connections."""


@dataclass(frozen=True)
class AgentCaller:
    """Who an authenticated /mcp request acts for."""
    token_id: str
    user_id: str
    org_id: str


def generate() -> str:
    return PREFIX + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def well_formed(token: Optional[str]) -> bool:
    return bool(token) and bool(_WELL_FORMED.match(token))


def clean_label(label: Optional[str]) -> str:
    text = " ".join((label or "").split())[:LABEL_MAX].strip()
    return text or DEFAULT_LABEL


def create(user_id: str, org_id: str, label: Optional[str], email: Optional[str] = None) -> dict:
    """Make a connection key. The ONLY place the plain `ap_...` value is returned."""
    token = generate()
    row = {"id": store.new_id("pat"), "label": clean_label(label), "created_at": store.now()}
    with get_db() as conn:
        active = conn.execute(
            "SELECT COUNT(*) AS n FROM prompt_agent_tokens "
            "WHERE user_id = %s AND org_id = %s AND revoked_at IS NULL", (user_id, org_id),
        ).fetchone()["n"]
        if active >= MAX_ACTIVE_PER_USER:
            raise LimitReached()
        conn.execute(
            "INSERT INTO prompt_agent_tokens (id, org_id, user_id, label, token_hash, created_at) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (row["id"], org_id, user_id, row["label"], hash_token(token), row["created_at"]),
        )
        log_audit(conn, user_id, email, "CREATE_PROMPT_AGENT_TOKEN", resource=row["id"],
                  detail=f"Agent connection '{row['label']}'", org_id=org_id)
    return {**row, "token": token}


def list_for_user(user_id: str, org_id: str) -> list[dict]:
    """The caller's own connections, working ones first. Never includes the hash."""
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT {_PUBLIC_COLS} FROM prompt_agent_tokens WHERE user_id = %s AND org_id = %s "
            "ORDER BY (revoked_at IS NOT NULL), created_at DESC, id LIMIT %s",
            (user_id, org_id, MAX_LISTED),
        ).fetchall()
    return [dict(r) for r in rows]


def revoke(token_id: str, user_id: str, org_id: str, email: Optional[str] = None) -> Optional[dict]:
    """Turn off one of the caller's own connections. Idempotent; None if it isn't theirs."""
    with get_db() as conn:
        row = conn.execute(
            "UPDATE prompt_agent_tokens SET revoked_at = COALESCE(revoked_at, %s) "
            f"WHERE id = %s AND user_id = %s AND org_id = %s RETURNING {_PUBLIC_COLS}",
            (store.now(), token_id, user_id, org_id),
        ).fetchone()
        if row is None:
            return None
        log_audit(conn, user_id, email, "REVOKE_PROMPT_AGENT_TOKEN", resource=token_id,
                  detail=f"Agent connection '{row['label']}'", org_id=org_id)
    return dict(row)


def resolve(token: Optional[str]) -> tuple[Optional[AgentCaller], str]:
    """(caller, "") for a working key, else (None, why): "invalid" or "revoked".

    Looked up by the sha256 of the presented value (unique index) and confirmed
    with a constant-time compare, so response time doesn't depend on how much of
    a guess matches. The lookup is pre-auth and must find the key whichever org
    made it, so it runs in the 'system' RLS context like login does; everything
    after it runs as the key's org.
    """
    if not well_formed(token):
        return None, "invalid"
    digest = hash_token(token)
    ctx = db.current_org.set("system")
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT t.id, t.org_id, t.user_id, t.token_hash, t.revoked_at, t.last_used_at, "
                "u.org_id AS user_org_id, u.disabled_at "
                "FROM prompt_agent_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = %s",
                (digest,),
            ).fetchone()
            if row is None or not hmac.compare_digest(row["token_hash"], digest):
                return None, "invalid"
            if row["revoked_at"]:
                return None, "revoked"
            if row["disabled_at"] or row["user_org_id"] != row["org_id"]:
                return None, "invalid"
            if _stale(row["last_used_at"]):
                conn.execute("UPDATE prompt_agent_tokens SET last_used_at = %s WHERE id = %s",
                             (store.now(), row["id"]))
    finally:
        db.current_org.reset(ctx)
    return AgentCaller(token_id=row["id"], user_id=row["user_id"], org_id=row["org_id"]), ""


def _stale(last_used_at: Optional[str]) -> bool:
    if not last_used_at:
        return True
    try:
        return datetime.utcnow() - datetime.fromisoformat(last_used_at) >= TOUCH_EVERY
    except ValueError:
        return True
