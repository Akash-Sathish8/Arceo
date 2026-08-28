"""Tier 3.1 and 3.2 — the two Tier 3 items that became beta-blocking.

Both were correctly sized as post-hosting when hosting was hypothetical. The
2026-08-18 decision that beta customers run on an Arceo-HOSTED instance moved
them: neither is defensible on a shared instance holding another company's code.

3.1 — one server-wide GITHUB_TOKEN read whatever repository any customer named,
      with owner/repo supplied by the caller and only editor-rank gating.
3.2 — deleting an agent orphaned its captured prompt and response bodies, and
      the audit export silently returned the most recent 100 rows while
      presenting as complete.
"""

from __future__ import annotations

import uuid

import pytest

import main


STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"action": "create_refund", "risk_labels": ["moves_money"],
                            "reversible": False}]}


def _agent(client, headers, name=None):
    r = client.post("/api/authority/agents", headers=headers,
                    json={"name": name or ("iso-" + uuid.uuid4().hex[:6]),
                          "tools": [STRIPE_TOOL], "simulation_model": "claude-sonnet-4-6"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _capture(org_id: str, agent_id: str, body: str = "a customer's private prompt") -> None:
    """Write a captured LLM body the way the capture path does."""
    from db import get_db

    with get_db() as conn:
        conn.execute(
            "INSERT INTO llm_captures (id, org_id, agent_id, content, content_sha256, created_at) "
            "VALUES (%s,%s,%s,%s,%s,%s)",
            (uuid.uuid4().hex[:12], org_id, agent_id, body, "x" * 64,
             "2026-08-01T00:00:00"),
        )


def _capture_count(org_id: str, agent_id: str) -> int:
    from db import get_db

    with get_db() as conn:
        return int(conn.execute(
            "SELECT COUNT(*) AS n FROM llm_captures WHERE org_id = %s AND agent_id = %s",
            (org_id, agent_id),
        ).fetchone()["n"])


@pytest.fixture()
def org(two_orgs):
    return two_orgs["org_a"]


@pytest.fixture(autouse=True)
def _master_key(monkeypatch):
    """The credential vault refuses to operate without a master key, and the
    test environment does not set one (correctly — see test_crypto_config).
    Same fixture the existing vault tests use."""
    import base64

    import vault

    monkeypatch.setenv(vault.MASTER_KEY_ENV, base64.b64encode(b"t" * 32).decode())


# ── 3.2 (1): deleting an agent must take its captured bodies with it ────────

def test_deleting_an_agent_erases_its_captured_bodies(client, org):
    """THE 3.2 test.

    `llm_captures.agent_id` is a bare Text column with an index but NO foreign
    key and NO cascade, so deletion orphaned the captured prompt and response
    bodies — the densest customer PII in the product. Nothing referenced them
    afterwards; only the age sweep would ever have removed them, and that sweep
    runs on the scheduler thread which until Tier 2.8 died permanently on a
    single Redis error.
    """
    agent_id = _agent(client, org["headers"])
    _capture(org["org_id"], agent_id)
    _capture(org["org_id"], agent_id)
    assert _capture_count(org["org_id"], agent_id) == 2

    r = client.delete(f"/api/authority/agent/{agent_id}", headers=org["headers"])
    assert r.status_code == 200, r.text
    assert _capture_count(org["org_id"], agent_id) == 0, "captured bodies outlived the agent"
    assert r.json()["cleaned"]["captures"] == 2, "the count must be reported, not silent"


def test_bulk_delete_erases_them_too(client, org):
    """Bulk delete is the path a customer offboarding a fleet actually uses, so
    it must not be the one that leaves the PII behind."""
    ids = [_agent(client, org["headers"]) for _ in range(3)]
    for aid in ids:
        _capture(org["org_id"], aid)

    r = client.post("/api/authority/agents/delete", headers=org["headers"],
                    json={"agent_ids": ids})
    assert r.status_code == 200, r.text
    assert r.json()["captures_erased"] == 3
    for aid in ids:
        assert _capture_count(org["org_id"], aid) == 0


def test_erasure_does_not_reach_another_orgs_captures(client, two_orgs):
    """`erase_captures_for_agent` is org-scoped. Agent ids are caller-supplied on
    registration, so two tenants CAN hold the same id — deletion must not become
    a cross-tenant delete primitive."""
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    shared_id = "same-id-" + uuid.uuid4().hex[:6]
    _agent(client, a["headers"], shared_id)
    _capture(a["org_id"], shared_id)
    _capture(b["org_id"], shared_id)          # org B's row, same agent id

    client.delete(f"/api/authority/agent/{shared_id}", headers=a["headers"])
    assert _capture_count(a["org_id"], shared_id) == 0
    assert _capture_count(b["org_id"], shared_id) == 1, "deleted another tenant's data"


def test_the_audit_row_survives_the_erasure(client, org):
    """The body goes, the trail does not. `erase_captures_for_agent` leaves the
    audit rows with their metadata and digest so the hash chain never notices —
    deleting PII must not look like tampering."""
    agent_id = _agent(client, org["headers"])
    _capture(org["org_id"], agent_id)
    client.delete(f"/api/authority/agent/{agent_id}", headers=org["headers"])

    v = client.get("/api/audit/verify", headers=org["headers"])
    assert v.status_code == 200, v.text
    assert v.json().get("valid") is not False, "erasure broke the audit chain"


# ── 3.2 (2): the export knows how much it is not showing ───────────────────

def test_the_audit_export_reports_what_it_left_out(client, org):
    """History.tsx's 'Export CSV' reads this endpoint and presents the result as
    a full export. Hard-capped at 100 with no cursor, a customer asking for
    their audit trail — a compliance request, or a pre-deletion copy — silently
    received the most recent 100 rows and no indication that was not all of it.

    The pagination matters less than `total`: a truncated export that KNOWS it
    is truncated is a UI problem; one that does not is a wrong answer to a
    compliance question."""
    for _ in range(3):
        _agent(client, org["headers"])          # each registration writes audit rows

    r = client.get("/api/audit?limit=1", headers=org["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["entries"]) == 1
    assert body["total"] > 1, "the caller cannot tell how much was withheld"
    assert body["hasMore"] is True
    assert body["limit"] == 1 and body["offset"] == 0


def test_paging_walks_the_whole_audit_trail(client, org):
    for _ in range(3):
        _agent(client, org["headers"])
    total = client.get("/api/audit?limit=1", headers=org["headers"]).json()["total"]

    seen, offset = [], 0
    while offset < total:
        page = client.get(f"/api/audit?limit=2&offset={offset}", headers=org["headers"]).json()
        seen.extend(page["entries"])
        offset += 2
    assert len(seen) == total


def test_executions_carry_the_same_contract(client, org):
    r = client.get("/api/executions?limit=5", headers=org["headers"])
    assert r.status_code == 200, r.text
    assert set(r.json()) >= {"entries", "total", "limit", "offset", "hasMore"}


def test_the_page_size_is_bounded(client, org):
    """The audit table is append-only and grows a row per LLM call. An
    unbounded read is its own item (3.3) — this must not become the way in."""
    assert client.get("/api/audit?limit=100000", headers=org["headers"]).status_code == 422
    assert main._HISTORY_PAGE_MAX <= 1000


def test_the_audit_export_stays_admin_only(client, roles):
    """Pagination must not have widened who can read it — `detail` carries
    captured prompts and responses (MED-001)."""
    for who in ("editor", "viewer"):
        assert client.get("/api/audit", headers=roles[who]["headers"]).status_code == 403


# ── 3.1: the repo scan uses the tenant's own credential ────────────────────

def test_scan_prefers_the_orgs_own_credential(client, org, monkeypatch):
    """One server-wide token reading whatever repository any customer names is
    unremarkable on a self-host and indefensible on a shared instance."""
    monkeypatch.setenv("GITHUB_TOKEN", "server-wide-token")
    r = client.put("/api/credentials/github_scan", headers=org["headers"],
                   json={"secret": "ghp_org_specific"})
    assert r.status_code == 200, r.text

    token, source = main._github_scan_token(org["org_id"])
    assert token == "ghp_org_specific"
    assert source == "org"


def test_it_falls_back_to_the_server_token(client, org, monkeypatch):
    """Self-host and local dev must keep working unchanged — the whole point of
    the fallback."""
    monkeypatch.setenv("GITHUB_TOKEN", "server-wide-token")
    token, source = main._github_scan_token(org["org_id"])
    assert token == "server-wide-token"
    assert source == "server"


def test_one_orgs_scan_credential_is_not_visible_to_another(client, two_orgs, monkeypatch):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    client.put("/api/credentials/github_scan", headers=a["headers"],
               json={"secret": "ghp_only_org_a"})

    assert main._github_scan_token(a["org_id"])[0] == "ghp_only_org_a"
    assert main._github_scan_token(b["org_id"])[0] is None, "cross-tenant credential read"


def test_scan_credentials_are_separate_from_runtime_github_credentials(client, org, monkeypatch):
    """⚠️ The design point. The existing `github` row is injected into the
    AGENT's runtime GitHub calls, and those include force_push,
    merge_pull_request and delete_branch. Reusing it for repo READS would run
    every scan on a production write credential; two purposes means a customer
    can grant the scan a read-only scope."""
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    client.put("/api/credentials/github", headers=org["headers"],
               json={"secret": "ghp_write_capable_runtime"})

    token, _ = main._github_scan_token(org["org_id"])
    assert token != "ghp_write_capable_runtime", (
        "the scan is using the agent's write-capable runtime credential"
    )
    assert "github_scan" in main.VAULT_SUPPORTED_PROVIDERS


def test_a_broken_credential_does_not_500_the_scan(client, org, monkeypatch):
    """An undecryptable row must degrade to the server token, not take the
    endpoint down."""
    monkeypatch.setenv("GITHUB_TOKEN", "server-wide-token")
    from db import get_db

    client.put("/api/credentials/github_scan", headers=org["headers"],
               json={"secret": "ghp_will_be_corrupted"})
    with get_db() as conn:
        conn.execute(
            "UPDATE provider_credentials SET encrypted_config = %s "
            "WHERE org_id = %s AND provider = 'github_scan'",
            (b"not-decryptable", org["org_id"]),
        )
    token, source = main._github_scan_token(org["org_id"])
    assert token == "server-wide-token" and source == "server"


def test_tenant_errors_do_not_leak_operator_instructions():
    """A customer on a shared instance cannot set an env var on our backend.
    Telling them to is useless AND a disclosure about how the service is run —
    and it contradicted the UI's own 'Public repos only'."""
    import inspect

    src = inspect.getsource(main.extract_agents_from_github)
    assert "GITHUB_TOKEN env var on the backend" not in src
    assert "set GITHUB_TOKEN on the backend" not in src
    assert "Settings → API & Integration → Credentials" in src
