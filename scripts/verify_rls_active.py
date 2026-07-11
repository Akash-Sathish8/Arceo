"""Prove Row-Level Security is ACTIVE in production — the single most important
post-cutover correctness check.

FORCE ROW LEVEL SECURITY is dormant under a superuser, so if the app accidentally
connects as a superuser (or a role with BYPASSRLS), tenant isolation silently
rests on the app-level `WHERE org_id` filters alone. This connects AS THE APP
ROLE and asserts:
  1. the role is neither a superuser nor BYPASSRLS (the decisive, data-independent
     proof that RLS will enforce), and
  2. a naked cross-tenant SELECT under a bogus org returns zero rows.

Exit non-zero on failure so it can gate a deploy. No data is modified.

Usage:
    APP_DATABASE_URL=postgresql://arceo_app:...@host:5432/arceo \
        python scripts/verify_rls_active.py
"""

from __future__ import annotations

import os
import sys

import psycopg


def check(url: str) -> str | None:
    """Return an error string if RLS would NOT enforce for this connection, else
    None. Kept as a function so tests can call it directly."""
    with psycopg.connect(url) as conn:
        role = conn.execute(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
        ).fetchone()
        is_super, bypass = bool(role[0]), bool(role[1])
        if is_super or bypass:
            return (f"connected as '{'superuser' if is_super else 'BYPASSRLS'}' — RLS is "
                    f"bypassed. The app must connect as the non-superuser arceo_app role "
                    f"(see scripts/setup_prod_role.sql).")
        # Positive signal: a bogus tenant must see none of any org's agents.
        conn.execute("SELECT set_config('app.current_org', %s, false)", ("__rls_probe__",))
        n = conn.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
        if n != 0:
            return f"a bogus-org connection saw {n} agent row(s) — RLS is NOT enforcing."
    return None


def main() -> None:
    url = os.environ.get("APP_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("APP_DATABASE_URL (the app role's connection URL) is not set.")
    err = check(url)
    if err:
        sys.exit(f"FAIL: {err}")
    print("OK: RLS is active — connected as a non-superuser role and a bogus-org "
          "read sees zero rows.")


if __name__ == "__main__":
    main()
