"""Tier 1 accuracy fixes (2026-07-12): model-pricing match honesty + burst guard.

Pins three behaviors:
1. The current Claude models are priced rows (before this, claude-fable-5
   silently family-matched to claude-opus-4-8 and billed at HALF its real rate
   while still counting as "recognized").
2. A family-level price GUESS is disclosed (coverage.modelMatch) and never
   carries better than the LOW band — but still PRICES at the guessed row,
   which is closer to reality than the catalog default.
3. HIGH confidence requires traffic on >=3 distinct days, not just >=50 calls:
   a single-day burst demotes to MEDIUM with a disclosed confidenceCap.
"""

from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta

from analysis.spend_forecast import (
    LIVE_TRACE_MIN_CALLS,
    LIVE_TRACE_MIN_CALLS_FORECAST,
    LIVE_TRACE_MIN_ACTIVE_DAYS,
    _call_cost_usd,
    _detect_tier,
    _model_recognized,
    _resolve_model_pricing,
    compute_live_rolling_averages,
    forecast_spend,
    load_defaults,
)

HEAVY_TRAFFIC = LIVE_TRACE_MIN_CALLS * 10


# ── 1. Current Claude models are priced rows (verified 2026-07-12) ────────────

def test_current_claude_models_price_exactly():
    d = load_defaults()
    for model, in_rate, out_rate in [
        ("claude-fable-5", 10.00, 50.00),
        ("claude-sonnet-5", 3.00, 15.00),
        ("claude-opus-4-7", 5.00, 25.00),
        ("claude-opus-4-6", 5.00, 25.00),
        ("claude-sonnet-4-5", 3.00, 15.00),
    ]:
        key, kind = _resolve_model_pricing(model, d)
        assert (key, kind) == (model, "exact"), model
        row = d["models"][key]
        assert (row["input_per_mtok"], row["output_per_mtok"]) == (in_rate, out_rate), model


def test_fable_5_no_longer_bills_at_half_price():
    # The bug this catches: fable-5 ($10/$50) used to family-match opus-4-8
    # ($5/$25). 1M input tokens must now cost $10, not $5.
    d = load_defaults()
    assert _call_cost_usd(1_000_000, 0, 0, "claude-fable-5", d) == 10.00
    assert _call_cost_usd(0, 0, 1_000_000, "claude-fable-5", d) == 50.00


# ── 2. Match-kind honesty ─────────────────────────────────────────────────────

def test_dated_snapshot_is_prefix_match_and_recognized():
    d = load_defaults()
    key, kind = _resolve_model_pricing("claude-sonnet-4-5-20250929", d)
    assert (key, kind) == ("claude-sonnet-4-5", "prefix")
    assert _model_recognized("claude-sonnet-4-5-20250929", d) is True


def test_family_guess_is_not_recognized_but_still_prices_at_guess():
    d = load_defaults()
    key, kind = _resolve_model_pricing("claude-zephyr-7", d)  # unpriced claude-*
    assert kind == "family"
    assert key.startswith("claude-")  # priced at a related row, not the default
    assert _model_recognized("claude-zephyr-7", d) is False


def test_no_overlap_falls_to_default_and_not_recognized():
    d = load_defaults()
    key, kind = _resolve_model_pricing("zz-unknown-model-9000", d)
    assert kind == "default"
    assert key == d["default_model"]
    assert _model_recognized("zz-unknown-model-9000", d) is False


def test_family_guess_caps_tier_low_but_prices_the_guess_in_forecast():
    f = forecast_spend(
        {"id": "x", "name": "X", "expected_calls_per_day": 100,
         "simulation_model": "claude-zephyr-7", "tools": []},
        live_trace_count_7d=HEAVY_TRAFFIC,
        _skip_sensitivity=True,
    )
    assert f["confidence"] == "low"  # guessed price never carries a tight band
    assert f["coverage"]["modelRecognized"] is False
    assert f["coverage"]["modelMatch"] == "family"
    # ...but the number is computed at the guessed family row, not the default.
    assert f["coverage"]["pricedModel"].startswith("claude-")
    assert f["model"] == f["coverage"]["pricedModel"]


# ── 3. Burst guard ────────────────────────────────────────────────────────────

def test_single_day_burst_demotes_high_to_medium():
    assert _detect_tier(None, HEAVY_TRAFFIC, model_recognized=True,
                        live_active_days=1) == "medium"
    assert _detect_tier(None, HEAVY_TRAFFIC, model_recognized=True,
                        live_active_days=LIVE_TRACE_MIN_ACTIVE_DAYS) == "high"
    # Unknown day-spread (direct/legacy callers) keeps the old behavior.
    assert _detect_tier(None, HEAVY_TRAFFIC, model_recognized=True) == "high"


def test_forecast_discloses_burst_cap():
    agent = {"id": "x", "name": "X", "expected_calls_per_day": 100,
             "simulation_model": "claude-sonnet-4-6", "tools": []}
    burst = forecast_spend(agent, live_trace_count_7d=HEAVY_TRAFFIC,
                           overrides={"llm_calls_per_day": 60, "active_days": 1},
                           _skip_sensitivity=True)
    assert burst["confidence"] == "medium"
    assert burst["confidenceCap"] == "single_day_burst"

    steady = forecast_spend(agent, live_trace_count_7d=HEAVY_TRAFFIC,
                            overrides={"llm_calls_per_day": 60, "active_days": 5},
                            _skip_sensitivity=True)
    assert steady["confidence"] == "high"
    assert steady["confidenceCap"] is None


def test_rolling_averages_count_distinct_active_days():
    def row(ts: datetime) -> dict:
        return {
            "timestamp": ts.isoformat(),
            "detail": json.dumps({
                "model": "claude-sonnet-4-6",
                "response": {"usage": {"input_tokens": 1000, "output_tokens": 100,
                                       "cache_read_input_tokens": 0,
                                       "cache_creation_input_tokens": 0}},
            }),
        }

    base = datetime(2026, 7, 10, 12, 0, 0)
    # A burst: 6 calls within 20 minutes → 1 active day.
    burst_rows = [row(base + timedelta(minutes=3 * i)) for i in range(6)]
    assert compute_live_rolling_averages(burst_rows)["active_days"] == 1
    # Same call count spread over 3 calendar days → 3 active days.
    spread_rows = [row(base + timedelta(days=i % 3, minutes=i)) for i in range(6)]
    assert compute_live_rolling_averages(spread_rows)["active_days"] == 3


# ── 4. An org's negotiated rate survives the live tier (2026-08-09) ───────────
#
# The bug: compute_live_rolling_averages called load_defaults() with no org, so
# it priced every captured call at published list rates. That average is emitted
# as llm_cost_per_call, which short-circuits the org-merged model pricing in
# forecast_spend — so a customer's negotiated rate silently stopped applying the
# moment an agent crossed LIVE_TRACE_MIN_CALLS_FORECAST (5) captured calls, while
# the confidence badge still read LOW or MEDIUM. Both gates are pinned below
# because the silent half of the bug lives between 5 and 49 calls.

_NEGOTIATED_IN_RATE = 1.50   # half of claude-sonnet-4-6's $3.00 list input rate


def _org_catalog_at_half_rate() -> dict:
    """What load_defaults(org_id) returns for an org that negotiated 50% off —
    a deep copy of the catalog with the model row patched. Built here rather
    than read through load_defaults(org_id) so the test needs no DB."""
    merged = copy.deepcopy(load_defaults())
    merged["models"]["claude-sonnet-4-6"]["input_per_mtok"] = _NEGOTIATED_IN_RATE
    return merged


def _million_token_rows(n: int) -> list[dict]:
    """n captured calls, each exactly 1M uncached input tokens and no output —
    so the expected per-call cost is the input rate, in dollars, exactly."""
    base = datetime(2026, 8, 1, 9, 0, 0)
    return [{
        "timestamp": (base + timedelta(days=i % 5, minutes=i)).isoformat(),
        "detail": json.dumps({
            "model": "claude-sonnet-4-6",
            "response": {"usage": {"input_tokens": 1_000_000, "output_tokens": 0,
                                   "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0}},
        }),
    } for i in range(n)]


def test_live_averages_price_at_the_catalog_they_are_handed():
    rows = _million_token_rows(10)
    # No catalog → list price. This is the pre-fix behavior, kept as the contrast.
    assert compute_live_rolling_averages(rows)["llm_cost_per_call"] == 3.00
    # Org catalog → the org's negotiated rate.
    org = compute_live_rolling_averages(rows, defaults=_org_catalog_at_half_rate())
    assert org["llm_cost_per_call"] == _NEGOTIATED_IN_RATE


def test_negotiated_rate_reaches_the_forecast_at_both_live_gates():
    agent = {"id": "x", "name": "X", "expected_calls_per_day": 100,
             "simulation_model": "claude-sonnet-4-6", "tools": []}
    org_catalog = _org_catalog_at_half_rate()

    # 5 = the silent gate (badge still reads LOW/MEDIUM); 50 = HIGH.
    for n_calls in (LIVE_TRACE_MIN_CALLS_FORECAST, LIVE_TRACE_MIN_CALLS):
        rows = _million_token_rows(n_calls)
        overrides = compute_live_rolling_averages(rows, defaults=org_catalog)
        assert overrides["llm_cost_per_call"] == _NEGOTIATED_IN_RATE, n_calls

        f = forecast_spend(agent, live_trace_count_7d=n_calls,
                           overrides=overrides, _skip_sensitivity=True)
        # monthly_llm = per-call $ x calls/day x 30. Assert the ratio rather than
        # an absolute so this doesn't re-pin the days-per-month convention.
        list_overrides = compute_live_rolling_averages(rows)
        f_list = forecast_spend(agent, live_trace_count_7d=n_calls,
                                overrides=list_overrides, _skip_sensitivity=True)
        assert f["tokensUsd"] == round(f_list["tokensUsd"] / 2), n_calls
        assert f["point"] < f_list["point"], n_calls
