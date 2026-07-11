"""Phase-5 PR-3: sensitive held-request fields are encrypted at rest.

Unit: the generic vault.encrypt_value/decrypt_value round-trips and leaks no
cleartext. End-to-end: with ARCEO_ENCRYPT_AT_REST on, a held proxy request's
body is stored encrypted (plaintext column NULL, no cleartext in the bytea),
yet approve+replay still reconstructs and forwards it correctly. Flag off = the
old plaintext behavior; a pre-existing plaintext row still reads with the flag
on.
"""

from __future__ import annotations

import base64
import json
import os
import uuid

import pytest

import approvals
import vault
from db import get_db

_TEST_MASTER_KEY = base64.b64encode(os.urandom(32)).decode()
STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}


@pytest.fixture(autouse=True)
def _master_key(monkeypatch):
    monkeypatch.setenv(vault.MASTER_KEY_ENV, _TEST_MASTER_KEY)


# ── unit ──────────────────────────────────────────────────────────────────────

def test_encrypt_value_round_trips_str_and_json():
    assert vault.decrypt_value(vault.encrypt_value("hello sk_live_x")) == "hello sk_live_x"
    blob = vault.encrypt_value({"amount": 900, "to": "acct_1"})
    assert vault.decrypt_value(blob, as_json=True) == {"amount": 900, "to": "acct_1"}


def test_ciphertext_leaks_no_cleartext():
    blob = vault.encrypt_value({"secret": "sk_live_LEAKME", "amount": 900})
    assert b"sk_live_LEAKME" not in blob and b"900" not in blob


def test_wrong_key_fails_loudly(monkeypatch):
    blob = vault.encrypt_value("x")
    monkeypatch.setenv(vault.MASTER_KEY_ENV, base64.b64encode(os.urandom(32)).decode())
    with pytest.raises(Exception):
        vault.decrypt_value(blob)


# ── end-to-end ────────────────────────────────────────────────────────────────

def _hold(client, headers, agent_id, key):
    r = client.post("/proxy/stripe/v1/refunds",
                    headers={"X-API-Key": key, "X-Agent-ID": agent_id},
                    json={"amount": 900, "customer": "cust_SECRET"})
    assert r.status_code == 200 and r.json()["pending_approval"], r.text
    return r.json()["pending_id"]


def _setup(client, org, name):
    h = org["headers"]
    agent_id = client.post("/api/authority/agents", headers=h,
                           json={"name": name, "tools": [STRIPE_TOOL]}).json()["id"]
    client.post(f"/api/authority/agent/{agent_id}/policies", headers=h,
                json={"action_pattern": "stripe.create_refund", "effect": "REQUIRE_APPROVAL",
                      "reason": "gate", "priority": 10})
    key = client.post("/api/keys", headers=h, json={"name": "k"}).json()["key"]
    return agent_id, key


def test_held_body_encrypted_at_rest_when_flag_on(client, two_orgs, monkeypatch):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")
    a = two_orgs["org_a"]
    agent_id, key = _setup(client, a, "enc-" + uuid.uuid4().hex[:6])
    pid = _hold(client, a["headers"], agent_id, key)

    with get_db() as conn:
        row = conn.execute("SELECT body, body_enc, params_json, params_json_enc FROM pending_requests WHERE id = %s",
                           (pid,)).fetchone()
    # Plaintext columns NULL, encrypted columns populated, no cleartext in the bytea.
    assert row["body"] is None and row["body_enc"] is not None
    assert row["params_json"] is None and row["params_json_enc"] is not None
    assert b"cust_SECRET" not in bytes(row["body_enc"])
    # The read helpers decrypt transparently.
    assert json.loads(approvals.decoded_body(dict(row))) == {"amount": 900, "customer": "cust_SECRET"}


def test_flag_off_stores_plaintext(client, two_orgs, monkeypatch):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "false")
    a = two_orgs["org_a"]
    agent_id, key = _setup(client, a, "enc-off-" + uuid.uuid4().hex[:6])
    pid = _hold(client, a["headers"], agent_id, key)
    with get_db() as conn:
        row = conn.execute("SELECT body, body_enc FROM pending_requests WHERE id = %s", (pid,)).fetchone()
    assert row["body"] is not None and row["body_enc"] is None


def test_replay_works_on_encrypted_row(client, two_orgs, monkeypatch):
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")
    monkeypatch.setenv("ARCEO_REPLAY_ENABLED", "true")
    a = two_orgs["org_a"]
    agent_id, key = _setup(client, a, "enc-replay-" + uuid.uuid4().hex[:6])
    # store a vaulted credential so replay injects it
    client.put("/api/credentials/stripe", headers=a["headers"], json={"secret": "sk_live_V"})

    import httpx
    seen = {}

    def _handler(request):
        seen["body"] = request.content
        return httpx.Response(200, json={"ok": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda *x, **k: real(transport=httpx.MockTransport(_handler), timeout=k.get("timeout")))

    r = client.post("/proxy/stripe/v1/refunds",
                    headers={"X-API-Key": key, "X-Agent-ID": agent_id}, json={"amount": 900})
    exec_id = r.json()["execution_id"]
    dec = client.post(f"/api/approvals/{exec_id}", headers=a["headers"], json={"decision": "approve"})
    assert dec.status_code == 200 and dec.json()["replay"]["status"] == "replayed", dec.text
    # The replayed request carried the decrypted body.
    assert json.loads(seen["body"]) == {"amount": 900}
