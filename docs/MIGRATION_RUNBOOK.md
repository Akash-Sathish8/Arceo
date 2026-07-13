# SQLite → Postgres migration runbook

For the repo owner. The app now runs exclusively on Postgres (`DATABASE_URL`);
this runbook moves an existing SQLite `actiongate.db`'s data onto a Postgres
instance. Where there is no existing deployment or the data is disposable,
skip to **Fresh start** at the bottom.

CI rehearses the copy script on every run (`Rehearse SQLite→Postgres migration
script` step), so the mechanics below are continuously verified.

## Prerequisites

- A Postgres 15+ instance and a DATABASE_URL for a **fresh, empty database**
  on it (e.g. `postgresql://user:pass@host:5432/arceo`).
- The `actiongate.db` file from the instance being migrated.
- A checkout of this repo at the commit being deployed, with backend deps
  installed (`pip install -r backend/requirements.txt`).

## Steps

1. **Stop the app** (or accept that writes after your copy are lost).
2. **Back up the SQLite file:**
   ```bash
   cp /data/actiongate.db /data/actiongate.pre-postgres.db
   ```
3. **Run the copy script** against the fresh Postgres database:
   ```bash
   DATABASE_URL=postgresql://user:pass@host:5432/arceo \
       python scripts/migrate_sqlite_to_pg.py --sqlite /data/actiongate.db
   ```
   It migrates the schema (Alembic), refuses to run if the target has any
   rows, copies all 17 tables in FK-safe order, converts SQLite's 0/1 booleans,
   resets the 8 auto-increment sequences, and prints a per-table verification
   table. Non-zero exit = do not proceed.

   **Audit seal:** the copied audit history can't be cryptographically proven
   across the copy, so the script writes a per-org **genesis row** that starts a
   fresh sealed chain at cutover. From then on `GET /api/audit/verify` reports
   the imported rows as `legacy_unsealed` (honest — they predate the seal) and
   verifies everything from the genesis forward. Nothing to do here; just know
   `verify` will show a non-zero `legacy_unsealed` on a migrated instance.
4. **Point the app at Postgres:** set `DATABASE_URL` in the deploy environment
   (the Dockerfile no longer sets `ARCEO_DB_PATH`; the app refuses to boot on
   known prod platforms without `DATABASE_URL`).
5. **Start and health-check:**
   ```bash
   curl -fsS http://<host>:8000/api/health
   ```
   Log in and spot-check an agent detail page and the approvals queue (the
   two surfaces that join across the most tables).

## Rollback

The old code path is gone from the app, so rollback = redeploy the previous
release (pre-cutover image/commit) pointed back at the SQLite file:

1. Redeploy the prior release.
2. Restore `ARCEO_DB_PATH=/data/actiongate.db` in its environment (restore the
   file from `actiongate.pre-postgres.db` if anything wrote to it).
3. Health-check as above.

Rows written to Postgres between cutover and rollback are not merged back —
export them first if they matter.

## Fresh start (no data to preserve)

Just set `DATABASE_URL` and boot: startup runs `alembic upgrade head` and
seeds the default org + admin on an empty database. For local dev:
`docker compose up -d` gives you Postgres + Redis matching every default.

## Activating row-level security in production (Phase 3)

Migration `0002` enables **FORCE ROW LEVEL SECURITY** on every org-scoped table
as a structural tenant backstop under the app-level `org_id` filters. The app
sets `app.current_org` per request transaction, so the policy scopes each
request to its caller's org.

**One catch: a Postgres SUPERUSER bypasses RLS even when it is FORCED.** If the
app connects as a superuser (or the table owner), RLS is a silent no-op. To make
it bite, run the app as a dedicated **non-superuser** role. Create it with the
scripted, idempotent role setup (it also grants on FUTURE migration-created
tables via `ALTER DEFAULT PRIVILEGES`, so a later `alembic upgrade` never locks
the app out):

```bash
# as the DB owner/admin, AFTER `alembic upgrade head` has created the schema:
psql "$ADMIN_DATABASE_URL" -v app_password="'a-strong-password'" \
    -f scripts/setup_prod_role.sql
```

Point the running app's `DATABASE_URL` at `arceo_app`; keep running migrations
under the admin/owner URL (migrations create tables; `arceo_app` only does DML).

**Then verify RLS is actually live** — the single most important post-cutover
check:

```bash
APP_DATABASE_URL=postgresql://arceo_app:...@host:5432/arceo \
    python scripts/verify_rls_active.py
```

It connects as the app role and asserts the role is neither superuser nor
BYPASSRLS and that a bogus-org read sees zero rows; non-zero exit = do not cut
over. `backend/tests/test_rls_enforcement.py` + `test_cutover.py` prove the
policies isolate tenants under exactly this restricted role. Until the role is in
place, isolation rests on the app-level filters (which `test_cross_org_matrix.py`
guards) — RLS is dormant, not broken.

## Backups: prove the restore, not just the dump

A backup you have never restored is a hope. Before the cutover and on a schedule
after, run the drill — it dumps the live DB, restores into a throwaway scratch
database, and verifies per-table row counts match:

```bash
DATABASE_URL=postgresql://user:pass@host:5432/arceo scripts/backup_restore_drill.sh
```

Managed backup schedules are the platform's job; this proves a dump is actually
restorable.
