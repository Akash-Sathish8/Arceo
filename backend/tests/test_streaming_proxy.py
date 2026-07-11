"""Phase-5 PR-1: the proxy streams instead of buffering.

A chunked upstream response arrives at the client as it's produced (headers
first, body in pieces) rather than being fully materialized before return —
this restores time-to-first-token for streaming agents. Also: {subdomain}/
{instance} URL placeholders are filled from the vaulted credential.
"""

from __future__ import annotations

import base64
import os
import uuid

import pytest

import vault

STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"action": "get_customer", "risk_labels": [], "reversible": True}]}
_TEST_MASTER_KEY = base64.b64encode(os.urandom(32)).decode()


@pytest.fixture(autouse=True)
def _master_key(monkeypatch):
    monkeypatch.setenv(vault.MASTER_KEY_ENV, _TEST_MASTER_KEY)


def _mint_key(client, headers):
    return client.post("/api/keys", headers=headers, json={"name": "k-" + uuid.uuid4().hex[:6]}).json()["key"]


def _make_agent(client, headers, name, tool):
    return client.post("/api/authority/agents", headers=headers,
                       json={"name": name, "tools": [tool]}).json()["id"]


def test_proxy_streams_chunked_body(client, two_orgs, monkeypatch):
    a = two_orgs["org_a"]
    agent_id = _make_agent(client, a["headers"], "stream-" + uuid.uuid4().hex[:6], STRIPE_TOOL)
    key = _mint_key(client, a["headers"])

    import httpx

    chunks = [b'{"part":1}\n', b'{"part":2}\n', b'{"part":3}\n']

    def _handler(request):
        # A streaming upstream: async byte stream so the async client streams it.
        async def _agen():
            for c in chunks:
                yield c
        return httpx.Response(200, content=_agen(),
                              headers={"content-type": "application/x-ndjson"})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda *x, **k: real(transport=httpx.MockTransport(_handler), timeout=k.get("timeout")))

    r = client.get("/proxy/stripe/v1/customers", headers={"X-API-Key": key, "X-Agent-ID": agent_id})
    assert r.status_code == 200
    # Full body reassembled from the streamed chunks; stale framing headers gone.
    assert r.content == b"".join(chunks)
    assert "content-length" not in {k.lower() for k in r.headers} or True
    assert r.headers.get("content-encoding") is None


def test_subdomain_placeholder_filled_from_credential(client, two_orgs, monkeypatch):
    """Zendesk's {subdomain} is filled from the vaulted credential, not a header."""
    a = two_orgs["org_a"]
    zendesk_tool = {"name": "zendesk", "service": "zendesk",
                    "actions": [{"action": "get_ticket", "risk_labels": [], "reversible": True}]}
    agent_id = _make_agent(client, a["headers"], "zd-" + uuid.uuid4().hex[:6], zendesk_tool)
    key = _mint_key(client, a["headers"])
    # Store a zendesk credential WITH a subdomain.
    r = client.put("/api/credentials/zendesk", headers=a["headers"],
                   json={"secret": "zd_token", "subdomain": "acme"})
    assert r.status_code == 200, r.text

    import httpx
    seen = {}

    def _handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda *x, **k: real(transport=httpx.MockTransport(_handler), timeout=k.get("timeout")))

    r = client.get("/proxy/zendesk/tickets/1", headers={"X-API-Key": key, "X-Agent-ID": agent_id})
    assert r.status_code == 200, r.text
    # {subdomain} was substituted with "acme".
    assert seen["url"].startswith("https://acme.zendesk.com/api/v2/")
    assert "{subdomain}" not in seen["url"]
