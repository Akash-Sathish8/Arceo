"""PR 1B — HIGH-002: LLM prompt/response PII in audit_log.detail.

The two LLM-capture paths now (a) redact PII before storing and (b) route the
detail column through the encryption-at-rest seam that already protects
execution_log.params. The tamper-evident hash-chain hashes the PLAINTEXT detail,
so /api/audit/verify stays valid with the flag on OR off, and every spend/display
reader hydrates so encryption is transparent.
"""

from __future__ import annotations

import base64
import os
import uuid

import pytest

import vault
from db import get_db

_MK = base64.b64encode(os.urandom(32)).decode()


@pytest.fixture(autouse=True)
def _master_key(monkeypatch):
    monkeypatch.setenv(vault.MASTER_KEY_ENV, _MK)


def _agent_and_key(client, headers, name):
    aid = client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [
        {"name": "stripe", "service": "stripe", "actions": [
            {"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}]}).json()["id"]
    key = client.post("/api/keys", headers=headers, json={"name": "k", "agent_id": aid}).json()["key"]
    return aid, key


def _llm_call(client, key, aid, system="hi", usage=None):
    payload = {"provider": "anthropic", "model": "claude-3-5-sonnet-20241022", "system": system,
               "response": {"usage": usage or {"input_tokens": 1000, "output_tokens": 500}}}
    return client.post(f"/api/agent/{aid}/llm-call", headers={"X-API-Key": key}, json=payload)


PII_SYSTEM = "Reach me at jane.doe@example.com or SSN 123-45-6789."


def test_llm_pii_is_redacted_before_storage(client, roles):
    """MED-013 moved the prompt body out of audit_log.detail into the purgeable
    llm_captures table, so this now asserts the stronger pair: the raw PII is in
    NEITHER place, and the redaction markers are in the store that actually holds
    the content."""
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "pii-" + uuid.uuid4().hex[:5])
    assert _llm_call(client, key, aid, system=PII_SYSTEM).status_code == 200
    with get_db() as conn:
        row = conn.execute("SELECT detail FROM audit_log WHERE user_email=%s AND action='LLM_CALL' "
                           "ORDER BY id DESC LIMIT 1", (aid,)).fetchone()
        cap = conn.execute("SELECT content FROM llm_captures WHERE agent_id=%s "
                           "ORDER BY created_at DESC LIMIT 1", (aid,)).fetchone()

    for blob in (row["detail"], cap["content"]):
        assert "jane.doe@example.com" not in blob
        assert "123-45-6789" not in blob
    # The prompt itself lives in the capture, redacted — not in the audit chain.
    assert "[REDACTED_EMAIL]" in cap["content"] and "[REDACTED_SSN]" in cap["content"]
    assert "system" not in row["detail"]


def test_detail_encrypted_at_rest_when_flag_on(client, roles, monkeypatch):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "enc-" + uuid.uuid4().hex[:5])
    assert _llm_call(client, key, aid, system="model instructions here").status_code == 200
    with get_db() as conn:
        row = conn.execute("SELECT detail, detail_enc FROM audit_log WHERE user_email=%s AND action='LLM_CALL' "
                           "ORDER BY id DESC LIMIT 1", (aid,)).fetchone()
    assert row["detail"] is None and row["detail_enc"] is not None
    assert b"model instructions" not in bytes(row["detail_enc"])
    # The read side hydrates back to plaintext and never leaks the bytea column.
    entries = client.get("/api/audit", headers=admin["headers"]).json()["entries"]
    llm = next(e for e in entries if e["action"] == "LLM_CALL")
    assert "detail_enc" not in llm
    # MED-013: the prompt is no longer IN the audit row — the row references it.
    assert "capture_id" in llm["detail"] and "capture_sha256" in llm["detail"]
    assert "model instructions here" not in llm["detail"]

    # ...and the capture itself goes through the same encryption seam.
    with get_db() as conn:
        cap = conn.execute("SELECT content, content_enc FROM llm_captures WHERE agent_id=%s "
                           "ORDER BY created_at DESC LIMIT 1", (aid,)).fetchone()
    assert cap["content"] is None and cap["content_enc"] is not None
    assert b"model instructions" not in bytes(cap["content_enc"])


def test_detail_plaintext_when_flag_off(client, roles, monkeypatch):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "false")
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "pt-" + uuid.uuid4().hex[:5])
    assert _llm_call(client, key, aid, system="plain instructions").status_code == 200
    with get_db() as conn:
        row = conn.execute("SELECT detail, detail_enc FROM audit_log WHERE user_email=%s AND action='LLM_CALL' "
                           "ORDER BY id DESC LIMIT 1", (aid,)).fetchone()
    assert row["detail"] is not None and row["detail_enc"] is None


@pytest.mark.parametrize("flag", ["true", "false"])
def test_audit_chain_verifies_with_encryption_on_or_off(client, roles, monkeypatch, flag):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", flag)
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "chain-" + uuid.uuid4().hex[:5])
    for i in range(3):
        assert _llm_call(client, key, aid, system=f"call {i} secret@x.com").status_code == 200
    v = client.get("/api/audit/verify", headers=admin["headers"]).json()
    assert v["valid"] is True, v


def test_spend_readable_through_encryption(client, roles, monkeypatch):
    # With detail encrypted at rest, month-to-date spend must still compute — the
    # spend readers hydrate, so encryption is transparent to cost forecasting.
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")
    admin = roles["admin"]
    aid, key = _agent_and_key(client, admin["headers"], "spend-" + uuid.uuid4().hex[:5])
    client.put(f"/api/agents/{aid}/budget", headers=admin["headers"],
               json={"monthly_budget_usd": 1000, "alert_threshold_pct": 80})
    for _ in range(3):
        assert _llm_call(client, key, aid, usage={"input_tokens": 50000, "output_tokens": 20000}).status_code == 200
    b = client.get(f"/api/agents/{aid}/budget", headers=admin["headers"]).json()
    assert b["monthToDateUsd"] > 0, b
