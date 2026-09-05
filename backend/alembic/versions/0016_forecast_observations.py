"""forecast_observations — the feature/outcome ledger the cold-start prior needs.

Every cold-start forecast is driven by a hardcoded prior:
`default_turns_per_run_by_archetype` in cost_defaults_operational.yaml is six
integers (scheduler 2, support 4, sales 4, devops 8, ops 8, default 4), beside
`default_calls_per_day: 100`, `default_cache_hit_rate: 0.60`,
`default_retry_rate: 0.03`. The plan is to learn those from real fleet traffic so
a brand-new agent gets a sharp number before it has run once.

That is blocked on data we are not keeping. `jobs/snapshot_forecasts.py` persists
only the forecast OUTPUT — point/low/high/composition — and discards every input
and every provenance flag that produced it: `inputSources`, `runsPerDay`,
`turnsPerRun`, `tokensPerCall`, `cacheHit`, `coverage`, `observedDays`. Nothing
joins a forecast to the traffic that agent subsequently produced. Each day that
passes is training data that cannot be reconstructed later.

This table is that join, recorded daily: the features knowable at cold start (X),
the forecast as it was actually made, and the parameters the agent really
exhibited over a trailing window (Y). One append-only row per
(agent | org) x window x source; every row is a self-contained training example.

The learning target is deliberately the PARAMETER vector, not the dollar figure.
Token and call counts are provider-reported — `_extract_usage` parses them out of
the response usage block — so they are independent evidence even inside our own
capture; only the pricing is ours. That keeps `outcome_source='arceo_capture'`
honest for the parameter model (the campaign rule is "never grade Arceo with
Arceo's numbers") and confines the circularity to the dollar layer, which
`provider_invoice` rows grade instead. Parameter priors also survive a repricing,
which dollar priors do not.

No unique constraint, matching `forecast_snapshots`: idempotency is the job's
`SELECT 1 ... LIMIT 1` guard. That is also the correct choice here rather than
merely the conventional one — `agent_id` is NULL on org-level invoice rows, and
Postgres treats NULLs as distinct in a unique constraint, so a constraint would
silently fail to dedupe exactly the rows most at risk of duplication.

Holds no prompt or response content — counts and aggregates only — so it is
outside the `llm_captures` purge path by construction.

Revision ID: 0016_forecast_observations
Revises: 0015_webhook_url_enc
Create Date: 2026-09-04
"""
from alembic import op
import sqlalchemy as sa

revision = "0016_forecast_observations"
down_revision = "0015_webhook_url_enc"
branch_labels = None
depends_on = None

_PRED = (
    "current_setting('app.current_org', true) IS NULL "
    "OR current_setting('app.current_org', true) = 'system' "
    "OR org_id = current_setting('app.current_org', true)"
)


def upgrade() -> None:
    op.create_table(
        "forecast_observations",
        # ── identity ──
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("agent_id", sa.Text),                        # NULL on org-level invoice rows
        sa.Column("observed_on", sa.Text, nullable=False),     # YYYY-MM-DD, window END
        sa.Column("window_days", sa.Integer, nullable=False),
        sa.Column("outcome_source", sa.Text, nullable=False),  # arceo_capture | provider_invoice | sandbox | hand_truth

        # ── X: cold-start features (every one knowable with zero traffic) ──
        sa.Column("archetype", sa.Text),                       # scheduler | support | ops | devops | sales | default
        sa.Column("declared_model", sa.Text),
        sa.Column("model_match", sa.Text),                     # exact | prefix | default
        sa.Column("model_recognized", sa.Boolean),
        sa.Column("n_tools", sa.Integer),
        sa.Column("n_actions", sa.Integer),
        sa.Column("tools_priced", sa.Integer),
        sa.Column("tools_total", sa.Integer),
        # Declared inputs. NULL is itself a feature — "the customer told us a
        # volume" is the single strongest predictor we have, since a declared
        # number is never multiplied by an archetype guess (the rule that took
        # mean |err| from 546% to 60%).
        sa.Column("expected_calls_per_day", sa.Integer),
        sa.Column("expected_turns_per_run", sa.Integer),
        sa.Column("avg_context_tokens", sa.Integer),
        sa.Column("environment", sa.Text),                     # prod | staging | dev
        sa.Column("trigger_source", sa.Text),                  # untrusted | internal | scheduled
        sa.Column("human_in_loop", sa.Boolean),
        sa.Column("tool_services_json", sa.Text),              # ["stripe", "sendgrid", ...]
        sa.Column("risk_label_counts_json", sa.Text),          # {"moves_money": 1, ...}
        # An agent that gains a tool mid-window makes X and Y describe different
        # agents; the hash lets the eval drop those rows instead of training on them.
        sa.Column("config_hash", sa.Text),
        sa.Column("feature_version", sa.Integer, nullable=False, server_default=sa.text("1")),

        # ── the forecast as made, so error is computable without re-running it ──
        sa.Column("forecast_point_usd", sa.Float),
        sa.Column("forecast_low_usd", sa.Float),
        sa.Column("forecast_high_usd", sa.Float),
        sa.Column("confidence", sa.Text),                      # low | medium | high
        sa.Column("confidence_cap", sa.Text),                  # single_day_burst | NULL
        sa.Column("forecast_inputs_json", sa.Text),            # the values the math actually used
        # Finer than the API's inputSources, which flattens sandbox- and
        # live-measured to one "measured": here they stay measured_sandbox vs
        # measured_live, because whose measurement it is decides whether a row
        # can train a prior at all.
        sa.Column("input_sources_json", sa.Text),
        sa.Column("formula_version", sa.Integer),

        # ── Y: realized parameters (the learning target) ──
        sa.Column("realized_calls_per_day", sa.Float),
        # Sandbox-only for now: live capture sees LLM calls with no run
        # boundaries, so it cannot observe turns/run — the very parameter the
        # archetype table guesses. Filled once captured calls carry a run id.
        sa.Column("realized_turns_per_run", sa.Float),
        sa.Column("realized_input_tokens", sa.Float),
        sa.Column("realized_output_tokens", sa.Float),
        sa.Column("realized_cache_hit_pct", sa.Float),
        sa.Column("realized_cost_per_call_usd", sa.Float),
        sa.Column("realized_monthly_usd", sa.Float),
        sa.Column("observed_calls", sa.Integer),
        sa.Column("observed_days", sa.Float),
        sa.Column("active_days", sa.Integer),
        sa.Column("model_mix_json", sa.Text),                  # [{model, calls, costShare}]
        sa.Column("tool_mix_json", sa.Text),

        sa.Column("captured_at", sa.Text),
    )
    op.create_index("ix_forecast_observations_org_id", "forecast_observations", ["org_id"])
    # Shaped for the job's idempotency guard and for the per-agent training pull.
    op.create_index(
        "idx_forecast_observations_agent_date", "forecast_observations", ["agent_id", "observed_on"]
    )

    # Same tenant isolation as every org-scoped table (0002). No append-only
    # trigger: a mis-derived row should be correctable, and nothing here is
    # evidence in the audit sense.
    op.execute("ALTER TABLE forecast_observations ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE forecast_observations FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY org_isolation ON forecast_observations "
        f"USING ({_PRED}) WITH CHECK ({_PRED})"
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS org_isolation ON forecast_observations")
    op.drop_table("forecast_observations")
