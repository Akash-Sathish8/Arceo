"""SQLite database — agents, policies, audit log, execution log, users, organizations.

Multi-tenant: every table has org_id. All queries filter by org_id.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "actiongate.db"

DEFAULT_ORG_ID = "default"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_db():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    """Create tables and seed sample data if empty."""
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS organizations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT
            );

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                role TEXT DEFAULT 'viewer',
                org_id TEXT DEFAULT 'default' REFERENCES organizations(id),
                created_at TEXT
            );

            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                tenant_id TEXT,
                org_id TEXT DEFAULT 'default',
                simulation_model TEXT,
                created_at TEXT,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS agent_tools (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                service TEXT NOT NULL,
                description TEXT
            );

            CREATE TABLE IF NOT EXISTS tool_actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tool_id INTEGER REFERENCES agent_tools(id) ON DELETE CASCADE,
                action TEXT NOT NULL,
                description TEXT,
                risk_labels TEXT DEFAULT '[]',
                reversible BOOLEAN DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS policies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
                action_pattern TEXT NOT NULL,
                effect TEXT NOT NULL,
                reason TEXT,
                conditions TEXT DEFAULT '[]',
                priority INTEGER DEFAULT 0,
                org_id TEXT DEFAULT 'default',
                created_by TEXT,
                created_at TEXT
            );

            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                user_email TEXT,
                action TEXT NOT NULL,
                resource TEXT,
                detail TEXT,
                org_id TEXT DEFAULT 'default',
                timestamp TEXT
            );

            CREATE TABLE IF NOT EXISTS execution_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT,
                tool TEXT,
                action TEXT,
                status TEXT,
                policy_id INTEGER,
                detail TEXT,
                org_id TEXT DEFAULT 'default',
                timestamp TEXT
            );

            CREATE TABLE IF NOT EXISTS test_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
                data_json TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS simulations (
                id TEXT PRIMARY KEY,
                agent_id TEXT,
                scenario_id TEXT,
                status TEXT,
                trace_json TEXT,
                report_json TEXT,
                org_id TEXT DEFAULT 'default',
                created_at TEXT
            );

            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                key_hash TEXT NOT NULL,
                key_prefix TEXT NOT NULL,
                name TEXT NOT NULL,
                created_by TEXT,
                agent_id TEXT,
                scopes TEXT DEFAULT '["enforce","register","report"]',
                active INTEGER DEFAULT 1,
                org_id TEXT DEFAULT 'default',
                last_used TEXT,
                created_at TEXT
            );

            CREATE TABLE IF NOT EXISTS sweeps (
                id TEXT PRIMARY KEY,
                agent_id TEXT,
                status TEXT,
                total_scenarios INTEGER,
                completed INTEGER,
                report_json TEXT,
                org_id TEXT DEFAULT 'default',
                created_at TEXT
            );

            CREATE TABLE IF NOT EXISTS workspace_settings (
                id INTEGER PRIMARY KEY DEFAULT 1,
                slack_webhook_url TEXT DEFAULT '',
                alert_email TEXT DEFAULT '',
                notify_on_block INTEGER DEFAULT 1,
                org_id TEXT DEFAULT 'default',
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS regression_baselines (
                id TEXT PRIMARY KEY,
                agent_id TEXT,
                version INTEGER DEFAULT 1,
                baseline_json TEXT NOT NULL,
                result_json TEXT,
                regressions_json TEXT,
                status TEXT DEFAULT 'baseline',
                org_id TEXT DEFAULT 'default',
                created_at TEXT
            );
        """)

        # Seed default org and demo user if empty
        org_count = conn.execute("SELECT COUNT(*) FROM organizations").fetchone()[0]
        if org_count == 0:
            conn.execute(
                "INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)",
                (DEFAULT_ORG_ID, "Default Organization", datetime.utcnow().isoformat()),
            )

        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if user_count == 0:
            _seed_demo_user(conn)


def _seed_demo_user(conn):
    """Seed only the demo login user in the default org."""
    from auth import hash_password
    now = datetime.utcnow().isoformat()
    pw_hash = hash_password("admin123")
    conn.execute(
        "INSERT INTO users (id, email, password_hash, name, role, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), "admin@actiongate.io", pw_hash, "Admin", "admin", DEFAULT_ORG_ID, now),
    )


# ── Query helpers (all org-scoped) ────────────────────────────────────────

def get_agent_from_db(conn, agent_id: str, org_id: str = None) -> dict | None:
    """Load a full agent config from the database, scoped to org."""
    if org_id:
        row = conn.execute("SELECT * FROM agents WHERE id = ? AND org_id = ?", (agent_id, org_id)).fetchone()
    else:
        row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    if not row:
        return None

    tools = conn.execute(
        "SELECT * FROM agent_tools WHERE agent_id = ? ORDER BY id", (agent_id,)
    ).fetchall()

    agent = {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "org_id": row["org_id"],
        "simulation_model": row["simulation_model"] if "simulation_model" in row.keys() else None,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "tools": [],
    }

    for t in tools:
        actions = conn.execute(
            "SELECT * FROM tool_actions WHERE tool_id = ? ORDER BY id", (t["id"],)
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
                }
                for a in actions
            ],
        })

    return agent


def get_all_agents_from_db(conn, org_id: str = None) -> list[dict]:
    """Load all agents from the database, scoped to org."""
    if org_id:
        rows = conn.execute("SELECT id FROM agents WHERE org_id = ? ORDER BY name", (org_id,)).fetchall()
    else:
        rows = conn.execute("SELECT id FROM agents ORDER BY name").fetchall()
    return [get_agent_from_db(conn, r["id"]) for r in rows]


def log_audit(conn, user_id: str | None, user_email: str | None, action: str, resource: str = None, detail: str = None, org_id: str = DEFAULT_ORG_ID):
    """Write an audit log entry."""
    conn.execute(
        "INSERT INTO audit_log (user_id, user_email, action, resource, detail, org_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user_id, user_email, action, resource, detail, org_id, datetime.utcnow().isoformat()),
    )


def log_execution(conn, agent_id: str, tool: str, action: str, status: str, policy_id: int = None, detail: str = None, org_id: str = DEFAULT_ORG_ID):
    """Write an execution log entry."""
    conn.execute(
        "INSERT INTO execution_log (agent_id, tool, action, status, policy_id, detail, org_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (agent_id, tool, action, status, policy_id, detail, org_id, datetime.utcnow().isoformat()),
    )
