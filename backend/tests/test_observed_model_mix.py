"""An agent declares ONE model; a real one may route across several.

`agents.simulation_model` is a single column (0001_baseline.py:79) and
forecast_spend resolves one `declared_model`. That is fine as a pre-deployment
assumption, but the product also reported spend BY MODEL — on the Spend
Dashboard and in the fleet CFO PDF — by attributing an agent's whole LLM spend
to that one declared model. For an agent running Haiku for extraction and Opus
for reasoning, that overstated one model and hid the other entirely.

The per-call model was already resolved to price each captured call, then
discarded. These tests pin that it is now kept and reported as a mix, and that
the mix is a share of COST rather than of calls, because the consumer splits a
dollar figure by it.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

from analysis.spend_forecast import (
    LIVE_TRACE_MIN_CALLS_FORECAST,
    compute_live_rolling_averages,
    forecast_spend,
)

AGENT = {"id": "x", "name": "X", "expected_calls_per_day": 100,
         "simulation_model": "claude-sonnet-4-6", "tools": []}


def _row(model: str, ts: datetime, tin: int = 1_000_000, tout: int = 0) -> dict:
    return {"timestamp": ts.isoformat(), "detail": json.dumps({
        "model": model,
        "response": {"usage": {"input_tokens": tin, "output_tokens": tout,
                               "cache_read_input_tokens": 0,
                               "cache_creation_input_tokens": 0}}})}


def _mixed_rows(n_haiku: int = 8, n_opus: int = 2) -> list[dict]:
    """Haiku dominates by CALL COUNT, Opus by COST — the two orderings disagree
    on purpose, so a test can tell which basis the share actually uses."""
    base = datetime(2026, 8, 1, 9, 0, 0)
    rows = [_row("claude-haiku-4-5", base + timedelta(days=i % 4, minutes=i))
            for i in range(n_haiku)]
    rows += [_row("claude-opus-4-7", base + timedelta(days=i % 4, minutes=30 + i))
             for i in range(n_opus)]
    return rows


def test_mix_is_reported_and_shares_sum_to_one():
    mix = compute_live_rolling_averages(_mixed_rows())["by_model"]
    assert {m["model"] for m in mix} == {"claude-haiku-4-5", "claude-opus-4-7"}
    assert round(sum(m["costShare"] for m in mix), 4) == 1.0


def test_share_is_of_cost_not_of_calls():
    """Haiku has 4x the calls; Opus is ~5x the rate, so Opus must lead. If this
    ever flips, someone changed the basis to call count and every dollar split
    downstream is wrong."""
    mix = compute_live_rolling_averages(_mixed_rows())["by_model"]
    assert mix[0]["model"] == "claude-opus-4-7"
    assert mix[0]["calls"] == 2
    assert mix[1]["model"] == "claude-haiku-4-5"
    assert mix[1]["calls"] == 8
    assert mix[0]["costShare"] > mix[1]["costShare"]


def test_single_model_agent_reports_exactly_one_entry():
    base = datetime(2026, 8, 1, 9, 0, 0)
    rows = [_row("claude-haiku-4-5", base + timedelta(days=i % 4, minutes=i))
            for i in range(6)]
    mix = compute_live_rolling_averages(rows)["by_model"]
    assert mix == [{"model": "claude-haiku-4-5", "calls": 6, "costShare": 1.0}]


def test_forecast_exposes_the_mix_on_coverage():
    overrides = compute_live_rolling_averages(_mixed_rows())
    f = forecast_spend(AGENT, live_trace_count_7d=LIVE_TRACE_MIN_CALLS_FORECAST,
                       overrides=overrides, _skip_sensitivity=True)
    observed = f["coverage"]["observedModels"]
    assert [m["model"] for m in observed] == ["claude-opus-4-7", "claude-haiku-4-5"]
    # The declared model is NOT one of the models it actually ran — exactly the
    # case the dashboard used to misreport as 100% claude-sonnet-4-6.
    assert f["coverage"]["declaredModel"] == "claude-sonnet-4-6"
    assert "claude-sonnet-4-6" not in {m["model"] for m in observed}


def test_no_captured_traffic_reports_an_empty_mix_not_the_declared_model():
    """Empty means "not measured". Defaulting to [{declared, 1.0}] would state
    an assumption as a measurement, which is the bug this exists to prevent."""
    f = forecast_spend(AGENT, _skip_sensitivity=True)
    assert f["coverage"]["observedModels"] == []


def test_forecast_prices_the_mix_so_the_ui_claim_holds():
    """The card says the forecast is priced across the mix rather than the single
    declared model. That is only true because the blended per-call cost wins over
    single-model pricing — pin it, because the UI copy asserts it."""
    cheap = compute_live_rolling_averages(_mixed_rows(n_haiku=10, n_opus=0))
    dear = compute_live_rolling_averages(_mixed_rows(n_haiku=0, n_opus=10))
    f_cheap = forecast_spend(AGENT, live_trace_count_7d=LIVE_TRACE_MIN_CALLS_FORECAST,
                             overrides=cheap, _skip_sensitivity=True)
    f_dear = forecast_spend(AGENT, live_trace_count_7d=LIVE_TRACE_MIN_CALLS_FORECAST,
                            overrides=dear, _skip_sensitivity=True)
    # Same declared model, same volume, different observed mix -> different cost.
    assert f_dear["tokensUsd"] > f_cheap["tokensUsd"]
