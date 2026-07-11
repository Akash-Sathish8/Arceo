"""users.token_version for instant session revocation (Phase 5).

The JWT embeds the user's token_version; changing the password bumps it, so
every token issued before the change (a possibly-stolen session) stops
verifying immediately instead of lingering until its 24h expiry.

Revision ID: 0006_token_version
Revises: 0005_encrypt_at_rest
Create Date: 2026-07-11
"""
from alembic import op
import sqlalchemy as sa

revision = "0006_token_version"
down_revision = "0005_encrypt_at_rest"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("token_version", sa.Integer, nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("users", "token_version")
