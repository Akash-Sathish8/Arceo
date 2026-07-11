"""Audit-grade logging: tamper-evident hash chain + append-only (Phase 6).

Two protections so the audit log is defensible in a SOC2/enterprise review:
- DETECT: each row stores prev_hash + entry_hash = sha256(prev_hash || the row's
  content), forming a per-org chain. Editing or removing any past row breaks the
  chain, and GET /api/audit/verify proves it.
- PREVENT: a BEFORE DELETE/UPDATE trigger raises, so audit rows are append-only
  even for the app's own database role (triggers fire for everyone, unlike RLS).

Revision ID: 0007_audit_hash_chain
Revises: 0006_token_version
Create Date: 2026-07-11
"""
from alembic import op
import sqlalchemy as sa

revision = "0007_audit_hash_chain"
down_revision = "0006_token_version"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("audit_log", sa.Column("prev_hash", sa.Text, nullable=True))
    op.add_column("audit_log", sa.Column("entry_hash", sa.Text, nullable=True))

    # Append-only: block any DELETE or UPDATE on audit_log. Fires for every role
    # (including a superuser), so the log genuinely cannot be rewritten in place.
    op.execute("""
        CREATE OR REPLACE FUNCTION _audit_append_only() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'audit_log is append-only (Phase 6): % is not permitted', TG_OP;
        END; $$ LANGUAGE plpgsql;
    """)
    op.execute("CREATE TRIGGER trg_audit_append_only BEFORE UPDATE OR DELETE ON audit_log "
               "FOR EACH ROW EXECUTE FUNCTION _audit_append_only()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_audit_append_only ON audit_log")
    op.execute("DROP FUNCTION IF EXISTS _audit_append_only()")
    op.drop_column("audit_log", "entry_hash")
    op.drop_column("audit_log", "prev_hash")
