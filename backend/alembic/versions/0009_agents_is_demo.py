"""Demo-data honesty: mark seeded demo agents so no surface can pass
synthetic traffic off as measured.

The demo seeder (seed_demo_cost_portfolio.py) writes rng-generated LLM_CALL
rows that are structurally identical to real capture and drive a genuine
high-confidence forecast. Before this flag, nothing in the API or UI could
tell a viewer the numbers are illustrative — the only disclosure was a code
comment in the seeder. `is_demo` is set ONLY by the seeder (direct DB write);
it is deliberately absent from RegisterAgentInput so no API caller can set or
clear it.

Revision ID: 0009_agents_is_demo
Revises: 0008_execution_params_enc
Create Date: 2026-07-12
"""
from alembic import op
import sqlalchemy as sa

revision = "0009_agents_is_demo"
down_revision = "0008_execution_params_enc"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agents",
        sa.Column("is_demo", sa.Boolean, nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("agents", "is_demo")
