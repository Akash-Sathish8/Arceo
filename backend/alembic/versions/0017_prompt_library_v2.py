"""Prompt library v2: customer-facing fields.

  organizations.workspace     'agents' (default) | 'prompts': which product a
                              signup came for, so a founder from the prompts page
                              lands in a prompts workspace
  prompts.runs_per_day        how often the author runs it -> monthly cost
  prompts.model               the model the author actually uses -> savings line
  prompts.dismissed           JSON [reason id] the author marked not applicable
  prompts.use_count           times someone used it (filled + copied/opened)
  prompts.ai_check            JSON cached AI danger check, keyed by body hash
  prompt_usage                one row per model run on ARCEO's key (QA, compare,
                              workflow run, comparison entry): the free monthly
                              allowance counts these. Runs on a customer's own
                              key are recorded with key_source='org' and don't count.
  prompt_workflows.last_run   JSON last real run (outputs can carry pasted
                              content, so it has an _enc twin registered in
                              encryption.ENCRYPTED_COLUMNS)

Revision ID: 0017_prompt_library_v2
Revises: 0016_prompt_library
Create Date: 2026-10-20
"""
from alembic import op
import sqlalchemy as sa

revision = "0017_prompt_library_v2"
down_revision = "0016_prompt_library"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("organizations", sa.Column("workspace", sa.Text, nullable=False, server_default="agents"))
    op.add_column("prompts", sa.Column("runs_per_day", sa.Integer))
    op.add_column("prompts", sa.Column("model", sa.Text))
    op.add_column("prompts", sa.Column("dismissed", sa.Text))
    op.add_column("prompts", sa.Column("use_count", sa.Integer, nullable=False, server_default="0"))
    op.add_column("prompts", sa.Column("ai_check", sa.Text))
    op.add_column("prompt_workflows", sa.Column("last_run", sa.Text))
    op.add_column("prompt_workflows", sa.Column("last_run_enc", sa.LargeBinary))
    op.create_table(
        "prompt_usage",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("kind", sa.Text, nullable=False),        # qa | compare | workflow_run | comparison_entry
        sa.Column("key_source", sa.Text, nullable=False),  # server | org
        sa.Column("usd", sa.Float),
        sa.Column("created_at", sa.Text, nullable=False),
    )
    op.create_index("ix_prompt_usage_org_created", "prompt_usage", ["org_id", "created_at"])
    pred = ("current_setting('app.current_org', true) IS NULL "
            "OR current_setting('app.current_org', true) = 'system' "
            "OR org_id = current_setting('app.current_org', true)")
    op.execute("ALTER TABLE prompt_usage ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE prompt_usage FORCE ROW LEVEL SECURITY")
    op.execute(f"CREATE POLICY org_isolation ON prompt_usage USING ({pred}) WITH CHECK ({pred})")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS org_isolation ON prompt_usage")
    op.drop_table("prompt_usage")
    op.drop_column("prompt_workflows", "last_run_enc")
    op.drop_column("prompt_workflows", "last_run")
    for c in ("ai_check", "use_count", "dismissed", "model", "runs_per_day"):
        op.drop_column("prompts", c)
    op.drop_column("organizations", "workspace")
