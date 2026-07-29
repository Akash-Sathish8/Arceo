"""MED-015 + MED-016 — what a failure is allowed to tell the caller.

MED-016: four handlers plus the sim runner interpolated `str(e)` into what the
client received, so upstream response bodies, a caller-supplied URL and provider
internals came back as the response. The detail now moves to the log behind a
random reference. Two sites were deliberately LEFT informative — the tests at the
bottom pin those exclusions so they read as decisions, not misses.

MED-015: signup's duplicate-email branch skipped bcrypt, so it answered far
faster than a real signup. The response body was never the only tell.
"""

from __future__ import annotations

import logging
import uuid

import pytest

import errors


# ── errors.log_and_ref ────────────────────────────────────────────────────────

def test_log_and_ref_moves_the_detail_to_the_log(caplog):
    logger = logging.getLogger("test.errors.move")
    boom = ValueError("connect to 10.4.1.9:5432 failed; password=hunter2")
    with caplog.at_level(logging.WARNING, logger="test.errors.move"):
        ref = errors.log_and_ref(logger, "widget fetch", boom)

    logged = " ".join(r.getMessage() for r in caplog.records)
    # The operator keeps everything...
    assert "10.4.1.9:5432" in logged and "hunter2" in logged
    assert ref in logged
    # ...and the reference itself encodes nothing about the failure.
    assert len(ref) == 12
    assert all(c in "0123456789abcdef" for c in ref)
    assert "hunter2" not in ref


def test_refs_are_unique_per_occurrence():
    """A ref is a join key for one event, not a fingerprint of the error type —
    otherwise two users hitting the same bug would get the same ref and the log
    lookup would be ambiguous."""
    logger = logging.getLogger("test.errors.unique")
    same = ValueError("identical text")
    refs = {errors.log_and_ref(logger, "op", same) for _ in range(5)}
    assert len(refs) == 5


# ── MED-015: signup timing parity ─────────────────────────────────────────────

def test_duplicate_signup_still_pays_for_a_hash(client, monkeypatch):
    """The whole point of MED-015's timing half: bcrypt dominates this handler,
    and it used to run only when the account was actually created."""
    import auth

    hashed: list[str] = []
    real = auth.hash_password
    monkeypatch.setattr(auth, "hash_password",
                        lambda pw: (hashed.append(pw), real(pw))[1])

    email = f"dup-{uuid.uuid4().hex[:8]}@example.com"
    first = client.post("/api/auth/signup",
                        json={"email": email, "password": "pw12345678", "name": "A"})
    assert first.status_code == 200, first.text
    assert len(hashed) == 1

    second = client.post("/api/auth/signup",
                         json={"email": email, "password": "pw12345678", "name": "A"})
    assert second.status_code == 409
    assert len(hashed) == 2, "the duplicate branch must still pay the bcrypt cost"


def test_duplicate_signup_still_returns_409_on_purpose(client):
    """MED-015-b, pinned deliberately.

    A uniform response needs out-of-band confirmation for the legitimate new
    user, and email_utils.send_email is a no-op unless SMTP_HOST is set — there
    is no verification flow to hang it on. Until there is, 409 stays: a
    "uniform" response today would mean nobody can sign up. This test exists so
    that reads as a decision rather than an oversight.
    """
    email = f"still409-{uuid.uuid4().hex[:8]}@example.com"
    assert client.post("/api/auth/signup",
                       json={"email": email, "password": "pw12345678"}).status_code == 200
    assert client.post("/api/auth/signup",
                       json={"email": email, "password": "pw12345678"}).status_code == 409


# ── MED-016: the five sites that were leaking ─────────────────────────────────

_REF_HINT = "ref:"


def _assert_opaque(detail: str, *leaked: str):
    assert _REF_HINT in detail, f"no correlation ref in {detail!r}"
    for fragment in leaked:
        assert fragment not in detail, f"{fragment!r} still reflected in {detail!r}"


@pytest.fixture()
def upstream_refuses(monkeypatch):
    """Every egress raises a transport error carrying internal-looking detail."""
    import httpx

    secret_text = "failed to connect to 10.9.9.9:443 (internal-billing.corp)"

    def _handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(secret_text)

    for name in ("AsyncClient", "Client"):
        real = getattr(httpx, name)
        monkeypatch.setattr(
            httpx, name,
            lambda *a, _r=real, **k: _r(transport=httpx.MockTransport(_handler),
                                        timeout=k.get("timeout")),
        )
    return secret_text


def test_proxy_upstream_error_is_opaque(client, two_orgs, upstream_refuses):
    a = two_orgs["org_a"]
    agent = client.post("/api/authority/agents", headers=a["headers"],
                        json={"name": "err-proxy-agent", "tools": []})
    assert agent.status_code == 200, agent.text
    body = agent.json()
    agent_id = body["agent"]["id"] if "agent" in body else body["id"]
    key = client.post("/api/keys", headers=a["headers"], json={"name": "err-key"}).json()["key"]

    r = client.post("/proxy/stripe/v1/refunds",
                    headers={"X-API-Key": key, "X-Agent-ID": agent_id},
                    json={"amount": 1})
    assert r.status_code == 502, r.text
    detail = r.json()["detail"]
    # The service NAME stays — it is an allowlist key the caller already chose.
    assert "stripe" in detail
    _assert_opaque(detail, "10.9.9.9", "internal-billing.corp")


def test_mcp_connect_failure_does_not_echo_the_url(client, roles, upstream_refuses):
    """The worst of the set: it reported the caller's URL *and* what happened when
    the server dialled it, which is a reachability probe with extra steps."""
    r = client.post("/api/authority/agents/connect/mcp", headers=roles["admin"]["headers"],
                    json={"url": "http://93.184.216.34/mcp", "agent_name": "mcp-err"})
    assert r.status_code == 502, r.text
    detail = r.json()["detail"]
    _assert_opaque(detail, "93.184.216.34", "10.9.9.9", "internal-billing.corp")


def _stub_anthropic_raising(monkeypatch, module, text: str):
    """Point `module.anthropic_client` at a client whose create() explodes."""
    class _Messages:
        def create(self, **_kw):
            raise RuntimeError(text)

    class _Client:
        messages = _Messages()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-real")
    monkeypatch.setattr(module, "anthropic_client", lambda *_a, **_k: _Client())


def test_extraction_failure_is_opaque(client, roles, monkeypatch):
    import main

    leaked = "AuthenticationError: invalid x-api-key sk-ant-REALKEY req_abc123"
    _stub_anthropic_raising(monkeypatch, main, leaked)

    r = client.post("/api/authority/agents/extract", headers=roles["admin"]["headers"],
                    json={"content": "def tool_refund(amount): pass", "filename": "a.py"})
    assert r.status_code == 502, r.text
    _assert_opaque(r.json()["detail"], "sk-ant-REALKEY", "req_abc123", "AuthenticationError")


def test_scenario_generation_failure_is_opaque(client, roles, monkeypatch):
    import main

    agent = client.post("/api/authority/agents", headers=roles["admin"]["headers"],
                        json={"name": "scen-err-agent", "tools": []})
    assert agent.status_code == 200, agent.text
    body = agent.json()
    agent_id = body["agent"]["id"] if "agent" in body else body["id"]

    leaked = "RateLimitError: org org_INTERNAL_9 exceeded quota req_xyz789"
    _stub_anthropic_raising(monkeypatch, main, leaked)

    r = client.post(f"/api/sandbox/agent/{agent_id}/generate-scenarios",
                    headers=roles["admin"]["headers"])
    assert r.status_code == 502, r.text
    _assert_opaque(r.json()["detail"], "org_INTERNAL_9", "req_xyz789", "RateLimitError")


def test_simulation_trace_error_is_opaque(monkeypatch):
    """trace.error travels to the client with the simulation, so it is a response
    body in every sense that matters."""
    from sandbox import runner
    from sandbox.prompts.scenarios import ALL_SCENARIOS

    leaked = "APIConnectionError: api.anthropic.com resolved to 10.2.2.2 sk-ant-LEAK"

    def _boom(*_a, **_k):
        raise RuntimeError(leaked)

    monkeypatch.setattr(runner, "_call_llm", _boom)
    trace = runner.run_simulation({"id": "e", "name": "E", "tools": []}, ALL_SCENARIOS[0],
                                  api_key="sk-ant-test-not-real")

    assert trace.status == "error"
    assert _REF_HINT in trace.error
    for fragment in ("sk-ant-LEAK", "10.2.2.2", "APIConnectionError"):
        assert fragment not in trace.error
    # The model stays: it is the agent's own configured value and the first thing
    # you need when a sim fails.
    assert "claude" in trace.error.lower()


# ── The two deliberate exclusions ─────────────────────────────────────────────

def test_vault_config_error_stays_readable(client, roles, monkeypatch):
    """A 503 from a missing/weak master key is operator guidance with no secret
    material in it — making it opaque would leave an operator with a bare 503 and
    nothing to act on. Reviewed and kept as-is for MED-016."""
    import main
    import vault

    def _boom(_config):
        raise vault.VaultConfigError("ARCEO_MASTER_KEY is not set — see docs/SECURITY_DESIGN.md")

    monkeypatch.setattr(main.vault, "encrypt_credential", _boom)
    r = client.put("/api/credentials/stripe", headers=roles["admin"]["headers"],
                   json={"secret": "sk_live_x"})
    assert r.status_code == 503, r.text
    assert "ARCEO_MASTER_KEY" in r.json()["detail"]


def test_invoice_csv_error_stays_specific(client, roles):
    """The parse error describes the caller's OWN uploaded file. Replacing it with
    a reference would mean re-uploading blind. Reviewed and kept as-is."""
    r = client.post("/api/cost/invoices", headers=roles["admin"]["headers"],
                    json={"provider": "anthropic", "source": "csv",
                          "csv_text": "not,a,valid\ninvoice,file,here"})
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert _REF_HINT not in detail
    # Specific enough to fix the file without re-uploading blind: it names the
    # column it wanted AND echoes the headers the caller actually sent — which
    # are the caller's own data, not ours.
    assert "cost" in detail.lower()
    assert "not, a, valid" in detail
