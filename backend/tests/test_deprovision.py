"""MED-001 — session revocation gaps.

Arceo revokes sessions by comparing a `tv` claim in the JWT against
`users.token_version`. Three holes in that model:

  1. `get_current_user` only ran the comparison `if row is not None`, so a DELETED
     user skipped the check entirely and their unexpired token kept working — the
     control failing open on exactly the event it exists to catch;
  2. the `/ws/traces` handshake called `verify_token` only (signature + expiry),
     never loading the user row, so a session killed by a password change still
     opened a live-trace socket;
  3. `token_version` was bumped in exactly one place — self-service change-password.
     There was no admin lever at all, so offboarding was impossible in-product.

Deprovisioning disables rather than deletes: the row survives so `audit_log`
attribution for the person's past actions survives with it.
"""

from __future__ import annotations

import uuid

import pytest

import main
from db import get_db


def _member(client, admin, role="editor"):
    """Invite a teammate and log them in; returns their auth context + id."""
    email = f"{role}-{uuid.uuid4().hex[:8]}@example.com"
    r = client.post("/api/team/invite", headers=admin["headers"],
                    json={"email": email, "password": "pw12345678", "role": role})
    assert r.status_code == 200, r.text
    uid = r.json()["id"]
    login = client.post("/api/auth/login", json={"email": email, "password": "pw12345678"})
    assert login.status_code == 200, login.text
    return {"id": uid, "email": email, "token": login.json()["token"],
            "headers": {"Authorization": f"Bearer {login.json()['token']}"}}


# ── 1. Fail closed on a missing / disabled row ────────────────────────────────

def test_deleted_users_token_is_rejected(client, roles):
    """The headline fail-open: `if row is not None` meant no row → no check."""
    admin = roles["admin"]
    m = _member(client, admin)
    assert client.get("/api/authority/agents", headers=m["headers"]).status_code == 200

    with get_db() as conn:
        conn.execute("DELETE FROM users WHERE id = %s", (m["id"],))

    r = client.get("/api/authority/agents", headers=m["headers"])
    assert r.status_code == 401, r.text


def test_disabled_users_token_is_rejected(client, roles):
    admin = roles["admin"]
    m = _member(client, admin)
    assert client.post(f"/api/team/{m['id']}/revoke", headers=admin["headers"]).status_code == 200

    r = client.get("/api/authority/agents", headers=m["headers"])
    assert r.status_code == 401
    assert "deactivat" in r.json()["detail"].lower()


def test_revoked_user_cannot_log_back_in(client, roles):
    """Revoke has to survive the user simply signing in again, or it's only a
    session reset, not an offboarding."""
    admin = roles["admin"]
    m = _member(client, admin)
    client.post(f"/api/team/{m['id']}/revoke", headers=admin["headers"])

    r = client.post("/api/auth/login", json={"email": m["email"], "password": "pw12345678"})
    assert r.status_code == 401
    # Same message as a wrong password — no account-state oracle.
    assert r.json()["detail"] == "Invalid email or password"


def test_restore_reopens_login_but_not_the_old_tokens(client, roles):
    admin = roles["admin"]
    m = _member(client, admin)
    client.post(f"/api/team/{m['id']}/revoke", headers=admin["headers"])
    assert client.post(f"/api/team/{m['id']}/restore", headers=admin["headers"]).status_code == 200

    # Can sign in again...
    fresh = client.post("/api/auth/login", json={"email": m["email"], "password": "pw12345678"})
    assert fresh.status_code == 200
    # ...but the token from before the revoke stays dead (token_version moved on).
    assert client.get("/api/authority/agents", headers=m["headers"]).status_code == 401


# ── 2. The WebSocket handshake ────────────────────────────────────────────────

def _agent(client, headers):
    r = client.post("/api/authority/agents", headers=headers, json={
        "name": "ws-" + uuid.uuid4().hex[:6],
        "tools": [{"name": "stripe", "service": "stripe", "actions": [
            {"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}]})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _ws_ticket(client, headers, agent_id: str) -> str:
    """MED-002: the socket takes a single-use ticket now, not the session JWT."""
    r = client.post("/api/ws-ticket", headers=headers, json={"agent_id": agent_id})
    assert r.status_code == 200, r.text
    return r.json()["ticket"]


def test_ws_accepts_a_valid_ticket(client, roles):
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    with client.websocket_connect(f"/ws/traces/{aid}?ticket={_ws_ticket(client, admin['headers'], aid)}") as ws:
        assert ws is not None


def test_ws_rejects_a_ticket_whose_token_version_went_stale(client, roles):
    """The handshake used to call verify_token only (signature + expiry), so a
    session already revoked still opened a socket.

    Stronger than the pre-MED-002 version of this test: the ticket is minted while
    the session is still valid, and the revoke lands afterwards. That is precisely
    the window a ticket could have opened — it proves the user row is re-checked at
    REDEEM time, not merely at mint time.
    """
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    m = _member(client, admin)
    ticket = _ws_ticket(client, m["headers"], aid)

    with get_db() as conn:  # simulate a password change / admin revoke
        conn.execute("UPDATE users SET token_version = token_version + 1 WHERE id = %s", (m["id"],))

    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/traces/{aid}?ticket={ticket}"):
            pass


def test_ws_rejects_a_disabled_user(client, roles):
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    m = _member(client, admin)
    ticket = _ws_ticket(client, m["headers"], aid)
    # Disable WITHOUT bumping token_version, so only the disabled_at check can catch it.
    with get_db() as conn:
        conn.execute("UPDATE users SET disabled_at = %s WHERE id = %s", ("2026-07-29", m["id"]))

    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/traces/{aid}?ticket={ticket}"):
            pass


def test_ws_rejects_a_ticket_for_a_user_that_no_longer_exists(client, roles):
    """Minted straight into Redis: a deleted user cannot reach the mint endpoint
    at all (auth.py fails closed on a missing row), so the only way to exercise the
    socket's own row check is to hand it a well-formed ticket for a ghost."""
    import json as _json

    import shared_state

    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    ticket = "ghost-" + uuid.uuid4().hex
    shared_state.ws_ticket_store(ticket, _json.dumps(
        {"sub": "no-such-user", "org_id": admin["org_id"], "tv": 0, "agent_id": aid}))

    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/traces/{aid}?ticket={ticket}"):
            pass


# ── 3. The admin lever ────────────────────────────────────────────────────────

def test_revoke_sets_disabled_at_and_bumps_token_version(client, roles):
    admin = roles["admin"]
    m = _member(client, admin)
    with get_db() as conn:
        before = conn.execute("SELECT token_version FROM users WHERE id = %s", (m["id"],)).fetchone()["token_version"]

    r = client.post(f"/api/team/{m['id']}/revoke", headers=admin["headers"])
    assert r.status_code == 200, r.text

    with get_db() as conn:
        row = conn.execute("SELECT token_version, disabled_at FROM users WHERE id = %s", (m["id"],)).fetchone()
    assert row["disabled_at"] is not None
    assert int(row["token_version"]) == int(before) + 1


def test_revoking_is_idempotent(client, roles):
    admin = roles["admin"]
    m = _member(client, admin)
    client.post(f"/api/team/{m['id']}/revoke", headers=admin["headers"])
    r = client.post(f"/api/team/{m['id']}/revoke", headers=admin["headers"])
    assert r.status_code == 200 and r.json()["already_revoked"] is True


def test_admin_cannot_revoke_themselves(client, roles):
    """Self-revoke is an instant, unrecoverable lockout."""
    admin = roles["admin"]
    with get_db() as conn:
        uid = conn.execute("SELECT id FROM users WHERE email = %s", (admin["email"],)).fetchone()["id"]
    r = client.post(f"/api/team/{uid}/revoke", headers=admin["headers"])
    assert r.status_code == 400
    assert "your own" in r.json()["detail"].lower()


def test_an_org_always_keeps_an_active_admin(client, roles):
    """The invariant that makes an explicit "last admin" guard unnecessary: the
    caller is always an active admin of the org, and can never be the target, so
    whoever is left after a revoke includes at least the person who did it.

    Walk it: two admins, each revokes toward the other until only one remains, and
    that one cannot remove themselves."""
    admin = roles["admin"]
    second = _member(client, admin, role="admin")
    with get_db() as conn:
        admin_id = conn.execute("SELECT id FROM users WHERE email = %s",
                                (admin["email"],)).fetchone()["id"]

    # The second admin removes the first — fine, `second` is still standing.
    assert client.post(f"/api/team/{admin_id}/revoke",
                       headers=second["headers"]).status_code == 200
    # The first admin's session is dead immediately.
    assert client.get("/api/team", headers=admin["headers"]).status_code == 401
    # `second` is now the only active admin, and cannot remove themselves.
    r = client.post(f"/api/team/{second['id']}/revoke", headers=second["headers"])
    assert r.status_code == 400 and "your own" in r.json()["detail"].lower()

    members = client.get("/api/team", headers=second["headers"]).json()["members"]
    assert [m for m in members if m["active"] and m["role"] == "admin"]


def test_non_admin_cannot_revoke(client, roles):
    admin, editor = roles["admin"], roles["editor"]
    m = _member(client, admin)
    r = client.post(f"/api/team/{m['id']}/revoke", headers=editor["headers"])
    assert r.status_code == 403


def test_cannot_revoke_a_user_in_another_org(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    victim = _member(client, b)
    r = client.post(f"/api/team/{victim['id']}/revoke", headers=a["headers"])
    assert r.status_code == 404
    # ...and they are untouched.
    assert client.get("/api/authority/agents", headers=victim["headers"]).status_code == 200


# ── 4. The roster ─────────────────────────────────────────────────────────────

def test_team_list_is_org_scoped_and_flags_self(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    mine = _member(client, a)
    theirs = _member(client, b)

    r = client.get("/api/team", headers=a["headers"])
    assert r.status_code == 200, r.text
    emails = {m["email"] for m in r.json()["members"]}
    assert mine["email"] in emails
    assert theirs["email"] not in emails
    assert sum(1 for m in r.json()["members"] if m["is_self"]) == 1
    assert all(m["active"] for m in r.json()["members"])


def test_team_list_shows_revoked_state(client, roles):
    admin = roles["admin"]
    m = _member(client, admin)
    client.post(f"/api/team/{m['id']}/revoke", headers=admin["headers"])

    members = client.get("/api/team", headers=admin["headers"]).json()["members"]
    revoked = next(x for x in members if x["email"] == m["email"])
    assert revoked["active"] is False and revoked["disabled_at"]


def test_team_list_is_admin_only(client, roles):
    """A GET, so the mutating-method RBAC middleware doesn't cover it — the
    handler has to gate itself (same shape as notification settings)."""
    assert client.get("/api/team", headers=roles["viewer"]["headers"]).status_code == 403
    assert client.get("/api/team", headers=roles["editor"]["headers"]).status_code == 403
    assert client.get("/api/team", headers=roles["admin"]["headers"]).status_code == 200
