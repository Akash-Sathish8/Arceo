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


# ── LOW-003: legacy SHA-256 hash verifies then upgrades to bcrypt ───────────────

def test_legacy_sha256_hash_upgraded_on_login(client):
    email = f"legacy-{uuid.uuid4().hex[:6]}@e.com"
    pw = "legacypw12"
    assert _signup(client, email).status_code == 200
    with get_db() as conn:
        conn.execute("UPDATE users SET password_hash=%s WHERE email=%s",
                     (hashlib.sha256(pw.encode()).hexdigest(), email))
    assert client.post("/api/auth/login", json={"email": email, "password": pw}).status_code == 200
    with get_db() as conn:
        h = conn.execute("SELECT password_hash FROM users WHERE email=%s", (email,)).fetchone()["password_hash"]
    assert h.startswith("$2b$")  # re-hashed to bcrypt


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
