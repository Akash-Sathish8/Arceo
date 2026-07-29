"""MED-013 — captured LLM content is purgeable without breaking the audit chain.

Both capture paths wrote the system prompt and the full response body into
`audit_log.detail`. `audit_log` is append-only by trigger (0007) for EVERY role
including superuser, so that content could never be deleted: no TTL, no purge, no
answer to a GDPR erasure request — by construction, not by oversight.

Content now goes to `llm_captures`, which has no such trigger. The audit row keeps
the metadata, the token usage the cost engine prices from, and a SHA-256 of what
was captured. So a purge is an ordinary DELETE, the chain never notices, and the
row still attests to what WAS there without retaining it.

The cost-engine assertions here are load-bearing: `_extract_usage` reads exactly
`detail["response"]["usage"]`, so if the split ever moved that, historical spend
would silently evaporate when a capture is purged.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

import pytest

import main
from db import get_db
from jobs.purge_llm_captures import (
    erase_captures_for_agent, purge_expired_captures, retention_days,
)


def _agent_and_key(client, headers, name):
    aid = client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [
        {"name": "stripe", "service": "stripe", "actions": [
            {"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}]}).json()["id"]
    key = client.post("/api/keys", headers=headers, json={"name": "k", "agent_id": aid}).json()["key"]
    return aid, key


def _llm_call(client, key, aid, system="secret prompt", text="secret answer"):
    payload = {
        "provider": "anthropic", "model": "claude-3-5-sonnet-20241022",
        "system": system,
        "response": {
            "id": "msg_1",
            "content": [{"type": "text", "text": text}],
            "usage": {"input_tokens": 1000, "output_tokens": 500},
        },
    }
    return client.post(f"/api/agent/{aid}/llm-call", headers={"X-API-Key": key}, json=payload)


def _audit_detail(aid) -> dict:
    with get_db() as conn:
        rows = main._hydrate_audit_rows(conn.execute(
            "SELECT detail, detail_enc FROM audit_log WHERE user_email=%s AND action='LLM_CALL' "
            "ORDER BY id DESC LIMIT 1", (aid,)).fetchall())
    return json.loads(rows[0]["detail"])


# ── The split itself ──────────────────────────────────────────────────────────

def test_split_keeps_usage_and_moves_bodies():
    """Unit-level, because this is the part that would silently break the cost
    engine if it drifted."""
    payload = {
        "provider": "anthropic", "model": "claude-x", "system": "SYSTEM TEXT",
        "latency_ms": 12, "max_tokens": 100,
        "response": {"id": "msg_1", "content": [{"type": "text", "text": "BODY TEXT"}],
                     "usage": {"input_tokens": 10, "output_tokens": 5}},
    }
    detail, content = main._split_capture(payload)

    # Chained forever: metadata + the counts the forecaster prices from.
    assert detail["response"]["usage"] == {"input_tokens": 10, "output_tokens": 5}
    assert detail["provider"] == "anthropic" and detail["latency_ms"] == 12
    # Purgeable: everything that is actually content.
    assert content["system"] == "SYSTEM TEXT"
    assert content["response"]["content"][0]["text"] == "BODY TEXT"
    # And no content leaked into the chained half.
    assert "SYSTEM TEXT" not in json.dumps(detail)
    assert "BODY TEXT" not in json.dumps(detail)


def test_split_is_a_noop_when_there_is_no_content():
    detail, content = main._split_capture(
        {"provider": "openai", "response": {"usage": {"prompt_tokens": 3}}})
    assert content == {}
    assert detail["response"]["usage"] == {"prompt_tokens": 3}


def test_capture_path_writes_bodies_outside_the_audit_row(client, roles):
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "cap-" + uuid.uuid4().hex[:5])
    assert _llm_call(client, key, aid).status_code == 200

    detail = _audit_detail(aid)
    assert "secret prompt" not in json.dumps(detail)
    assert "secret answer" not in json.dumps(detail)
    assert detail["capture_id"] and detail["capture_sha256"]

    with get_db() as conn:
        cap = conn.execute("SELECT * FROM llm_captures WHERE id=%s",
                           (detail["capture_id"],)).fetchone()
    assert cap is not None
    assert cap["content_sha256"] == detail["capture_sha256"]


def test_the_cost_engine_still_prices_a_captured_call(client, roles):
    """The whole reason `response.usage` stays in the audit row."""
    from analysis.spend_forecast import compute_month_to_date_spend, load_defaults

    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "cost-" + uuid.uuid4().hex[:5])
    assert _llm_call(client, key, aid).status_code == 200

    with get_db() as conn:
        rows = main._hydrate_audit_rows(conn.execute(
            "SELECT detail, detail_enc, timestamp FROM audit_log "
            "WHERE user_email=%s AND action='LLM_CALL'", (aid,)).fetchall())
    assert compute_month_to_date_spend(rows, defaults=load_defaults()) > 0


# ── Retention ─────────────────────────────────────────────────────────────────

def test_expired_captures_are_purged(client, roles):
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "old-" + uuid.uuid4().hex[:5])
    assert _llm_call(client, key, aid).status_code == 200
    cid = _audit_detail(aid)["capture_id"]

    with get_db() as conn:
        conn.execute("UPDATE llm_captures SET created_at=%s WHERE id=%s",
                     ((datetime.utcnow() - timedelta(days=retention_days() + 5)).isoformat(), cid))
        result = purge_expired_captures(conn)
        assert result["purged"] >= 1
        assert conn.execute("SELECT 1 FROM llm_captures WHERE id=%s", (cid,)).fetchone() is None


def test_fresh_captures_survive_the_sweep(client, roles):
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "new-" + uuid.uuid4().hex[:5])
    assert _llm_call(client, key, aid).status_code == 200
    cid = _audit_detail(aid)["capture_id"]

    with get_db() as conn:
        purge_expired_captures(conn)
        assert conn.execute("SELECT 1 FROM llm_captures WHERE id=%s", (cid,)).fetchone() is not None


def test_dry_run_counts_without_deleting(client, roles):
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "dry-" + uuid.uuid4().hex[:5])
    assert _llm_call(client, key, aid).status_code == 200
    cid = _audit_detail(aid)["capture_id"]

    with get_db() as conn:
        conn.execute("UPDATE llm_captures SET created_at=%s WHERE id=%s",
                     ((datetime.utcnow() - timedelta(days=retention_days() + 5)).isoformat(), cid))
        result = purge_expired_captures(conn, dry_run=True)
        assert result["purged"] >= 1
        assert conn.execute("SELECT 1 FROM llm_captures WHERE id=%s", (cid,)).fetchone() is not None


def test_retention_can_be_disabled(monkeypatch):
    monkeypatch.setenv("ARCEO_CAPTURE_RETENTION_DAYS", "0")
    with get_db() as conn:
        result = purge_expired_captures(conn)
    assert result["enabled"] is False and result["purged"] == 0


# ── Erasure, and the chain surviving it ───────────────────────────────────────

def test_per_subject_erasure_removes_content(client, roles):
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "erase-" + uuid.uuid4().hex[:5])
    for _ in range(3):
        assert _llm_call(client, key, aid).status_code == 200

    with get_db() as conn:
        n = erase_captures_for_agent(conn, admin["org_id"], aid)
        assert n == 3
        assert conn.execute("SELECT COUNT(*) AS n FROM llm_captures WHERE agent_id=%s",
                            (aid,)).fetchone()["n"] == 0


def test_audit_chain_still_verifies_after_a_purge(client, roles):
    """The finding's own verification: content older than the window is purged and
    GET /api/audit/verify still validates."""
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "chain-" + uuid.uuid4().hex[:5])
    for _ in range(3):
        assert _llm_call(client, key, aid).status_code == 200

    before = client.get("/api/audit/verify", headers=admin["headers"])
    assert before.status_code == 200 and before.json()["valid"] is True

    with get_db() as conn:
        conn.execute("UPDATE llm_captures SET created_at=%s WHERE agent_id=%s",
                     ((datetime.utcnow() - timedelta(days=retention_days() + 5)).isoformat(), aid))
        purge_expired_captures(conn)

    after = client.get("/api/audit/verify", headers=admin["headers"])
    assert after.status_code == 200, after.text
    assert after.json()["valid"] is True
    # The row survives the purge, still attesting to what was captured.
    detail = _audit_detail(aid)
    assert detail["capture_sha256"]


def test_the_audit_row_outlives_its_capture(client, roles):
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "outlive-" + uuid.uuid4().hex[:5])
    assert _llm_call(client, key, aid).status_code == 200
    detail_before = _audit_detail(aid)

    with get_db() as conn:
        erase_captures_for_agent(conn, admin["org_id"], aid)

    detail_after = _audit_detail(aid)
    assert detail_after == detail_before  # untouched — that's why the chain holds


def test_captures_are_org_scoped(client, two_orgs):
    """RLS is FORCE'd on the new table like every other one."""
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    aid, key = _agent_and_key(client, a["headers"], "scoped-" + uuid.uuid4().hex[:5])
    assert _llm_call(client, key, aid).status_code == 200

    with get_db() as conn:
        # Org B's erasure must not reach org A's captures.
        assert erase_captures_for_agent(conn, b["org_id"], aid) == 0
        assert conn.execute("SELECT COUNT(*) AS n FROM llm_captures WHERE agent_id=%s",
                            (aid,)).fetchone()["n"] == 1


def test_append_only_trigger_still_guards_the_audit_log(client, roles):
    """The capture table is deletable; audit_log must NOT have become so."""
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "trig-" + uuid.uuid4().hex[:5])
    assert _llm_call(client, key, aid).status_code == 200

    with pytest.raises(Exception):
        with get_db() as conn:
            conn.execute("DELETE FROM audit_log WHERE user_email=%s", (aid,))
