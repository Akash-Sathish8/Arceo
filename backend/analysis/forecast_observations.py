"""Build and store rows for `forecast_observations` — the feature/outcome ledger.

One row pairs three things for a single agent over a single trailing window:

  X   the features knowable at cold start, with no traffic at all
  F   the forecast as it was actually made, so error needs no re-run
  Y   the parameters the agent really exhibited over that window

That pairing is what a learned cold-start prior needs and what nothing currently
stores: `forecast_snapshots` keeps point/low/high and throws away every input.

The learning target is the PARAMETER vector, not the dollar figure. Token and
call counts are provider-reported (they arrive in the response `usage` block),
so they are independent evidence even inside our own capture — only the pricing
is ours. Parameter priors also survive a repricing, which dollar priors do not.

Nothing here holds prompt or response content: counts and aggregates only.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any, Optional

FEATURE_VERSION = 1

# Sources a row's Y can come from, in descending independence.
OUTCOME_ARCEO_CAPTURE = "arceo_capture"      # our own captured calls; tokens are provider-reported
OUTCOME_PROVIDER_INVOICE = "provider_invoice"  # the bill; org-level dollars only
OUTCOME_SANDBOX = "sandbox"                  # our own simulation; the only source of turns/run
OUTCOME_HAND_TRUTH = "hand_truth"            # test-agents/synthetic hand-computed truth


def _n_actions(agent_config: dict) -> int:
    return sum(len(t.get("actions") or []) for t in agent_config.get("tools") or [])


def _tool_services(agent_config: dict) -> list[str]:
    out = []
    for t in agent_config.get("tools") or []:
        name = t.get("service") or t.get("name")
        if name and name not in out:
            out.append(name)
    return sorted(out)


def _risk_label_counts(agent_config: dict) -> dict[str, int]:
    counts: dict[str, int] = {}
    for t in agent_config.get("tools") or []:
        for a in t.get("actions") or []:
            for label in a.get("risk_labels") or []:
                counts[label] = counts.get(label, 0) + 1
    return dict(sorted(counts.items()))


def config_hash(agent_config: dict) -> str:
    """Stable digest of the cold-start feature vector.

    An agent that gains a tool mid-window makes that row's X and Y describe two
    different agents. Comparing hashes across rows is how the eval drops those
    rows instead of silently training on them.
    """
    material = {
        "model": agent_config.get("simulation_model"),
        "tools": _tool_services(agent_config),
        "n_actions": _n_actions(agent_config),
        "labels": _risk_label_counts(agent_config),
        "expected_calls_per_day": agent_config.get("expected_calls_per_day"),
        "expected_turns_per_run": agent_config.get("expected_turns_per_run"),
        "avg_context_tokens": agent_config.get("avg_context_tokens"),
    }
    blob = json.dumps(material, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def refine_input_sources(
    input_sources: Optional[dict],
    live_avgs: Optional[dict],
    sandbox_avgs: Optional[dict],
) -> dict:
    """Split the API's flat "measured" into measured_live / measured_sandbox.

    `forecast_spend` emits one `"measured"` for both, which is fine for a chip in
    the UI and useless here: whose measurement it is decides whether a row can
    train a prior at all. Sandbox numbers are ours; live numbers are the
    customer's. Deliberately NOT fixed in `forecast_spend` itself — the four-value
    vocabulary is a shipped API contract that mockSpend.ts, CostPortfolio.tsx and
    cfoReport.ts all read.
    """
    live_avgs = live_avgs or {}
    sandbox_avgs = sandbox_avgs or {}
    # Which measurement could have supplied each input, live winning where both
    # could (it is what the forecast's own precedence does).
    supplier = {
        "runsPerDay": "live" if live_avgs.get("llm_calls_per_day") is not None else None,
        "turnsPerRun": "live" if live_avgs.get("llm_calls_per_day") is not None
        else ("sandbox" if sandbox_avgs.get("turns_per_run") is not None else None),
        "tokensPerCall": "live" if live_avgs.get("input_tokens") is not None
        else ("sandbox" if sandbox_avgs.get("input_tokens") is not None else None),
        # Sandbox runs every scenario cold, so its cache rate is structurally 0%
        # and is never treated as a measurement — cache can only be live-measured.
        "cacheHit": "live" if live_avgs.get("cache_hit") is not None else None,
        "model": None,
        "toolMix": "sandbox",
    }
    refined = {}
    for key, value in (input_sources or {}).items():
        if value == "measured":
            who = supplier.get(key)
            refined[key] = f"measured_{who}" if who else "measured"
        else:
            refined[key] = value
    return refined


def build_observation(
    agent_config: dict,
    forecast: dict,
    *,
    observed_on: str,
    captured_at: str,
    window_days: int = 7,
    outcome_source: str = OUTCOME_ARCEO_CAPTURE,
    live_avgs: Optional[dict] = None,
    sandbox_avgs: Optional[dict] = None,
) -> dict:
    """Assemble one ledger row. Pure — takes values, returns a dict of columns."""
    from analysis.spend_forecast import FORECAST_FORMULA_VERSION, _infer_archetype

    live_avgs = live_avgs or {}
    sandbox_avgs = sandbox_avgs or {}
    coverage = forecast.get("coverage") or {}

    # Y — the realized parameters. Every value stays None when nothing measured
    # it; a missing measurement must never arrive as a zero.
    calls_per_day = live_avgs.get("llm_calls_per_day")
    cost_per_call = live_avgs.get("llm_cost_per_call")
    # Measured LLM token spend only, extrapolated to 30 days — the same basis
    # the actuals chart and budget alerts use, and labelled as such everywhere.
    # Tool and infra dollars are estimated, never measured, so they stay out.
    realized_monthly = (
        float(cost_per_call) * float(calls_per_day) * 30.0
        if cost_per_call is not None and calls_per_day is not None
        else None
    )

    return {
        "id": str(uuid.uuid4()),
        "org_id": agent_config.get("org_id") or "default",
        "agent_id": agent_config.get("id"),
        "observed_on": observed_on,
        "window_days": window_days,
        "outcome_source": outcome_source,

        # ── X ──
        "archetype": _infer_archetype(agent_config),
        "declared_model": agent_config.get("simulation_model"),
        "model_match": coverage.get("modelMatch"),
        "model_recognized": coverage.get("modelRecognized"),
        "n_tools": len(agent_config.get("tools") or []),
        "n_actions": _n_actions(agent_config),
        "tools_priced": coverage.get("toolsPriced"),
        "tools_total": coverage.get("toolsTotal"),
        "expected_calls_per_day": agent_config.get("expected_calls_per_day"),
        "expected_turns_per_run": agent_config.get("expected_turns_per_run"),
        "avg_context_tokens": agent_config.get("avg_context_tokens"),
        "environment": agent_config.get("environment"),
        "trigger_source": agent_config.get("trigger_source"),
        "human_in_loop": bool(agent_config.get("human_in_loop")) if agent_config.get("human_in_loop") is not None else None,
        "tool_services_json": json.dumps(_tool_services(agent_config)),
        "risk_label_counts_json": json.dumps(_risk_label_counts(agent_config)),
        "config_hash": config_hash(agent_config),
        "feature_version": FEATURE_VERSION,

        # ── F ──
        "forecast_point_usd": forecast.get("point"),
        "forecast_low_usd": forecast.get("low"),
        "forecast_high_usd": forecast.get("high"),
        # The LLM-only slice, which is the only part `realized_monthly_usd` below
        # can be graded against — it measures tokens and nothing else.
        "forecast_tokens_usd": forecast.get("tokensUsdExact"),
        "forecast_tokens_low_usd": forecast.get("tokensLowUsd"),
        "forecast_tokens_high_usd": forecast.get("tokensHighUsd"),
        "confidence": forecast.get("confidence"),
        "confidence_cap": forecast.get("confidenceCap"),
        "forecast_inputs_json": json.dumps({
            "runsPerDay": forecast.get("runsPerDay"),
            "turnsPerRun": forecast.get("turnsPerRun"),
            "callsPerDay": forecast.get("callsPerDay"),
            "tokensPerCall": forecast.get("tokensPerCall"),
            "cacheHit": forecast.get("cacheHit"),
            "retryRate": forecast.get("retryRate"),
            "runtime": forecast.get("runtime"),
            "model": forecast.get("model"),
        }),
        "input_sources_json": json.dumps(
            refine_input_sources(forecast.get("inputSources"), live_avgs, sandbox_avgs)
        ),
        "formula_version": FORECAST_FORMULA_VERSION,

        # ── Y ──
        "realized_calls_per_day": calls_per_day,
        "realized_turns_per_run": sandbox_avgs.get("turns_per_run"),
        "realized_input_tokens": live_avgs.get("input_tokens", sandbox_avgs.get("input_tokens")),
        "realized_output_tokens": live_avgs.get("output_tokens", sandbox_avgs.get("output_tokens")),
        "realized_cache_hit_pct": live_avgs.get("cache_hit"),
        "realized_cost_per_call_usd": cost_per_call,
        "realized_monthly_usd": realized_monthly,
        "observed_calls": live_avgs.get("observed_calls"),
        "observed_days": live_avgs.get("observed_days"),
        "active_days": live_avgs.get("active_days"),
        "model_mix_json": json.dumps(live_avgs.get("by_model") or []),
        "tool_mix_json": json.dumps(forecast.get("topTools") or []),
        "captured_at": captured_at,
    }


_COLUMNS = (
    "id", "org_id", "agent_id", "observed_on", "window_days", "outcome_source",
    "archetype", "declared_model", "model_match", "model_recognized",
    "n_tools", "n_actions", "tools_priced", "tools_total",
    "expected_calls_per_day", "expected_turns_per_run", "avg_context_tokens",
    "environment", "trigger_source", "human_in_loop",
    "tool_services_json", "risk_label_counts_json", "config_hash", "feature_version",
    "forecast_point_usd", "forecast_low_usd", "forecast_high_usd",
    "forecast_tokens_usd", "forecast_tokens_low_usd", "forecast_tokens_high_usd",
    "confidence", "confidence_cap", "forecast_inputs_json", "input_sources_json",
    "formula_version",
    "realized_calls_per_day", "realized_turns_per_run",
    "realized_input_tokens", "realized_output_tokens", "realized_cache_hit_pct",
    "realized_cost_per_call_usd", "realized_monthly_usd",
    "observed_calls", "observed_days", "active_days",
    "model_mix_json", "tool_mix_json", "captured_at",
)


def observation_exists(conn, agent_id: str, org_id: str, observed_on: str,
                       outcome_source: str = OUTCOME_ARCEO_CAPTURE) -> bool:
    """Idempotency guard, matching `forecast_snapshots` — the table carries no
    unique constraint, because `agent_id` is NULL on org-level invoice rows and
    Postgres counts NULLs as distinct, so a constraint would fail to dedupe
    exactly the rows most at risk."""
    row = conn.execute(
        "SELECT 1 AS hit FROM forecast_observations "
        "WHERE agent_id = %s AND org_id = %s AND observed_on = %s AND outcome_source = %s LIMIT 1",
        (agent_id, org_id, observed_on, outcome_source),
    ).fetchone()
    return row is not None


def insert_observation(conn, row: dict[str, Any]) -> None:
    placeholders = ", ".join(["%s"] * len(_COLUMNS))
    conn.execute(
        f"INSERT INTO forecast_observations ({', '.join(_COLUMNS)}) VALUES ({placeholders})",
        tuple(row.get(c) for c in _COLUMNS),
    )
