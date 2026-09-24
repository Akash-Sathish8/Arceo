"""forecast_observations — the feature/outcome ledger (migration 0016).

The ledger exists because `forecast_snapshots` keeps only the forecast OUTPUT and
discards every input that produced it, so nothing pairs "what we knew about this
agent before it ran" with "what it actually did". Without that pair the cold-start
prior in cost_defaults_operational.yaml can never be learned — it can only be
hand-tuned forever.

These tests pin the three properties that make the table trainable rather than
merely populated: the row is written at all (the job's per-agent body swallows
exceptions, so a silent zero-row job is the failure mode this table inherits), it
is written once per agent per day, and a measurement's provenance survives at
finer grain than the shipped API exposes.
"""

from __future__ import annotations

import json
import uuid

import pytest

from db import get_db


def _agent(client, headers, name="obs", **fields) -> str:
    """Create an agent with a declared volume, so its forecast is `available`.

    Without a declared volume (and with no sandbox or live traffic) the forecast
    refuses to produce a number at all, and the job correctly writes nothing.
    """
    payload = {
        "name": f"{name}-{uuid.uuid4().hex[:6]}",
        "tools": [{
            "name": "stripe",
            "service": "stripe",
            "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}],
        }],
        "simulation_model": "claude-sonnet-4-6",
        "expected_calls_per_day": 100,
    }
    payload.update(fields)
    r = client.post("/api/authority/agents", headers=headers, json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    return body["agent"]["id"] if "agent" in body else body["id"]


def _rows(agent_id: str) -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM forecast_observations WHERE agent_id = %s", (agent_id,)
        ).fetchall()]


# ── the row gets written, with the features actually filled in ────────────────

def test_job_writes_a_ledger_row_with_features_and_forecast(client, roles):
    """A zero-row job is this table's failure mode, inherited from the snapshot
    job: the per-agent body wraps everything in `except Exception: failed += 1`,
    so a broken write counts as a skip and nothing polls the exit code. Assert
    the row exists AND that X is populated — an all-NULL row is not training data.
    """
    from jobs import snapshot_forecasts

    admin = roles["admin"]
    agent_id = _agent(client, admin["headers"])

    result = snapshot_forecasts.snapshot_all_agents()
    assert result["failed"] == 0, result
    assert result["observations"] >= 1, result

    rows = _rows(agent_id)
    assert len(rows) == 1, rows
    row = rows[0]

    # X — knowable with zero traffic.
    assert row["archetype"] is not None
    assert row["declared_model"] == "claude-sonnet-4-6"
    assert row["expected_calls_per_day"] == 100
    assert row["n_tools"] == 1
    assert row["n_actions"] == 1
    assert json.loads(row["tool_services_json"]) == ["stripe"]
    assert json.loads(row["risk_label_counts_json"]) == {"moves_money": 1}
    assert row["config_hash"] and len(row["config_hash"]) == 64
    assert row["feature_version"] == 1

    # F — the forecast as made, so error needs no re-run.
    assert row["forecast_point_usd"] is not None
    assert row["confidence"] in ("low", "medium", "high")
    assert row["formula_version"] is not None
    assert json.loads(row["forecast_inputs_json"])["runsPerDay"] is not None
    assert json.loads(row["input_sources_json"])["runsPerDay"] == "declared"

    # Y — nothing measured this agent, so the realized side stays NULL. A missing
    # measurement must never arrive as a zero; a zero is a claim.
    assert row["realized_calls_per_day"] is None
    assert row["realized_monthly_usd"] is None
    assert row["outcome_source"] == "arceo_capture"


def test_the_llm_only_slice_is_recorded_alongside_the_all_in_forecast(client, roles):
    """`realized_monthly_usd` measures LLM tokens and nothing else — tool and infra
    dollars are estimated, never observed. So the all-in forecast is the wrong thing
    to grade it against: the realized side would be missing two components the
    forecast side has, and every agent would read as spending under forecast. The
    ledger records the LLM-only point and band for that comparison.
    """
    from analysis.spend_forecast import load_defaults
    from jobs import snapshot_forecasts

    agent_id = _agent(client, roles["admin"]["headers"])
    snapshot_forecasts.snapshot_all_agents()
    row = _rows(agent_id)[0]

    for col in ("forecast_tokens_usd", "forecast_tokens_low_usd", "forecast_tokens_high_usd"):
        assert row[col] is not None, col

    # A slice, not the whole. This is the assertion that fails if someone ever wires
    # these three columns to point/low/high and reintroduces the mismatch.
    assert row["forecast_tokens_usd"] < row["forecast_point_usd"]
    assert row["forecast_tokens_low_usd"] < row["forecast_tokens_usd"] < row["forecast_tokens_high_usd"]

    # The band carries this tier's real multipliers, exactly. This is why the LLM
    # band is stored rather than derived from the all-in columns: those are rounded
    # to whole dollars, so on a small forecast `low/point` recovers 0.53 for a band
    # whose true low multiplier is 0.50 — a 6% error on the very edge a
    # cost-out-of-band finding fires at.
    band = load_defaults()["confidence_bands"][row["confidence"]]
    assert row["forecast_tokens_low_usd"] / row["forecast_tokens_usd"] == pytest.approx(
        band["low_multiplier"])
    assert row["forecast_tokens_high_usd"] / row["forecast_tokens_usd"] == pytest.approx(
        band["high_multiplier"])


def test_one_row_per_agent_per_day(client, roles):
    """Idempotency is the job's SELECT-1 guard, not a unique constraint — the
    table deliberately has none, because agent_id is NULL on org-level invoice
    rows and Postgres counts NULLs as distinct."""
    from jobs import snapshot_forecasts

    agent_id = _agent(client, roles["admin"]["headers"], "obs-idem")
    snapshot_forecasts.snapshot_all_agents()
    snapshot_forecasts.snapshot_all_agents()

    assert len(_rows(agent_id)) == 1


def test_no_row_when_the_forecast_refuses_to_produce_one(client, roles):
    """No declared volume, no sandbox, no live traffic → no forecast. The job
    already refuses to persist a fabricated snapshot; the ledger inherits that,
    because a row with no F half is not a training example."""
    from jobs import snapshot_forecasts

    r = client.post("/api/authority/agents", headers=roles["admin"]["headers"],
                    json={"name": f"obs-bare-{uuid.uuid4().hex[:6]}", "tools": []})
    assert r.status_code == 200, r.text
    body = r.json()
    agent_id = body["agent"]["id"] if "agent" in body else body["id"]

    snapshot_forecasts.snapshot_all_agents()
    assert _rows(agent_id) == []


def test_the_ledger_row_is_written_even_when_today_is_already_snapshotted(client, roles):
    """0016 shipped after this job had been running, so on the first day the
    snapshot exists and the observation does not. The two rows are guarded
    independently precisely so that day is not lost."""
    from jobs import snapshot_forecasts

    agent_id = _agent(client, roles["admin"]["headers"], "obs-backdate")
    snapshot_forecasts.snapshot_all_agents()

    with get_db() as conn:
        conn.execute("DELETE FROM forecast_observations WHERE agent_id = %s", (agent_id,))
    assert _rows(agent_id) == []

    result = snapshot_forecasts.snapshot_all_agents()
    assert result["observations"] >= 1, result
    assert len(_rows(agent_id)) == 1


# ── tenancy ───────────────────────────────────────────────────────────────────

def test_rows_are_scoped_to_their_own_org(client, two_orgs):
    """App-level scoping — the layer that actually runs on every query."""
    from jobs import snapshot_forecasts

    a, b = two_orgs["org_a"], two_orgs["org_b"]
    a_id = _agent(client, a["headers"], "obs-a")
    b_id = _agent(client, b["headers"], "obs-b")
    snapshot_forecasts.snapshot_all_agents()

    with get_db() as conn:
        visible = {r["agent_id"] for r in conn.execute(
            "SELECT agent_id FROM forecast_observations WHERE org_id = %s", (a["org_id"],)
        ).fetchall()}

    assert a_id in visible
    assert b_id not in visible
    # Each row carries the org of the agent it describes, not the job's context.
    with get_db() as conn:
        row = conn.execute(
            "SELECT org_id FROM forecast_observations WHERE agent_id = %s", (b_id,)
        ).fetchone()
    assert row["org_id"] == b["org_id"]


def test_the_rls_backstop_is_installed_on_this_table():
    """The structural half, and the one that actually needs a test here.

    RLS behaviour is proven once in test_rls_enforcement.py under a NOSUPERUSER
    role — and it only exercises `agents`, so it does NOT cover a new table.
    Meanwhile the suite connects as `postgres`, a superuser, which bypasses RLS
    even when FORCED: a behavioural assertion in this file would pass whether or
    not the policy exists. So assert the policy is there. The realistic failure
    is a future migration copying this table and dropping the RLS block.
    """
    with get_db() as conn:
        flags = conn.execute(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
            "WHERE relname = 'forecast_observations'"
        ).fetchone()
        policies = [r["policyname"] for r in conn.execute(
            "SELECT policyname FROM pg_policies WHERE tablename = 'forecast_observations'"
        ).fetchall()]

    assert flags["relrowsecurity"], "row level security is not enabled"
    assert flags["relforcerowsecurity"], "RLS is not FORCEd — the table owner would bypass it"
    assert "org_isolation" in policies, policies


# ── the provenance split, which is the whole point of the ledger ──────────────

def test_measured_is_split_into_live_and_sandbox():
    """`forecast_spend` emits one flat "measured" for both sandbox- and
    live-measured inputs. That is fine for a chip in the UI and useless here:
    sandbox numbers are ours, live numbers are the customer's, and only the
    second kind can train a prior that generalises."""
    from analysis.forecast_observations import refine_input_sources

    api_shape = {
        "runsPerDay": "measured", "turnsPerRun": "measured",
        "tokensPerCall": "measured", "cacheHit": "measured",
        "model": "declared", "toolMix": "default",
    }

    live = refine_input_sources(
        api_shape,
        live_avgs={"llm_calls_per_day": 12, "input_tokens": 900, "cache_hit": 60},
        sandbox_avgs={},
    )
    assert live["runsPerDay"] == "measured_live"
    assert live["tokensPerCall"] == "measured_live"
    assert live["cacheHit"] == "measured_live"
    assert live["model"] == "declared", "non-measured values pass through untouched"

    sandbox = refine_input_sources(
        api_shape, live_avgs={}, sandbox_avgs={"turns_per_run": 4, "input_tokens": 900},
    )
    assert sandbox["turnsPerRun"] == "measured_sandbox"
    assert sandbox["tokensPerCall"] == "measured_sandbox"
    # Sandbox runs every scenario cold, so its cache rate is structurally 0% and
    # is never a measurement of production locality.
    assert sandbox["cacheHit"] == "measured"


def test_config_hash_moves_when_the_agent_does():
    """An agent that gains a tool mid-window makes X and Y describe two different
    agents. The hash is how the eval drops those rows instead of training on them."""
    from analysis.forecast_observations import config_hash

    base = {
        "simulation_model": "claude-sonnet-4-6",
        "expected_calls_per_day": 100,
        "tools": [{"service": "stripe", "actions": [{"action": "create_refund", "risk_labels": ["moves_money"]}]}],
    }
    grown = {
        **base,
        "tools": base["tools"] + [
            {"service": "sendgrid", "actions": [{"action": "send_email", "risk_labels": ["sends_external"]}]}
        ],
    }

    assert config_hash(base) == config_hash(dict(base)), "hash must be stable for one config"
    assert config_hash(base) != config_hash(grown)


# ── backfill: recovering the Y half from traffic that predates 0016 ───────────

def test_backfill_recovers_realized_parameters_and_leaves_the_forecast_null(client, roles):
    """`audit_log` has been storing LLM calls since long before the ledger, so
    the realized half of the training set is already on disk — it just was never
    paired with anything.

    Y is genuinely recoverable: the token counts are provider-reported and were
    written down at the time. F is not, and is deliberately left NULL rather than
    reconstructed — prices, defaults and the formula have all moved since, so a
    "forecast" computed today for a window last month would be a fabrication
    wearing a timestamp. NULL forecast_point_usd is the marker for "backfilled:
    Y only".
    """
    from datetime import datetime

    from db import current_org, log_audit
    from jobs import backfill_forecast_observations as backfill

    admin = roles["admin"]
    agent_id = _agent(client, admin["headers"], "obs-backfill")
    org_id = admin["org_id"]

    token = current_org.set(org_id)
    try:
        with get_db() as conn:
            for _ in range(6):  # above the 5-call floor the live tier also uses
                log_audit(
                    conn, None, agent_id, "LLM_CALL", "anthropic:claude-sonnet-4-6",
                    json.dumps({
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-6",
                        "response": {"usage": {
                            "input_tokens": 1000,
                            "output_tokens": 200,
                            "cache_read_input_tokens": 500,
                        }},
                    }),
                    org_id,
                )

        assert backfill.backfill(days=7, dry_run=True)["written"] >= 1, "dry run found nothing"
        assert _rows(agent_id) == [], "dry run must not write"

        # Deliberately not asserting the fleet-wide `failed` counter: the backfill
        # walks every agent in the database, and in a full-suite run that is every
        # agent every other test left behind. This test owns one agent; the
        # assertions below are all scoped to it.
        backfill.backfill(days=7)
    finally:
        current_org.reset(token)

    rows = [r for r in _rows(agent_id) if r["forecast_point_usd"] is None]
    assert len(rows) == 1, rows
    row = rows[0]

    # Y is real.
    assert row["realized_input_tokens"] == 1500, "total input = input + cache_read"
    assert row["realized_output_tokens"] == 200
    assert row["realized_cache_hit_pct"] is not None
    assert row["observed_calls"] == 6
    assert row["window_days"] == 7

    # X came along for the ride, hashed so drift is detectable later.
    assert row["archetype"] is not None
    assert row["config_hash"]

    # F is absent, on purpose.
    assert row["forecast_low_usd"] is None
    assert row["confidence"] is None


# ── the snapshot and the displayed forecast must be the same number ───────────

def test_the_job_forecasts_on_measured_values_not_just_the_measured_tier(client, roles, monkeypatch):
    """Regression, found by reading a ledger row rather than by a failing test.

    The job passed `live_trace_count_7d` — which lifts the confidence TIER to
    high — but not `overrides=compute_live_rolling_averages(...)`, which supplies
    the measured values. So a snapshot claimed ±15% around a number still built
    from `default_calls_per_day: 100` × an archetype turns guess. On the demo
    agent that was $121/mo snapshotted against $7/mo displayed: 17×, both
    labelled "high".

    It matters beyond the ledger: `forecast_snapshots` is what `_prev_snapshot_point`
    reads for `vsLastMonth`, so the delta shown to any customer with live traffic
    was comparing a defaults-derived number against a measured one.
    """
    from jobs import snapshot_forecasts

    agent_id = _agent(client, roles["admin"]["headers"], "obs-overrides")

    seen: dict = {}
    real = snapshot_forecasts.forecast_spend

    def _spy(agent, **kwargs):
        if agent.get("id") == agent_id:
            seen["overrides"] = kwargs.get("overrides")
            seen["live_count"] = kwargs.get("live_trace_count_7d")
        return real(agent, **kwargs)

    monkeypatch.setattr(snapshot_forecasts, "forecast_spend", _spy)
    snapshot_forecasts.snapshot_all_agents()

    assert "live_count" in seen, "the job never forecast this agent"
    # With no captured traffic there is nothing to pass, and None is correct —
    # what must never recur is a live COUNT arriving without the live VALUES.
    assert seen["live_count"] == 0
    assert seen["overrides"] is None
