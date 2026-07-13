"""invoice_imports — provider bills imported for spend reconciliation.

The accuracy story made checkable: a customer imports what Anthropic/OpenAI/
Google actually billed (usage-export CSV or a typed total) and the Cost pages
compare it to the LLM spend Arceo captured over the same window. Rows are
org-scoped (an invoice covers an API key/org, never one agent) and carry the
day+model aggregation of the import so reconciliation can align per-day
without re-parsing the original file.

`source` is 'csv' | 'manual' | 'demo' — 'demo' rows are seeded illustrations
and the UI labels them as such (same honesty rule as agents.is_demo).

Revision ID: 0010_invoice_imports
Revises: 0009_agents_is_demo
Create Date: 2026-07-12
"""
from alembic import op
import sqlalchemy as sa

revision = "0010_invoice_imports"
down_revision = "0009_agents_is_demo"
branch_labels = None
depends_on = None

_PRED = (
    "current_setting('app.current_org', true) IS NULL "
    "OR current_setting('app.current_org', true) = 'system' "
    "OR org_id = current_setting('app.current_org', true)"
)


def upgrade() -> None:
    op.create_table(
        "invoice_imports",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("provider", sa.Text, nullable=False),      # normalized: anthropic | openai | google | ...
        sa.Column("source", sa.Text, nullable=False),        # csv | manual | demo
        sa.Column("filename", sa.Text),                      # csv imports only
        sa.Column("period_start", sa.Text),                  # YYYY-MM-DD (inclusive)
        sa.Column("period_end", sa.Text),                    # YYYY-MM-DD (inclusive)
        sa.Column("total_usd", sa.Float, nullable=False),
        sa.Column("line_items", sa.Text),                    # JSON [{day, model, usd}] aggregated
        sa.Column("created_at", sa.Text),
    )
    op.create_index("ix_invoice_imports_org_id", "invoice_imports", ["org_id"])

    # RLS: same tenant backstop as every org-scoped table.
    op.execute("ALTER TABLE invoice_imports ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE invoice_imports FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY org_isolation ON invoice_imports "
        f"USING ({_PRED}) WITH CHECK ({_PRED})"
    )


def downgrade() -> None:
    op.drop_table("invoice_imports")
