"""Phase-6 PR-1: audit-grade logging — tamper-evident + append-only.

The audit chain verifies clean under normal use; editing a past row breaks the
chain (and /api/audit/verify proves it); deleting an audit row is refused at the
database level.
"""

from __future__ import annotations

import uuid

import pytest

from db import get_db


def _do_some_audited_actions(client, headers):
    # Each of these writes an audit row via log_audit.
    client.post("/api/authority/agents", headers=headers,
                json={"name": "aud-" + uuid.uuid4().hex[:6], "tools": []})
    client.post("/api/keys", headers=headers, json={"name": "k"})


def test_chain_verifies_clean(client, roles):
    admin = roles["admin"]
    _do_some_audited_actions(client, admin["headers"])
    r = client.get("/api/audit/verify", headers=admin["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["valid"] is True
    assert r.json()["checked"] >= 2


def test_chained_rows_have_hashes(client, roles):
    admin = roles["admin"]
    _do_some_audited_actions(client, admin["headers"])
    with get_db() as conn:
        rows = conn.execute("SELECT prev_hash, entry_hash FROM audit_log WHERE org_id = %s ORDER BY id",
                            (admin["org_id"],)).fetchall()
    assert all(r["entry_hash"] for r in rows)
    # each row's prev_hash links to the previous row's entry_hash
    for i in range(1, len(rows)):
        assert rows[i]["prev_hash"] == rows[i - 1]["entry_hash"]


def test_tampering_a_past_row_breaks_the_chain(client, roles):
    admin = roles["admin"]
    _do_some_audited_actions(client, admin["headers"])
    # A DB-level tamper must bypass the app; but UPDATE is blocked by the trigger,
    # so we prove tamper-EVIDENCE by disabling the trigger (as an attacker with DB
    # access would), editing a row, and showing verify catches it.
    with get_db() as conn:
        rid = conn.execute("SELECT id FROM audit_log WHERE org_id = %s ORDER BY id LIMIT 1",
                          (admin["org_id"],)).fetchone()["id"]
        conn.execute("ALTER TABLE audit_log DISABLE TRIGGER trg_audit_append_only")
        conn.execute("UPDATE audit_log SET detail = 'TAMPERED' WHERE id = %s", (rid,))
        conn.execute("ALTER TABLE audit_log ENABLE TRIGGER trg_audit_append_only")
    r = client.get("/api/audit/verify", headers=admin["headers"])
    assert r.json()["valid"] is False
    assert r.json()["broken_at"] == rid


def test_delete_is_refused_at_db_level(client, roles):
    admin = roles["admin"]
    _do_some_audited_actions(client, admin["headers"])
    import psycopg
    with pytest.raises(psycopg.errors.Error):
        with get_db() as conn:
            conn.execute("DELETE FROM audit_log WHERE org_id = %s", (admin["org_id"],))


def test_verify_is_admin_only(client, roles):
    viewer = roles["viewer"]
    assert client.get("/api/audit/verify", headers=viewer["headers"]).status_code == 403


def test_demo_wipe_does_not_erase_audit(client, roles, monkeypatch):
    # Even a demo reset can't drop the audit trail.
    admin = roles["admin"]
    _do_some_audited_actions(client, admin["headers"])
    with get_db() as conn:
        before = conn.execute("SELECT count(*) AS n FROM audit_log").fetchone()["n"]
    import main
    main._wipe_demo_data()
    with get_db() as conn:
        after = conn.execute("SELECT count(*) AS n FROM audit_log").fetchone()["n"]
    assert after >= before  # audit_log untouched by the wipe
