"""Tier 2.10 — the flags that disable a protection must not work in production.

2.10 is mostly a handover document (docs/DEPLOYMENT_CONTRACT.md). These are the
parts of it that are code, and the first one is the reason it is not just a
document.

⚠️ `ARCEO_ALLOW_INTERNAL_MCP` was a full SSRF primitive with NO production gate.
`validate_external_url` returned before `getaddrinfo`, which disables BOTH the
loopback/private/link-local rejection AND the DNS-rebind IP pinning — the caller
receives `pinned_ip=None` and sends to the hostname unchanged. It is reached from
MCP connect, where the URL is caller-supplied and there is no host allowlist. So
with the flag set, "connect to an MCP server" fetches any address the server can
reach; on Google Cloud that includes 169.254.169.254, the metadata server that
issues service-account tokens.

⚠️ And `docs/security/backend/Dead_Code_Report.md` asserted these flags were
"each fenced against production by an explicit gate". That was true of DEMO_MODE
and false of this one. A security document saying a thing is safe is a very
effective way for it to stay unsafe, which is why the correction is written into
that file rather than only here.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import HTTPException

import egress


_METADATA = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/"
_ROOT = Path(__file__).resolve().parents[2]


# ── The SSRF bypass is dev-only now ─────────────────────────────────────────

@pytest.mark.parametrize("url", [
    _METADATA,                       # GCP metadata — service account tokens
    "http://127.0.0.1:5432/",        # the Cloud SQL Auth Proxy sidecar
    "http://10.0.0.5/admin",         # anything else in the VPC
])
def test_the_internal_bypass_is_ignored_outside_dev(monkeypatch, url):
    """THE 2.10 test. Setting the flag on a real deploy must accomplish
    nothing."""
    monkeypatch.setenv("ARCEO_ALLOW_INTERNAL_MCP", "1")
    monkeypatch.setenv("ARCEO_ENV", "production")
    with pytest.raises(HTTPException) as e:
        egress.validate_external_url(url)
    assert e.value.status_code == 400


def test_an_unset_arceo_env_also_counts_as_production(monkeypatch):
    """Same default as every other guard — forgetting the variable must not
    quietly re-enable an SSRF primitive."""
    monkeypatch.setenv("ARCEO_ALLOW_INTERNAL_MCP", "1")
    monkeypatch.delenv("ARCEO_ENV", raising=False)
    with pytest.raises(HTTPException):
        egress.validate_external_url(_METADATA)


def test_ignoring_the_flag_is_logged_not_silent(monkeypatch, caplog):
    """An operator who set it deliberately needs to know it did nothing;
    otherwise they conclude the bypass is broken and go looking for another
    way through."""
    monkeypatch.setenv("ARCEO_ALLOW_INTERNAL_MCP", "1")
    monkeypatch.setenv("ARCEO_ENV", "production")
    with caplog.at_level("WARNING"):
        with pytest.raises(HTTPException):
            egress.validate_external_url(_METADATA)
    assert any("ARCEO_ALLOW_INTERNAL_MCP" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("env", ["dev", "local", "test", "ci"])
def test_the_bypass_still_works_where_it_is_meant_to(monkeypatch, env):
    """The counterweight. This exists so someone can point Arceo at an MCP
    server on their laptop; breaking that would just get the guard reverted."""
    monkeypatch.setenv("ARCEO_ALLOW_INTERNAL_MCP", "1")
    monkeypatch.setenv("ARCEO_ENV", env)
    assert egress.validate_external_url("http://localhost:9000/mcp") is None


def test_the_guard_is_on_by_default_with_the_flag_unset(monkeypatch):
    monkeypatch.delenv("ARCEO_ALLOW_INTERNAL_MCP", raising=False)
    monkeypatch.setenv("ARCEO_ENV", "dev")
    with pytest.raises(HTTPException):
        egress.validate_external_url(_METADATA)


# ── The container honours the port its platform assigns ─────────────────────

def test_the_container_honours_PORT():
    """Nothing in backend/ reads PORT and the Dockerfile hardcoded 8000, but
    Cloud Run injects PORT and routes to it — so a by-the-book deploy started a
    server nobody could reach. Fixed rather than documented as a workaround."""
    dockerfile = (_ROOT / "Dockerfile").read_text()
    cmd = [l for l in dockerfile.splitlines() if l.startswith("CMD [")][-1]
    assert "${PORT:-8000}" in cmd, "the port is hardcoded again"
    json.loads(cmd[4:])          # exec form must stay valid JSON
    assert '"exec ' in cmd or "exec python" in cmd, (
        "without exec, uvicorn is not PID 1 and will not receive SIGTERM"
    )


def test_the_healthcheck_follows_the_same_port():
    """A healthcheck pinned to 8000 while the server listens on $PORT reports a
    permanently unhealthy container."""
    dockerfile = (_ROOT / "Dockerfile").read_text()
    hc = [l for l in dockerfile.splitlines() if "api/health" in l][0]
    assert "PORT" in hc


# ── Every protection-disabling flag is documented ───────────────────────────

@pytest.mark.parametrize("flag", [
    "ARCEO_ENV", "DEMO_MODE", "ARCEO_FAIL_MODE", "ARCEO_ALLOW_INTERNAL_MCP",
    "ARCEO_ENCRYPT_AT_REST", "ARCEO_VAULT_MASTER_KEY",
])
def test_the_dangerous_flags_are_documented(flag):
    """2.10's list. `.env.example` documented none of them, which is how a
    deploy ends up with one set by someone who did not know what it turns off."""
    assert flag in (_ROOT / "backend" / ".env.example").read_text(), \
        f"{flag} is undocumented"


def test_the_security_doc_no_longer_claims_the_bypass_is_gated():
    """The false sentence is corrected in place rather than deleted — a reader
    who remembers the original claim needs to find out it was wrong, and the
    correction is the record that it went unnoticed for a reason."""
    report = (_ROOT / "docs" / "security" / "backend" / "Dead_Code_Report.md").read_text()
    assert "CORRECTION (Tier 2.10" in report
    assert "was FALSE for `ARCEO_ALLOW_INTERNAL_MCP`" in report


def test_fail_open_enforcement_is_announced_at_boot():
    """ARCEO_FAIL_MODE=allow is read per-exception deep inside
    safe_enforce_check, so an instance can run for months failing open with
    nothing anywhere saying so."""
    import inspect

    import main

    assert 'ARCEO_FAIL_MODE' in inspect.getsource(main.lifespan)
    assert "FAILS OPEN" in inspect.getsource(main.lifespan)
