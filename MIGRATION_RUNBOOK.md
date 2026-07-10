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
`docker compose up -d postgres` gives you a server matching every default.
