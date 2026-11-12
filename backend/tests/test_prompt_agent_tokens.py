"""Agent connections (ap_ keys) and the send inbox, over the REST API (plan §5).

The MCP side of the same features lives in test_prompt_mcp.py."""

from __future__ import annotations

import base64
import hashlib
import os
import uuid
from datetime import datetime, timedelta

import pytest

from db import get_db
from prompts import agent_tokens, sends
from tests.prompt_helpers import signup


def _email(tag: str) -> str:
    return f"{tag}-{uuid.uuid4().hex[:8]}@example.com"


def _prompt(client, org, **over) -> dict:
    body = {"title": f"Thank-you note {uuid.uuid4().hex[:6]}", "description": "A short thank-you.",
            "body": "Write a thank-you note to {{name}} for {{gift}}. Keep it warm.",
            "variables": {"name": {"sample": "Aunt May"}, "gift": {"sample": "the scarf"}}, **over}
    r = client.post("/api/prompts", headers=org["headers"], json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _make_viewer(org) -> None:
    with get_db() as conn:
        conn.execute("UPDATE users SET role = 'viewer' WHERE email = %s", (org["email"],))


def _send_row(send_id: str) -> dict:
    with get_db() as conn:
        return conn.execute("SELECT * FROM prompt_sends WHERE id = %s", (send_id,)).fetchone()


# ── connections ──────────────────────────────────────────────────────────

def test_create_shows_the_key_once_and_stores_only_its_hash(client):
    a = signup(client, _email("tok"))
    r = client.post("/api/prompts/agent-tokens", headers=a["headers"], json={"label": "  Claude   Code "})
    assert r.status_code == 200, r.text
    made = r.json()
    assert set(made) == {"id", "label", "token", "created_at"}
    assert made["label"] == "Claude Code"
    token = made["token"]
    assert token.startswith("ap_") and len(token) == 3 + 43 and agent_tokens.well_formed(token)

    listed = client.get("/api/prompts/agent-tokens", headers=a["headers"]).json()["tokens"]
    assert [t["id"] for t in listed] == [made["id"]]
    assert set(listed[0]) == {"id", "label", "created_at", "last_used_at", "revoked_at"}
    assert token not in str(listed)

    with get_db() as conn:
        row = conn.execute("SELECT * FROM prompt_agent_tokens WHERE id = %s", (made["id"],)).fetchone()
    assert row["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert token not in str(dict(row))
    assert row["org_id"] == a["org_id"] and row["revoked_at"] is None


def test_keys_are_unique_and_labels_have_a_default(client):
    a = signup(client, _email("tok"))
    one = client.post("/api/prompts/agent-tokens", headers=a["headers"], json={}).json()
    two = client.post("/api/prompts/agent-tokens", headers=a["headers"], json={"label": "x" * 150}).json()
    assert one["label"] == agent_tokens.DEFAULT_LABEL
    assert len(two["label"]) == agent_tokens.LABEL_MAX
    assert one["token"] != two["token"] and one["id"] != two["id"]
    assert client.post("/api/prompts/agent-tokens", headers=a["headers"],
                       json={"label": "y" * 201}).status_code == 422


def test_revoke_only_your_own_and_it_is_idempotent(client):
    a = signup(client, _email("tok-a"))
    b = signup(client, _email("tok-b"))
    made = client.post("/api/prompts/agent-tokens", headers=a["headers"], json={"label": "laptop"}).json()

    # Someone else, in another org, can't see or turn it off.
    assert client.get("/api/prompts/agent-tokens", headers=b["headers"]).json()["tokens"] == []
    assert client.delete(f"/api/prompts/agent-tokens/{made['id']}", headers=b["headers"]).status_code == 404
    assert client.delete("/api/prompts/agent-tokens/pat_nope", headers=a["headers"]).status_code == 404

    r = client.delete(f"/api/prompts/agent-tokens/{made['id']}", headers=a["headers"])
    assert r.status_code == 200, r.text
    first = r.json()["revoked_at"]
    assert first
    again = client.delete(f"/api/prompts/agent-tokens/{made['id']}", headers=a["headers"]).json()
    assert again["revoked_at"] == first           # the first revoke time sticks

    listed = client.get("/api/prompts/agent-tokens", headers=a["headers"]).json()["tokens"]
    assert listed[0]["revoked_at"] == first
    assert agent_tokens.resolve(made["token"]) == (None, "revoked")

    with get_db() as conn:
        actions = [r["action"] for r in conn.execute(
            "SELECT action FROM audit_log WHERE resource = %s ORDER BY id", (made["id"],)).fetchall()]
    assert actions[0] == "CREATE_PROMPT_AGENT_TOKEN" and "REVOKE_PROMPT_AGENT_TOKEN" in actions


def test_a_teammate_cannot_revoke_your_connection(client):
    a = signup(client, _email("team-a"))
    made = client.post("/api/prompts/agent-tokens", headers=a["headers"], json={}).json()
    # A second user in the SAME org (an admin, even).
    mate_email = _email("team-b")
    from auth import create_token, hash_password
    mate_id = uuid.uuid4().hex[:12]
    with get_db() as conn:
        conn.execute("INSERT INTO users (id, email, password_hash, name, role, org_id, created_at) "
                     "VALUES (%s, %s, %s, %s, 'admin', %s, %s)",
                     (mate_id, mate_email, hash_password("pw12345678"), "mate", a["org_id"],
                      datetime.utcnow().isoformat()))
    mate = {"Authorization": f"Bearer {create_token(mate_id, mate_email, 'admin', a['org_id'])}"}
    assert client.get("/api/prompts/agent-tokens", headers=mate).json()["tokens"] == []
    assert client.delete(f"/api/prompts/agent-tokens/{made['id']}", headers=mate).status_code == 404
    assert agent_tokens.resolve(made["token"])[0] is not None


def test_viewers_can_list_but_not_create_or_send(client):
    a = signup(client, _email("viewer"))
    pid = _prompt(client, a)["id"]
    _make_viewer(a)
    assert client.get("/api/prompts/agent-tokens", headers=a["headers"]).status_code == 200
    assert client.get("/api/prompts/sends", headers=a["headers"]).status_code == 200
    assert client.post("/api/prompts/agent-tokens", headers=a["headers"], json={}).status_code == 403
    assert client.post(f"/api/prompts/{pid}/send", headers=a["headers"], json={"values": {}}).status_code == 403
    assert client.post("/api/prompts/sends/test", headers=a["headers"]).status_code == 403


def test_active_connection_cap(client, monkeypatch):
    monkeypatch.setattr(agent_tokens, "MAX_ACTIVE_PER_USER", 2)
    a = signup(client, _email("cap"))
    made = [client.post("/api/prompts/agent-tokens", headers=a["headers"], json={}).json() for _ in range(2)]
    r = client.post("/api/prompts/agent-tokens", headers=a["headers"], json={})
    assert r.status_code == 409 and "Turn one off" in r.json()["detail"]
    client.delete(f"/api/prompts/agent-tokens/{made[0]['id']}", headers=a["headers"])
    assert client.post("/api/prompts/agent-tokens", headers=a["headers"], json={}).status_code == 200


def test_endpoints_need_sign_in(client):
    assert client.get("/api/prompts/agent-tokens").status_code == 401
    assert client.post("/api/prompts/agent-tokens", json={}).status_code == 401
    assert client.get("/api/prompts/sends").status_code == 401
    # An ap_ key is for /mcp only; the REST API never takes it.
    a = signup(client, _email("rest"))
    token = client.post("/api/prompts/agent-tokens", headers=a["headers"], json={}).json()["token"]
    assert client.get("/api/prompts/sends", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_resolve_rejects_bad_shapes_without_touching_the_db():
    for bad in (None, "", "ap_", "ap_short", "Bearer ap_x", "xx_" + "a" * 43, "ap_" + "a" * 43 + "!",
                "ap_" + "a" * 65):
        assert agent_tokens.resolve(bad) == (None, "invalid")


def test_deactivated_user_keys_stop_working(client):
    a = signup(client, _email("off"))
    token = client.post("/api/prompts/agent-tokens", headers=a["headers"], json={}).json()["token"]
    assert agent_tokens.resolve(token)[0] is not None
    with get_db() as conn:
        conn.execute("UPDATE users SET disabled_at = %s WHERE email = %s", (datetime.utcnow().isoformat(), a["email"]))
    assert agent_tokens.resolve(token) == (None, "invalid")


def test_last_used_is_touched_at_most_once_a_minute(client):
    a = signup(client, _email("touch"))
    made = client.post("/api/prompts/agent-tokens", headers=a["headers"], json={}).json()
    caller, _ = agent_tokens.resolve(made["token"])
    assert caller.user_id and caller.org_id == a["org_id"] and caller.token_id == made["id"]

    def last_used():
        with get_db() as conn:
            return conn.execute("SELECT last_used_at FROM prompt_agent_tokens WHERE id = %s",
                                (made["id"],)).fetchone()["last_used_at"]

    first = last_used()
    assert first
    agent_tokens.resolve(made["token"])
    assert last_used() == first                     # within the minute: no write
    old = (datetime.utcnow() - timedelta(minutes=5)).isoformat()
    with get_db() as conn:
        conn.execute("UPDATE prompt_agent_tokens SET last_used_at = %s WHERE id = %s", (old, made["id"]))
    agent_tokens.resolve(made["token"])
    assert last_used() > old


# ── sending ──────────────────────────────────────────────────────────────

def test_send_fills_blanks_and_keeps_missing_ones(client):
    a = signup(client, _email("send"))
    p = _prompt(client, a)
    r = client.post(f"/api/prompts/{p['id']}/send", headers=a["headers"],
                    json={"values": {"name": "Sam", "gift": "   ", "extra": "ignored"}})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["unfilled"] == ["gift"]
    row = _send_row(out["id"])
    assert row["text"] == "Write a thank-you note to Sam for {{gift}}. Keep it warm."
    assert row["user_id"] and row["org_id"] == a["org_id"] and row["prompt_id"] == p["id"]
    assert row["title"] == p["title"] and row["delivered_at"] is None
    made = datetime.fromisoformat(row["created_at"])
    assert datetime.fromisoformat(out["expires_at"]) - made == timedelta(hours=24)
    assert out["expires_at"] == row["expires_at"]


def test_fill_is_one_pass():
    body = "Hi {{name}}, about {{ topic }}: {{name}}."
    assert sends.fill(body, {"name": "{{topic}}", "topic": "pay"}) == "Hi {{topic}}, about pay: {{topic}}."
    assert sends.fill(body, {}) == body
    assert sends.unfilled(body, {"name": "x"}) == ["topic"]


def test_sends_list_shows_status_and_a_short_preview_only(client):
    a = signup(client, _email("list"))
    long_note = "word " * 200
    p = _prompt(client, a, body="Summarize this for me:\n<notes>\n{{notes}}\n</notes>",
                variables={"notes": {"sample": "x"}})
    sent = client.post(f"/api/prompts/{p['id']}/send", headers=a["headers"],
                       json={"values": {"notes": long_note}}).json()
    listed = client.get("/api/prompts/sends", headers=a["headers"]).json()["sends"]
    assert [s["id"] for s in listed] == [sent["id"]]
    item = listed[0]
    assert item["status"] == "waiting" and item["delivered_at"] is None
    assert item["prompt_id"] == p["id"] and item["title"] == p["title"]
    assert "text" not in item and "text_enc" not in item
    assert len(item["preview"]) <= sends.PREVIEW_CHARS and item["preview"].startswith("Summarize this for me:")
    assert long_note.strip() not in str(item)

    # Nobody else sees it.
    b = signup(client, _email("list-b"))
    assert client.get("/api/prompts/sends", headers=b["headers"]).json()["sends"] == []

    with get_db() as conn:
        conn.execute("UPDATE prompt_sends SET expires_at = %s WHERE id = %s",
                     ((datetime.utcnow() - timedelta(minutes=1)).isoformat(), sent["id"]))
    assert client.get("/api/prompts/sends", headers=a["headers"]).json()["sends"][0]["status"] == "expired"
    assert client.get("/api/prompts/sends?limit=0", headers=a["headers"]).status_code == 422


def test_send_uses_the_same_visibility_as_reading_a_prompt(client):
    a = signup(client, _email("vis-a"))
    b = signup(client, _email("vis-b"))
    private = _prompt(client, a)
    assert client.post(f"/api/prompts/{private['id']}/send", headers=b["headers"],
                       json={"values": {}}).status_code == 404
    assert client.post("/api/prompts/pr_missing/send", headers=a["headers"], json={"values": {}}).status_code == 404

    shared = _prompt(client, a, title=f"Shared note {uuid.uuid4().hex[:6]}")
    r = client.post(f"/api/prompts/{shared['id']}/publish", headers=a["headers"], json={"visibility": "public"})
    assert r.status_code == 200, r.text
    # The author keeps editing; another org gets the PUBLISHED text, never the draft.
    upd = {k: shared[k] for k in ("title", "description", "use_case")}
    r = client.put(f"/api/prompts/{shared['id']}", headers=a["headers"],
                   json={**upd, "body": "DRAFT ONLY {{name}}", "variables": {}})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/prompts/{shared['id']}/send", headers=b["headers"],
                    json={"values": {"name": "Bo", "gift": "tea"}})
    assert r.status_code == 200, r.text
    row = _send_row(r.json()["id"])
    assert row["text"] == "Write a thank-you note to Bo for tea. Keep it warm."
    assert row["org_id"] == b["org_id"]


def test_send_size_limits(client):
    a = signup(client, _email("size"))
    p = _prompt(client, a)
    r = client.post(f"/api/prompts/{p['id']}/send", headers=a["headers"],
                    json={"values": {"name": "x" * (sends.MAX_VALUES_CHARS + 1)}})
    assert r.status_code == 413 and "100,000" in r.json()["detail"]
    # Just under the cap is fine.
    r = client.post(f"/api/prompts/{p['id']}/send", headers=a["headers"],
                    json={"values": {"name": "x" * (sends.MAX_VALUES_CHARS - 10)}})
    assert r.status_code == 200, r.text
    # A value used many times can't blow the filled text past its own cap.
    many = _prompt(client, a, body=" ".join(["{{v}}"] * 5), variables={})
    r = client.post(f"/api/prompts/{many['id']}/send", headers=a["headers"],
                    json={"values": {"v": "y" * 90_000}})
    assert r.status_code == 413
    with pytest.raises(sends.SendError):
        sends.check_values({"k": "z" * (sends.MAX_VALUES_CHARS + 1)})


def test_send_counts_one_use_per_ten_minutes(client):
    a = signup(client, _email("use"))
    p = _prompt(client, a)
    for _ in range(2):
        assert client.post(f"/api/prompts/{p['id']}/send", headers=a["headers"],
                           json={"values": {}}).status_code == 200
    assert client.get(f"/api/prompts/{p['id']}", headers=a["headers"]).json()["use_count"] == 1
    # /use after a send inside the window doesn't double count either.
    client.post(f"/api/prompts/{p['id']}/use", headers=a["headers"])
    assert client.get(f"/api/prompts/{p['id']}", headers=a["headers"]).json()["use_count"] == 1


def test_waiting_cap_and_cleanup(client, monkeypatch):
    monkeypatch.setattr(sends, "MAX_WAITING_PER_USER", 2)
    a = signup(client, _email("cap-send"))
    p = _prompt(client, a)
    ids = [client.post(f"/api/prompts/{p['id']}/send", headers=a["headers"], json={"values": {}}).json()["id"]
           for _ in range(2)]
    r = client.post(f"/api/prompts/{p['id']}/send", headers=a["headers"], json={"values": {}})
    assert r.status_code == 429 and "waiting" in r.json()["detail"]
    # Long-expired sends are purged on the next send, and don't count as waiting.
    long_ago = (datetime.utcnow() - timedelta(days=sends.KEEP_DAYS + 2)).isoformat()
    with get_db() as conn:
        conn.execute("UPDATE prompt_sends SET expires_at = %s WHERE id = %s", (long_ago, ids[0]))
    assert client.post(f"/api/prompts/{p['id']}/send", headers=a["headers"], json={"values": {}}).status_code == 200
    with get_db() as conn:
        assert conn.execute("SELECT 1 FROM prompt_sends WHERE id = %s", (ids[0],)).fetchone() is None


def test_test_send_is_a_harmless_canned_prompt(client):
    a = signup(client, _email("ping"))
    r = client.post("/api/prompts/sends/test", headers=a["headers"])
    assert r.status_code == 200, r.text
    row = _send_row(r.json()["id"])
    assert row["prompt_id"] is None and row["title"] == sends.TEST_TITLE and row["text"] == sends.TEST_TEXT
    assert client.get("/api/prompts/sends", headers=a["headers"]).json()["sends"][0]["title"] == sends.TEST_TITLE


def test_send_rate_limit(client, monkeypatch):
    from prompts import agent_router
    monkeypatch.setattr(agent_router, "RATE_LIMIT_SEND_MAX", 2)
    a = signup(client, _email("rl"))
    codes = [client.post("/api/prompts/sends/test", headers=a["headers"]).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


# ── encryption seam ──────────────────────────────────────────────────────

def test_send_text_is_encrypted_at_rest_when_the_flag_is_on(client, monkeypatch):
    import vault
    monkeypatch.setenv(vault.MASTER_KEY_ENV, base64.b64encode(os.urandom(32)).decode())
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")
    a = signup(client, _email("enc"))
    p = _prompt(client, a)
    sent = client.post(f"/api/prompts/{p['id']}/send", headers=a["headers"],
                       json={"values": {"name": "Secret Sam", "gift": "the vase"}}).json()
    row = _send_row(sent["id"])
    assert row["text"] is None and row["text_enc"] is not None
    assert b"Secret Sam" not in bytes(row["text_enc"])
    # The read side decrypts: the list preview and the agent's copy are plaintext.
    item = client.get("/api/prompts/sends", headers=a["headers"]).json()["sends"][0]
    assert "Secret Sam" in item["preview"] and "text_enc" not in item
    got = sends.claim_next(row["user_id"], a["org_id"])
    assert got["id"] == sent["id"] and "Secret Sam" in got["text"] and "text_enc" not in got


def test_send_text_is_plain_with_no_enc_twin_when_the_flag_is_off(client, monkeypatch):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "false")
    a = signup(client, _email("plain"))
    p = _prompt(client, a)
    sent = client.post(f"/api/prompts/{p['id']}/send", headers=a["headers"], json={"values": {"name": "Al"}}).json()
    row = _send_row(sent["id"])
    assert row["text_enc"] is None and row["text"].startswith("Write a thank-you note to Al")


def test_claim_rolls_back_when_the_text_cannot_be_read(client, monkeypatch):
    import vault
    monkeypatch.setenv(vault.MASTER_KEY_ENV, base64.b64encode(os.urandom(32)).decode())
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")
    a = signup(client, _email("badkey"))
    sent = client.post("/api/prompts/sends/test", headers=a["headers"]).json()
    user_id = _send_row(sent["id"])["user_id"]
    monkeypatch.setenv(vault.MASTER_KEY_ENV, base64.b64encode(os.urandom(32)).decode())   # wrong key now
    with pytest.raises(Exception):
        sends.claim_next(user_id, a["org_id"])
    assert _send_row(sent["id"])["delivered_at"] is None     # still waiting, not lost


# ── routing ──────────────────────────────────────────────────────────────

def test_every_agent_route_and_mcp_win_dispatch():
    """Nothing registered earlier (GET /api/prompts/{prompt_id}, the SPA catch-all)
    swallows these paths."""
    import re

    from fastapi.routing import APIRoute
    from starlette.routing import Match

    import main
    from prompts import agent_router, mcp_server

    def first(method, path):
        scope = {"type": "http", "method": method, "path": path, "root_path": "", "query_string": b"", "headers": []}
        return next((r for r in main.app.router.routes if r.matches(scope)[0] == Match.FULL), None)

    routes = [r for r in agent_router.router.routes if isinstance(r, APIRoute)]
    assert {(m, r.path) for r in routes for m in r.methods} == {
        ("GET", "/api/prompts/agent-tokens"), ("POST", "/api/prompts/agent-tokens"),
        ("DELETE", "/api/prompts/agent-tokens/{token_id}"), ("GET", "/api/prompts/sends"),
        ("POST", "/api/prompts/sends/test"), ("POST", "/api/prompts/{prompt_id}/send")}
    for r in routes:
        for m in r.methods:
            hit = first(m, re.sub(r"\{[^}]+\}", "pr_sample", r.path))
            assert hit is not None and hit.endpoint is r.endpoint, (m, r.path)
    for m in ("POST", "GET", "DELETE"):
        hit = first(m, "/mcp")
        assert hit is not None and isinstance(hit.app, mcp_server._Endpoint), m
