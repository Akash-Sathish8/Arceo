"""Retention sweep for captured LLM prompt/response content (MED-013).

Deletes rows from `llm_captures` older than the retention window. That table is
deliberately outside the append-only audit chain, so this is an ordinary DELETE —
the `audit_log` rows that reference the captures are untouched, keep their
metadata, token usage and content digest, and the tamper-evident chain stays
verifiable through `GET /api/audit/verify`.

Window: ARCEO_CAPTURE_RETENTION_DAYS (default 90). Set it to 0 to disable the
sweep entirely — an explicit "retain indefinitely" choice rather than the previous
situation, where indefinite retention was the only possible behaviour.

The backend runs this from the same daily scheduler as the forecast snapshots.
Manual run:
    cd backend && python3 -m jobs.purge_llm_captures
    cd backend && python3 -m jobs.purge_llm_captures --dry-run
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta

from db import get_db

DEFAULT_RETENTION_DAYS = 90


def retention_days() -> int:
    """0 (or negative) disables the sweep."""
    try:
        return int(os.getenv("ARCEO_CAPTURE_RETENTION_DAYS", str(DEFAULT_RETENTION_DAYS)))
    except ValueError:
        return DEFAULT_RETENTION_DAYS


def purge_expired_captures(conn, *, now=None, dry_run: bool = False) -> dict:
    """Delete captures past the retention window. Returns a summary dict.

    Runs in the caller's transaction so a scheduler can wrap it; `dry_run` counts
    without deleting."""
    days = retention_days()
    if days <= 0:
        return {"enabled": False, "retention_days": days, "purged": 0, "cutoff": None}

    cutoff = ((now or datetime.utcnow()) - timedelta(days=days)).isoformat()
    doomed = conn.execute(
        "SELECT COUNT(*) AS n FROM llm_captures WHERE created_at < %s", (cutoff,)
    ).fetchone()["n"]
    if not dry_run and doomed:
        conn.execute("DELETE FROM llm_captures WHERE created_at < %s", (cutoff,))
    return {"enabled": True, "retention_days": days, "purged": int(doomed),
            "cutoff": cutoff, "dry_run": dry_run}


def erase_captures_for_agent(conn, org_id: str, agent_id: str) -> int:
    """Per-subject erasure: drop every captured body for one agent in one org.

    This is the GDPR path for content written since MED-013 shipped. The audit
    rows survive with their metadata and digest, so the trail still shows that a
    call happened and what its content hashed to — the chain never notices.

    Content in `audit_log.detail` from BEFORE this migration is not reachable
    here; it sits inside the append-only table. See
    `scripts/scrub_historical_audit_content.py` for that (break-glass, rewrites
    the chain).
    """
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM llm_captures WHERE org_id = %s AND agent_id = %s",
        (org_id, agent_id),
    ).fetchone()
    conn.execute("DELETE FROM llm_captures WHERE org_id = %s AND agent_id = %s",
                 (org_id, agent_id))
    return int(row["n"])


def main() -> int:
    dry = "--dry-run" in sys.argv
    with get_db() as conn:
        result = purge_expired_captures(conn, dry_run=dry)
    if not result["enabled"]:
        print("capture retention disabled (ARCEO_CAPTURE_RETENTION_DAYS=0) — nothing purged")
        return 0
    verb = "would purge" if dry else "purged"
    print(f"{verb} {result['purged']} capture(s) older than "
          f"{result['retention_days']}d (cutoff {result['cutoff']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
