"""Purgeable store for captured LLM prompt/response content (MED-013).

Both capture paths wrote the system prompt and the full response body into
`audit_log.detail` — the densest customer PII in the product. `audit_log` is
append-only by trigger (0007), and that trigger fires for EVERY role including
superuser, so there was no TTL, no purge, and no erasure path anywhere: a GDPR
deletion request had no answer, by construction.

The content moves here instead. This table has no append-only trigger, so rows
can be deleted on a retention schedule or for a specific subject. `audit_log`
keeps the metadata and the token usage the cost engine reads, plus a reference and
a SHA-256 of the content — so the hash chain stays valid forever and a purge is
still provable (the digest shows what WAS there without retaining it).

Encrypted through the same seam as audit_log.detail / execution_log.params: when
ARCEO_ENCRYPT_AT_REST is on, `content_enc` holds ciphertext and `content` is NULL.
Registered in encryption.ENCRYPTED_COLUMNS so key rotation and backfill pick it up
(the HIGH-004 registry exists precisely so a new _enc column can't desync).

Revision ID: 0014_llm_captures
Revises: 0013_users_disabled_at
Create Date: 2026-07-29
"""
from alembic import op
import sqlalchemy as sa

revision = "0014_llm_captures"
down_revision = "0013_users_disabled_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "llm_captures",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("agent_id", sa.Text),
        sa.Column("content", sa.Text),              # plaintext when the flag is off
        sa.Column("content_enc", sa.LargeBinary),   # ciphertext when it's on
        sa.Column("content_sha256", sa.Text),
        sa.Column("created_at", sa.Text, nullable=False),
    )
    op.create_index("ix_llm_captures_org_id", "llm_captures", ["org_id"])
    # The retention job sweeps by age; the erasure path looks up by agent.
    op.create_index("ix_llm_captures_created_at", "llm_captures", ["created_at"])
    op.create_index("ix_llm_captures_agent_id", "llm_captures", ["agent_id"])

    # Same tenant isolation as every other table (0002). Deliberately NO
    # append-only trigger — being deletable is the entire point of this table.
    op.execute("ALTER TABLE llm_captures ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE llm_captures FORCE ROW LEVEL SECURITY")
    # Same predicate and policy name as every table in 0002 — unset/system context
    # sees everything, a real org sees only its own.
    pred = ("current_setting('app.current_org', true) IS NULL "
            "OR current_setting('app.current_org', true) = 'system' "
            "OR org_id = current_setting('app.current_org', true)")
    op.execute(f"CREATE POLICY org_isolation ON llm_captures "
               f"USING ({pred}) WITH CHECK ({pred})")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS org_isolation ON llm_captures")
    op.drop_table("llm_captures")
