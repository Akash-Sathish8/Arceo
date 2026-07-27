"""Per-org configurable JWT session length (workspace_settings.token_expiry_hours).

"Dumb code, smart config" (2026-07-24 review): the 24h token lifetime becomes a
per-org setting instead of a hardcoded constant, so an org can shorten or lengthen
its session window without a code change. NULL = fall back to the 24h default;
reads are clamped to [1, 72] hours so it can't be set to something insecure.

Revision ID: 0012_org_token_expiry
Revises: 0011_audit_detail_enc
Create Date: 2026-07-26
"""
from alembic import op
import sqlalchemy as sa

revision = "0012_org_token_expiry"
down_revision = "0011_audit_detail_enc"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("workspace_settings", sa.Column("token_expiry_hours", sa.Integer, nullable=True))


def downgrade() -> None:
    op.drop_column("workspace_settings", "token_expiry_hours")
