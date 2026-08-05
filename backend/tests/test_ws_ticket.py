"""MED-002 — the live-trace socket took a full session JWT in the query string.

A browser cannot set headers on a WebSocket handshake, so the socket's credential
has to travel in the URL. What travelled was a 24-hour bearer token for the entire
API — and URLs are the least private part of a request: access logs, proxy and
load-balancer logs, `Referer`, browser history. None of those are secret stores,
and all of them outlive the request that created them.

Replaced with a ticket that is opaque, ~30 seconds long, single-use, and bound to
one agent. Leaking the URL after the socket opens leaks nothing, because redeeming
consumed it.

The cutover is deliberate: `?token=` is no longer accepted at all. Nothing in the
repo opened this socket (no frontend, SDK or website code), so there was no client
to migrate — and continuing to honour the JWT would have left the finding open.
"""

from __future__ import annotations

import json
import uuid

import pytest

import shared_state


def _agent(client, headers, name_prefix="wsticket") -> str:
    r = client.post("/api/authority/agents", headers=headers, json={
        "name": f"{name_prefix}-{uuid.uuid4().hex[:6]}", "tools": []})
    assert r.status_code == 200, r.text
    body = r.json()
    return body["agent"]["id"] if "agent" in body else body["id"]


def _mint(client, headers, agent_id):
    return client.post("/api/ws-ticket", headers=headers, json={"agent_id": agent_id})


# ── The cutover ───────────────────────────────────────────────────────────────

def test_jwt_in_the_query_string_is_no_longer_accepted(client, roles):
    """The finding itself. If this ever passes again, the JWT is back in URLs."""
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/traces/{aid}?token={admin['token']}"):
            pass


def test_socket_without_any_credential_is_refused(client, roles):
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/traces/{aid}"):
            pass


# ── Minting ───────────────────────────────────────────────────────────────────

def test_mint_requires_authentication(client, roles):
    aid = _agent(client, roles["admin"]["headers"])
    assert client.post("/api/ws-ticket", json={"agent_id": aid}).status_code == 401


def test_mint_refuses_an_agent_from_another_org(client, two_orgs):
    """The ticket must not become a way around tenant scoping."""
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    aid = _agent(client, a["headers"])
    assert _mint(client, b["headers"], aid).status_code == 404


def test_minted_ticket_is_opaque_and_short_lived(client, roles):
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    body = _mint(client, admin["headers"], aid).json()

    assert body["expires_in"] == shared_state.WS_TICKET_TTL_SECONDS
    assert body["expires_in"] <= 120, "a ticket this long stops being a ticket"
    # Not a JWT, not derived from one: no dots, no 'eyJ' header, and it carries no
    # readable claims.
    assert "." not in body["ticket"]
    assert not body["ticket"].startswith("eyJ")
    assert admin["token"] not in body["ticket"]
    assert len(body["ticket"]) >= 32


# ── Redeeming ─────────────────────────────────────────────────────────────────

def test_ticket_opens_the_socket(client, roles):
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    ticket = _mint(client, admin["headers"], aid).json()["ticket"]
    with client.websocket_connect(f"/ws/traces/{aid}?ticket={ticket}") as ws:
        assert ws is not None


def test_ticket_is_single_use(client, roles):
    """The whole point: once redeemed, a leaked URL is worthless. Redeem is an
    atomic GETDEL, so this holds even for two handshakes racing."""
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    ticket = _mint(client, admin["headers"], aid).json()["ticket"]

    with client.websocket_connect(f"/ws/traces/{aid}?ticket={ticket}"):
        pass
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/traces/{aid}?ticket={ticket}"):
            pass


def test_unknown_or_expired_ticket_is_refused(client, roles):
    """Expiry is a Redis TTL, so an expired ticket is indistinguishable from one
    that never existed — this covers both."""
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/traces/{aid}?ticket=not-a-real-ticket"):
            pass


def test_ticket_for_one_agent_cannot_open_another(client, roles):
    """Bound to the agent, not just the caller — otherwise any ticket would open
    every stream in the org."""
    admin = roles["admin"]
    a1 = _agent(client, admin["headers"], "wsticket-a")
    a2 = _agent(client, admin["headers"], "wsticket-b")
    ticket = _mint(client, admin["headers"], a1).json()["ticket"]

    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/traces/{a2}?ticket={ticket}"):
            pass


def test_a_malformed_ticket_payload_is_refused(client, roles):
    """Defensive: the redeem path json-decodes whatever it finds under the key."""
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    ticket = "garbage-" + uuid.uuid4().hex
    shared_state.ws_ticket_store(ticket, "this is not json")

    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/traces/{aid}?ticket={ticket}"):
            pass


# ── Failure posture ───────────────────────────────────────────────────────────

def test_redis_failure_fails_closed(client, roles, monkeypatch):
    """A credential check that cannot run must not wave the connection through —
    same posture as rate_limit_ok's default (MED-007)."""
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    ticket = _mint(client, admin["headers"], aid).json()["ticket"]

    def _down(*_a, **_k):
        raise RuntimeError("redis is unreachable")

    monkeypatch.setattr(shared_state, "ws_ticket_redeem", _down)
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/traces/{aid}?ticket={ticket}"):
            pass


def test_mint_reports_unavailable_when_the_store_is_down(client, roles, monkeypatch):
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])

    def _down(*_a, **_k):
        raise RuntimeError("redis is unreachable")

    monkeypatch.setattr(shared_state, "ws_ticket_store", _down)
    r = _mint(client, admin["headers"], aid)
    assert r.status_code == 503
    # MED-016: a reference, not the underlying exception text.
    assert "ref:" in r.json()["detail"]
    assert "redis is unreachable" not in r.json()["detail"]


# ── The store itself ──────────────────────────────────────────────────────────

def test_redeem_consumes_the_key():
    ticket = "unit-" + uuid.uuid4().hex
    shared_state.ws_ticket_store(ticket, json.dumps({"sub": "u1"}))
    assert json.loads(shared_state.ws_ticket_redeem(ticket))["sub"] == "u1"
    assert shared_state.ws_ticket_redeem(ticket) is None


def test_redeem_of_empty_string_is_none():
    assert shared_state.ws_ticket_redeem("") is None
