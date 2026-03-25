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
        """)

        # Seed if no agents exist
        count = conn.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
        if count == 0:
            _seed_data(conn)


def _seed_data(conn):
    """Seed with the 3 sample agents and a demo user."""
    from authority.parser import SAMPLE_CONFIGS
    from authority.action_mapper import ACTION_CATALOG

    now = datetime.utcnow().isoformat()

    for config in SAMPLE_CONFIGS:
        conn.execute(
            "INSERT INTO agents (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (config["id"], config["name"], config["description"], now, now),
        )

        for tool in config["tools"]:
            cur = conn.execute(
                "INSERT INTO agent_tools (agent_id, name, service, description) VALUES (?, ?, ?, ?)",
                (config["id"], tool["name"], tool["service"], tool["description"]),
            )
            tool_id = cur.lastrowid

            # Pull action details from the catalog
            catalog = ACTION_CATALOG.get(tool["name"], {})
            for action_name in tool["actions"]:
                mapped = catalog.get(action_name)
                if mapped:
                    conn.execute(
                        "INSERT INTO tool_actions (tool_id, action, description, risk_labels, reversible) VALUES (?, ?, ?, ?, ?)",
                        (tool_id, action_name, mapped.description, json.dumps(mapped.risk_labels), mapped.reversible),
                    )
                else:
                    conn.execute(
                        "INSERT INTO tool_actions (tool_id, action, description, risk_labels, reversible) VALUES (?, ?, ?, ?, ?)",
                        (tool_id, action_name, "", "[]", True),
                    )

    # Seed demo user: admin@actiongate.io / admin123
    import hashlib
    pw_hash = hashlib.sha256("admin123".encode()).hexdigest()
    conn.execute(
        "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), "admin@actiongate.io", pw_hash, "Admin", "admin", now),
    )

    # Seed sample execution logs
    _seed_execution_logs(conn)

    # Seed sample policies
    _seed_policies(conn)


def _seed_execution_logs(conn):
    """Seed realistic execution logs."""
    now = datetime.utcnow()
    logs = [
        ("support-agent", "stripe", "get_customer", "EXECUTED", None, "Looked up CUST-1042"),
        ("support-agent", "salesforce", "query_contacts", "EXECUTED", None, "Queried contacts for CUST-1042"),
        ("support-agent", "stripe", "create_refund", "BLOCKED", None, "Blocked: policy requires approval for refunds"),
        ("support-agent", "email", "send_email", "EXECUTED", None, "Sent confirmation to jane.doe@email.com"),
        ("support-agent", "zendesk", "update_ticket", "EXECUTED", None, "Updated ticket #4821 status"),
        ("support-agent", "stripe", "create_charge", "BLOCKED", None, "Blocked: charges require human approval"),
        ("devops-agent", "github", "get_pull_request", "EXECUTED", None, "Fetched PR #287"),
        ("devops-agent", "github", "merge_pull_request", "EXECUTED", None, "Merged PR #287 to main"),
        ("devops-agent", "github", "trigger_workflow", "EXECUTED", None, "Triggered deploy workflow"),
        ("devops-agent", "aws", "terminate_instance", "BLOCKED", None, "Blocked: instance termination requires approval"),
        ("devops-agent", "slack", "send_channel_message", "EXECUTED", None, "Posted deploy notification to #releases"),
        ("devops-agent", "aws", "update_security_group", "EXECUTED", None, "Opened port 443 on sg-0a1b2c3d"),
        ("sales-agent", "hubspot", "query_contacts", "EXECUTED", None, "Searched leads matching 'enterprise'"),
        ("sales-agent", "gmail", "send_email", "EXECUTED", None, "Sent outreach to prospect@company.com"),
        ("sales-agent", "hubspot", "delete_contact", "BLOCKED", None, "Blocked: contact deletion not allowed"),
        ("sales-agent", "calendly", "create_invite_link", "EXECUTED", None, "Created meeting link for prospect"),
    ]
    for i, (agent, tool, action, status, policy_id, detail) in enumerate(logs):
        ts = datetime(2026, 3, 24, 10 + i % 8, (i * 7) % 60, 0).isoformat()
        conn.execute(
            "INSERT INTO execution_log (agent_id, tool, action, status, policy_id, detail, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (agent, tool, action, status, policy_id, detail, ts),
        )


def _seed_policies(conn):
    """Seed sample enforcement policies."""
    now = datetime.utcnow().isoformat()
    policies = [
        ("support-agent", "stripe.create_refund", "REQUIRE_APPROVAL", "Refunds over $50 require human approval"),
        ("support-agent", "stripe.create_charge", "BLOCK", "Support agents cannot create charges"),
        ("support-agent", "stripe.delete_customer", "BLOCK", "Customer deletion is never automated"),
        ("support-agent", "salesforce.delete_record", "BLOCK", "CRM record deletion requires admin"),
        ("devops-agent", "aws.terminate_instance", "REQUIRE_APPROVAL", "Instance termination needs SRE approval"),
        ("devops-agent", "aws.delete_snapshot", "REQUIRE_APPROVAL", "Snapshot deletion needs backup verification"),
        ("sales-agent", "hubspot.delete_contact", "BLOCK", "Contact deletion not permitted for sales agents"),
        ("sales-agent", "gmail.send_email", "REQUIRE_APPROVAL", "Outbound emails need manager review"),
    ]
    for agent_id, pattern, effect, reason in policies:
        conn.execute(
            "INSERT INTO policies (agent_id, action_pattern, effect, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (agent_id, pattern, effect, reason, "system", now),
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
