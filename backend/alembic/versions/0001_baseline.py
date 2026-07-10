"""Baseline: the full 17-table schema as of the SQLite era (Phase 2, PR-1).

This is a hand-written transcription of init_db()'s executescript PLUS every
column its defensive PRAGMA/ALTER block adds (workspace_settings.default_model
is the one column that exists ONLY via that block on a fresh SQLite DB).

Type mapping decisions:
- TEXT timestamps stay TEXT — type modernization is explicitly not this phase.
- The 7 INTEGER PRIMARY KEY AUTOINCREMENT tables become Integer PKs with
  autoincrement (SERIAL). workspace_settings.id joins them: in SQLite it is
  `INTEGER PRIMARY KEY DEFAULT 1`, a rowid alias that auto-assigns on the
  `VALUES (NULL, …)` inserts main.py uses — the DEFAULT 1 is dead code, and
  auto-assignment is the behavior to preserve (8 sequences total).
- tool_actions.reversible (SQLite `BOOLEAN DEFAULT 1`) becomes a real BOOLEAN;
  every writer inserts a Python bool.
- org_id gets an index on every table that has one — all queries filter by it.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-07-10
"""
from alembic import op
import sqlalchemy as sa

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None

# Creation order is FK-safe; downgrade drops in reverse.
_TABLES_IN_DROP_ORDER = (
    "agent_budgets",
    "cost_overrides",
    "forecast_snapshots",
    "regression_baselines",
    "workspace_settings",
    "sweeps",
    "api_keys",
    "simulations",
    "test_data",
    "execution_log",
    "audit_log",
    "policies",
    "tool_actions",
    "agent_tools",
    "agents",
    "users",
    "organizations",
)


def upgrade() -> None:
    op.create_table(
        "organizations",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("created_at", sa.Text),
    )

    op.create_table(
        "users",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("email", sa.Text, nullable=False, unique=True),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("role", sa.Text, server_default="viewer"),
        sa.Column("org_id", sa.Text, sa.ForeignKey("organizations.id"), server_default="default"),
        sa.Column("created_at", sa.Text),
    )
    op.create_index("ix_users_org_id", "users", ["org_id"])

    op.create_table(
        "agents",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("tenant_id", sa.Text),
        sa.Column("org_id", sa.Text, server_default="default"),
        sa.Column("simulation_model", sa.Text),
        sa.Column("expected_calls_per_day", sa.Integer),
        sa.Column("expected_turns_per_run", sa.Integer),
        sa.Column("avg_context_tokens", sa.Integer),
        sa.Column("system_prompt", sa.Text),
        sa.Column("environment", sa.Text),
        sa.Column("trigger_source", sa.Text),
        sa.Column("human_in_loop", sa.Integer),
        sa.Column("default_effect", sa.Text, nullable=False, server_default="ALLOW"),
        sa.Column("created_at", sa.Text),
        sa.Column("updated_at", sa.Text),
    )
    op.create_index("ix_agents_org_id", "agents", ["org_id"])

    op.create_table(
        "agent_tools",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("agent_id", sa.Text, sa.ForeignKey("agents.id", ondelete="CASCADE")),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("service", sa.Text, nullable=False),
        sa.Column("description", sa.Text),
    )

    op.create_table(
        "tool_actions",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("tool_id", sa.Integer, sa.ForeignKey("agent_tools.id", ondelete="CASCADE")),
        sa.Column("action", sa.Text, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("risk_labels", sa.Text, server_default="[]"),
        sa.Column("reversible", sa.Boolean, server_default=sa.text("true")),
        sa.Column("classification_source", sa.Text, server_default="unknown"),
    )

    op.create_table(
        "policies",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("agent_id", sa.Text, sa.ForeignKey("agents.id", ondelete="CASCADE")),
        sa.Column("action_pattern", sa.Text, nullable=False),
        sa.Column("effect", sa.Text, nullable=False),
        sa.Column("reason", sa.Text),
        sa.Column("conditions", sa.Text, server_default="[]"),
        sa.Column("priority", sa.Integer, server_default=sa.text("0")),
        sa.Column("org_id", sa.Text, server_default="default"),
        sa.Column("created_by", sa.Text),
        sa.Column("created_at", sa.Text),
    )
    op.create_index("ix_policies_org_id", "policies", ["org_id"])

    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Text),
        sa.Column("user_email", sa.Text),
        sa.Column("action", sa.Text, nullable=False),
        sa.Column("resource", sa.Text),
        sa.Column("detail", sa.Text),
        sa.Column("org_id", sa.Text, server_default="default"),
        sa.Column("timestamp", sa.Text),
    )
    op.create_index("ix_audit_log_org_id", "audit_log", ["org_id"])

    op.create_table(
        "execution_log",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("agent_id", sa.Text),
        sa.Column("tool", sa.Text),
        sa.Column("action", sa.Text),
        sa.Column("status", sa.Text),
        sa.Column("policy_id", sa.Integer),
        sa.Column("detail", sa.Text),
        sa.Column("params", sa.Text),
        sa.Column("source", sa.Text),
        sa.Column("org_id", sa.Text, server_default="default"),
        sa.Column("timestamp", sa.Text),
    )
    op.create_index("ix_execution_log_org_id", "execution_log", ["org_id"])

    op.create_table(
        "test_data",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("agent_id", sa.Text, sa.ForeignKey("agents.id", ondelete="CASCADE")),
        sa.Column("data_json", sa.Text, nullable=False),
        sa.Column("created_at", sa.Text),
        sa.Column("updated_at", sa.Text),
    )

    op.create_table(
        "simulations",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("agent_id", sa.Text),
        sa.Column("scenario_id", sa.Text),
        sa.Column("status", sa.Text),
        sa.Column("trace_json", sa.Text),
        sa.Column("report_json", sa.Text),
        sa.Column("org_id", sa.Text, server_default="default"),
        sa.Column("created_at", sa.Text),
        sa.Column("run_mode", sa.Text, nullable=False, server_default="live"),
    )
    op.create_index("ix_simulations_org_id", "simulations", ["org_id"])

    op.create_table(
        "api_keys",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("key_hash", sa.Text, nullable=False),
        sa.Column("key_prefix", sa.Text, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("created_by", sa.Text),
        sa.Column("agent_id", sa.Text),
        sa.Column("scopes", sa.Text, server_default='["enforce","register","report"]'),
        sa.Column("active", sa.Integer, server_default=sa.text("1")),
        sa.Column("org_id", sa.Text, server_default="default"),
        sa.Column("last_used", sa.Text),
        sa.Column("created_at", sa.Text),
    )
    op.create_index("ix_api_keys_org_id", "api_keys", ["org_id"])

    op.create_table(
        "sweeps",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("agent_id", sa.Text),
        sa.Column("status", sa.Text),
        sa.Column("total_scenarios", sa.Integer),
        sa.Column("completed", sa.Integer),
        sa.Column("report_json", sa.Text),
        sa.Column("org_id", sa.Text, server_default="default"),
        sa.Column("created_at", sa.Text),
    )
    op.create_index("ix_sweeps_org_id", "sweeps", ["org_id"])

    op.create_table(
        "workspace_settings",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("slack_webhook_url", sa.Text, server_default=""),
        sa.Column("alert_email", sa.Text, server_default=""),
        sa.Column("notify_on_block", sa.Integer, server_default=sa.text("1")),
        sa.Column("org_id", sa.Text, server_default="default"),
        sa.Column("last_digest_sent", sa.Text),
        sa.Column("updated_at", sa.Text),
        sa.Column("default_model", sa.Text),
    )
    op.create_index("ix_workspace_settings_org_id", "workspace_settings", ["org_id"])

    op.create_table(
        "regression_baselines",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("agent_id", sa.Text),
        sa.Column("version", sa.Integer, server_default=sa.text("1")),
        sa.Column("baseline_json", sa.Text, nullable=False),
        sa.Column("result_json", sa.Text),
        sa.Column("regressions_json", sa.Text),
        sa.Column("status", sa.Text, server_default="baseline"),
        sa.Column("org_id", sa.Text, server_default="default"),
        sa.Column("created_at", sa.Text),
    )
    op.create_index("ix_regression_baselines_org_id", "regression_baselines", ["org_id"])

    op.create_table(
        "forecast_snapshots",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("agent_id", sa.Text, nullable=False),
        sa.Column("org_id", sa.Text, server_default="default"),
        sa.Column("snapshot_date", sa.Text, nullable=False),
        sa.Column("point_usd", sa.Float, nullable=False),
        sa.Column("low_usd", sa.Float),
        sa.Column("high_usd", sa.Float),
        sa.Column("composition_json", sa.Text),
        sa.Column("captured_at", sa.Text),
    )
    op.create_index(
        "idx_forecast_snapshots_agent_date", "forecast_snapshots", ["agent_id", "snapshot_date"]
    )
    op.create_index("ix_forecast_snapshots_org_id", "forecast_snapshots", ["org_id"])

    op.create_table(
        "cost_overrides",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("scope", sa.Text, nullable=False),
        sa.Column("key", sa.Text, nullable=False),
        sa.Column("sub_key", sa.Text, nullable=False, server_default=""),
        sa.Column("value", sa.Float, nullable=False),
        sa.Column("updated_at", sa.Text),
        sa.UniqueConstraint("org_id", "scope", "key", "sub_key", name="uq_cost_overrides_scope"),
    )
    op.create_index("ix_cost_overrides_org_id", "cost_overrides", ["org_id"])

    op.create_table(
        "agent_budgets",
        sa.Column("agent_id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("monthly_budget_usd", sa.Float, nullable=False),
        sa.Column("alert_threshold_pct", sa.Integer, nullable=False, server_default=sa.text("80")),
        sa.Column("updated_at", sa.Text),
    )
    op.create_index("ix_agent_budgets_org_id", "agent_budgets", ["org_id"])


def downgrade() -> None:
    for table in _TABLES_IN_DROP_ORDER:
        op.drop_table(table)
