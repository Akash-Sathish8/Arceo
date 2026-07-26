"""Encryption-at-rest: companion enc column for audit_log.detail (HIGH-002).

The two LLM-capture paths (/api/agent/{id}/llm-call and /proxy/llm) write full
system prompts + model responses into audit_log.detail — the densest customer PII
in the platform. This extends the flag-gated (`ARCEO_ENCRYPT_AT_REST`) at-rest
encryption to that column, exactly as 0008 did for execution_log.params: when the
flag is on, detail is written to `detail_enc` (bytea) and the plaintext column is
left NULL; the read path (encryption.hydrate) prefers the enc column and falls back
to plaintext, so old rows and flag-off rows keep working and the flag is safe to
flip both ways.

The audit hash-chain deliberately hashes the PLAINTEXT detail (in log_audit),
so /api/audit/verify stays valid regardless of the encryption flag.

Revision ID: 0011_audit_detail_enc
Revises: 0010_invoice_imports
Create Date: 2026-07-26
"""
from alembic import op
import sqlalchemy as sa

revision = "0011_audit_detail_enc"
down_revision = "0010_invoice_imports"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("audit_log", sa.Column("detail_enc", sa.LargeBinary, nullable=True))


def downgrade() -> None:
    op.drop_column("audit_log", "detail_enc")
