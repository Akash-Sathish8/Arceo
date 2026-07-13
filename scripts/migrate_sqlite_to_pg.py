"""Copy a legacy SQLite actiongate.db into a fresh Postgres database.

Usage (the prod cutover — see docs/MIGRATION_RUNBOOK.md):

    DATABASE_URL=postgresql://user:pass@host:5432/arceo \
        python scripts/migrate_sqlite_to_pg.py --sqlite /data/actiongate.db

What it does, in order:
  1. `alembic upgrade head` against DATABASE_URL (schema only — no seeding;
     the source DB brings its own default org/admin rows).
  2. Verifies every target table is EMPTY — refuses to copy into a used DB.
  3. Copies rows table-by-table in FK-safe order, converting SQLite's 0/1
     integers to booleans where the Postgres schema says BOOLEAN
     (tool_actions.reversible only).
  4. Resets the sequences behind the 8 auto-increment PKs to MAX(id).
  5. Prints a per-table row-count verification table; exits non-zero on any
     mismatch.

`--rehearse` (CI): builds a small throwaway SQLite file, drops/recreates the
target database named in DATABASE_URL, runs the full pipeline against it, and
asserts the copy landed. Guards this script and the runbook, not the app.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

import psycopg

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))
import db  # noqa: E402  — seal_new_audit_chain for the post-copy audit genesis

# FK-safe copy order — parents before children (matches alembic 0001_baseline).
TABLES = (
    "organizations",
    "users",
    "agents",
    "agent_tools",
    "tool_actions",
    "policies",
    "audit_log",
    "execution_log",
    "test_data",
    "simulations",
    "api_keys",
    "sweeps",
    "workspace_settings",
    "regression_baselines",
    "forecast_snapshots",
    "cost_overrides",
    "agent_budgets",
)

# Auto-increment integer PKs whose sequences need resetting after explicit-id
# inserts (the 7 SQLite AUTOINCREMENT tables + workspace_settings, whose SQLite
# rowid-alias PK auto-assigned too).
SERIAL_PK_TABLES = (
    "agent_tools",
    "tool_actions",
    "policies",
    "audit_log",
    "execution_log",
    "test_data",
    "cost_overrides",
    "workspace_settings",
)

# SQLite stores booleans as 0/1; these columns are real BOOLEANs in Postgres.
BOOL_COLUMNS = {"tool_actions": {"reversible"}}


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL is not set — point it at the TARGET Postgres database.")
    return url


def migrate_schema(url: str) -> None:
    from alembic import command
    from alembic.config import Config

    os.environ["DATABASE_URL"] = url
    command.upgrade(Config(str(BACKEND_DIR / "alembic.ini")), "head")


def copy_data(sqlite_path: str, url: str) -> list[tuple[str, int, int]]:
    """Copy all rows; returns [(table, source_count, target_count), ...]."""
    src = sqlite3.connect(sqlite_path)
    src.row_factory = sqlite3.Row
    results = []
    with psycopg.connect(url) as dst:
        # Refuse to merge into a database that already has data.
        for table in TABLES:
            n = dst.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            if n:
                sys.exit(f"Target table {table} already has {n} rows — refusing to copy. "
                         f"Point DATABASE_URL at a fresh database.")

        for table in TABLES:
            exists = src.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()
            if not exists:
                results.append((table, 0, 0))  # older DBs predate some tables
                continue

            rows = src.execute(f'SELECT * FROM "{table}"').fetchall()
            if rows:
                cols = rows[0].keys()
                bools = BOOL_COLUMNS.get(table, set())
                col_list = ", ".join(f'"{c}"' for c in cols)
                placeholders = ", ".join("%s" for _ in cols)
                with dst.cursor() as cur:
                    cur.executemany(
                        f'INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})',
                        [
                            tuple(
                                (bool(r[c]) if r[c] is not None else None) if c in bools else r[c]
                                for c in cols
                            )
                            for r in rows
                        ],
                    )

            target_n = dst.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            results.append((table, len(rows), target_n))

        # Explicit-id inserts don't advance sequences — reset each to MAX(id)
        # so the next app insert doesn't collide.
        for table in SERIAL_PK_TABLES:
            dst.execute(
                f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                f'COALESCE((SELECT MAX(id) FROM "{table}"), 0) + 1, false)'
            )

        # Seal a fresh audit chain per org that carried imported history. The old
        # tamper-evident seal can't be proven across a copy, so we start a NEW
        # sealed chain here (a genesis row, prev_hash='') and honestly treat the
        # imported rows above it as legacy/unsealed — /api/audit/verify segments
        # the two. Runs AFTER the sequence reset so the genesis id doesn't collide
        # with copied rows. (See docs/MIGRATION_RUNBOOK.md.)
        sealed_orgs = [r[0] for r in dst.execute(
            "SELECT DISTINCT org_id FROM audit_log WHERE org_id IS NOT NULL").fetchall()]
        for oid in sealed_orgs:
            db.seal_new_audit_chain(dst, oid)
        if sealed_orgs:
            print(f"Sealed a fresh audit chain for {len(sealed_orgs)} org(s); "
                  f"imported audit history above the genesis is legacy/unsealed.")

        dst.commit()
    src.close()
    return results


def print_verification(results: list[tuple[str, int, int]]) -> bool:
    width = max(len(t) for t, _, _ in results)
    print(f"\n{'table'.ljust(width)}  sqlite  postgres  status")
    ok = True
    for table, n_src, n_dst in results:
        status = "OK" if n_src == n_dst else "MISMATCH"
        ok = ok and n_src == n_dst
        print(f"{table.ljust(width)}  {str(n_src).rjust(6)}  {str(n_dst).rjust(8)}  {status}")
    return ok


# ── Rehearsal (CI) ─────────────────────────────────────────────────────────

_REHEARSAL_DDL = """
CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    name TEXT NOT NULL, role TEXT DEFAULT 'viewer', org_id TEXT DEFAULT 'default', created_at TEXT);
CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, tenant_id TEXT,
    org_id TEXT DEFAULT 'default', simulation_model TEXT, expected_calls_per_day INTEGER,
    expected_turns_per_run INTEGER, avg_context_tokens INTEGER, system_prompt TEXT, environment TEXT,
    trigger_source TEXT, human_in_loop INTEGER, default_effect TEXT NOT NULL DEFAULT 'ALLOW',
    created_at TEXT, updated_at TEXT);
CREATE TABLE agent_tools (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, name TEXT NOT NULL,
    service TEXT NOT NULL, description TEXT);
CREATE TABLE tool_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_id INTEGER, action TEXT NOT NULL,
    description TEXT, risk_labels TEXT DEFAULT '[]', reversible BOOLEAN DEFAULT 1,
    classification_source TEXT DEFAULT 'unknown');
CREATE TABLE policies (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, action_pattern TEXT NOT NULL,
    effect TEXT NOT NULL, reason TEXT, conditions TEXT DEFAULT '[]', priority INTEGER DEFAULT 0,
    org_id TEXT DEFAULT 'default', created_by TEXT, created_at TEXT);
CREATE TABLE execution_log (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, tool TEXT, action TEXT,
    status TEXT, policy_id INTEGER, detail TEXT, params TEXT, source TEXT,
    org_id TEXT DEFAULT 'default', timestamp TEXT);
CREATE TABLE workspace_settings (id INTEGER PRIMARY KEY DEFAULT 1, slack_webhook_url TEXT DEFAULT '',
    alert_email TEXT DEFAULT '', notify_on_block INTEGER DEFAULT 1, org_id TEXT DEFAULT 'default',
    last_digest_sent TEXT, updated_at TEXT, default_model TEXT);
"""

_REHEARSAL_SEED = """
INSERT INTO organizations VALUES ('default', 'Default Organization', '2026-01-01T00:00:00');
INSERT INTO organizations VALUES ('org-b', 'Org B', '2026-02-01T00:00:00');
INSERT INTO users VALUES ('u1', 'admin@actiongate.io', 'x', 'Admin', 'admin', 'default', '2026-01-01T00:00:00');
INSERT INTO agents (id, name, org_id, human_in_loop) VALUES ('agent-1', 'Support Bot', 'default', 1);
INSERT INTO agent_tools (agent_id, name, service) VALUES ('agent-1', 'stripe', 'Stripe');
INSERT INTO tool_actions (tool_id, action, risk_labels, reversible) VALUES (1, 'create_refund', '["moves_money"]', 0);
INSERT INTO tool_actions (tool_id, action, reversible) VALUES (1, 'get_customer', 1);
INSERT INTO policies (agent_id, action_pattern, effect, priority) VALUES ('agent-1', 'stripe.*', 'BLOCK', 100);
INSERT INTO execution_log (agent_id, tool, action, status) VALUES ('agent-1', 'stripe', 'create_refund', 'BLOCKED');
INSERT INTO workspace_settings (id, org_id, default_model) VALUES (NULL, 'default', 'claude-sonnet-4-5');
"""


def rehearse(url: str) -> None:
    dbname = urlsplit(url).path.lstrip("/")
    admin_url = url.rsplit("/", 1)[0] + "/postgres"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')
        admin.execute(f'CREATE DATABASE "{dbname}"')

    with tempfile.TemporaryDirectory(prefix="arceo-migration-rehearsal-") as tmp:
        sqlite_path = os.path.join(tmp, "actiongate.db")
        conn = sqlite3.connect(sqlite_path)
        conn.executescript(_REHEARSAL_DDL)
        conn.executescript(_REHEARSAL_SEED)
        conn.commit()
        conn.close()

        migrate_schema(url)
        results = copy_data(sqlite_path, url)
        ok = print_verification(results)

        # The rehearsal must prove actual data movement, not 17 empty tables.
        copied = {t: n for t, n, _ in results}
        assert copied["tool_actions"] == 2 and copied["organizations"] == 2, "rehearsal seed did not copy"
        with psycopg.connect(url) as check:
            rev = check.execute(
                "SELECT reversible FROM tool_actions WHERE action = 'create_refund'"
            ).fetchone()[0]
            assert rev is False, "0/1 -> boolean conversion failed"
            # Sequence reset: the next serial id must not collide with copied rows.
            nxt = check.execute(
                "INSERT INTO policies (agent_id, action_pattern, effect) "
                "VALUES ('agent-1', 'x.*', 'ALLOW') RETURNING id"
            ).fetchone()[0]
            assert nxt == 2, f"sequence not reset (got id {nxt})"
        if not ok:
            sys.exit(1)
        print("\nRehearsal passed: schema migrated, rows copied, booleans converted, sequences reset.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", help="Path to the source actiongate.db")
    parser.add_argument("--rehearse", action="store_true",
                        help="CI mode: seed a throwaway SQLite file and run the full pipeline")
    args = parser.parse_args()
    url = _database_url()

    if args.rehearse:
        rehearse(url)
        return

    if not args.sqlite:
        sys.exit("--sqlite <path to actiongate.db> is required (or use --rehearse)")
    if not Path(args.sqlite).exists():
        sys.exit(f"No such file: {args.sqlite}")

    migrate_schema(url)
    results = copy_data(args.sqlite, url)
    if not print_verification(results):
        sys.exit(1)
    print("\nMigration complete. Verify /api/health against the new DATABASE_URL before cutting over.")


if __name__ == "__main__":
    main()
