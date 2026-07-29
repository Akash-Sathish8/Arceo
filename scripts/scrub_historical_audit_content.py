"""BREAK-GLASS: scrub captured LLM content from PRE-MED-013 audit_log rows.

Read this whole header before running it. This script rewrites the tamper-evident
audit chain. That is the one thing the chain exists to prevent, and doing it is a
deliberate, recorded decision — not routine maintenance.

WHY IT EXISTS
-------------
Before MED-013, both LLM capture paths wrote the system prompt and the full
response body into `audit_log.detail`. `audit_log` is append-only by trigger
(migration 0007, fires for every role including superuser), so that content cannot
be deleted through the application at all. MED-013 fixed this going FORWARD —
new captures live in the purgeable `llm_captures` table and erasing them never
touches the chain. Rows written before that migration are still stuck.

If a GDPR erasure request (or a retention obligation) covers that historical
content, this is the only way to satisfy it.

WHAT IT DOES
------------
For each matching row (action LLM_CALL / LLM_CALL_PROXY, optionally scoped to one
org and/or agent):
  1. parses `detail`, drops the content keys (`system`, `messages`, and the
     response body), KEEPS the metadata and `response.usage` so historical spend
     figures and the cost engine are unaffected,
  2. records `scrubbed_at` and the SHA-256 of the content that was removed, so the
     row still attests to what was there,
  3. rewrites `detail`/`detail_enc` in place, then
  4. RECOMPUTES the hash chain for every affected org from the earliest touched
     row forward, so `GET /api/audit/verify` passes again afterwards.

Steps 3 and 4 require suspending the append-only trigger, which means the
connecting role must OWN `audit_log` (or be superuser) — the same requirement the
key-rotation and backfill scripts already carry.

WHAT IT COSTS
-------------
The chain after this run is internally consistent but is NOT the original chain.
Anyone holding a previously-exported entry_hash will see it no longer matches.
That is unavoidable: erasure and immutability are in genuine conflict here, and
this script chooses erasure explicitly rather than pretending otherwise. It prints
the before/after head hash for every org it touches — record those in your
compliance log alongside the erasure request that prompted the run.

USAGE
-----
    DATABASE_URL=postgresql://... \
    ARCEO_VAULT_MASTER_KEY=<base64 key> \
        python scripts/scrub_historical_audit_content.py --dry-run
    ... --org-id <org> --agent-id <agent>      # scope to one subject
    ... --confirm                               # actually write

`--dry-run` is the default. Nothing is written without `--confirm`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import encryption  # noqa: E402
from db import audit_entry_hash  # noqa: E402

CAPTURE_ACTIONS = ("LLM_CALL", "LLM_CALL_PROXY")
CONTENT_KEYS = ("system", "messages")


def _scrub_detail(detail: dict) -> tuple[dict, str] | None:
    """Strip content, keep metadata + usage. Returns (new_detail, digest) or None
    when the row holds no content to remove (already scrubbed, or post-MED-013)."""
    removed: dict = {}
    out = dict(detail)

    for key in CONTENT_KEYS:
        if out.get(key):
            removed[key] = out.pop(key)
        else:
            out.pop(key, None)

    response = out.get("response")
    if isinstance(response, dict):
        keep = {k: v for k, v in response.items()
                if k in ("usage", "usageMetadata", "model", "stop_reason", "id")}
        body = {k: v for k, v in response.items() if k not in keep}
        if body:
            removed["response"] = body
        out["response"] = keep

    if not removed:
        return None
    digest = hashlib.sha256(json.dumps(removed, sort_keys=True).encode()).hexdigest()
    out["scrubbed_at"] = datetime.utcnow().isoformat()
    out["scrubbed_sha256"] = digest
    return out, digest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--org-id", help="scope to one org (default: all)")
    ap.add_argument("--agent-id", help="scope to one agent (audit_log.user_email)")
    ap.add_argument("--confirm", action="store_true",
                    help="actually write; without this the run is a dry run")
    ap.add_argument("--dry-run", action="store_true", help="explicit no-op (default)")
    args = ap.parse_args()
    write = args.confirm and not args.dry_run

    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is required", file=sys.stderr)
        return 2

    where = ["action = ANY(%s)"]
    params: list = [list(CAPTURE_ACTIONS)]
    if args.org_id:
        where.append("org_id = %s")
        params.append(args.org_id)
    if args.agent_id:
        where.append("user_email = %s")
        params.append(args.agent_id)
    clause = " AND ".join(where)

    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        rows = conn.execute(
            f"SELECT id, org_id, detail, detail_enc FROM audit_log WHERE {clause} ORDER BY id",
            params,
        ).fetchall()

        scrubbed: list[tuple[int, str, dict]] = []
        for r in rows:
            hydrated = encryption.hydrate(dict(r), "detail")
            raw = hydrated.get("detail")
            if not raw:
                continue
            try:
                detail = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            result = _scrub_detail(detail)
            if result:
                scrubbed.append((r["id"], r["org_id"], result[0]))

        orgs = sorted({o for _, o, _ in scrubbed})
        print(f"{len(scrubbed)} row(s) carry removable content across {len(orgs)} org(s)")
        if not scrubbed:
            return 0
        if not write:
            print("dry run — nothing written. Re-run with --confirm to proceed.")
            return 0

        heads_before = {
            o: (conn.execute(
                "SELECT entry_hash FROM audit_log WHERE org_id = %s ORDER BY id DESC LIMIT 1",
                (o,)).fetchone() or {}).get("entry_hash")
            for o in orgs
        }

        conn.execute("ALTER TABLE audit_log DISABLE TRIGGER trg_audit_append_only")
        try:
            for row_id, _org, new_detail in scrubbed:
                pt, enc = encryption.split(json.dumps(new_detail))
                conn.execute("UPDATE audit_log SET detail = %s, detail_enc = %s WHERE id = %s",
                             (pt, enc, row_id))

            # Rebuild each affected org's chain from its first touched row onward.
            for org in orgs:
                first = min(i for i, o, _ in scrubbed if o == org)
                prev = conn.execute(
                    "SELECT entry_hash FROM audit_log WHERE org_id = %s AND id < %s "
                    "ORDER BY id DESC LIMIT 1", (org, first)).fetchone()
                prev_hash = (prev or {}).get("entry_hash") or ""
                tail = conn.execute(
                    "SELECT id, action, resource, detail, detail_enc, user_id, user_email, "
                    "timestamp FROM audit_log WHERE org_id = %s AND id >= %s ORDER BY id",
                    (org, first)).fetchall()
                for row in tail:
                    d = encryption.hydrate(dict(row), "detail").get("detail")
                    h = audit_entry_hash(prev_hash, org, row["action"], row["resource"], d,
                                         row["user_id"], row["user_email"], row["timestamp"])
                    conn.execute(
                        "UPDATE audit_log SET prev_hash = %s, entry_hash = %s WHERE id = %s",
                        (prev_hash, h, row["id"]))
                    prev_hash = h
                print(f"org {org}: chain head {heads_before[org]} -> {prev_hash}")
        finally:
            conn.execute("ALTER TABLE audit_log ENABLE TRIGGER trg_audit_append_only")
        conn.commit()

    print(f"scrubbed {len(scrubbed)} row(s). Record the head-hash changes above in "
          f"your compliance log — the chain has been rewritten.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
