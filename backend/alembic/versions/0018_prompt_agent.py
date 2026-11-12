"""Prompt library: send a prompt to your coding agent (MCP tokens + inbox).

  prompt_agent_tokens   one row per agent connection a person creates on the
                        Connect page. Only the sha256 of the token is stored
                        (token_hash, unique), the plain `ap_...` value is shown
                        once. Per USER, limited to prompts. revoked_at set =
                        the token no longer works.
  prompt_sends          the inbox: "send this prompt to my agent". The filled
                        text can carry a customer's pasted content, so `text`
                        has an _enc twin (encryption.split, registered in
                        encryption.ENCRYPTED_COLUMNS). delivered_at is set the
                        one time an agent fetches it; expires_at = 24 h.

Both use the same `org_isolation` policy as every tenant table (0002/0016),
with no public policy: tokens and sends are private to the org that made them.

Revision ID: 0018_prompt_agent
Revises: 0017_prompt_library_v2
Create Date: 2026-11-11
"""
from alembic import op
import sqlalchemy as sa

revision = "0018_prompt_agent"
down_revision = "0017_prompt_library_v2"
branch_labels = None
depends_on = None

_ORG_PRED = ("current_setting('app.current_org', true) IS NULL "
             "OR current_setting('app.current_org', true) = 'system' "
             "OR org_id = current_setting('app.current_org', true)")

_TABLES = ["prompt_agent_tokens", "prompt_sends"]


def upgrade() -> None:
    op.create_table(
        "prompt_agent_tokens",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("user_id", sa.Text, nullable=False),
        sa.Column("label", sa.Text),
        sa.Column("token_hash", sa.Text, nullable=False),            # sha256 hex of the plain token
        sa.Column("created_at", sa.Text, nullable=False),
        sa.Column("last_used_at", sa.Text),
        sa.Column("revoked_at", sa.Text),
        sa.UniqueConstraint("token_hash", name="uq_prompt_agent_tokens_token_hash"),
    )
    op.create_index("ix_prompt_agent_tokens_org_id", "prompt_agent_tokens", ["org_id"])
    op.create_index("ix_prompt_agent_tokens_user_id", "prompt_agent_tokens", ["user_id"])

    op.create_table(
        "prompt_sends",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("user_id", sa.Text, nullable=False),
        sa.Column("prompt_id", sa.Text),                              # null if the prompt was deleted
        sa.Column("title", sa.Text),
        sa.Column("text", sa.Text),                                   # filled prompt (plaintext twin)
        sa.Column("text_enc", sa.LargeBinary),
        sa.Column("created_at", sa.Text, nullable=False),
        sa.Column("delivered_at", sa.Text),
        sa.Column("expires_at", sa.Text, nullable=False),
    )
    op.create_index("ix_prompt_sends_org_id", "prompt_sends", ["org_id"])
    # The agent's "oldest undelivered send for this user" lookup and the Connect
    # page's recent-sends list both walk this index.
    op.create_index("ix_prompt_sends_user_delivered_created", "prompt_sends",
                    ["user_id", "delivered_at", "created_at"])

    for t in _TABLES:
        op.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY org_isolation ON {t} USING ({_ORG_PRED}) WITH CHECK ({_ORG_PRED})")


def downgrade() -> None:
    for t in reversed(_TABLES):
        op.execute(f"DROP POLICY IF EXISTS org_isolation ON {t}")
        op.drop_table(t)
