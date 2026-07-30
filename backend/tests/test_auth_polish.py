"""PR 4A — auth polish (LOW-002/003/004/010) + configurable per-org JWT expiry.

- min-8 passwords on signup/change (LOW-010)
- failed logins are audited, and unknown-email vs wrong-password take the same
  path so timing can't enumerate accounts (LOW-002/004)
- legacy unsalted SHA-256 hashes still verify but upgrade to bcrypt on login (LOW-003)
- JWT session length is configurable per org (2026-07-24 review), admin-only,
  bounded to [1,72]h
"""

from __future__ import annotations

import datetime as dt
import hashlib
import uuid

import jwt as _jwt

import auth
from db import get_db


def _signup(client, email, pw="pw12345678"):
    return client.post("/api/auth/signup", json={"email": email, "password": pw, "name": "x"})


# ── LOW-010: password minimum length ───────────────────────────────────────────

def test_signup_rejects_short_password(client):
    r = _signup(client, f"short-{uuid.uuid4().hex[:6]}@e.com", pw="short7")  # 6 chars
    assert r.status_code == 400 and "8 characters" in r.json()["detail"]


def test_signup_accepts_8_char_password(client):
    r = _signup(client, f"ok-{uuid.uuid4().hex[:6]}@e.com", pw="abcdefgh")  # 8 chars
    assert r.status_code == 200, r.text


# ── LOW-004 / LOW-002: failed logins audited; same path for unknown email ───────

def test_failed_login_wrong_password_is_audited(client, roles):
    admin = roles["admin"]
    r = client.post("/api/auth/login", json={"email": admin["email"], "password": "wrong-password"})
    assert r.status_code == 401
    with get_db() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM audit_log WHERE action='FAILED_LOGIN' AND user_email=%s",
                         (admin["email"],)).fetchone()["n"]
    assert n >= 1


def test_failed_login_unknown_email_is_audited_and_401(client):
    email = f"ghost-{uuid.uuid4().hex[:6]}@e.com"
    r = client.post("/api/auth/login", json={"email": email, "password": "whatever12"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid email or password"  # identical to wrong-password
    with get_db() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM audit_log WHERE action='FAILED_LOGIN' AND user_email=%s",
                         (email,)).fetchone()["n"]
    assert n >= 1


# ── MED-003: a legacy SHA-256 hash is REFUSED, not verified-then-upgraded ──────
#
# This test previously asserted the opposite: that a SHA-256 digest authenticated
# successfully and was then re-hashed to bcrypt. That behaviour WAS the finding —
# unsalted SHA-256 is GPU-brute-forceable, so the "upgrade on next login" path
# only helps an account whose password an attacker has already had every
# opportunity to recover offline, and the branch compared with `==`. Inverted to
# pin the fail-closed contract, rather than deleted, so the regression it guards
# against stays named.

def test_legacy_sha256_hash_is_refused(client):
    email = f"legacy-{uuid.uuid4().hex[:6]}@e.com"
    pw = "legacypw12"
    assert _signup(client, email).status_code == 200
    with get_db() as conn:
        conn.execute("UPDATE users SET password_hash=%s WHERE email=%s",
                     (hashlib.sha256(pw.encode()).hexdigest(), email))

    r = client.post("/api/auth/login", json={"email": email, "password": pw})
    assert r.status_code == 401, "an unsalted SHA-256 hash must not authenticate"
    # Indistinguishable from any other bad login — no oracle for "this account is
    # on a legacy hash".
    assert r.json()["detail"] == "Invalid email or password"

    # And the row is untouched: no silent upgrade, so an operator resetting the
    # password is the only way back in.
    with get_db() as conn:
        h = conn.execute("SELECT password_hash FROM users WHERE email=%s",
                         (email,)).fetchone()["password_hash"]
    assert not h.startswith("$2b$")


def test_verify_password_fails_closed_on_every_non_bcrypt_shape(client):
    """The unit-level contract behind the endpoint test above."""
    from auth import verify_password, hash_password

    pw = "legacypw12"
    for bogus in (
        hashlib.sha256(pw.encode()).hexdigest(),   # the removed branch
        hashlib.md5(pw.encode()).hexdigest(),
        pw,                                        # plaintext in the column
        "",
        "x",                                       # the old migration fixture
        "$1$salt$abc",                             # md5-crypt
    ):
        assert verify_password(pw, bogus) is False, f"accepted {bogus!r}"

    # ...while real bcrypt still works, both variants.
    assert verify_password(pw, hash_password(pw)) is True
    assert verify_password("wrong", hash_password(pw)) is False


def test_bcrypt_2a_variant_still_verifies_and_upgrades(client):
    """`$2a$` is genuine bcrypt, so it must keep working — the fail-closed change
    must not have swept it up with the legacy digests. It still re-hashes to
    `$2b$` on login, which is now the ONLY thing that upgrade path does."""
    import bcrypt as _bcrypt

    email = f"bcrypt2a-{uuid.uuid4().hex[:6]}@e.com"
    pw = "legacypw12"
    assert _signup(client, email).status_code == 200
    old = _bcrypt.hashpw(pw.encode(), _bcrypt.gensalt(prefix=b"2a")).decode()
    assert old.startswith("$2a$")
    with get_db() as conn:
        conn.execute("UPDATE users SET password_hash=%s WHERE email=%s", (old, email))

    assert client.post("/api/auth/login", json={"email": email, "password": pw}).status_code == 200
    with get_db() as conn:
        h = conn.execute("SELECT password_hash FROM users WHERE email=%s",
                         (email,)).fetchone()["password_hash"]
    assert h.startswith("$2b$")


# ── Configurable per-org JWT expiry ────────────────────────────────────────────

def test_session_expiry_is_configurable_and_applied(client, roles):
    admin = roles["admin"]
    assert client.put("/api/settings/session", headers=admin["headers"],
                      json={"token_expiry_hours": 2}).status_code == 200
    assert client.get("/api/settings/session", headers=admin["headers"]).json()["tokenExpiryHours"] == 2

    login = client.post("/api/auth/login", json={"email": admin["email"], "password": "pw12345678"}).json()
    payload = _jwt.decode(login["token"], auth.SECRET_KEY, algorithms=["HS256"])
    hours_left = (dt.datetime.utcfromtimestamp(payload["exp"]) - dt.datetime.utcnow()).total_seconds() / 3600
    assert 1.5 < hours_left < 2.5  # ~2h, not the 24h default


def test_session_expiry_out_of_range_rejected(client, roles):
    assert client.put("/api/settings/session", headers=roles["admin"]["headers"],
                      json={"token_expiry_hours": 999}).status_code == 422


def test_session_expiry_admin_only(client, roles):
    for role in ("viewer", "editor"):
        assert client.get("/api/settings/session", headers=roles[role]["headers"]).status_code == 403
        assert client.put("/api/settings/session", headers=roles[role]["headers"],
                          json={"token_expiry_hours": 5}).status_code == 403
