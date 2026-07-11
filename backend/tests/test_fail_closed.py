"""Phase-1 B2: no exception path in proxy / /api/enforce / SDK executes an action.

- safe_enforce_check: any exception mid-decision → structured BLOCK (never
  raises); ARCEO_FAIL_MODE=allow is the break-glass that flips the fallback.
- /proxy/{service}: X-API-Key mandatory even on a fresh DB with zero keys;
  enforcement errors return a blocked JSON, and the upstream is never called.
- Forwarded responses drop stale Content-Length/Content-Encoding (httpx
  already decompressed the body).
- SDK enforce(): fails closed by default; on_error="allow" and
  ARCEO_FAIL_MODE=allow restore fail-open; explicit argument beats env.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

import authority.enforcement as enf

# The SDK is a separate stdlib-only package (sdk/arceo) — not installed in the
# backend venv, so import it straight off the repo tree.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from arceo._enforce import enforce as sdk_enforce  # noqa: E402

STRIPE_TOOL = {
    "name": "stripe", "service": "stripe",
    "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}],
}


def _boom(*a, **k):
    raise RuntimeError("db exploded mid-decision")


# ── safe_enforce_check ────────────────────────────────────────────────────────

def test_safe_enforce_check_blocks_on_exception(monkeypatch):
    monkeypatch.setattr(enf, "enforce_check", _boom)
    monkeypatch.delenv("ARCEO_FAIL_MODE", raising=False)
    out = enf.safe_enforce_check("any-agent", "stripe", "create_refund")
    assert out["decision"] == "BLOCK"
    assert out["reason"] == "enforcement_error"
    assert "RuntimeError" in out["message"]


def test_safe_enforce_check_break_glass_allow(monkeypatch):
    monkeypatch.setattr(enf, "enforce_check", _boom)
    monkeypatch.setenv("ARCEO_FAIL_MODE", "allow")
    out = enf.safe_enforce_check("any-agent", "stripe", "create_refund")
    assert out["decision"] == "ALLOW"
    assert "error" in out["reason"] or "error" in out["message"].lower()


def test_safe_enforce_check_passthrough_when_healthy(client, two_orgs):
    a = two_orgs["org_a"]
    r = client.post("/api/authority/agents", headers=a["headers"],
                    json={"name": "fail-closed-healthy", "tools": [STRIPE_TOOL]})
    agent_id = r.json()["agent"]["id"] if "agent" in r.json() else r.json()["id"]
    out = enf.safe_enforce_check(agent_id, "stripe", "create_refund")
    assert out["decision"] == "ALLOW"  # no policies yet, default_effect ALLOW


# ── /proxy/{service} ──────────────────────────────────────────────────────────

def _mint_key(client, headers, name="proxy-test-key"):
    r = client.post("/api/keys", headers=headers, json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()["key"]


def test_proxy_requires_api_key_even_with_zero_keys(client):
    # Fresh-DB posture: BEFORE any key exists the proxy must already 401 —
    # the old conditional made a keyless install a wide-open egress proxy.
    r = client.post("/proxy/stripe/v1/refunds", headers={"X-Agent-ID": "nobody"})
    assert r.status_code == 401


def test_proxy_blocks_and_skips_upstream_on_enforcement_error(client, two_orgs, monkeypatch):
    a = two_orgs["org_a"]
    key = _mint_key(client, a["headers"])

    monkeypatch.setattr(enf, "enforce_check", _boom)
    monkeypatch.delenv("ARCEO_FAIL_MODE", raising=False)

    upstream_called = {"n": 0}

    import httpx

    def _handler(request):
        upstream_called["n"] += 1
        return httpx.Response(200, json={"ok": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda *a, **k: real(transport=httpx.MockTransport(_handler), timeout=k.get("timeout")))

    r = client.post("/proxy/stripe/v1/refunds",
                    headers={"X-API-Key": key, "X-Agent-ID": "some-agent"},
                    json={"amount": 100})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("blocked") is True
    assert upstream_called["n"] == 0


def test_proxy_strips_stale_content_headers(client, two_orgs, monkeypatch):
    a = two_orgs["org_a"]
    key = _mint_key(client, a["headers"], name="proxy-header-key")

    decompressed = b'{"ok": true, "padding": "' + b"x" * 200 + b'"}'

    import httpx

    def _handler(request):
        # Simulate an upstream sending a STALE content-length (23) that no longer
        # matches the real body — forwarding it verbatim truncates the response.
        return httpx.Response(200, content=decompressed,
                              headers={"content-length": "23", "content-type": "application/json"})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda *a, **k: real(transport=httpx.MockTransport(_handler), timeout=k.get("timeout")))

    r = client.get("/proxy/stripe/v1/customers",
                   headers={"X-API-Key": key, "X-Agent-ID": "some-agent"})
    assert r.status_code == 200
    assert r.content == decompressed  # full body, not truncated to 23 bytes
    assert r.headers.get("content-encoding") is None


# ── SDK ───────────────────────────────────────────────────────────────────────

@pytest.fixture()
def _sdk_offline(monkeypatch):
    import urllib.request as _url

    def _refuse(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(_url, "urlopen", _refuse)


def test_sdk_fails_closed_by_default(_sdk_offline, monkeypatch):
    monkeypatch.delenv("ARCEO_FAIL_MODE", raising=False)
    out = sdk_enforce("agent", "stripe", "create_refund")
    assert out["decision"] == "BLOCK"
    assert "error" in out


def test_sdk_on_error_allow_restores_fail_open(_sdk_offline, monkeypatch):
    monkeypatch.delenv("ARCEO_FAIL_MODE", raising=False)
    out = sdk_enforce("agent", "stripe", "create_refund", on_error="allow")
    assert out["decision"] == "ALLOW"


def test_sdk_env_break_glass(_sdk_offline, monkeypatch):
    monkeypatch.setenv("ARCEO_FAIL_MODE", "allow")
    out = sdk_enforce("agent", "stripe", "create_refund")
    assert out["decision"] == "ALLOW"


def test_sdk_explicit_arg_beats_env(_sdk_offline, monkeypatch):
    monkeypatch.setenv("ARCEO_FAIL_MODE", "allow")
    out = sdk_enforce("agent", "stripe", "create_refund", on_error="block")
    assert out["decision"] == "BLOCK"
