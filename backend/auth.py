"""Authentication — JWT tokens, bcrypt passwords, user middleware. Multi-tenant."""

from __future__ import annotations

import os
from datetime import datetime, timedelta

import bcrypt
import jwt
from fastapi import HTTPException, Request

from db import get_db, log_audit, DEFAULT_ORG_ID
from envcheck import DEV_ENVS as _DEV_ENVS

import logging as _logging

SECRET_KEY = os.getenv("JWT_SECRET", "actiongate-demo-secret-key-change-in-prod")
ALGORITHM = "HS256"
TOKEN_EXPIRY_HOURS = 24  # default session length; per-org override in workspace_settings
# Configurable per-org expiry is clamped to this range so it can't be set to a
# value that's either useless or a security hole (2026-07-24 review).
TOKEN_EXPIRY_MIN_HOURS = 1
TOKEN_EXPIRY_MAX_HOURS = 72

_logger = _logging.getLogger("actiongate.auth")

# A host is "dev-like" ONLY if it says so explicitly. The old guard whitelisted
# four PaaS env vars and let everything else (bare VMs, Docker, a tunneled
# laptop) boot on the public demo secret — an open door to token forgery. We
# invert it: the default secret is refused everywhere UNLESS ARCEO_ENV opts in.
#
# `_DEV_ENVS` is imported from envcheck (aliased, because this module's guards
# run at IMPORT time and tests reach for it by name) so that every boot guard
# answers "is this a real deploy?" identically.
ARCEO_ENV = os.getenv("ARCEO_ENV", "").lower()

_DEMO_TRUTHY = {"1", "true", "yes", "on"}


def demo_mode_enabled() -> bool:
    """Single source of truth for whether DEMO_MODE is on. Accepts any common
    truthy value so the boot guard, the get_current_user JWT bypass, the demo
    reset, and the trace WebSocket can never disagree. A prior mismatch — the WS
    guard accepted 1/true/yes while everything else demanded exactly "true" —
    left the trace socket unauthenticated in prod when DEMO_MODE=1 (MED-002)."""
    return os.getenv("DEMO_MODE", "").lower() in _DEMO_TRUTHY

if SECRET_KEY == "actiongate-demo-secret-key-change-in-prod":
    if ARCEO_ENV not in _DEV_ENVS:
        raise RuntimeError(
            "JWT_SECRET is unset and defaulting to the public demo value, which lets "
            "anyone forge admin tokens. Set JWT_SECRET, or set ARCEO_ENV=dev for local work."
        )
    _logger.warning("JWT_SECRET is the default demo value — allowed only because ARCEO_ENV=%s.", ARCEO_ENV)

# DEMO_MODE bypasses JWT entirely (get_current_user returns the admin user). It
# must never run on a real deploy, where it would collapse the tenant boundary —
# so it too is gated on an explicit dev environment, not a platform whitelist.
if demo_mode_enabled():
    if ARCEO_ENV not in _DEV_ENVS:
        raise RuntimeError(
            "DEMO_MODE is an authentication bypass and must not run outside a dev "
            "environment. Set ARCEO_ENV=dev to acknowledge this is local-only."
        )
    _logger.warning("DEMO_MODE is ON — JWT auth is bypassed and any login wipes demo data. Never set this in production.")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    """True only for a real bcrypt hash. Anything else fails CLOSED.

    MED-003: there used to be a fallback branch here that accepted an unsalted
    SHA-256 digest compared with `==`. Two problems, either one sufficient:
    unsalted SHA-256 is GPU-brute-forceable at billions of guesses/second, so a
    stolen `users` table is effectively plaintext for any password in a wordlist;
    and `==` on a secret-derived value short-circuits on the first differing byte.

    It was reachable — `verify_password` is called with whatever the row holds —
    but nothing in the codebase WRITES such a hash: `hash_password` is bcrypt-only.
    So the branch was a door left open for an attacker who could already write to
    the users table, and a liability if a customer ever imported legacy rows.
    Verified empty before removal (2026-07-29):

        SELECT count(*) FROM users WHERE password_hash NOT LIKE '$2%'  -> 0

    across `arceo` and `arceo_test`. Failing closed means a legacy row cannot
    authenticate at all and needs an admin password reset — which is the correct
    outcome, and the warning below is what makes it diagnosable instead of an
    unexplained "invalid password".
    """
    if hashed.startswith("$2b$") or hashed.startswith("$2a$"):
        return bcrypt.checkpw(password.encode(), hashed.encode())
    _logger.warning(
        "Refused a login against a non-bcrypt password hash (MED-003). This "
        "account cannot authenticate until an admin resets its password."
    )
    return False


def create_token(user_id: str, email: str, role: str, org_id: str = DEFAULT_ORG_ID,
                 token_version: int = 0, expiry_hours: int | None = None) -> str:
    hours = expiry_hours if expiry_hours is not None else TOKEN_EXPIRY_HOURS
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "org_id": org_id,
        "tv": token_version,  # bumped on password change → old tokens stop verifying
        "exp": datetime.utcnow() + timedelta(hours=hours),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def resolve_token_expiry_hours(conn, org_id: str) -> int:
    """Per-org session length from workspace_settings.token_expiry_hours, clamped
    to [TOKEN_EXPIRY_MIN_HOURS, TOKEN_EXPIRY_MAX_HOURS] and defaulting to 24h when
    unset. 'Dumb code, smart config' — orgs tune sessions without a code change."""
    try:
        row = conn.execute(
            "SELECT token_expiry_hours FROM workspace_settings WHERE org_id = %s", (org_id,)
        ).fetchone()
    except Exception:
        return TOKEN_EXPIRY_HOURS
    if not row or row["token_expiry_hours"] is None:
        return TOKEN_EXPIRY_HOURS
    return max(TOKEN_EXPIRY_MIN_HOURS, min(TOKEN_EXPIRY_MAX_HOURS, int(row["token_expiry_hours"])))


def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


def get_current_user(request: Request) -> dict:
    """Extract and verify user from Authorization header.

    Returns dict with: sub, email, role, org_id.
    DEMO_MODE bypasses JWT and returns admin user with their org_id.
    """
    if demo_mode_enabled():
        with get_db() as conn:
            row = conn.execute("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").fetchone()
            if row:
                org_id = row["org_id"] if "org_id" in row.keys() else DEFAULT_ORG_ID
                return {"sub": row["id"], "email": row["email"], "role": row["role"], "org_id": org_id}
        return {"sub": "demo", "email": "admin@actiongate.io", "role": "admin", "org_id": DEFAULT_ORG_ID}
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization header")
    token = auth[7:]
    payload = verify_token(token)
    # Ensure org_id is always present (backward compat with old tokens)
    if "org_id" not in payload:
        payload["org_id"] = DEFAULT_ORG_ID
    # Instant revocation: a token whose version is behind the user's current
    # token_version was issued before a password change or an admin revoke —
    # reject it.
    with get_db() as conn:
        row = conn.execute(
            "SELECT token_version, role, disabled_at FROM users WHERE id = %s",
            (payload.get("sub"),),
        ).fetchone()
    # MED-001: fail CLOSED on a missing row. This used to be `if row is not None`,
    # so a deleted or deprovisioned account skipped the check entirely and its
    # unexpired JWT kept authenticating — the revocation control failing open on
    # precisely the event it exists to catch.
    if row is None:
        raise HTTPException(status_code=401, detail="Your session expired. Please log in again.")
    # disabled_at before token_version: a revoke bumps BOTH, and "your account was
    # deactivated" tells the user what actually happened where "session expired"
    # would send them to a login screen that will never let them in.
    if _row_get(row, "disabled_at"):
        raise HTTPException(status_code=401, detail="This account has been deactivated")
    if int(payload.get("tv", 0)) != int(row["token_version"] or 0):
        raise HTTPException(status_code=401, detail="Your session expired. Please log in again.")
    # Trust the DB role over the token's (a role change takes effect without re-login).
    payload["role"] = row["role"]
    return payload


def _row_get(row, key):
    """Read an optional column that may not exist on a pre-migration row."""
    try:
        return row[key]
    except (KeyError, IndexError):
        return None


# A fixed bcrypt hash of a value no password will match. When the email is
# unknown we still run a verify against this so login takes the same time whether
# or not the account exists — closing the timing side-channel that let an attacker
# enumerate valid emails (LOW-002).
_DUMMY_HASH = bcrypt.hashpw(b"arceo-login-timing-equalizer", bcrypt.gensalt()).decode()


def login_user(email: str, password: str) -> dict:
    """Authenticate user and return token + user info including org_id."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = %s", (email,)).fetchone()
        # Always run a hash comparison so a missing account and a wrong password
        # take the same time (LOW-002); the boolean is discarded when row is None.
        password_ok = verify_password(password, row["password_hash"]) if row else verify_password(password, _DUMMY_HASH)
        if not row or not password_ok:
            # LOW-004: record the failed attempt in its OWN committed transaction —
            # this outer transaction is rolled back by the 401 below.
            try:
                with get_db() as audit_conn:
                    log_audit(audit_conn, row["id"] if row else None, email, "FAILED_LOGIN",
                              detail="Invalid credentials",
                              org_id=(row["org_id"] if row and "org_id" in row.keys() else DEFAULT_ORG_ID))
            except Exception:
                pass  # never let audit failure change the auth outcome
            raise HTTPException(status_code=401, detail="Invalid email or password")

        # MED-001: a deprovisioned account must not be able to start a NEW session.
        # Checked after the password comparison so a disabled account is not
        # distinguishable from a wrong password by timing.
        if _row_get(row, "disabled_at"):
            try:
                with get_db() as audit_conn:
                    log_audit(audit_conn, row["id"], email, "FAILED_LOGIN",
                              detail="Account deactivated",
                              org_id=(row["org_id"] if "org_id" in row.keys() else DEFAULT_ORG_ID))
            except Exception:
                pass
            raise HTTPException(status_code=401, detail="Invalid email or password")

        # Opportunistic hash upgrade. Since MED-003 removed the SHA-256 fallback,
        # verify_password only returns True for bcrypt — so reaching here with a
        # non-`$2b$` hash now means exactly one thing, an older `$2a$` variant, and
        # this re-hashes it to `$2b$`. It is no longer a legacy-format migration
        # path: a non-bcrypt row can never authenticate to get here at all.
        if not row["password_hash"].startswith("$2b$"):
            new_hash = hash_password(password)
            conn.execute("UPDATE users SET password_hash = %s WHERE id = %s", (new_hash, row["id"]))

        org_id = row["org_id"] if "org_id" in row.keys() else DEFAULT_ORG_ID
        tv = int(row["token_version"]) if "token_version" in row.keys() and row["token_version"] is not None else 0
        expiry = resolve_token_expiry_hours(conn, org_id)
        token = create_token(row["id"], row["email"], row["role"], org_id, token_version=tv, expiry_hours=expiry)
        log_audit(conn, row["id"], row["email"], "LOGIN", detail="User logged in", org_id=org_id)

        return {
            "token": token,
            "user": {
                "id": row["id"],
                "email": row["email"],
                "name": row["name"],
                "role": row["role"],
                "org_id": org_id,
            },
        }
