"""provider_credentials — the credential vault's storage (Phase 2, PR-3).

Encrypted, decryptable-by-design provider secrets (see backend/vault.py for
the envelope scheme). Deliberately separate from api_keys, whose SHA-256
hashes are one-way identity checks — the opposite contract.

Revision ID: 0002_provider_credentials
Revises: 0001_baseline
Create Date: 2026-07-10
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_provider_credentials"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None


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


def downgrade() -> None:
    op.drop_table("provider_credentials")
