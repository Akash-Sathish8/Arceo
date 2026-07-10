"""provider_credentials — the credential vault's storage (Phase 2, PR-3).

Encrypted, decryptable-by-design provider secrets (see backend/vault.py for
the envelope scheme). Deliberately separate from api_keys, whose SHA-256
hashes are one-way identity checks — the opposite contract.

Chained AFTER 0002_rls_tenant_isolation (which landed first on dev) so the
Alembic tree has a single head. The new table is org-scoped, so it gets the
SAME FORCE ROW LEVEL SECURITY policy as every other tenant table — the vault
is the most sensitive store, it must sit under the same structural backstop.

Revision ID: 0003_provider_credentials
Revises: 0002_rls_tenant_isolation
Create Date: 2026-07-10
"""
from alembic import op
import sqlalchemy as sa

revision = "0003_provider_credentials"
down_revision = "0002_rls_tenant_isolation"
branch_labels = None
depends_on = None

# Matches the org-context predicate defined in 0002_rls_tenant_isolation.
_PRED = (
    "current_setting('app.current_org', true) IS NULL "
    "OR current_setting('app.current_org', true) = 'system' "
    "OR org_id = current_setting('app.current_org', true)"
)


def upgrade() -> None:
    op.create_table(
        "provider_credentials",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("provider", sa.Text, nullable=False),
        sa.Column("auth_type", sa.Text, nullable=False, server_default="bearer"),
        sa.Column("encrypted_config", sa.LargeBinary, nullable=False),
        sa.Column("wrapped_dek", sa.LargeBinary, nullable=False),
        sa.Column("created_by", sa.Text),
        sa.Column("created_at", sa.Text),
        sa.Column("updated_at", sa.Text),
        sa.UniqueConstraint("org_id", "provider", name="uq_provider_credentials_org_provider"),
    )
    op.create_index("ix_provider_credentials_org_id", "provider_credentials", ["org_id"])

    # RLS: the vault table gets the same tenant isolation as the rest.
    op.execute("ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE provider_credentials FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY org_isolation ON provider_credentials "
        f"USING ({_PRED}) WITH CHECK ({_PRED})"
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS org_isolation ON provider_credentials")
    op.drop_table("provider_credentials")
