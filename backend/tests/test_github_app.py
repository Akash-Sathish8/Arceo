"""Connect with GitHub: the signed state, the callback's ownership check, and
how a linked installation is used (and dropped) by the repo scan."""

import json
import re
import time
import types
import uuid

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

import github_app
import main


@pytest.fixture()
def app_env(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    import base64, os
    monkeypatch.setenv("ARCEO_VAULT_MASTER_KEY", base64.b64encode(os.urandom(32)).decode())
    monkeypatch.setenv("GITHUB_APP_ID", "123")
    monkeypatch.setenv("GITHUB_APP_SLUG", "arceo-test")
    monkeypatch.setenv("GITHUB_APP_CLIENT_ID", "Iv1.abc")
    monkeypatch.setenv("GITHUB_APP_CLIENT_SECRET", "shh")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", pem.replace("\n", "\\n"))
    github_app._token_cache.clear()
    yield


_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _mock(monkeypatch, handler):
    # Always wrap the REAL client: re-mocking must replace, not stack.
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _REAL_ASYNC_CLIENT(
        transport=httpx.MockTransport(handler), timeout=k.get("timeout")))


def _github(installs=(), *, token_status=201, repos=(), seen=None):
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if seen is not None:
            seen.append((request.method, url, request.headers.get("authorization")))
        if url.startswith("https://github.com/login/oauth/access_token"):
            return httpx.Response(200, json={"access_token": "user-tok"})
        if "/user/installations" in url:
            return httpx.Response(200, json={"installations": [
                {"id": i, "account": {"login": f"acct{i}", "type": "User"}} for i in installs]})
        if "/access_tokens" in url:
            if token_status != 201:
                return httpx.Response(token_status, json={})
            return httpx.Response(201, json={"token": "inst-tok", "expires_at": "2099-01-01T00:00:00Z"})
        if "/installation/repositories" in url:
            return httpx.Response(200, json={"repositories": list(repos)})
        return httpx.Response(404)
    return handler


def _connect(client, who, monkeypatch, installs, installation_id=""):
    r = client.post("/api/integrations/github/connect", headers=who["headers"])
    assert r.status_code == 200, r.text
    start = client.get(r.json()["url"], follow_redirects=False)
    assert start.status_code == 302
    assert start.headers["location"].startswith("https://github.com/login/oauth/authorize")
    state = re.search(r"state=([^&]+)", start.headers["location"]).group(1)
    _mock(monkeypatch, _github(installs))
    q = f"code=abc&state={state}" + (f"&installation_id={installation_id}" if installation_id else "")
    return client.get(f"/api/integrations/github/callback?{q}", follow_redirects=False)


# ── Signed tokens ────────────────────────────────────────────────────────────

def test_state_round_trips_and_rejects_tampering():
    tok = github_app.sign({"k": "state", "org": "o1"}, 60)
    assert github_app.verify(tok, "state")["org"] == "o1"
    raw, mac = tok.split(".")
    assert github_app.verify(raw + "." + mac[:-2] + "AA", "state") is None
    assert github_app.verify(tok, "ticket") is None  # a state is not a ticket


def test_expired_state_is_rejected():
    tok = github_app.sign({"k": "state", "org": "o1"}, -1)
    assert github_app.verify(tok, "state") is None


# ── Status + connect flow ────────────────────────────────────────────────────

def test_unconfigured_server_reports_it(client, roles, monkeypatch):
    monkeypatch.delenv("GITHUB_APP_ID", raising=False)
    r = client.get("/api/integrations/github", headers=roles["admin"]["headers"])
    assert r.status_code == 200
    assert r.json()["configured"] is False and r.json()["connected"] is False


def test_connect_links_an_installation_the_user_can_see(client, roles, app_env, monkeypatch):
    r = _connect(client, roles["admin"], monkeypatch, installs=[777])
    assert r.status_code == 302
    assert "github=connected" in r.headers["location"]
    status = client.get("/api/integrations/github", headers=roles["admin"]["headers"]).json()
    assert status["connected"] is True and status["account"] == "acct777"
    assert main._github_app_link(roles["admin"]["org_id"])["installation_id"] == 777


def test_a_forged_installation_id_is_ignored(client, roles, app_env, monkeypatch):
    """installation_id arrives as a query param anyone can edit. Only an
    installation on the connecting user's own /user/installations is linked."""
    r = _connect(client, roles["admin"], monkeypatch, installs=[5], installation_id="99999")
    assert r.status_code == 302
    assert main._github_app_link(roles["admin"]["org_id"])["installation_id"] == 5


def test_no_installation_yet_sends_the_user_to_install(client, roles, app_env, monkeypatch):
    r = _connect(client, roles["admin"], monkeypatch, installs=[])
    assert r.status_code == 302
    assert r.headers["location"].startswith("https://github.com/apps/arceo-test/installations/new")
    assert main._github_app_link(roles["admin"]["org_id"]) is None


def test_callback_without_the_state_cookie_links_nothing(client, roles, app_env, monkeypatch):
    _mock(monkeypatch, _github([1]))
    r = client.get("/api/integrations/github/callback?code=abc&installation_id=1", follow_redirects=False)
    assert "github_error=expired" in r.headers["location"]
    assert main._github_app_link(roles["admin"]["org_id"]) is None


def test_mismatched_state_is_rejected(client, roles, app_env, monkeypatch):
    r = client.post("/api/integrations/github/connect", headers=roles["admin"]["headers"])
    client.get(r.json()["url"], follow_redirects=False)
    _mock(monkeypatch, _github([1]))
    r = client.get("/api/integrations/github/callback?code=abc&state=forged", follow_redirects=False)
    assert "github_error=state" in r.headers["location"]


def test_the_link_is_per_workspace(client, two_orgs, app_env, monkeypatch):
    _connect(client, two_orgs["org_a"], monkeypatch, installs=[42])
    assert main._github_app_link(two_orgs["org_a"]["org_id"]) is not None
    assert main._github_app_link(two_orgs["org_b"]["org_id"]) is None


def test_generic_credentials_put_cannot_forge_a_link(client, roles):
    r = client.put("/api/credentials/github_app", headers=roles["admin"]["headers"], json={"secret": "1"})
    assert r.status_code == 422


def test_only_admins_disconnect(client, roles, app_env, monkeypatch):
    _connect(client, roles["admin"], monkeypatch, installs=[8])
    assert client.delete("/api/integrations/github", headers=roles["editor"]["headers"]).status_code == 403
    assert client.delete("/api/integrations/github", headers=roles["admin"]["headers"]).status_code == 200
    assert main._github_app_link(roles["admin"]["org_id"]) is None


def test_repos_lists_the_installation(client, roles, app_env, monkeypatch):
    _connect(client, roles["admin"], monkeypatch, installs=[9])
    _mock(monkeypatch, _github(repos=[
        {"full_name": "acct9/old", "private": False, "default_branch": "main", "pushed_at": "2025-01-01"},
        {"full_name": "acct9/new", "private": True, "default_branch": "main", "pushed_at": "2026-01-01"},
    ]))
    body = client.get("/api/integrations/github/repos", headers=roles["admin"]["headers"]).json()
    assert [r["full_name"] for r in body["repos"]] == ["acct9/new", "acct9/old"]


# ── Use in the scan ──────────────────────────────────────────────────────────

class _Fake:
    def __init__(self):
        self.messages = self

    def create(self, **kw):
        body = {"name": f"priv-{uuid.uuid4().hex[:6]}", "tools": [{"name": "s", "actions": [{"name": "a"}]}]}
        return types.SimpleNamespace(content=[types.SimpleNamespace(text=json.dumps(body))], stop_reason="end_turn")


def test_private_repo_scans_through_the_installation(client, roles, app_env, monkeypatch):
    _connect(client, roles["admin"], monkeypatch, installs=[11])
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(main, "anthropic_client", lambda key: _Fake())
    seen = []
    base = _github(seen=seen)

    def handler(request):
        url = str(request.url)
        if "/access_tokens" in url:
            return base(request)
        seen.append((request.method, url, request.headers.get("authorization")))
        if url.endswith("/repos/acct11/secret"):
            ok = request.headers.get("authorization") == "Bearer inst-tok"
            return httpx.Response(200 if ok else 404, json={"private": True, "default_branch": "main"})
        if "/git/trees/" in url:
            return httpx.Response(200, json={"tree": [{"type": "blob", "path": "agent.py", "size": 20}]})
        if "/contents/agent.py" in url:
            return httpx.Response(200, text="import anthropic\n")
        return httpx.Response(404)

    _mock(monkeypatch, handler)
    r = client.post("/api/authority/agents/extract-github", headers=roles["admin"]["headers"],
                    json={"url": "https://github.com/acct11/secret"})
    assert r.status_code == 200, r.text
    assert r.json()["private"] is True
    assert r.json()["results"][0]["status"] == "registered"
    fetches = [s for s in seen if "/contents/" in s[1]]
    assert fetches and all(a == "Bearer inst-tok" for _, _, a in fetches)
    assert not any("raw.githubusercontent.com" in u for _, u, _ in seen)


def test_uninstalled_app_drops_the_link(client, roles, app_env, monkeypatch):
    _connect(client, roles["admin"], monkeypatch, installs=[12])
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    github_app._token_cache.clear()

    def handler(request):
        url = str(request.url)
        if "/access_tokens" in url:
            return httpx.Response(404, json={})
        return httpx.Response(404, json={})

    _mock(monkeypatch, handler)
    r = client.post("/api/authority/agents/extract-github", headers=roles["admin"]["headers"],
                    json={"url": "https://github.com/acct12/secret"})
    assert r.status_code == 404
    assert main._github_app_link(roles["admin"]["org_id"]) is None


def test_public_scans_use_the_operator_installation_but_never_for_private(client, roles, app_env, monkeypatch):
    """With no server PAT, the operator's own installation token lifts the
    anonymous rate limit for PUBLIC repos, and is still refused on a private one."""
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setenv("GITHUB_APP_PUBLIC_INSTALLATION_ID", "4242")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(main, "anthropic_client", lambda key: _Fake())
    github_app._token_cache.clear()
    seen = []

    def handler(request):
        url = str(request.url)
        seen.append((url, request.headers.get("authorization")))
        if "/app/installations/4242/access_tokens" in url:
            return httpx.Response(201, json={"token": "house-tok", "expires_at": "2099-01-01T00:00:00Z"})
        if url.endswith("/repos/acme/private"):
            return httpx.Response(200, json={"private": True, "default_branch": "main"})
        if url.endswith("/repos/acme/public"):
            return httpx.Response(200, json={"private": False, "default_branch": "main"})
        if "/git/trees/" in url:
            return httpx.Response(200, json={"tree": []})
        return httpx.Response(404)

    _mock(monkeypatch, handler)
    ok = client.post("/api/authority/agents/extract-github", headers=roles["admin"]["headers"],
                     json={"url": "https://github.com/acme/public"})
    assert ok.status_code == 200, ok.text
    assert any(u.endswith("/repos/acme/public") and a == "Bearer house-tok" for u, a in seen)

    denied = client.post("/api/authority/agents/extract-github", headers=roles["admin"]["headers"],
                         json={"url": "https://github.com/acme/private"})
    assert denied.status_code == 403
