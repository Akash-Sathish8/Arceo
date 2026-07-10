"""Phase-3 PR-4: row-level security as a second tenant-isolation layer.

Adds org_id to the three FK-only tables (agent_tools, tool_actions, test_data)
so every tenant row is directly attributable, keeps them populated with BEFORE
INSERT triggers (deriving org_id from the parent — tool_actions only has a
tool_id in scope, so SQL-side derivation is the only place this can't be
forgotten), and enables FORCE ROW LEVEL SECURITY on every org-scoped table.

The RLS policy is permissive when the request has no org context ('system' or
unset — seeding, the scheduler, migrations, unauthenticated endpoints) and
restrictive to a single org when get_db() has set app.current_org. It therefore
never restricts BELOW today's app-level filters (which the cross-org matrix
already proves correct) — it only ADDS a structural backstop so a future
missing WHERE org_id clause cannot leak across tenants.

NOTE: a Postgres SUPERUSER bypasses RLS even when FORCED. The app must run as a
non-superuser role in production for this layer to bite (see SECURITY note in
the PR / runbook). The RLS test connects as a dedicated non-superuser role to
prove the policies genuinely enforce isolation.

Revision ID: 0002_rls_tenant_isolation
Revises: 0001_baseline
"""

from alembic import op

revision = "0002_rls_tenant_isolation"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None

# org-scoped tables whose tenant column is `org_id`
_ORG_TABLES = [
    "users", "agents", "agent_tools", "tool_actions", "test_data",
    "policies", "audit_log", "execution_log", "simulations", "api_keys",
    "sweeps", "workspace_settings", "regression_baselines",
    "forecast_snapshots", "cost_overrides", "agent_budgets",
]

# The org-context predicate: unset/system → full access; a real org → that org only.
_PRED = (
    "current_setting('app.current_org', true) IS NULL "
    "OR current_setting('app.current_org', true) = 'system' "
    "OR {col} = current_setting('app.current_org', true)"
)


def _enable_rls(table: str, col: str = "org_id") -> None:
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    pred = _PRED.format(col=col)
    op.execute(
        f"CREATE POLICY org_isolation ON {table} "
        f"USING ({pred}) WITH CHECK ({pred})"
    )


def upgrade() -> None:
    # 1) org_id on the three FK-only tables (nullable, backfilled, then NOT NULL).
    for t in ("agent_tools", "tool_actions", "test_data"):
        op.execute(f"ALTER TABLE {t} ADD COLUMN IF NOT EXISTS org_id TEXT")

    op.execute("UPDATE agent_tools t SET org_id = a.org_id "
               "FROM agents a WHERE a.id = t.agent_id AND t.org_id IS NULL")
    op.execute("UPDATE tool_actions ta SET org_id = a.org_id "
               "FROM agent_tools t JOIN agents a ON a.id = t.agent_id "
               "WHERE t.id = ta.tool_id AND ta.org_id IS NULL")
    op.execute("UPDATE test_data td SET org_id = a.org_id "
               "FROM agents a WHERE a.id = td.agent_id AND td.org_id IS NULL")

    # Any orphans (no parent agent) get the default org so NOT NULL holds.
    for t in ("agent_tools", "tool_actions", "test_data"):
        op.execute(f"UPDATE {t} SET org_id = 'default' WHERE org_id IS NULL")
        op.execute(f"ALTER TABLE {t} ALTER COLUMN org_id SET DEFAULT 'default'")
        op.execute(f"ALTER TABLE {t} ALTER COLUMN org_id SET NOT NULL")
        op.execute(f"CREATE INDEX IF NOT EXISTS ix_{t}_org_id ON {t} (org_id)")

    # 2) Triggers keep org_id in sync from the parent, so no INSERT site can
    #    forget it (tool_actions in particular only carries a tool_id).
    op.execute("""
        CREATE OR REPLACE FUNCTION _set_org_from_agent() RETURNS trigger AS $$
        BEGIN
            IF NEW.org_id IS NULL THEN
                NEW.org_id := (SELECT org_id FROM agents WHERE id = NEW.agent_id);
            END IF;
            RETURN NEW;
        END; $$ LANGUAGE plpgsql;
    """)
    op.execute("""
        CREATE OR REPLACE FUNCTION _set_org_from_tool() RETURNS trigger AS $$
        BEGIN
            IF NEW.org_id IS NULL THEN
                NEW.org_id := (SELECT a.org_id FROM agent_tools t
                               JOIN agents a ON a.id = t.agent_id
                               WHERE t.id = NEW.tool_id);
            END IF;
            RETURN NEW;
        END; $$ LANGUAGE plpgsql;
    """)
    op.execute("CREATE TRIGGER trg_agent_tools_org BEFORE INSERT ON agent_tools "
               "FOR EACH ROW EXECUTE FUNCTION _set_org_from_agent()")
    op.execute("CREATE TRIGGER trg_test_data_org BEFORE INSERT ON test_data "
               "FOR EACH ROW EXECUTE FUNCTION _set_org_from_agent()")
    op.execute("CREATE TRIGGER trg_tool_actions_org BEFORE INSERT ON tool_actions "
               "FOR EACH ROW EXECUTE FUNCTION _set_org_from_tool()")

    # 3) RLS on every org-scoped table (org_id), plus organizations (keyed by id).
    for t in _ORG_TABLES:
        _enable_rls(t)
    _enable_rls("organizations", col="id")


def downgrade() -> None:
    for t in _ORG_TABLES + ["organizations"]:
        op.execute(f"DROP POLICY IF EXISTS org_isolation ON {t}")
        op.execute(f"ALTER TABLE {t} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} DISABLE ROW LEVEL SECURITY")

    op.execute("DROP TRIGGER IF EXISTS trg_agent_tools_org ON agent_tools")
    op.execute("DROP TRIGGER IF EXISTS trg_test_data_org ON test_data")
    op.execute("DROP TRIGGER IF EXISTS trg_tool_actions_org ON tool_actions")
    op.execute("DROP FUNCTION IF EXISTS _set_org_from_agent()")
    op.execute("DROP FUNCTION IF EXISTS _set_org_from_tool()")

    for t in ("agent_tools", "tool_actions", "test_data"):
        op.execute(f"DROP INDEX IF EXISTS ix_{t}_org_id")
        op.execute(f"ALTER TABLE {t} DROP COLUMN IF EXISTS org_id")
