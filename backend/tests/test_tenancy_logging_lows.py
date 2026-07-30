"""Low batch 1 — tenancy + logging hygiene (LOW-004, LOW-005, LOW-014, LOW-015).

Four findings that share a theme: the audit trail and the RLS backstop were both
quietly less useful than they looked.

  LOW-004  every privileged access-log line was attributed to org "system",
           because the log middleware read the ContextVar after the tenant
           middleware had already reset it
  LOW-005  live-trace Redis keys carried no tenant prefix — safe today only
           because agents.id happens to be a global primary key
  LOW-014  refused privileged actions produced no audit row at all, and a
           credential that failed to resolve fell back to full RLS access
           silently
  LOW-015  the snapshot job wrote every tenant's rows in ONE transaction at the
           'system' context, so the RLS backstop was inert for the one job that
           touches everybody
"""

from __future__ import annotations

import json
import logging
import uuid

import pytest

import shared_state
from db import get_db


def _agent(client, headers, name="low1") -> str:
    r = client.post("/api/authority/agents", headers=headers,
                    json={"name": f"{name}-{uuid.uuid4().hex[:6]}", "tools": []})
    assert r.status_code == 200, r.text
    body = r.json()
    return body["agent"]["id"] if "agent" in body else body["id"]


# ── LOW-004: privileged access log carries the real org ───────────────────────

def test_access_log_records_the_callers_org_not_system(client, roles, caplog):
    """The line exists to answer "who did this privileged thing" — and the tenant
    half of the answer was always "system"."""
    admin = roles["admin"]
    with caplog.at_level(logging.INFO, logger="arceo.access"):
        _agent(client, admin["headers"])  # a POST under /api/ => privileged

    lines = [json.loads(r.getMessage()) for r in caplog.records
             if r.name == "arceo.access"]
    assert lines, "no privileged access-log line was emitted"
    assert any(l["org_id"] == admin["org_id"] for l in lines), \
        f"expected org {admin['org_id']}, got {[l['org_id'] for l in lines]}"
    assert not any(l["org_id"] == "system" for l in lines)


def test_two_orgs_are_distinguishable_in_the_access_log(client, two_orgs, caplog):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    with caplog.at_level(logging.INFO, logger="arceo.access"):
        _agent(client, a["headers"])
        _agent(client, b["headers"])

    orgs = {json.loads(r.getMessage())["org_id"] for r in caplog.records
            if r.name == "arceo.access"}
    assert a["org_id"] in orgs and b["org_id"] in orgs


# ── LOW-014: a refused privileged action is audited ───────────────────────────

def test_authz_denial_writes_an_audit_row(client, roles):
    """A burst of 403s from one account is the signal that someone is probing what
    their role reaches — and it was the one thing the trail could not show."""
    viewer = roles["viewer"]
    r = client.get("/api/notifications/settings", headers=viewer["headers"])
    assert r.status_code == 403, r.text

    with get_db() as conn:
        row = conn.execute(
            "SELECT action, user_email, org_id FROM audit_log "
            "WHERE action = 'AUTHZ_DENIED' AND user_email = %s ORDER BY timestamp DESC LIMIT 1",
            (viewer["email"],),
        ).fetchone()
    assert row is not None, "the denial left no audit row"
    assert row["org_id"] == roles["admin"]["org_id"]


def test_the_denial_row_survives_the_403(client, roles):
    """The handler raises straight after, which rolls back its transaction — the
    audit write has to be committed separately or it vanishes with the denial."""
    viewer = roles["viewer"]
    before = _count_denials(viewer["email"])
    for _ in range(3):
        assert client.get("/api/notifications/settings",
                          headers=viewer["headers"]).status_code == 403
    assert _count_denials(viewer["email"]) == before + 3


def _count_denials(email: str) -> int:
    with get_db() as conn:
        return int(conn.execute(
            "SELECT count(*) AS n FROM audit_log WHERE action = 'AUTHZ_DENIED' AND user_email = %s",
            (email,),
        ).fetchone()["n"])


def test_an_allowed_action_writes_no_denial(client, roles):
    admin = roles["admin"]
    before = _count_denials(admin["email"])
    assert client.get("/api/notifications/settings", headers=admin["headers"]).status_code == 200
    assert _count_denials(admin["email"]) == before


# ── LOW-005: live-trace keys are tenant-namespaced ────────────────────────────

def test_trace_keys_are_namespaced_by_org():
    assert shared_state._trace_key("agent-1", "org-a") != shared_state._trace_key("agent-1", "org-b")
    assert shared_state.channel("agent-1", "org-a") != shared_state.channel("agent-1", "org-b")
    assert "org-a" in shared_state._trace_key("agent-1", "org-a")


def test_two_orgs_do_not_share_a_trace_buffer():
    """Today agents.id is a global PK so this cannot happen via the API — the
    point is that separation now lives in the cache key rather than depending on
    a constraint in another table."""
    agent_id = f"shared-{uuid.uuid4().hex[:8]}"
    shared_state.push_trace(agent_id, json.dumps({"who": "a"}), "org-a")
    shared_state.push_trace(agent_id, json.dumps({"who": "b"}), "org-b")

    a = [json.loads(e) for e in shared_state.drain_traces(agent_id, "org-a")]
    b = [json.loads(e) for e in shared_state.drain_traces(agent_id, "org-b")]
    assert a == [{"who": "a"}]
    assert b == [{"who": "b"}]


def test_ws_slot_counters_are_per_org():
    agent_id = f"slots-{uuid.uuid4().hex[:8]}"
    assert shared_state.ws_acquire_slot(agent_id, 1, "org-a") is True
    assert shared_state.ws_acquire_slot(agent_id, 1, "org-a") is False   # org-a full
    assert shared_state.ws_acquire_slot(agent_id, 1, "org-b") is True    # org-b unaffected


def test_live_trace_roundtrip_through_the_api(client, roles):
    """End-to-end: push via the API, drain via the API, with the org coming from
    the authenticated caller at both ends."""
    admin = roles["admin"]
    aid = _agent(client, admin["headers"])
    key = client.post("/api/keys", headers=admin["headers"], json={"name": "low5"}).json()["key"]

    r = client.post("/api/traces/live", headers={"X-API-Key": key}, json={
        "agent_id": aid, "tool": "stripe", "action": "create_refund",
        "params": {}, "result": {}, "decision": "ALLOW", "duration_ms": 1,
        "risk_labels": ["moves_money"]})
    assert r.status_code == 200, r.text

    got = client.get(f"/api/traces/live/{aid}", headers=admin["headers"]).json()
    assert got["count"] == 1
    assert got["events"][0]["action"] == "create_refund"


# ── LOW-015: the snapshot job runs per-org, in its own transaction ────────────

def test_snapshot_job_sets_the_org_context_per_org(client, two_orgs, monkeypatch):
    """The job used to run the whole fleet in one transaction at 'system', so RLS
    was inert for the one job that touches every tenant."""
    from db import current_org
    from jobs import snapshot_forecasts

    a, b = two_orgs["org_a"], two_orgs["org_b"]
    _agent(client, a["headers"], "snap-a")
    _agent(client, b["headers"], "snap-b")

    seen: list[str] = []
    real = snapshot_forecasts._snapshot_one_org

    def _spy(agents, snapshot_date, captured_at):
        seen.append(current_org.get())
        return real(agents, snapshot_date, captured_at)

    monkeypatch.setattr(snapshot_forecasts, "_snapshot_one_org", _spy)
    snapshot_forecasts.snapshot_all_agents()

    assert a["org_id"] in seen and b["org_id"] in seen, seen
    assert "system" not in seen, "the fleet was still snapshotted at the system context"
    # One transaction per org, not one for the whole fleet.
    assert len(seen) == len(set(seen))


def test_snapshot_job_actually_writes_rows(client, roles):
    """Regression for a bug found while restructuring this job, not a finding:
    `_live_trace_count_7d` indexed its row positionally (`row[0]`), which is a
    KeyError under psycopg3's dict_row factory. The per-agent body swallows
    exceptions into a `failed` counter, so the job had been failing on EVERY agent
    and writing zero snapshots since the Postgres migration — silently, because
    nothing polls its exit code.

    `failed == 0` alone would not have caught it: a job that snapshots nothing at
    all also fails nothing.
    """
    from jobs import snapshot_forecasts
    from jobs.snapshot_forecasts import _live_trace_count_7d

    _agent(client, roles["admin"]["headers"], "snap-sum")

    # The precise regression: this raised KeyError: 0 on every call.
    with get_db() as conn:
        assert isinstance(_live_trace_count_7d(conn, "any-agent"), int)

    result = snapshot_forecasts.snapshot_all_agents()
    for k in ("snapshot_date", "written", "skipped", "failed"):
        assert k in result
    # With at least one agent present, `failed` was >= 1 before the fix — every
    # agent hit the exception and was counted as a failure.
    assert result["failed"] == 0, "the job is still erroring per-agent"
    # Deliberately NOT asserting written >= 1: an agent with no sandbox or live
    # traces yields `available: False` and is skipped on purpose, so a written
    # count depends on test data the forecaster considers real, not on this fix.
