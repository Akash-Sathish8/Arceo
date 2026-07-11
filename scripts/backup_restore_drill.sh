#!/usr/bin/env bash
# Backup + restore drill for the production Postgres database.
#
# A backup you have never restored is a hope, not a backup. This dumps the live
# DB, restores it into a throwaway scratch database, and verifies per-table row
# counts match. Run it before the cutover and on a schedule after. It is
# read-only against the source (pg_dump) and drops only its own scratch DB.
#
# Usage:
#   DATABASE_URL=postgresql://user:pass@host:5432/arceo \
#     scripts/backup_restore_drill.sh [/path/to/backup.dump]
#
# If a backup path is given it is kept; otherwise a temp file is used and removed.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is not set}"

DUMP_PATH="${1:-$(mktemp -t arceo-backup-XXXX.dump)}"
KEEP_DUMP=0
[ -n "${1:-}" ] && KEEP_DUMP=1

# Derive the admin (maintenance) URL + a scratch db name on the same server.
BASE_URL="${DATABASE_URL%/*}"
SCRATCH_DB="arceo_restore_drill_$$"
ADMIN_URL="${BASE_URL}/postgres"

cleanup() {
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" >/dev/null 2>&1 || true
  [ "$KEEP_DUMP" -eq 0 ] && rm -f "$DUMP_PATH" || true
}
trap cleanup EXIT

echo "1/4  Dumping $DATABASE_URL -> $DUMP_PATH"
pg_dump --format=custom --file="$DUMP_PATH" "$DATABASE_URL"

echo "2/4  Creating scratch database $SCRATCH_DB"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$SCRATCH_DB\";" >/dev/null

echo "3/4  Restoring into $SCRATCH_DB"
pg_restore --no-owner --dbname="${BASE_URL}/${SCRATCH_DB}" "$DUMP_PATH" >/dev/null

echo "4/4  Verifying per-table row counts"
count_sql="SELECT string_agg(t.rel || ':' || t.n, ',' ORDER BY t.rel) FROM (
  SELECT c.relname AS rel, (xpath('/row/c/text()',
      query_to_xml(format('SELECT count(*) c FROM %I.%I', 'public', c.relname), false, true, '')))[1]::text::bigint AS n
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind = 'r'
) t;"

SRC=$(psql -Atq "$DATABASE_URL" -c "$count_sql")
DST=$(psql -Atq "${BASE_URL}/${SCRATCH_DB}" -c "$count_sql")

if [ "$SRC" = "$DST" ]; then
  echo "PASS: restored database matches the source (per-table row counts identical)."
else
  echo "FAIL: row counts differ between source and restore." >&2
  echo "  source:  $SRC" >&2
  echo "  restore: $DST" >&2
  exit 1
fi
