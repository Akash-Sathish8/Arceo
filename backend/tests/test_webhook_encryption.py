"""MED-014 — the Slack webhook URL was the last secret stored in cleartext.

A Slack incoming-webhook URL *is* a bearer credential: the path segment is the
token, and anyone holding it can post into that workspace as the integration. The
vault covered provider credentials and 0005/0008/0011 covered request bodies,
execution params and audit detail — this column was never brought along, and the
settings GET handed the whole thing back to any admin session.

Two halves, both tested here: encrypted at rest via the same flag-gated
`encryption.split` path as every other sensitive column, and masked on read so the
live value never leaves the server after it is stored.

The mask creates a trap the tests below exist to pin: Settings.tsx loads the GET
response into the form and posts it back verbatim, so an untouched save arrives
carrying the MASK. Writing that through would replace the credential with
"https://hooks.slack.com/…aB3x" and silently kill every alert.
"""

from __future__ import annotations

import base64
import os
import socket
import uuid

import pytest

import egress
import encryption
import main
import vault
from db import get_db


def _addrinfo(ip: str):
    fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
    return lambda *a, **k: [(fam, socket.SOCK_STREAM, 6, "", (ip, 443))]


SLACK = "https://hooks.slack.com/services/T0PINNED/B0PINNED/tokenaB3x"
SLACK_2 = "https://hooks.slack.com/services/T0SECOND/B0SECOND/tokenZZZ9"


@pytest.fixture()
def resolvable(monkeypatch):
    """hooks.slack.com resolves to a public address, so save-time validation passes."""
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("93.184.216.34"))


@pytest.fixture()
def encrypted(monkeypatch):
    """Flag on AND a master key present — the pairing `enforce_prod_encryption_policy`
    guarantees at boot (flag-on-without-key is a refuse-to-start misconfiguration,
    which is why the write path doesn't special-case VaultConfigError)."""
    monkeypatch.setenv(vault.MASTER_KEY_ENV, base64.b64encode(os.urandom(32)).decode())
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")


def _save(client, headers, url, notify=True):
    return client.post("/api/notifications/settings", headers=headers,
                       json={"slack_webhook_url": url, "alert_email": "",
                             "notify_on_block": notify})


def _get(client, headers):
    r = client.get("/api/notifications/settings", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _raw_row(org_id: str) -> dict:
    with get_db() as conn:
        return conn.execute(
            "SELECT slack_webhook_url, slack_webhook_url_enc FROM workspace_settings "
            "WHERE org_id = %s", (org_id,)
        ).fetchone()


# ── The mask itself ───────────────────────────────────────────────────────────

def test_mask_keeps_the_host_and_drops_the_token():
    masked = main._mask_webhook(SLACK)
    assert "hooks.slack.com" in masked          # which integration, still legible
    assert "tokenaB3x"[-4:] in masked           # enough to tell two webhooks apart
    assert "T0PINNED" not in masked             # ...and nothing usable
    assert "B0PINNED" not in masked
    assert "tokenaB3x" not in masked


def test_mask_of_empty_is_empty():
    assert main._mask_webhook("") == ""
    assert main._mask_webhook(None) == ""


# ── At rest ───────────────────────────────────────────────────────────────────

def test_webhook_is_encrypted_at_rest(client, roles, resolvable, encrypted):
    org_id = roles["admin"]["org_id"]
    assert _save(client, roles["admin"]["headers"], SLACK).status_code == 200

    row = _raw_row(org_id)
    assert row["slack_webhook_url"] is None, "plaintext column must be nulled"
    assert row["slack_webhook_url_enc"], "ciphertext column must be populated"
    # No fragment of the credential survives in the clear.
    blob = bytes(row["slack_webhook_url_enc"])
    for fragment in (b"hooks.slack.com", b"T0PINNED", b"tokenaB3x"):
        assert fragment not in blob
    # ...and it still round-trips.
    assert encryption.read(row, "slack_webhook_url") == SLACK


def test_plaintext_rows_still_readable_when_flag_is_off(client, roles, resolvable, monkeypatch):
    """The flag must stay safe to flip both ways: with it off the value is stored
    plaintext, and `encryption.read` falls back — which is also how every
    pre-migration row keeps working."""
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "false")
    org_id = roles["admin"]["org_id"]
    assert _save(client, roles["admin"]["headers"], SLACK).status_code == 200

    row = _raw_row(org_id)
    assert row["slack_webhook_url"] == SLACK
    assert row["slack_webhook_url_enc"] is None
    assert encryption.read(row, "slack_webhook_url") == SLACK


def test_enc_column_is_registered_for_rotation_and_backfill():
    """HIGH-004's lesson: an unregistered `_enc` column is silently skipped by a
    master-key rotation and permanently bricked when the old key retires."""
    registered = {(t, enc) for t, _id, _pt, enc in encryption.ENCRYPTED_COLUMNS}
    assert ("workspace_settings", "slack_webhook_url_enc") in registered
    # Keyed on the real PK — backfill/rotation paginate with ORDER BY <id_col>.
    entry = next(e for e in encryption.ENCRYPTED_COLUMNS if e[0] == "workspace_settings")
    assert entry[1] == "id"


# ── Masked on read ────────────────────────────────────────────────────────────

def test_get_returns_a_mask_not_the_credential(client, roles, resolvable, encrypted):
    assert _save(client, roles["admin"]["headers"], SLACK).status_code == 200
    body = _get(client, roles["admin"]["headers"])

    assert body["slack_webhook_configured"] is True
    assert body["slack_webhook_url"] == main._mask_webhook(SLACK)
    assert SLACK not in str(body)
    assert "T0PINNED" not in str(body)


def test_get_with_no_settings_row_reports_unconfigured(client, roles):
    body = _get(client, roles["admin"]["headers"])
    assert body["slack_webhook_configured"] is False
    assert body["slack_webhook_url"] == ""


# ── The mask round-trip trap ──────────────────────────────────────────────────

def test_resaving_the_mask_preserves_the_stored_secret(client, roles, resolvable, encrypted):
    """THE regression test for this PR. Settings.tsx posts the GET response back
    verbatim, so an untouched save arrives as the mask. It must be a no-op on the
    credential, not an overwrite."""
    headers = roles["admin"]["headers"]
    org_id = roles["admin"]["org_id"]
    assert _save(client, headers, SLACK).status_code == 200

    masked = _get(client, headers)["slack_webhook_url"]
    # Simulate "open Settings, change the email, hit Save" — webhook field untouched.
    r = client.post("/api/notifications/settings", headers=headers,
                    json={"slack_webhook_url": masked, "alert_email": "ops@example.com",
                          "notify_on_block": True})
    assert r.status_code == 200, r.text

    assert encryption.read(_raw_row(org_id), "slack_webhook_url") == SLACK
    assert _get(client, headers)["alert_email"] == "ops@example.com"


def test_a_new_url_replaces_the_stored_one(client, roles, resolvable, encrypted):
    headers = roles["admin"]["headers"]
    org_id = roles["admin"]["org_id"]
    assert _save(client, headers, SLACK).status_code == 200
    assert _save(client, headers, SLACK_2).status_code == 200
    assert encryption.read(_raw_row(org_id), "slack_webhook_url") == SLACK_2


def test_empty_still_clears_the_webhook(client, roles, resolvable, encrypted):
    """Pre-existing contract the page states: empty turns alerts off. The mask
    sentinel must not have quietly turned empty into 'unchanged'."""
    headers = roles["admin"]["headers"]
    org_id = roles["admin"]["org_id"]
    assert _save(client, headers, SLACK).status_code == 200
    assert _save(client, headers, "").status_code == 200

    row = _raw_row(org_id)
    assert not encryption.read(row, "slack_webhook_url")
    assert _get(client, headers)["slack_webhook_configured"] is False


def test_med_010_guard_still_fires_on_a_changed_url(client, roles, monkeypatch, encrypted):
    """Encryption must not have moved validation off the save path."""
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("169.254.169.254"))
    r = _save(client, roles["admin"]["headers"], "http://169.254.169.254/latest/meta-data/")
    assert r.status_code == 400, r.text


# ── The fire paths must still get real, usable URLs ────────────────────────────

def test_block_notification_fires_with_the_decrypted_url(client, roles, resolvable,
                                                         encrypted, monkeypatch):
    """enforcement.py reads the column directly via SELECT * — if it stopped
    decrypting, alerting would silently die the moment the flag went on."""
    headers = roles["admin"]["headers"]
    assert _save(client, headers, SLACK).status_code == 200

    fired: list = []
    monkeypatch.setattr(egress, "post_webhook",
                        lambda url, payload, **k: fired.append(url) or True)

    from authority import enforcement
    agent = client.post("/api/authority/agents", headers=headers,
                        json={"name": f"webhook-enc-{uuid.uuid4().hex[:6]}", "tools": []})
    assert agent.status_code == 200, agent.text
    body = agent.json()
    agent_id = body["agent"]["id"] if "agent" in body else body["id"]

    enforcement.fire_block_notification(agent_id, "stripe", "create_refund", "test block")

    assert fired == [SLACK], f"fire path did not receive the decrypted URL: {fired}"
