"""pending_requests — the durable held-action queue (Phase 4).

When a policy pauses an action (REQUIRE_APPROVAL), the full request is parked
here so it can be REPLAYED verbatim once a human approves. Durable (Postgres,
survives restart) and multi-worker safe (approve is an atomic conditional
UPDATE, so two approvers can't double-release). Org-scoped, so it gets the same
FORCE ROW LEVEL SECURITY as every tenant table.

`kind='proxy'` rows carry the full HTTP envelope (method/path/query/headers/body)
for replay; `Authorization` and `X-API-Key` are stripped before store — the
vault provides the real upstream secret at replay time. `kind='enforce'` rows
are decision gates only (the agent itself performs the action on approval).

Revision ID: 0004_pending_requests
Revises: 0003_provider_credentials
Create Date: 2026-07-11
"""
from alembic import op
import sqlalchemy as sa

revision = "0004_pending_requests"
down_revision = "0003_provider_credentials"
branch_labels = None
depends_on = None

_PRED = (
    "current_setting('app.current_org', true) IS NULL "
    "OR current_setting('app.current_org', true) = 'system' "
    "OR org_id = current_setting('app.current_org', true)"
)


def upgrade() -> None:
    op.create_table(
        "pending_requests",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("execution_id", sa.Integer, sa.ForeignKey("execution_log.id")),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("agent_id", sa.Text),
        sa.Column("kind", sa.Text, nullable=False),          # 'proxy' | 'enforce'
        sa.Column("status", sa.Text, nullable=False, server_default="PENDING"),
        # PENDING | APPROVED | REJECTED | REPLAYED | REPLAY_FAILED
        sa.Column("service", sa.Text),                       # proxy: the service key
        sa.Column("method", sa.Text),                        # proxy: HTTP verb
        sa.Column("path", sa.Text),                          # proxy: upstream path
        sa.Column("query_json", sa.Text),                    # proxy: query params (JSON)
        sa.Column("headers_json", sa.Text),                  # proxy: REDACTED headers (JSON)
        sa.Column("body", sa.Text),                          # proxy: request body (base64)
        sa.Column("tool", sa.Text),
        sa.Column("action", sa.Text),
        sa.Column("params_json", sa.Text),                   # display/enforcement params
        sa.Column("idempotency_key", sa.Text, nullable=False, unique=True),
        sa.Column("decided_by", sa.Text),
        sa.Column("decided_at", sa.Text),
        sa.Column("replayed_at", sa.Text),
        sa.Column("replay_detail", sa.Text),
        sa.Column("created_at", sa.Text),
    )
    op.create_index("ix_pending_requests_org_id", "pending_requests", ["org_id"])
    op.create_index("ix_pending_requests_execution_id", "pending_requests", ["execution_id"])

    # Auto-derive org_id from the linked execution_log row if a writer omits it
    # (belt-and-suspenders; the app always passes it explicitly).
    op.execute("""
        CREATE OR REPLACE FUNCTION _set_pending_org() RETURNS trigger AS $$
        BEGIN
            IF NEW.org_id IS NULL OR NEW.org_id = 'default' THEN
                NEW.org_id := COALESCE(
                    (SELECT org_id FROM execution_log WHERE id = NEW.execution_id),
                    NEW.org_id);
            END IF;
            RETURN NEW;
        END; $$ LANGUAGE plpgsql;
    """)
    op.execute("CREATE TRIGGER trg_pending_requests_org BEFORE INSERT ON pending_requests "
               "FOR EACH ROW EXECUTE FUNCTION _set_pending_org()")

    # RLS: same tenant backstop as every org-scoped table.
    op.execute("ALTER TABLE pending_requests ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE pending_requests FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY org_isolation ON pending_requests "
        f"USING ({_PRED}) WITH CHECK ({_PRED})"
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS org_isolation ON pending_requests")
    op.execute("DROP TRIGGER IF EXISTS trg_pending_requests_org ON pending_requests")
    op.execute("DROP FUNCTION IF EXISTS _set_pending_org()")
    op.drop_table("pending_requests")
