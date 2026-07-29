"""Phase-2 PR-3: the credential vault.

The proxy used to forward the agent's own Authorization header upstream — an
agent holding its own Stripe key could bypass enforcement entirely. These
tests prove the fix end-to-end: the vaulted secret is injected, the
agent-supplied header and the Arceo X-API-Key never reach the upstream, and
with ARCEO_REQUIRE_VAULT=on an uncredentialed org's call is blocked before
any network egress ("no credential, no call").
"""

from __future__ import annotations

import base64
import os
import uuid

import pytest

import vault

STRIPE_TOOL = {
    "name": "stripe", "service": "stripe",
    "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}],
}

# Test-only master key, generated locally — never a real secret.
_TEST_MASTER_KEY = base64.b64encode(os.urandom(32)).decode()


@pytest.fixture(autouse=True)
def _master_key(monkeypatch):
    monkeypatch.setenv(vault.MASTER_KEY_ENV, _TEST_MASTER_KEY)


def _mint_key(client, headers, name="vault-test-key"):
    r = client.post("/api/keys", headers=headers, json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()["key"]


def _make_agent(client, headers, name):
    r = client.post("/api/authority/agents", headers=headers,
                    json={"name": name, "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text
    body = r.json()
    return body["agent"]["id"] if "agent" in body else body["id"]


@pytest.fixture()
def capture_upstream(monkeypatch):
    """Route every egress through a real httpx MockTransport so BOTH the
    streaming proxy (build_request + send) and the buffered replay (request)
    paths work, and record each forwarded request's headers."""
    import httpx

    calls: list[dict] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        calls.append({"method": request.method, "url": str(request.url),
                      "headers": {k.lower(): v for k, v in request.headers.items()}})
        return httpx.Response(200, json={"ok": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda *a, **k: real(transport=httpx.MockTransport(_handler), timeout=k.get("timeout")),
    )
    return calls


# ── vault.py unit ─────────────────────────────────────────────────────────────

def test_round_trip():
    config = {"secret": "sk_live_abc123", "subdomain": "acme"}
    wrapped_dek, blob = vault.encrypt_credential(config)
    assert vault.decrypt_credential(wrapped_dek, blob) == config
    # Nothing readable in the ciphertext.
    assert b"sk_live_abc123" not in blob and b"sk_live_abc123" not in wrapped_dek


def test_same_config_encrypts_differently():
    config = {"secret": "sk_live_abc123"}
    w1, b1 = vault.encrypt_credential(config)
    w2, b2 = vault.encrypt_credential(config)
    # Fresh DEK + fresh nonce per call: no two stored rows ever share bytes.
    assert w1 != w2 and b1 != b2


def test_wrong_master_key_fails_loudly(monkeypatch):
    from cryptography.exceptions import InvalidTag

    wrapped_dek, blob = vault.encrypt_credential({"secret": "s"})
    monkeypatch.setenv(vault.MASTER_KEY_ENV, base64.b64encode(os.urandom(32)).decode())
    with pytest.raises(InvalidTag):
        vault.decrypt_credential(wrapped_dek, blob)


@pytest.mark.parametrize("bad", ["", "not-base64!!", base64.b64encode(b"short").decode()])
def test_missing_or_weak_master_key_refused(monkeypatch, bad):
    if bad:
        monkeypatch.setenv(vault.MASTER_KEY_ENV, bad)
    else:
        monkeypatch.delenv(vault.MASTER_KEY_ENV, raising=False)
    with pytest.raises(vault.VaultConfigError):
        vault.encrypt_credential({"secret": "s"})


# ── /api/credentials CRUD ─────────────────────────────────────────────────────

def test_put_get_delete_lifecycle_and_no_secret_exposure(client, two_orgs):
    a = two_orgs["org_a"]
    r = client.put("/api/credentials/stripe", headers=a["headers"], json={"secret": "sk_live_vaulted"})
    assert r.status_code == 200, r.text

    r = client.get("/api/credentials", headers=a["headers"])
    assert r.status_code == 200
    creds = r.json()["credentials"]
    assert [c["provider"] for c in creds] == ["stripe"]
    # Metadata only — the secret never appears anywhere in the response.
    assert "sk_live_vaulted" not in r.text
    assert set(creds[0].keys()) == {"provider", "auth_type", "created_by", "created_at", "updated_at"}

    r = client.delete("/api/credentials/stripe", headers=a["headers"])
    assert r.status_code == 200
    assert client.get("/api/credentials", headers=a["headers"]).json()["credentials"] == []
    assert client.delete("/api/credentials/stripe", headers=a["headers"]).status_code == 404


def test_unsupported_provider_rejected(client, two_orgs):
    a = two_orgs["org_a"]
    # slack isn't in VAULT_SUPPORTED_PROVIDERS (zendesk/salesforce now are).
    r = client.put("/api/credentials/slack", headers=a["headers"], json={"secret": "s"})
    assert r.status_code == 422
    r = client.put("/api/credentials/stripe", headers=a["headers"], json={"secret": "   "})
    assert r.status_code == 422


def test_viewer_role_gets_403(client, two_orgs):
    """Uses a REAL viewer account. This used to mint a token for a random UUID that
    had no `users` row at all — which only reached the role check because
    get_current_user failed open on a missing row (MED-001). Now that it fails
    closed, a phantom user is 401 before RBAC is ever consulted, so testing 403
    requires a user who actually exists."""
    a = two_orgs["org_a"]
    email = f"viewer-{uuid.uuid4().hex[:8]}@example.com"
    r = client.post("/api/team/invite", headers=a["headers"],
                    json={"email": email, "password": "pw12345678", "role": "viewer"})
    assert r.status_code == 200, r.text
    viewer_token = client.post("/api/auth/login",
                               json={"email": email, "password": "pw12345678"}).json()["token"]
    vh = {"Authorization": f"Bearer {viewer_token}"}
    assert client.get("/api/credentials", headers=vh).status_code == 403
    assert client.put("/api/credentials/stripe", headers=vh, json={"secret": "s"}).status_code == 403
    assert client.delete("/api/credentials/stripe", headers=vh).status_code == 403


def test_credentials_are_org_scoped(client, two_orgs):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    client.put("/api/credentials/stripe", headers=a["headers"], json={"secret": "org-a-secret"})
    assert client.get("/api/credentials", headers=b["headers"]).json()["credentials"] == []


# ── The flagship integration: strip + inject ──────────────────────────────────

def test_proxy_strips_agent_key_and_injects_vaulted_secret(client, two_orgs, capture_upstream):
    a = two_orgs["org_a"]
    agent_id = _make_agent(client, a["headers"], "vault-inject-agent")
    api_key = _mint_key(client, a["headers"])
    assert client.put("/api/credentials/stripe", headers=a["headers"],
                      json={"secret": "sk_live_VAULTED"}).status_code == 200

    r = client.post(f"/proxy/stripe/v1/refunds",
                    headers={"X-API-Key": api_key, "X-Agent-ID": agent_id,
                             "Authorization": "Bearer sk_agent_OWN_KEY"},
                    json={"amount": 12})
    assert r.status_code == 200, r.text
    assert len(capture_upstream) == 1
    sent = {k.lower(): v for k, v in capture_upstream[0]["headers"].items()}
    # The roadmap's Phase-2 exit line, verbatim: the agent's own key is
    # stripped and the vaulted secret injected against a mock Stripe.
    assert sent.get("authorization") == "Bearer sk_live_VAULTED"
    assert "sk_agent_OWN_KEY" not in str(sent.values())
    assert "x-api-key" not in sent


def test_rotation_changes_what_is_injected(client, two_orgs, capture_upstream):
    a = two_orgs["org_a"]
    agent_id = _make_agent(client, a["headers"], "vault-rotate-agent")
    api_key = _mint_key(client, a["headers"])
    client.put("/api/credentials/stripe", headers=a["headers"], json={"secret": "sk_v1"})
    client.put("/api/credentials/stripe", headers=a["headers"], json={"secret": "sk_v2_rotated"})

    r = client.get("/proxy/stripe/v1/customers",
                   headers={"X-API-Key": api_key, "X-Agent-ID": agent_id})
    assert r.status_code == 200
    sent = {k.lower(): v for k, v in capture_upstream[-1]["headers"].items()}
    assert sent.get("authorization") == "Bearer sk_v2_rotated"


def test_require_vault_on_blocks_uncredentialed_org(client, two_orgs, capture_upstream, monkeypatch):
    b = two_orgs["org_b"]
    agent_id = _make_agent(client, b["headers"], "vault-blocked-agent")
    api_key = _mint_key(client, b["headers"])
    monkeypatch.setenv("ARCEO_REQUIRE_VAULT", "on")

    r = client.get("/proxy/stripe/v1/customers",
                   headers={"X-API-Key": api_key, "X-Agent-ID": agent_id,
                            "Authorization": "Bearer sk_agent_OWN_KEY"})
    assert r.status_code == 200
    assert r.json().get("blocked") is True
    assert "no vaulted credential" in r.json()["reason"]
    assert capture_upstream == []  # nothing forwarded

    # The block is provable after the fact: it landed in the execution log.
    r = client.get(f"/api/executions/{agent_id}", headers=b["headers"])
    entries = r.json()["entries"]
    assert any(e["status"] == "BLOCKED" and "no vaulted credential" in (e["detail"] or "")
               for e in entries)


def test_require_vault_off_keeps_passthrough(client, two_orgs, capture_upstream, monkeypatch):
    """Rollout safety: without the flag, an uncredentialed org behaves exactly
    as before the vault existed (agent header passes through)."""
    b = two_orgs["org_b"]
    agent_id = _make_agent(client, b["headers"], "vault-passthrough-agent")
    api_key = _mint_key(client, b["headers"])
    monkeypatch.delenv("ARCEO_REQUIRE_VAULT", raising=False)

    r = client.get("/proxy/stripe/v1/customers",
                   headers={"X-API-Key": api_key, "X-Agent-ID": agent_id,
                            "Authorization": "Bearer sk_agent_OWN_KEY"})
    assert r.status_code == 200
    sent = {k.lower(): v for k, v in capture_upstream[0]["headers"].items()}
    assert sent.get("authorization") == "Bearer sk_agent_OWN_KEY"


def test_delete_then_require_vault_blocks_again(client, two_orgs, capture_upstream, monkeypatch):
    a = two_orgs["org_a"]
    agent_id = _make_agent(client, a["headers"], "vault-revoke-agent")
    api_key = _mint_key(client, a["headers"])
    client.put("/api/credentials/stripe", headers=a["headers"], json={"secret": "sk_soon_gone"})
    client.delete("/api/credentials/stripe", headers=a["headers"])
    monkeypatch.setenv("ARCEO_REQUIRE_VAULT", "true")

    r = client.get("/proxy/stripe/v1/customers",
                   headers={"X-API-Key": api_key, "X-Agent-ID": agent_id})
    assert r.json().get("blocked") is True
    assert capture_upstream == []


# ── HIGH-001: proxy binds the target agent to the API key's org ────────────────

def test_proxy_rejects_cross_org_agent(client, two_orgs, capture_upstream):
    """A non-agent-scoped key from org A that names org B's agent must be refused
    (403) BEFORE any enforcement or vault egress — otherwise the proxy would inject
    org B's vaulted secret on behalf of an org-A caller (cross-tenant money movement)."""
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    key_a = _mint_key(client, a["headers"])                 # org A key, not agent-scoped
    agent_b = _make_agent(client, b["headers"], "orgb-proxy-target")
    # org B has a real credential — proves the 403 is the org bind, not a missing secret.
    client.put("/api/credentials/stripe", headers=b["headers"], json={"secret": "sk_orgB_secret"})

    r = client.post("/proxy/stripe/v1/refunds",
                    headers={"X-API-Key": key_a, "X-Agent-ID": agent_b}, json={"amount": 1000})
    assert r.status_code == 403, r.text
    assert capture_upstream == [], "cross-org proxy must not forward upstream"


def test_proxy_unknown_agent_is_404(client, two_orgs, capture_upstream):
    """An unknown X-Agent-ID is a hard 404, never a fall-through to the default org's
    secret — this is the branch that bites under active RLS, where a cross-org agent
    lookup returns no row."""
    a = two_orgs["org_a"]
    key_a = _mint_key(client, a["headers"])
    r = client.post("/proxy/stripe/v1/refunds",
                    headers={"X-API-Key": key_a, "X-Agent-ID": "does-not-exist"}, json={"amount": 1})
    assert r.status_code == 404, r.text
    assert capture_upstream == []


def test_proxy_same_org_agent_passes_bind(client, two_orgs, capture_upstream):
    """Positive: a key + agent in the SAME org pass the org bind and reach the normal
    enforce → vault-inject → forward path, so the new check isn't overbroad."""
    a = two_orgs["org_a"]
    key_a = _mint_key(client, a["headers"])
    agent_a = _make_agent(client, a["headers"], "orga-proxy-self")
    client.put("/api/credentials/stripe", headers=a["headers"], json={"secret": "sk_orgA_secret"})

    r = client.get("/proxy/stripe/v1/customers",
                   headers={"X-API-Key": key_a, "X-Agent-ID": agent_a})
    assert r.status_code == 200, r.text          # bind passed → forwarded via MockTransport
    assert len(capture_upstream) == 1
