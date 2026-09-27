"""Delete open-demo tenants older than the retention window.

Open-demo logins (ARCEO_OPEN_DEMO_LOGIN) create a fresh org per login. Their
users carry the `+demo-` marker in the stored email, and that is the only
thing this job keys on: an org is purged when every one of its users is an
open-demo user and the org is older than DEMO_ORG_RETENTION_DAYS (default 7).
The seeded admin org and every real signup are untouched.

    python -m jobs.purge_demo_orgs            # canonical entrypoint
    GET /api/internal/cron/purge-demo-orgs    # the Vercel cron wrapper
"""

import os
from datetime import datetime, timedelta

from db import get_db

# Dependency order: children first, then users, then the org.
_ORG_SCOPED_TABLES = (
    "pending_requests", "execution_log", "simulations", "sweeps", "policies",
    "regression_baselines", "cost_overrides", "agent_budgets", "forecast_snapshots",
    "api_keys", "test_data", "workspace_settings",
)
# audit_log is append-only by trigger and stays; its org_id is plain text, so a
# purged org leaves its audit rows behind as the record that it existed.


def purge_demo_orgs(now: datetime | None = None) -> dict:
    from auth import OPEN_DEMO_MARKER
    days = int(os.getenv("DEMO_ORG_RETENTION_DAYS", "7"))
    cutoff = ((now or datetime.utcnow()) - timedelta(days=days)).isoformat()
    purged = []
    with get_db() as conn:
        rows = conn.execute(
            "SELECT o.id FROM organizations o "
            "WHERE o.created_at < %s "
            "AND EXISTS (SELECT 1 FROM users u WHERE u.org_id = o.id) "
            "AND NOT EXISTS (SELECT 1 FROM users u WHERE u.org_id = o.id AND u.email NOT LIKE %s)",
            (cutoff, f"%{OPEN_DEMO_MARKER}%"),
        ).fetchall()
        scoped = {r["table_name"] for r in conn.execute(
            "SELECT table_name FROM information_schema.columns "
            "WHERE column_name = 'org_id' AND table_schema = current_schema()").fetchall()}
        for r in rows:
            org_id = r["id"]
            for table in _ORG_SCOPED_TABLES:
                if table in scoped:
                    conn.execute(f"DELETE FROM {table} WHERE org_id = %s", (org_id,))
            conn.execute("DELETE FROM agents WHERE org_id = %s", (org_id,))
            conn.execute("DELETE FROM users WHERE org_id = %s", (org_id,))
            conn.execute("DELETE FROM organizations WHERE id = %s", (org_id,))
            purged.append(org_id)
    return {"purged": len(purged), "retention_days": days}


if __name__ == "__main__":
    print(purge_demo_orgs())
