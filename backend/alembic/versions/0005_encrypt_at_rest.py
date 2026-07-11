"""Encryption-at-rest companion columns (Phase 5).

Adds nullable bytea columns that hold the envelope-encrypted form of the most
sensitive held-request fields (the raw outbound body + the action params). When
ARCEO_ENCRYPT_AT_REST is on, writes go to the *_enc column and the plaintext is
left NULL; reads prefer *_enc and fall back to plaintext. That makes the flag
safe to flip both ways and lets old plaintext rows keep working.

The same `vault.encrypt_value` scheme extends to other sensitive columns
(system_prompt, trace_json — already PII-redacted) as follow-ons.

Revision ID: 0005_encrypt_at_rest
Revises: 0004_pending_requests
Create Date: 2026-07-11
"""
from alembic import op
import sqlalchemy as sa

revision = "0005_encrypt_at_rest"
down_revision = "0004_pending_requests"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("pending_requests", sa.Column("body_enc", sa.LargeBinary, nullable=True))
    op.add_column("pending_requests", sa.Column("params_json_enc", sa.LargeBinary, nullable=True))


def downgrade() -> None:
    op.drop_column("pending_requests", "params_json_enc")
    op.drop_column("pending_requests", "body_enc")
