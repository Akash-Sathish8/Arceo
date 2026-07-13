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
