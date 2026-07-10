"""Phase-3 PR-4: prove RLS genuinely enforces isolation.

A Postgres SUPERUSER bypasses RLS even when it's FORCED, and the test suite
connects as the superuser `postgres` — so the rest of the suite can't observe
RLS at all. This test creates a dedicated NON-superuser role, seeds two orgs'
rows as the superuser, then connects as the restricted role and shows that with
app.current_org set to org B, even a naked `SELECT * FROM agents` (no WHERE
clause — i.e. a future missing app-level filter) returns ONLY org B's rows.

That's the whole point of the layer: it's a structural backstop that a dropped
`WHERE org_id` cannot defeat.
"""

from __future__ import annotations

import uuid

import psycopg
import pytest

from db import DATABASE_URL

_APP_ROLE = "arceo_rls_test_app"
_APP_PW = "rls_test_pw"


def _admin_url() -> str:
    return DATABASE_URL


def _app_url() -> str:
    # same host/db, restricted role
    from urllib.parse import urlsplit, urlunsplit
    p = urlsplit(DATABASE_URL)
    netloc = f"{_APP_ROLE}:{_APP_PW}@{p.hostname}:{p.port or 5432}"
    return urlunsplit((p.scheme, netloc, p.path, "", ""))


@pytest.fixture()
def restricted_role():
    """Create a non-superuser role with DML grants (no BYPASSRLS)."""
    with psycopg.connect(_admin_url(), autocommit=True) as admin:
        admin.execute(f"DROP ROLE IF EXISTS {_APP_ROLE}")
        admin.execute(f"CREATE ROLE {_APP_ROLE} LOGIN PASSWORD '{_APP_PW}'")
        admin.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {_APP_ROLE}")
        admin.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {_APP_ROLE}")
    yield
    with psycopg.connect(_admin_url(), autocommit=True) as admin:
        admin.execute(f"DROP OWNED BY {_APP_ROLE}")
        admin.execute(f"DROP ROLE IF EXISTS {_APP_ROLE}")


def _seed_org(admin, org_id: str) -> str:
    agent_id = f"rls-{org_id}-{uuid.uuid4().hex[:6]}"
    admin.execute("INSERT INTO organizations (id, name, created_at) VALUES (%s,%s,%s) ON CONFLICT (id) DO NOTHING",
                  (org_id, org_id, "2026-01-01"))
    admin.execute("INSERT INTO agents (id, name, org_id, created_at) VALUES (%s,%s,%s,%s)",
                  (agent_id, agent_id, org_id, "2026-01-01"))
    return agent_id


def test_rls_blocks_cross_org_even_without_where_clause(restricted_role):
    org_a, org_b = f"orgA-{uuid.uuid4().hex[:6]}", f"orgB-{uuid.uuid4().hex[:6]}"
    with psycopg.connect(_admin_url(), autocommit=True) as admin:
        a_agent = _seed_org(admin, org_a)
        b_agent = _seed_org(admin, org_b)

    with psycopg.connect(_app_url()) as appconn:
        appconn.execute("SELECT set_config('app.current_org', %s, true)", (org_b,))
        # Naked scan — the exact shape of a future query that FORGOT its org filter.
        rows = appconn.execute("SELECT id, org_id FROM agents").fetchall()
        seen = {r[1] for r in rows}
        ids = {r[0] for r in rows}
        assert org_a not in seen, "RLS leaked org A rows to an org-B connection"
        assert b_agent in ids and a_agent not in ids

    # Switching the GUC to org A flips what's visible — same connection role.
    with psycopg.connect(_app_url()) as appconn:
        appconn.execute("SELECT set_config('app.current_org', %s, true)", (org_a,))
        rows = appconn.execute("SELECT id FROM agents").fetchall()
        ids = {r[0] for r in rows}
        assert a_agent in ids and b_agent not in ids


def test_rls_write_check_blocks_cross_org_insert(restricted_role):
    org_a, org_b = f"orgA-{uuid.uuid4().hex[:6]}", f"orgB-{uuid.uuid4().hex[:6]}"
    with psycopg.connect(_admin_url(), autocommit=True) as admin:
        _seed_org(admin, org_a)
        _seed_org(admin, org_b)

    # As org A, WITH CHECK must forbid inserting a row tagged for org B.
    with psycopg.connect(_app_url()) as appconn:
        appconn.execute("SELECT set_config('app.current_org', %s, true)", (org_a,))
        with pytest.raises(psycopg.errors.Error):
            appconn.execute(
                "INSERT INTO agents (id, name, org_id, created_at) VALUES (%s,%s,%s,%s)",
                (f"evil-{uuid.uuid4().hex[:6]}", "evil", org_b, "2026-01-01"),
            )


def test_system_context_sees_all(restricted_role):
    """The 'system' sentinel (seeding/scheduler/migrations) keeps full access."""
    org_a, org_b = f"orgA-{uuid.uuid4().hex[:6]}", f"orgB-{uuid.uuid4().hex[:6]}"
    with psycopg.connect(_admin_url(), autocommit=True) as admin:
        a_agent = _seed_org(admin, org_a)
        b_agent = _seed_org(admin, org_b)

    with psycopg.connect(_app_url()) as appconn:
        appconn.execute("SELECT set_config('app.current_org', %s, true)", ("system",))
        ids = {r[0] for r in appconn.execute("SELECT id FROM agents").fetchall()}
        assert a_agent in ids and b_agent in ids
