"""Postgres database — agents, policies, audit log, execution log, users, organizations.

Multi-tenant: every table has org_id. All queries filter by org_id.

Schema is owned by Alembic (backend/alembic/) — init_db() applies migrations
and seeds; there is no inline DDL here. Raw SQL through psycopg3, no ORM.
"""

from __future__ import annotations

import os
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import json

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

# Production guard: refuse to boot on a real deploy without an explicit
# DATABASE_URL — the localhost default below only exists to pair with the
# docker-compose postgres service for development.
_PROD_MARKERS = ("RAILWAY_ENVIRONMENT", "FLY_APP_NAME", "RENDER", "PRODUCTION")
DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    if any(os.getenv(k) for k in _PROD_MARKERS):
        raise RuntimeError(
            "DATABASE_URL is not set on a production deploy. Point it at the "
            "production Postgres instance."
        )
    # Dev default: matches docker-compose.yml (`docker compose up -d postgres`).
    DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/arceo"

DEFAULT_ORG_ID = "default"

# The URL is resolved at import time — tests set DATABASE_URL before importing
# the app (conftest.py), the same timing contract ARCEO_DB_PATH had. The pool
# itself opens lazily on first use, so importing this module never requires a
# reachable server (alembic and utility scripts import it too). Thread-safe:
# the snapshot-scheduler daemon thread calls get_db() off the request path.
_POOL = ConnectionPool(
    DATABASE_URL,
    kwargs={"row_factory": dict_row},
    open=False,
)

# Per-request tenant context for row-level security. Request middleware sets
# this to the caller's org; everything else (seeding, scheduler, migrations,
# unauthenticated endpoints) leaves it at 'system', which the RLS policy treats
# as full access. get_db() applies it as a transaction-local GUC so an org's
# connection can only see that org's rows — a structural backstop under the
# app-level org_id filters.
import contextvars

current_org: contextvars.ContextVar[str] = contextvars.ContextVar("current_org", default="system")


@contextmanager
def get_db():
    """Yield a pooled connection; commit on clean exit, roll back on exception.

    Same call shape as the SQLite era (`with get_db() as conn:`) — ~150 call
    sites depend on it. Rows come back as dicts (row_factory=dict_row), so
    row["col"] and `"col" in row.keys()` behave as they did in the SQLite era.

    Sets app.current_org (transaction-local) from the request context so RLS
    scopes every statement in this transaction to the caller's tenant.
    """
    _POOL.open()  # no-op when already open
    conn = _POOL.getconn()
    try:
        # set_config(..., is_local=true) == SET LOCAL: resets on commit/rollback,
        # so a pooled connection never leaks one request's org into the next.
        conn.execute("SELECT set_config('app.current_org', %s, true)", (current_org.get(),))
        yield conn
        conn.commit()
    except BaseException:
        # SQLite discarded uncommitted work on close; Postgres needs the
        # rollback to be explicit before the connection returns to the pool.
        conn.rollback()
        raise
    finally:
        _POOL.putconn(conn)


def init_db():
    """Apply Alembic migrations (they own ALL schema) and seed baseline rows."""
    from alembic import command
    from alembic.config import Config

    os.environ["DATABASE_URL"] = DATABASE_URL  # alembic/env.py reads it
    cfg = Config(str(Path(__file__).parent / "alembic.ini"))
    command.upgrade(cfg, "head")

    with get_db() as conn:
        org_count = conn.execute("SELECT COUNT(*) AS n FROM organizations").fetchone()["n"]
        if org_count == 0:
            conn.execute(
                "INSERT INTO organizations (id, name, created_at) VALUES (%s, %s, %s)",
                (DEFAULT_ORG_ID, "Default Organization", datetime.utcnow().isoformat()),
            )

        user_count = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
        if user_count == 0:
            _seed_demo_user(conn)


def _seed_demo_user(conn):
    """Seed the initial admin user in the default org.

    In DEMO_MODE we use the well-known demo password so demos stay reproducible.
    Otherwise we generate a random one-time password and log it once — a fresh
    production DB must never boot with a publicly-known credential.
    """
    import secrets, logging
    from auth import hash_password
    now = datetime.utcnow().isoformat()
    demo = os.getenv("DEMO_MODE", "").lower() == "true"
    password = "admin123" if demo else secrets.token_urlsafe(16)
    pw_hash = hash_password(password)
    conn.execute(
        "INSERT INTO users (id, email, password_hash, name, role, org_id, created_at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (str(uuid.uuid4()), "admin@actiongate.io", pw_hash, "Admin", "admin", DEFAULT_ORG_ID, now),
    )
    if not demo:
        logging.getLogger("actiongate.db").warning(
            "Seeded initial admin 'admin@actiongate.io' with a RANDOM one-time password: %s — "
            "log in and change it immediately. (Set DEMO_MODE=true to use the demo password.)",
            password,
        )


# ── Query helpers (all org-scoped) ────────────────────────────────────────

def get_agent_from_db(conn, agent_id: str, org_id: str = None) -> dict | None:
    """Load a full agent config from the database, scoped to org."""
    if org_id:
        row = conn.execute("SELECT * FROM agents WHERE id = %s AND org_id = %s", (agent_id, org_id)).fetchone()
    else:
        row = conn.execute("SELECT * FROM agents WHERE id = %s", (agent_id,)).fetchone()
    if not row:
        return None

    tools = conn.execute(
        "SELECT * FROM agent_tools WHERE agent_id = %s ORDER BY id", (agent_id,)
    ).fetchall()

    agent = {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "org_id": row["org_id"],
        "simulation_model": row["simulation_model"] if "simulation_model" in row.keys() else None,
        "expected_calls_per_day": row["expected_calls_per_day"] if "expected_calls_per_day" in row.keys() else None,
        "expected_turns_per_run": row["expected_turns_per_run"] if "expected_turns_per_run" in row.keys() else None,
        "avg_context_tokens": row["avg_context_tokens"] if "avg_context_tokens" in row.keys() else None,
        "system_prompt": row["system_prompt"] if "system_prompt" in row.keys() else None,
        "environment": row["environment"] if "environment" in row.keys() else None,
        "trigger_source": row["trigger_source"] if "trigger_source" in row.keys() else None,
        "human_in_loop": row["human_in_loop"] if "human_in_loop" in row.keys() else None,
        "default_effect": (row["default_effect"] if "default_effect" in row.keys() else None) or "ALLOW",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "tools": [],
    }

    for t in tools:
        actions = conn.execute(
            "SELECT * FROM tool_actions WHERE tool_id = %s ORDER BY id", (t["id"],)
        ).fetchall()
        agent["tools"].append({
            "name": t["name"],
            "service": t["service"],
            "description": t["description"],
            "actions": [
                {
                    "action": a["action"],
                    "description": a["description"],
                    "risk_labels": json.loads(a["risk_labels"]),
                    "reversible": bool(a["reversible"]),
                    "classification_source": (
                        a["classification_source"]
                        if "classification_source" in a.keys() else "unknown"
                    ),
                }
                for a in actions
            ],
        })

    return agent


def get_all_agents_from_db(conn, org_id: str = None) -> list[dict]:
    """Load all agents from the database, scoped to org."""
    if org_id:
        rows = conn.execute("SELECT id FROM agents WHERE org_id = %s ORDER BY name", (org_id,)).fetchall()
    else:
        rows = conn.execute("SELECT id FROM agents ORDER BY name").fetchall()
    return [get_agent_from_db(conn, r["id"]) for r in rows]


def audit_entry_hash(prev_hash: str, org_id: str, action: str, resource, detail,
                     user_id, user_email, timestamp: str) -> str:
    """The chain hash for one audit row. Shared by the writer (log_audit) and the
    verifier (/api/audit/verify) so they can never disagree. Order + separator
    are fixed; a tamper that reshuffles or edits any field changes the digest."""
    import hashlib
    content = "|".join([
        prev_hash or "", org_id or "", action or "", resource or "", detail or "",
        str(user_id or ""), user_email or "", timestamp or "",
    ])
    return hashlib.sha256(content.encode()).hexdigest()


def log_audit(conn, user_id: str | None, user_email: str | None, action: str, resource: str = None, detail: str = None, org_id: str = DEFAULT_ORG_ID):
    """Write an audit log entry — tamper-evident and append-only (Phase 6).

    Each row is chained: entry_hash = sha256(prev_hash || this row's content),
    per org. An advisory lock serialises same-org writers so the chain stays
    linear. Failures raise (never silently drop an audit row); the DB trigger
    blocks any later edit/delete.

    Deliberately same-transaction with the action it records — NOT an async
    queue. A queue would risk losing rows on crash, the opposite of audit-grade;
    consistency here is the whole point."""
    ts = datetime.utcnow().isoformat()
    # Serialize concurrent same-org audit writes so two don't read the same
    # prev_hash and fork the chain. Transaction-scoped; released on commit.
    conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"audit:{org_id}",))
    prev = conn.execute(
        "SELECT entry_hash FROM audit_log WHERE org_id = %s ORDER BY id DESC LIMIT 1", (org_id,)
    ).fetchone()
    prev_hash = (prev["entry_hash"] if prev and prev["entry_hash"] else "")
    entry = audit_entry_hash(prev_hash, org_id, action, resource, detail, user_id, user_email, ts)
    conn.execute(
        "INSERT INTO audit_log (user_id, user_email, action, resource, detail, org_id, timestamp, prev_hash, entry_hash) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (user_id, user_email, action, resource, detail, org_id, ts, prev_hash, entry),
    )


def log_execution(conn, agent_id: str, tool: str, action: str, status: str, policy_id: int = None, detail: str = None, org_id: str = DEFAULT_ORG_ID, params: dict = None, source: str = None) -> int:
    """Write an execution log entry; returns the new row id.

    `params` (the action's arguments) are stored as JSON so the approvals queue
    can show reviewers WHAT they are approving, not just which action. `source`
    records where the call came from (runtime | sandbox | boundary_test |
    replay | report | test) so a reviewer can tell live agent traffic from
    simulations and seeded data. The returned id lets a caller link a durable
    pending_requests row to the PENDING_APPROVAL execution row (Phase 4)."""
    row = conn.execute(
        "INSERT INTO execution_log (agent_id, tool, action, status, policy_id, detail, params, source, org_id, timestamp) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (agent_id, tool, action, status, policy_id, detail,
         json.dumps(params) if params else None, source, org_id, datetime.utcnow().isoformat()),
    ).fetchone()
    return row["id"]
