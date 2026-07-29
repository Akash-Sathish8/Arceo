"""PR 1A — HIGH-001 (SSRF) + HIGH-003 (LLM spend gate + rate limit).

SSRF: `validate_external_url` now resolves ONCE and returns a vetted IP the caller
pins the connection to, defeating DNS-rebinding/TOCTOU. Internal/metadata targets
are still rejected outright.

Spend: LLM endpoints gain a per-agent rate limit and a pre-spend budget gate that
blocks (429) BEFORE recording spend — but only when ARCEO_BUDGET_ENFORCE is on, so
existing warn-only deployments are unaffected.
"""

from __future__ import annotations

import socket
import uuid

import pytest
from fastapi import HTTPException

import main


def _key(client, headers, agent_id: str = ""):
    body = {"name": "k-" + uuid.uuid4().hex[:6]}
    if agent_id:
        body["agent_id"] = agent_id
    r = client.post("/api/keys", headers=headers, json=body)
    assert r.status_code == 200, r.text
    return r.json()["key"]


def _mk_agent(client, headers, name):
    r = client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [
        {"name": "stripe", "service": "stripe",
         "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}]})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _addrinfo(ip: str):
    fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
    return lambda *a, **k: [(fam, socket.SOCK_STREAM, 6, "", (ip, 443))]


# ── SSRF: validate_external_url now returns a pinned IP ─────────────────────────

def test_validate_returns_vetted_public_ip(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo("93.184.216.34"))
    assert main.validate_external_url("https://example.com/mcp") == "93.184.216.34"


@pytest.mark.parametrize("ip", ["127.0.0.1", "169.254.169.254", "10.1.2.3", "192.168.0.5", "0.0.0.0"])
def test_validate_rejects_internal_addresses(monkeypatch, ip):
    monkeypatch.setattr(socket, "getaddrinfo", _addrinfo(ip))
    with pytest.raises(HTTPException) as e:
        main.validate_external_url("http://rebind.example/mcp")
    assert e.value.status_code == 400
    assert "internal" in e.value.detail.lower()


def test_validate_rejects_bad_scheme_and_missing_host():
    with pytest.raises(HTTPException) as e1:
        main.validate_external_url("ftp://example.com")
    assert e1.value.status_code == 400
    with pytest.raises(HTTPException) as e2:
        main.validate_external_url("https:///nohost")
    assert e2.value.status_code == 400


def test_internal_bypass_returns_none(monkeypatch):
    monkeypatch.setenv("ARCEO_ALLOW_INTERNAL_MCP", "true")
    # No pinning in dev-bypass mode → caller uses the hostname as-is.
    assert main.validate_external_url("http://localhost:9000/mcp") is None


# ── SSRF: _pin_url_to_ip rewrites host but preserves Host header ────────────────

def test_pin_url_to_ip_preserves_host_and_port():
    url, host = main._pin_url_to_ip("https://example.com:8443/mcp/v1", "93.184.216.34")
    assert url == "https://93.184.216.34:8443/mcp/v1"
    assert host == "example.com:8443"


def test_pin_url_to_ip_default_port_and_ipv6():
    url, host = main._pin_url_to_ip("https://example.com/x", "1.2.3.4")
    assert url == "https://1.2.3.4/x" and host == "example.com"
    url6, host6 = main._pin_url_to_ip("https://example.com/x", "2606:2800:220:1:248:1893:25c8:1946")
    assert url6.startswith("https://[2606:2800:220:1:248:1893:25c8:1946]/x")
    assert host6 == "example.com"


def test_connect_mcp_rejects_metadata_ip(client, roles):
    # IP-literal target: no DNS needed, getaddrinfo echoes the link-local address.
    r = client.post("/api/authority/agents/connect/mcp", headers=roles["admin"]["headers"],
                    json={"url": "http://169.254.169.254/latest/meta-data", "agent_name": "ssrf-x"})
    assert r.status_code == 400
    assert "internal" in r.json()["detail"].lower()


# ── HIGH-003: pre-spend budget gate ────────────────────────────────────────────

def _set_budget(client, headers, agent_id, usd):
    r = client.put(f"/api/agents/{agent_id}/budget", headers=headers,
                   json={"monthly_budget_usd": usd, "alert_threshold_pct": 80})
    assert r.status_code == 200, r.text


def _llm_call(client, api_key, agent_id):
    return client.post(f"/api/agent/{agent_id}/llm-call", headers={"X-API-Key": api_key},
                       json={"provider": "anthropic", "model": "claude-x", "response": {"ok": True}})


def test_budget_gate_blocks_over_budget_when_enforced(client, roles, monkeypatch):
    import analysis.spend_forecast as sf
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "bud-" + uuid.uuid4().hex[:5])
    _set_budget(client, admin["headers"], agent, 10.0)
    key = _key(client, admin["headers"], agent_id=agent)

    monkeypatch.setenv("ARCEO_BUDGET_ENFORCE", "true")
    monkeypatch.setattr(sf, "compute_month_to_date_spend", lambda *a, **k: 25.0)  # over the $10 cap

    r = _llm_call(client, key, agent)
    assert r.status_code == 429, r.text
    assert "budget" in r.json()["detail"].lower()


def test_budget_gate_is_noop_when_flag_off(client, roles, monkeypatch):
    import analysis.spend_forecast as sf
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "bud-off-" + uuid.uuid4().hex[:5])
    _set_budget(client, admin["headers"], agent, 10.0)
    key = _key(client, admin["headers"], agent_id=agent)

    # Flag unset (default) → warn-only, spend is recorded even when "over budget".
    monkeypatch.setattr(sf, "compute_month_to_date_spend", lambda *a, **k: 25.0)
    r = _llm_call(client, key, agent)
    assert r.status_code == 200, r.text


def test_budget_gate_is_noop_without_budget_row(client, roles, monkeypatch):
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "bud-none-" + uuid.uuid4().hex[:5])
    key = _key(client, admin["headers"], agent_id=agent)
    monkeypatch.setenv("ARCEO_BUDGET_ENFORCE", "true")  # on, but no budget saved
    r = _llm_call(client, key, agent)
    assert r.status_code == 200, r.text


# ── HIGH-003: per-agent LLM rate limit ─────────────────────────────────────────

def test_llm_endpoint_rate_limited(client, roles, monkeypatch):
    admin = roles["admin"]
    agent = _mk_agent(client, admin["headers"], "llmrl-" + uuid.uuid4().hex[:5])
    key = _key(client, admin["headers"], agent_id=agent)
    monkeypatch.setattr(main, "RATE_LIMIT_LLM_MAX", 3)
    codes = [_llm_call(client, key, agent).status_code for _ in range(8)]
    assert codes[0] == 200, codes
    assert 429 in codes, codes


# ── HIGH-003: the keyless LLM faucets now require a key unconditionally ──────────

def test_report_faucet_requires_key(client):
    """/api/report reaches an LLM summary; on a keyless install it used to run
    unauthenticated. It must now 401 without a key regardless of how many keys exist."""
    r = client.post("/api/report", json={"agent_id": "x", "actions": []})
    assert r.status_code == 401, r.text


def test_analyze_trace_faucet_requires_key(client):
    """/api/sdk/analyze-trace also spends on the LLM; unconditional key requirement."""
    r = client.post("/api/sdk/analyze-trace", json={})
    assert r.status_code == 401, r.text
