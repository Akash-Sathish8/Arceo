"""SQLite database — agents, policies, audit log, execution log, users, organizations.

Multi-tenant: every table has org_id. All queries filter by org_id.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

# Default to the file beside this module (dev). In production set ARCEO_DB_PATH to
# a path on a persistent volume (e.g. Railway volume mount) so the DB survives
# redeploys — the container filesystem is otherwise ephemeral.
DB_PATH = Path(os.environ.get("ARCEO_DB_PATH", Path(__file__).parent / "actiongate.db"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Production guard: the default DB path lives on the (ephemeral) container
# filesystem, so a redeploy silently wipes all customer data. Refuse to boot on a
# real deploy unless ARCEO_DB_PATH points at a persistent volume.
_PROD_MARKERS = ("RAILWAY_ENVIRONMENT", "FLY_APP_NAME", "RENDER", "PRODUCTION")
if "ARCEO_DB_PATH" not in os.environ and any(os.getenv(k) for k in _PROD_MARKERS):
    raise RuntimeError(
        "ARCEO_DB_PATH is not set on a production deploy. The default DB path is on "
        "the ephemeral container filesystem and will be wiped on redeploy. Point "
        "ARCEO_DB_PATH at a persistent volume."
    )

# Best-effort single restore point, refreshed each process start.
try:
    if DB_PATH.exists() and DB_PATH.stat().st_size > 0:
        import shutil as _shutil
        _shutil.copy2(DB_PATH, DB_PATH.with_suffix(".db.bak"))
except Exception:
    pass

DEFAULT_ORG_ID = "default"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    # Wait up to 10s for a held lock instead of erroring immediately with
    # "database is locked". Without this, a write (e.g. extract/upsert) that
    # overlaps a concurrent read poll surfaces as a 500 to the dashboard. 10s
    # covers the agent-connect burst, where extract + a wave of sandbox-sim
    # writes hold WAL's single writer slot back-to-back for several seconds.
    conn.execute("PRAGMA busy_timeout = 10000")
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
                expected_calls_per_day INTEGER,
                expected_turns_per_run INTEGER,
                avg_context_tokens INTEGER,
                system_prompt TEXT,
                environment TEXT,
                trigger_source TEXT,
                human_in_loop INTEGER,
                default_effect TEXT NOT NULL DEFAULT 'ALLOW',
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
                reversible BOOLEAN DEFAULT 1,
                classification_source TEXT DEFAULT 'unknown'
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
                params TEXT,
                source TEXT,
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
                created_at TEXT,
                run_mode TEXT NOT NULL DEFAULT 'live'
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
                last_digest_sent TEXT,
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

            CREATE TABLE IF NOT EXISTS forecast_snapshots (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                org_id TEXT DEFAULT 'default',
                snapshot_date TEXT NOT NULL,
                point_usd REAL NOT NULL,
                low_usd REAL,
                high_usd REAL,
                composition_json TEXT,
                captured_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_agent_date
                ON forecast_snapshots(agent_id, snapshot_date);

            CREATE TABLE IF NOT EXISTS cost_overrides (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                org_id TEXT NOT NULL DEFAULT 'default',
                scope TEXT NOT NULL,
                key TEXT NOT NULL,
                sub_key TEXT NOT NULL DEFAULT '',
                value REAL NOT NULL,
                updated_at TEXT,
                UNIQUE(org_id, scope, key, sub_key)
            );

            CREATE TABLE IF NOT EXISTS agent_budgets (
                agent_id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL DEFAULT 'default',
                monthly_budget_usd REAL NOT NULL,
                alert_threshold_pct INTEGER NOT NULL DEFAULT 80,
                updated_at TEXT
            );

        """)

        # Defensive migration for workspace_settings columns added over time.
        try:
            cols = [r[1] for r in conn.execute("PRAGMA table_info(workspace_settings)").fetchall()]
            if "last_digest_sent" not in cols:
                conn.execute("ALTER TABLE workspace_settings ADD COLUMN last_digest_sent TEXT")
            # Per-org default model for the forecaster — so an all-OpenAI (or
            # Llama, Gemini, …) shop isn't priced at the Claude default when an
            # agent doesn't declare its own model.
            if "default_model" not in cols:
                conn.execute("ALTER TABLE workspace_settings ADD COLUMN default_model TEXT")
        except Exception:
            pass

        # Defensive migration for forecast-input columns on the agents table.
        # These drive the cost predictor (model pricing, call volume, token
        # basis) and the sandbox persona — older DBs predate them.
        try:
            agent_cols = [r[1] for r in conn.execute("PRAGMA table_info(agents)").fetchall()]
            for col, decl in (
                ("simulation_model", "TEXT"),
                ("expected_calls_per_day", "INTEGER"),
                ("expected_turns_per_run", "INTEGER"),
                ("avg_context_tokens", "INTEGER"),
                ("system_prompt", "TEXT"),
                ("environment", "TEXT"),          # prod | staging | dev — exposure context
                ("trigger_source", "TEXT"),       # untrusted | internal | scheduled
                ("human_in_loop", "INTEGER"),     # 1 if a human approves actions
                # Opt-in fail-closed posture: with DENY, an action no policy
                # matches is BLOCKED instead of implicitly allowed (Phase 1, B1).
                ("default_effect", "TEXT NOT NULL DEFAULT 'ALLOW'"),
            ):
                if col not in agent_cols:
                    conn.execute(f"ALTER TABLE agents ADD COLUMN {col} {decl}")
        except Exception:
            pass

        # Defensive migration: classification provenance on stored actions
        # (catalog|primitive|strong_kw|weak_kw|schema|llm|read|ui|none).
        # 'unknown' marks rows classified before provenance existed.
        try:
            ta_cols = [r[1] for r in conn.execute("PRAGMA table_info(tool_actions)").fetchall()]
            if "classification_source" not in ta_cols:
                conn.execute("ALTER TABLE tool_actions ADD COLUMN classification_source TEXT DEFAULT 'unknown'")
        except Exception:
            pass

        # Defensive migration: action params on execution rows (JSON). Without
        # this, the approvals queue showed reviewers nothing about what they
        # were approving — no amount, no recipient. NULL on pre-migration rows.
        try:
            el_cols = [r[1] for r in conn.execute("PRAGMA table_info(execution_log)").fetchall()]
            if "params" not in el_cols:
                conn.execute("ALTER TABLE execution_log ADD COLUMN params TEXT")
            # Provenance: runtime | sandbox | boundary_test | replay | report |
            # test. Every number on a reviewer-facing surface must answer
            # "where did you come from?" — NULL marks pre-tracking rows.
            if "source" not in el_cols:
                conn.execute("ALTER TABLE execution_log ADD COLUMN source TEXT")
        except Exception:
            pass

        # Defensive migration: dry-run vs live provenance on simulations — the
        # sibling of execution_log.source. Evidence surfaces (uplift, confidence,
        # "Demonstrated") must only trust live runs. Historic rows are backfilled
        # off the '[STATIC ANALYSIS]' prompt marker that only run_simulation_dry
        # writes; the backfill runs exactly once, inside the column-add branch.
        try:
            sim_cols = [r[1] for r in conn.execute("PRAGMA table_info(simulations)").fetchall()]
            if "run_mode" not in sim_cols:
                conn.execute("ALTER TABLE simulations ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'live'")
                conn.execute("UPDATE simulations SET run_mode = 'dry' WHERE trace_json LIKE '%[STATIC ANALYSIS]%'")
        except Exception:
            pass

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
        "INSERT INTO users (id, email, password_hash, name, role, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
        rows = conn.execute("SELECT id FROM agents WHERE org_id = ? ORDER BY name", (org_id,)).fetchall()
    else:
        rows = conn.execute("SELECT id FROM agents ORDER BY name").fetchall()
    return [get_agent_from_db(conn, r["id"]) for r in rows]


def log_audit(conn, user_id: str | None, user_email: str | None, action: str, resource: str = None, detail: str = None, org_id: str = DEFAULT_ORG_ID):
    """Write an audit log entry. Best-effort: audit logging must never take down
    the caller's actual request. Under the agent-connect write burst SQLite WAL
    has a single writer slot, so an audit INSERT can lose the race past
    busy_timeout; swallow that rather than surfacing a 500 to the dashboard."""
    try:
        conn.execute(
            "INSERT INTO audit_log (user_id, user_email, action, resource, detail, org_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, user_email, action, resource, detail, org_id, datetime.utcnow().isoformat()),
        )
    except sqlite3.OperationalError:
        # "database is locked" / "database is busy" — drop the audit row, keep
        # serving the request. The audit log is non-critical telemetry.
        pass


def log_execution(conn, agent_id: str, tool: str, action: str, status: str, policy_id: int = None, detail: str = None, org_id: str = DEFAULT_ORG_ID, params: dict = None, source: str = None):
    """Write an execution log entry. `params` (the action's arguments) are
    stored as JSON so the approvals queue can show reviewers WHAT they are
    approving, not just which action. `source` records where the call came
    from (runtime | sandbox | boundary_test | replay | report | test) so a
    reviewer can tell live agent traffic from simulations and seeded data."""
    conn.execute(
        "INSERT INTO execution_log (agent_id, tool, action, status, policy_id, detail, params, source, org_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (agent_id, tool, action, status, policy_id, detail,
         json.dumps(params) if params else None, source, org_id, datetime.utcnow().isoformat()),
    )
