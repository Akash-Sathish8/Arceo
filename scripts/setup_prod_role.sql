-- Create the non-superuser application role that makes Row-Level Security bite
-- in production.
--
-- FORCE ROW LEVEL SECURITY (migration 0002) is DORMANT under a superuser: a
-- superuser bypasses every policy. So tenant isolation only holds at the DB
-- layer when the app connects as this restricted role. Run migrations as the
-- database owner/admin, then point the app's DATABASE_URL at `arceo_app`.
--
-- Usage (quote the password as a SQL string literal):
--   psql "$ADMIN_DATABASE_URL" -v app_password="'a-strong-password'" -f scripts/setup_prod_role.sql
--
-- Verify afterwards with: python scripts/verify_rls_active.py

\set ON_ERROR_STOP on

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'arceo_app') THEN
        CREATE ROLE arceo_app LOGIN;
    END IF;
END
$$;

ALTER ROLE arceo_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :app_password;

-- DML on today's tables + sequences.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO arceo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arceo_app;

-- And on tables/sequences created by FUTURE migrations (run as the owner), so a
-- later `alembic upgrade` never silently leaves the app without access.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO arceo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO arceo_app;

\echo 'arceo_app role ready (NOSUPERUSER, NOBYPASSRLS). Point the app DATABASE_URL at it, then run verify_rls_active.py.'
