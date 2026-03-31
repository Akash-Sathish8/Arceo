"""SQLite database — agents, policies, audit log, execution log, users."""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "actiongate.db"


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
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                role TEXT DEFAULT 'viewer',
                created_at TEXT
            );

            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                tenant_id TEXT,
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
                created_at TEXT
            );

            CREATE TABLE IF NOT EXISTS workspace_settings (
                id INTEGER PRIMARY KEY DEFAULT 1,
                slack_webhook_url TEXT DEFAULT '',
                alert_email TEXT DEFAULT '',
                notify_on_block INTEGER DEFAULT 1,
                updated_at TEXT
            );
        """)

        # Seed demo user if none exist
        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if user_count == 0:
            _seed_demo_user(conn)


def _seed_demo_user(conn):
    """Seed only the demo login user. No agents."""
    from auth import hash_password
    now = datetime.utcnow().isoformat()
    pw_hash = hash_password("admin123")
    conn.execute(
        "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), "admin@actiongate.io", pw_hash, "Admin", "admin", now),
    )


def _seed_ops_agent(conn, now: str):
    """Seed a default ops agent with GitHub, AWS, Slack, PagerDuty."""
    agent_id = "ops-agent"
    conn.execute(
        "INSERT OR IGNORE INTO agents (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (agent_id, "Ops Agent", "Infrastructure health, incident response, and remediation", now, now),
    )

    ops_tools = [
        ("github", "GitHub", "CI/CD and code changes", [
            ("get_pull_request", "View PR details", '[]', True),
            ("merge_pull_request", "Merge a PR", '["changes_production"]', False),
            ("trigger_workflow", "Run CI/CD pipeline", '["changes_production"]', True),
            ("get_workflow_status", "Check pipeline status", '[]', True),
            ("create_release", "Create a release", '["changes_production"]', False),
            ("rollback_release", "Rollback a release", '["changes_production"]', False),
        ]),
        ("aws", "AWS", "Infrastructure management", [
            ("list_instances", "List EC2 instances", '[]', True),
            ("start_instance", "Start an instance", '["changes_production"]', True),
            ("stop_instance", "Stop an instance", '["changes_production"]', True),
            ("terminate_instance", "Terminate an instance", '["changes_production", "deletes_data"]', False),
            ("scale_service", "Scale a service", '["changes_production"]', True),
            ("get_logs", "Retrieve logs", '[]', True),
            ("update_security_group", "Modify firewall rules", '["changes_production"]', False),
            ("create_snapshot", "Create backup", '[]', True),
            ("delete_snapshot", "Delete backup", '["deletes_data"]', False),
        ]),
        ("slack", "Slack", "Team notifications", [
            ("send_message", "Send Slack message", '["sends_external"]', False),
            ("send_channel_message", "Post to channel", '["sends_external"]', False),
        ]),
        ("pagerduty", "PagerDuty", "Incident management", [
            ("create_incident", "Create incident", '["changes_production"]', True),
            ("acknowledge_incident", "Acknowledge incident", '[]', True),
            ("resolve_incident", "Resolve incident", '[]', True),
            ("get_oncall", "Get on-call schedule", '[]', True),
            ("escalate_incident", "Escalate incident", '["changes_production"]', True),
            ("list_incidents", "List incidents", '[]', True),
        ]),
    ]

    for tool_name, service, desc, actions in ops_tools:
        cur = conn.execute(
            "INSERT INTO agent_tools (agent_id, name, service, description) VALUES (?, ?, ?, ?)",
            (agent_id, tool_name, service, desc),
        )
        tool_id = cur.lastrowid
        for action_name, action_desc, risk_labels, reversible in actions:
            conn.execute(
                "INSERT INTO tool_actions (tool_id, action, description, risk_labels, reversible) VALUES (?, ?, ?, ?, ?)",
                (tool_id, action_name, action_desc, risk_labels, reversible),
            )


# ── Query helpers ───────────────────────────────────────────────────────────

def get_agent_from_db(conn, agent_id: str) -> dict | None:
    """Load a full agent config from the database."""
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


def get_all_agents_from_db(conn) -> list[dict]:
    """Load all agents from the database."""
    rows = conn.execute("SELECT id FROM agents ORDER BY name").fetchall()
    return [get_agent_from_db(conn, r["id"]) for r in rows]


def log_audit(conn, user_id: str | None, user_email: str | None, action: str, resource: str = None, detail: str = None):
    """Write an audit log entry."""
    conn.execute(
        "INSERT INTO audit_log (user_id, user_email, action, resource, detail, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        (user_id, user_email, action, resource, detail, datetime.utcnow().isoformat()),
    )


def log_execution(conn, agent_id: str, tool: str, action: str, status: str, policy_id: int = None, detail: str = None):
    """Write an execution log entry."""
    conn.execute(
        "INSERT INTO execution_log (agent_id, tool, action, status, policy_id, detail, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (agent_id, tool, action, status, policy_id, detail, datetime.utcnow().isoformat()),
    )
