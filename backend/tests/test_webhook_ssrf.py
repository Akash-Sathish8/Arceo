"""MED-010 — blind SSRF via the org Slack webhook URL.

The webhook URL is admin-supplied, stored verbatim, and fired server-side by three
paths (policy BLOCK, spend-anomaly alert, budget alert), none of which passed it
through the SSRF guard that already existed for MCP connect. Pointing it at
169.254.169.254 or a localhost admin port turned Arceo into a blind SSRF probe
from inside the trust boundary.

Guarded now at BOTH ends: rejected at save, and re-validated at fire time — the
column predates the guard, so it may already hold an internal URL, and a hostname
that validates once can re-resolve to an internal address later (DNS rebinding).
"""

from __future__ import annotations

import socket
import uuid

import httpx
import pytest
from fastapi import HTTPException

import egress
import main


def _addrinfo(ip: str):
    fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
    return lambda *a, **k: [(fam, socket.SOCK_STREAM, 6, "", (ip, 443))]


SLACK = "https://hooks.slack.com/services/T000/B000/xxxx"


class _Recorder:
    """Stands in for httpx.Client so a test can assert on what would have been sent
    — and, more importantly, that nothing was sent at all."""

    sent: list = []
    last_request: dict = {}
    last_init: dict = {}

    def __init__(self, *a, **k):
        _Recorder.last_init = k

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def build_request(self, method, url, json=None, headers=None, extensions=None):
        _Recorder.last_request = {"method": method, "url": url, "json": json,
                                  "headers": headers or {}, "extensions": extensions or {}}
        return _Recorder.last_request

    def send(self, request):
        _Recorder.sent.append(request)
        return None


@pytest.fixture()
def recorder(monkeypatch):
    _Recorder.sent = []
    _Recorder.last_request = {}
    _Recorder.last_init = {}
    monkeypatch.setattr(httpx, "Client", _Recorder)
    return _Recorder


# ── Save-time rejection ───────────────────────────────────────────────────────

def _save(client, headers, url):
    return client.post("/api/notifications/settings", headers=headers,
                       json={"slack_webhook_url": url, "alert_email": "", "notify_on_block": True})


@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8000/api/health",
    "http://10.1.2.3/hook",
    "http://192.168.0.5/hook",
])
def test_save_rejects_internal_targets(client, roles, url):
    r = _save(client, roles["admin"]["headers"], url)
    assert r.status_code == 400, r.text


def test_save_rejects_a_non_allowlisted_public_host(client, roles, monkeypatch):
    """Even a perfectly public host is refused — otherwise the field is a generic
    'make the server POST anywhere' primitive."""
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("93.184.216.34"))
    r = _save(client, roles["admin"]["headers"], "https://evil.example.com/collect")
    assert r.status_code == 400, r.text
    assert "not allowed" in r.json()["detail"].lower()


def test_save_accepts_a_slack_webhook(client, roles, monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("93.184.216.34"))
    assert _save(client, roles["admin"]["headers"], SLACK).status_code == 200


def test_save_accepts_an_empty_url(client, roles):
    """Clearing the field must stay possible — validation only runs on a value."""
    assert _save(client, roles["admin"]["headers"], "").status_code == 200


def test_allowlist_is_extensible_by_env(client, roles, monkeypatch):
    """Mattermost/Discord/an internal relay — one env var, no code change."""
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("93.184.216.34"))
    url = "https://chat.acme.example/hooks/abc"
    assert _save(client, roles["admin"]["headers"], url).status_code == 400

    monkeypatch.setenv("ARCEO_WEBHOOK_ALLOWED_HOSTS", "chat.acme.example, other.example")
    assert _save(client, roles["admin"]["headers"], url).status_code == 200


def test_allowlist_env_does_not_re_open_internal_targets(client, roles, monkeypatch):
    """Allowlisting a host still doesn't let it resolve somewhere internal."""
    monkeypatch.setenv("ARCEO_WEBHOOK_ALLOWED_HOSTS", "rebind.example")
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("169.254.169.254"))
    r = _save(client, roles["admin"]["headers"], "https://rebind.example/hook")
    assert r.status_code == 400
    assert "internal" in r.json()["detail"].lower()


# ── Fire-time guard ───────────────────────────────────────────────────────────

def test_fire_drops_a_stored_internal_url(recorder, monkeypatch):
    """A URL saved before this guard existed must not fire."""
    assert egress.post_webhook("http://169.254.169.254/latest/meta-data/", {"x": 1}) is False
    assert recorder.sent == []


def test_fire_drops_a_stored_non_allowlisted_host(recorder, monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("93.184.216.34"))
    assert egress.post_webhook("https://evil.example.com/collect", {"x": 1}) is False
    assert recorder.sent == []


def test_fire_catches_dns_rebinding_after_a_clean_save(recorder, monkeypatch):
    """Host stays allowlisted, but now resolves inward. Save-time validation alone
    would have let this through."""
    monkeypatch.setenv("ARCEO_WEBHOOK_ALLOWED_HOSTS", "rebind.example")
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("127.0.0.1"))
    assert egress.post_webhook("https://rebind.example/hook", {"x": 1}) is False
    assert recorder.sent == []


def test_fire_pins_to_the_vetted_ip_and_refuses_redirects(recorder, monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("93.184.216.34"))
    assert egress.post_webhook(SLACK, {"blocks": []}) is True

    req = recorder.last_request
    assert req["url"] == "https://93.184.216.34/services/T000/B000/xxxx"  # IP, not host
    assert req["headers"]["Host"] == "hooks.slack.com"                    # routing preserved
    assert req["extensions"]["sni_hostname"] == "hooks.slack.com"         # TLS still verifies
    assert recorder.last_init["follow_redirects"] is False                # no 30x bounce inward
    assert len(recorder.sent) == 1


def test_fire_never_raises_on_a_dead_upstream(recorder, monkeypatch):
    """A notification failure must not break enforcement or ingestion."""
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("93.184.216.34"))

    def _boom(self, request):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(_Recorder, "send", _boom)
    assert egress.post_webhook(SLACK, {"x": 1}) is False


# ── The BLOCK path specifically (authority/enforcement.py) ────────────────────

def test_block_notification_does_not_fire_a_stored_internal_url(client, roles, recorder):
    """fire_block_notification runs on every policy BLOCK — the highest-frequency
    of the three fire sites. Seed the row directly, the way a pre-guard deployment
    would already have it."""
    from authority.enforcement import fire_block_notification

    admin = roles["admin"]
    r = client.post("/api/authority/agents", headers=admin["headers"], json={
        "name": "blk-" + uuid.uuid4().hex[:5],
        "tools": [{"name": "stripe", "service": "stripe", "actions": [
            {"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}]})
    assert r.status_code == 200, r.text
    agent_id = r.json()["id"]

    with main.get_db() as conn:
        conn.execute("DELETE FROM workspace_settings WHERE org_id = %s", (admin["org_id"],))
        conn.execute(
            "INSERT INTO workspace_settings (slack_webhook_url, alert_email, notify_on_block, "
            "org_id, updated_at) VALUES (%s, %s, %s, %s, %s)",
            ("http://169.254.169.254/latest/meta-data/", "", 1, admin["org_id"], "2026-07-29"),
        )

    fire_block_notification(agent_id, "stripe", "create_refund", "policy match")
    assert recorder.sent == []


def test_block_notification_fires_a_valid_webhook(client, roles, recorder, monkeypatch):
    from authority.enforcement import fire_block_notification

    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("93.184.216.34"))
    admin = roles["admin"]
    r = client.post("/api/authority/agents", headers=admin["headers"], json={
        "name": "blk-ok-" + uuid.uuid4().hex[:5],
        "tools": [{"name": "stripe", "service": "stripe", "actions": [
            {"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}]})
    agent_id = r.json()["id"]

    with main.get_db() as conn:
        conn.execute("DELETE FROM workspace_settings WHERE org_id = %s", (admin["org_id"],))
        conn.execute(
            "INSERT INTO workspace_settings (slack_webhook_url, alert_email, notify_on_block, "
            "org_id, updated_at) VALUES (%s, %s, %s, %s, %s)",
            (SLACK, "", 1, admin["org_id"], "2026-07-29"),
        )

    fire_block_notification(agent_id, "stripe", "create_refund", "policy match")
    assert len(recorder.sent) == 1
    assert "blocked an action" in recorder.last_request["json"]["blocks"][0]["text"]["text"]


# ── The moved guard still behaves as main.* callers expect ────────────────────

def test_main_still_exposes_the_guard_after_the_move(monkeypatch):
    """validate_external_url/_pin_url_to_ip moved to egress.py so enforcement could
    import them; every existing caller still reaches them through main."""
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("93.184.216.34"))
    assert main.validate_external_url("https://example.com/mcp") == "93.184.216.34"
    assert main._pin_url_to_ip("https://example.com/x", "1.2.3.4") == ("https://1.2.3.4/x", "example.com")
    with pytest.raises(HTTPException):
        main.validate_external_url("ftp://example.com")
