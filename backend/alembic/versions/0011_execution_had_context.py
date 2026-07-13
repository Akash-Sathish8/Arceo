"""Record whether an enforcement decision carried session context.

Chain policies (requires_prior) can only fire when the caller supplies
session_context. To tell an operator honestly that their chain policy is
*inert* — authored, but never exercised because live traffic omits context —
we record per decision whether context was present. NULL = legacy/unknown
(rows written before this column existed); TRUE/FALSE = a decision that did or
did not carry prior-action context. The dashboard reads this to warn when an
agent has requires_prior policies but no recent traffic ever carried context.

Revision ID: 0011_execution_had_context
Revises: 0010_invoice_imports
Create Date: 2026-07-13
"""
from alembic import op
import sqlalchemy as sa

revision = "0011_execution_had_context"
down_revision = "0010_invoice_imports"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("execution_log", sa.Column("had_session_context", sa.Boolean, nullable=True))


def downgrade() -> None:
    op.drop_column("execution_log", "had_session_context")
