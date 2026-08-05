"""MED-005 + MED-017 — the LLM proxy trusted a caller-supplied X-Agent-ID.

One header, two findings, same root cause:

  MED-005 — the rate-limit bucket key WAS that header, so rotating it landed every
    request in a fresh sliding window: the ceiling counted per fabricated identity,
    not per caller. The same header also auto-created `agents` rows with no key, so
    a rotating client flooded the table and dropped attacker-named agents into a
    real tenant's namespace (they defaulted to DEFAULT_ORG_ID).
  MED-017 — `.strip()` only trims the ENDS, so an interior newline survived into
    the plain-text application logger and let a caller forge whole log lines.
"""

from __future__ import annotations

import logging
import uuid

import pytest

import main
import redaction


def _key(client, headers, agent_id: str = ""):
    body = {"name": "k-" + uuid.uuid4().hex[:6]}
    if agent_id:
        body["agent_id"] = agent_id
    r = client.post("/api/keys", headers=headers, json=body)
    assert r.status_code == 200, r.text
    return r.json()["key"]


def _mk_agent(client, headers, name):
    r = client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [
        {"name": "stripe", "service": "stripe", "actions": [
            {"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}]})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _proxy(client, agent_id, api_key=None):
    headers = {"X-Agent-ID": agent_id}
    if api_key:
        headers["X-API-Key"] = api_key
    return client.post("/proxy/llm/anthropic/v1/messages", headers=headers, json={"model": "claude-x"})


@pytest.fixture(autouse=True)
def _stub_upstream(monkeypatch):
    """Intercept egress with a MockTransport (same shape as test_credential_vault's
    capture_upstream). Without it these tests reach api.anthropic.com for real, and
    an upstream 401 is indistinguishable from one of ours."""
    import httpx

    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda *a, **k: real(transport=httpx.MockTransport(_handler), timeout=k.get("timeout")),
    )


# ── MED-017: the header can't carry control characters ────────────────────────

@pytest.mark.parametrize("bad", [
    "agent\ninjected-line",
    "agent\r\nWARNING forged",
    "agent\x00null",
    "agent\x1bescape",
    "agent with spaces",
])
def test_control_characters_in_agent_id_are_rejected(client, bad):
    r = _proxy(client, bad)
    assert r.status_code == 400, r.text
    assert "X-Agent-ID" in r.json()["detail"]


@pytest.mark.parametrize("ok", ["support-agent", "svc.billing", "team:bot-1", "Agent_42"])
def test_realistic_agent_ids_are_still_accepted(client, roles, ok):
    """The charset is deliberately wider than the audit's `[a-z0-9-]` — the product
    itself mints ids with dots and colons. Rejecting them would be breakage for no
    security gain, so these must NOT 400."""
    r = _proxy(client, ok)
    assert r.status_code != 400, r.text


def test_log_safe_strips_control_characters():
    assert redaction.log_safe("a\nb") == "ab"
    assert redaction.log_safe("a\r\nWARNING forged") == "aWARNING forged"
    assert redaction.log_safe("a\x00\x1b\x7fb") == "ab"
    assert redaction.log_safe(None) == ""


def test_log_safe_caps_length():
    out = redaction.log_safe("x" * 500, max_length=50)
    assert len(out) == 51 and out.endswith("…")


def test_a_forged_newline_cannot_produce_a_second_log_line(caplog):
    """The property that matters: one logged event stays one line."""
    with caplog.at_level(logging.WARNING):
        logging.getLogger(__name__).warning(
            "classification failed for %s", redaction.log_safe("evil\nWARNING attacker-owned"))
    assert len(caplog.records) == 1
    assert "\n" not in caplog.records[0].getMessage()


# ── MED-005: the limiter keys on something the caller can't rotate ────────────

def test_rotating_the_header_no_longer_resets_the_rate_limit(client, roles, monkeypatch):
    """The headline bypass: same caller, fresh agent id per request, previously a
    fresh bucket every time."""
    monkeypatch.setattr(main, "RATE_LIMIT_LLM_MAX", 3)
    admin = roles["admin"]
    key = _key(client, admin["headers"])
    agent = _mk_agent(client, admin["headers"], "rot-" + uuid.uuid4().hex[:5])
    _proxy(client, agent, key)  # prime the agent so auto-create isn't the blocker

    codes = [_proxy(client, f"rotating-{i}", key).status_code for i in range(8)]
    assert 429 in codes, codes


def test_keyless_callers_cannot_auto_create_agents(client):
    """A rotating keyless client used to mint a row in `agents` AND an
    AUTO_CREATE_AGENT audit entry per request, in the default org."""
    ghost = "ghost-" + uuid.uuid4().hex[:8]
    r = _proxy(client, ghost)
    assert r.status_code in (401, 404), r.text

    with main.get_db() as conn:
        assert conn.execute("SELECT 1 FROM agents WHERE id = %s", (ghost,)).fetchone() is None


def test_proxy_requires_a_key_outside_dev(monkeypatch):
    monkeypatch.delenv("ARCEO_PROXY_REQUIRE_KEY", raising=False)
    monkeypatch.setattr(main, "_IS_DEV_ENV", False)
    assert main._proxy_requires_key() is True
    monkeypatch.setattr(main, "_IS_DEV_ENV", True)
    assert main._proxy_requires_key() is False


@pytest.mark.parametrize("flag,expected", [
    ("1", True), ("true", True), ("on", True),
    ("0", False), ("false", False), ("off", False),
])
def test_proxy_key_flag_overrides_both_ways(monkeypatch, flag, expected):
    monkeypatch.setattr(main, "_IS_DEV_ENV", not expected)
    monkeypatch.setenv("ARCEO_PROXY_REQUIRE_KEY", flag)
    assert main._proxy_requires_key() is expected


def test_keyless_proxy_is_refused_when_the_key_is_required(client, monkeypatch):
    monkeypatch.setenv("ARCEO_PROXY_REQUIRE_KEY", "true")
    r = _proxy(client, "some-agent")
    assert r.status_code == 401
    assert "X-API-Key" in r.json()["detail"]


def test_a_keyed_caller_can_still_register_on_first_call(client, roles, monkeypatch):
    """The legitimate SDK flow must keep working — with a key, first call still
    auto-registers the agent."""
    monkeypatch.setenv("ARCEO_PROXY_REQUIRE_KEY", "true")
    admin = roles["admin"]
    key = _key(client, admin["headers"])
    fresh = "sdk-" + uuid.uuid4().hex[:8]

    assert _proxy(client, fresh, key).status_code == 200
    with main.get_db() as conn:
        row = conn.execute("SELECT org_id FROM agents WHERE id = %s", (fresh,)).fetchone()
    assert row is not None
    assert row["org_id"] == admin["org_id"]  # the KEY's org, not the default one
