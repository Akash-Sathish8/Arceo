"""Encryption-at-rest: companion enc column for workspace_settings.slack_webhook_url (MED-014).

A Slack incoming-webhook URL *is* the credential — the path segment is the bearer
token, and anyone holding it can post into that workspace's channel as the
integration. It was the last secret in the schema stored in cleartext: the vault
covers provider credentials, 0005/0008/0011 covered request bodies, execution
params and audit detail, but this column was never brought along.

Same flag-gated (`ARCEO_ENCRYPT_AT_REST`) shape as every other encrypted column:
when the flag is on the value is written to `slack_webhook_url_enc` (bytea) and
the plaintext column is left NULL; `encryption.read` prefers the enc column and
falls back to plaintext, so pre-existing rows and flag-off deployments keep
working and the flag stays safe to flip in both directions.

Registering the pair in `encryption.ENCRYPTED_COLUMNS` (same commit) is what
makes `backfill_encryption.py` convert existing plaintext rows and
`rotate_vault_master_key.py` rewrap this column's DEKs — the HIGH-004 registry
exists precisely so a new `_enc` column cannot desync from the ops tooling, and
test_encrypt_at_rest_full.py::test_encrypted_columns_registry_matches_schema
fails the build if it does.

Revision ID: 0015_webhook_url_enc
Revises: 0014_llm_captures
Create Date: 2026-07-29
"""
from alembic import op
import sqlalchemy as sa

revision = "0015_webhook_url_enc"
down_revision = "0014_llm_captures"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "workspace_settings",
        sa.Column("slack_webhook_url_enc", sa.LargeBinary, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspace_settings", "slack_webhook_url_enc")
