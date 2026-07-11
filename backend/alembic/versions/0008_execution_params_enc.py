"""Encryption-at-rest: companion enc column for execution_log.params.

Extends the flag-gated (`ARCEO_ENCRYPT_AT_REST`) at-rest encryption from held
requests (0005) to `execution_log.params` — the action's arguments, i.e. actual
customer data (amounts, ids, recipients). When the flag is on, params are written
to `params_enc` (bytea) and the plaintext column is left NULL; the read path
(encryption.hydrate) prefers the enc column and falls back to plaintext, so old
rows and flag-off rows keep working and the flag is safe to flip both ways.

Revision ID: 0008_execution_params_enc
Revises: 0007_audit_hash_chain
Create Date: 2026-07-11
"""
from alembic import op
import sqlalchemy as sa

revision = "0008_execution_params_enc"
down_revision = "0007_audit_hash_chain"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("execution_log", sa.Column("params_enc", sa.LargeBinary, nullable=True))


def downgrade() -> None:
    op.drop_column("execution_log", "params_enc")
