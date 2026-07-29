"""Post-roadmap PR-2: encryption-at-rest generalized — execution params, the
reusable seam, master-key rotation, and a backfill for existing plaintext rows.

Extends the Phase-5 pending_requests coverage. The flag stays default OFF; these
exercise the flag-ON path plus the rotation/backfill machinery that makes flipping
it a no-drama, reviewed operation.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import sys
import uuid
from pathlib import Path

import pytest

import encryption
import vault
from db import get_db, log_execution

_TEST_MASTER_KEY = base64.b64encode(os.urandom(32)).decode()
_SCRIPTS = Path(__file__).resolve().parent.parent.parent / "scripts"


@pytest.fixture(autouse=True)
def _master_key(monkeypatch):
    monkeypatch.setenv(vault.MASTER_KEY_ENV, _TEST_MASTER_KEY)


def _load_script(name):
    spec = importlib.util.spec_from_file_location(name, _SCRIPTS / name)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── the seam ──────────────────────────────────────────────────────────────────

def test_split_and_read_round_trip(monkeypatch):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")
    pt, enc = encryption.split('{"amount": 900}')
    assert pt is None and enc is not None
    assert encryption.read({"foo": pt, "foo_enc": enc}, "foo") == '{"amount": 900}'


def test_split_is_noop_when_flag_off(monkeypatch):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "false")
    pt, enc = encryption.split("hello")
    assert pt == "hello" and enc is None


def test_hydrate_decrypts_and_drops_enc_key(monkeypatch):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")
    _, enc = encryption.split("secret-value")
    row = {"id": 1, "foo": None, "foo_enc": enc}
    out = encryption.hydrate(row, "foo")
    assert out["foo"] == "secret-value"
    assert "foo_enc" not in out  # bytea never survives to a JSON response


# ── execution_log.params at rest (end-to-end) ──────────────────────────────────

def _agent_and_key(client, org):
    h = org["headers"]
    aid = client.post("/api/authority/agents", headers=h, json={"name": "ex-" + uuid.uuid4().hex[:6],
        "tools": [{"name": "stripe", "service": "stripe", "actions": [
            {"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}]}).json()["id"]
    key = client.post("/api/keys", headers=h, json={"name": "k"}).json()["key"]
    return aid, key


def _enforce(client, key, aid, params):
    return client.post("/api/enforce", headers={"X-API-Key": key},
                       json={"agent_id": aid, "tool": "stripe", "action": "create_refund", "params": params})


def test_execution_params_encrypted_when_flag_on(client, two_orgs, monkeypatch):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")
    a = two_orgs["org_a"]
    aid, key = _agent_and_key(client, a)
    assert _enforce(client, key, aid, {"amount": 900, "customer": "cust_SECRET"}).status_code == 200

    with get_db() as conn:
        row = conn.execute(
            "SELECT params, params_enc FROM execution_log WHERE agent_id = %s ORDER BY id DESC LIMIT 1",
            (aid,)).fetchone()
    assert row["params"] is None and row["params_enc"] is not None
    assert b"cust_SECRET" not in bytes(row["params_enc"])

    # The API returns decrypted params and never leaks the bytea column.
    entries = client.get(f"/api/executions/{aid}", headers=a["headers"]).json()["entries"]
    latest = entries[0]
    assert "params_enc" not in latest
    assert json.loads(latest["params"]) == {"amount": 900, "customer": "cust_SECRET"}


def test_execution_params_plaintext_when_flag_off(client, two_orgs, monkeypatch):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "false")
    a = two_orgs["org_a"]
    aid, key = _agent_and_key(client, a)
    assert _enforce(client, key, aid, {"amount": 5}).status_code == 200
    with get_db() as conn:
        row = conn.execute(
            "SELECT params, params_enc FROM execution_log WHERE agent_id = %s ORDER BY id DESC LIMIT 1",
            (aid,)).fetchone()
    assert row["params"] is not None and row["params_enc"] is None


# ── master-key rotation (crypto) ───────────────────────────────────────────────

def test_rewrap_blob_moves_value_to_new_key():
    old = vault.EnvMasterKey("K_OLD")
    new = vault.EnvMasterKey("K_NEW")
    os.environ["K_OLD"] = base64.b64encode(os.urandom(32)).decode()
    os.environ["K_NEW"] = base64.b64encode(os.urandom(32)).decode()
    try:
        blob = vault.encrypt_value("sk_live_ROTATE", provider=old)
        rewrapped = vault.rewrap_blob(blob, old, new)
        # Decrypts under the new key; the old key no longer works.
        assert vault.decrypt_value(rewrapped, provider=new) == "sk_live_ROTATE"
        with pytest.raises(Exception):
            vault.decrypt_value(rewrapped, provider=old)
        # Ciphertext body is unchanged — only the wrapped-DEK header differs.
        assert blob[2 + int.from_bytes(blob[:2], "big"):] == rewrapped[2 + int.from_bytes(rewrapped[:2], "big"):]
    finally:
        del os.environ["K_OLD"], os.environ["K_NEW"]


def test_rewrap_credential_moves_dek_to_new_key():
    old = vault.EnvMasterKey("K_OLD")
    new = vault.EnvMasterKey("K_NEW")
    os.environ["K_OLD"] = base64.b64encode(os.urandom(32)).decode()
    os.environ["K_NEW"] = base64.b64encode(os.urandom(32)).decode()
    try:
        wrapped, cfg = vault.encrypt_credential({"secret": "sk_live_X"}, provider=old)
        new_wrapped = vault.rewrap_credential(wrapped, old, new)
        assert vault.decrypt_credential(new_wrapped, cfg, provider=new) == {"secret": "sk_live_X"}
    finally:
        del os.environ["K_OLD"], os.environ["K_NEW"]


# ── backfill script (existing plaintext → encrypted) ───────────────────────────

def test_backfill_encrypts_existing_plaintext_rows(client, two_orgs, monkeypatch):
    # Write a plaintext execution row (flag off), then backfill it.
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "false")
    a = two_orgs["org_a"]
    aid, key = _agent_and_key(client, a)
    assert _enforce(client, key, aid, {"amount": 42, "note": "backfill_me"}).status_code == 200
    with get_db() as conn:
        before = conn.execute(
            "SELECT id, params, params_enc FROM execution_log WHERE agent_id = %s ORDER BY id DESC LIMIT 1",
            (aid,)).fetchone()
    assert before["params"] is not None and before["params_enc"] is None
    row_id = before["id"]

    backfill = _load_script("backfill_encryption.py")
    monkeypatch.setattr(sys, "argv", ["backfill_encryption.py"])
    backfill.main()

    with get_db() as conn:
        after = conn.execute("SELECT params, params_enc FROM execution_log WHERE id = %s", (row_id,)).fetchone()
    assert after["params"] is None and after["params_enc"] is not None
    assert encryption.read(dict(after), "params") == '{"amount": 42, "note": "backfill_me"}'


# ── HIGH-004: registry completeness + audit_log.detail_enc coverage past the
#    append-only trigger, for both the backfill and the master-key rotation ─────────

def test_encrypted_columns_registry_matches_schema():
    """Every `*_enc` column in the live schema must be registered in
    encryption.ENCRYPTED_COLUMNS, or a master-key rotation would silently skip it and
    the old key's retirement would permanently brick it (HIGH-004)."""
    with get_db() as conn:
        live = {
            (r["table_name"], r["column_name"])
            for r in conn.execute(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND column_name LIKE '%enc'"
            ).fetchall()
            if r["column_name"].endswith("_enc")
        }
    registered = {(t, enc) for t, _id, _pt, enc in encryption.ENCRYPTED_COLUMNS}
    missing = live - registered
    assert not missing, f"_enc columns missing from encryption.ENCRYPTED_COLUMNS: {missing}"


def test_backfill_encrypts_audit_detail_past_append_only_trigger(client, two_orgs, monkeypatch):
    """Backfill must encrypt audit_log.detail even though the append-only trigger
    (migration 0007) blocks UPDATEs — the script suspends it, and the tamper-evident
    chain stays valid because the hash is over the (unchanged) plaintext."""
    backfill = _load_script("backfill_encryption.py")
    assert ("audit_log", "id", "detail", "detail_enc") in backfill._COLUMNS

    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "false")
    a = two_orgs["org_a"]
    from db import log_audit
    with get_db() as conn:
        log_audit(conn, "u", "u@ex.com", "LLM_CALL", resource="r",
                  detail='{"prompt": "audit_backfill_SECRET"}', org_id=a["org_id"])
        row = conn.execute(
            "SELECT id, detail, detail_enc FROM audit_log WHERE org_id = %s AND action = 'LLM_CALL' "
            "ORDER BY id DESC LIMIT 1", (a["org_id"],)).fetchone()
    assert row["detail"] is not None and row["detail_enc"] is None
    row_id = row["id"]

    monkeypatch.setattr(sys, "argv", ["backfill_encryption.py"])
    backfill.main()

    with get_db() as conn:
        after = conn.execute("SELECT detail, detail_enc FROM audit_log WHERE id = %s", (row_id,)).fetchone()
    assert after["detail"] is None and after["detail_enc"] is not None
    assert b"audit_backfill_SECRET" not in bytes(after["detail_enc"])
    assert encryption.read(dict(after), "detail") == '{"prompt": "audit_backfill_SECRET"}'
    assert client.get("/api/audit/verify", headers=a["headers"]).json()["valid"] is True


def test_rotation_covers_and_rewraps_audit_detail(client, two_orgs, monkeypatch):
    """Rotation must rewrap audit_log.detail_enc past the append-only trigger — else
    retiring the old key bricks it (HIGH-004). The rotation script's column list is
    derived from the registry (asserted); this drives the exact per-row rewrap it
    performs on audit_log with the same trigger-suspension helper, without re-keying
    the shared session DB (a full rotation needs every row under a single old key)."""
    rotate = _load_script("rotate_vault_master_key.py")
    assert ("audit_log", "id", "detail_enc") in rotate._BLOB_COLUMNS

    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")
    a = two_orgs["org_a"]
    from db import log_audit
    with get_db() as conn:
        log_audit(conn, "u", "u@ex.com", "LLM_CALL", resource="r",
                  detail='{"prompt": "rotate_me_SECRET"}', org_id=a["org_id"])
        row = conn.execute(
            "SELECT id, detail_enc FROM audit_log WHERE org_id = %s AND action = 'LLM_CALL' "
            "ORDER BY id DESC LIMIT 1", (a["org_id"],)).fetchone()
    assert row["detail_enc"] is not None
    row_id, blob = row["id"], bytes(row["detail_enc"])

    old = vault.EnvMasterKey(vault.MASTER_KEY_ENV)
    monkeypatch.setenv("K_ROT_NEW", base64.b64encode(os.urandom(32)).decode())
    new = vault.EnvMasterKey("K_ROT_NEW")
    with get_db() as conn:
        with encryption.suspend_append_only_trigger(conn, "audit_log"):
            conn.execute("UPDATE audit_log SET detail_enc = %s WHERE id = %s",
                         (vault.rewrap_blob(blob, old, new), row_id))

    with get_db() as conn:
        after = conn.execute("SELECT detail_enc FROM audit_log WHERE id = %s", (row_id,)).fetchone()
    # Decrypts only under the NEW key now; the chain still verifies under it.
    assert vault.decrypt_value(bytes(after["detail_enc"]), provider=new) == '{"prompt": "rotate_me_SECRET"}'
    monkeypatch.setenv("ARCEO_VAULT_MASTER_KEY", os.environ["K_ROT_NEW"])
    assert client.get("/api/audit/verify", headers=a["headers"]).json()["valid"] is True
