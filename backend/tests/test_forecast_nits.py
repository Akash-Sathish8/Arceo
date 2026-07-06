"""Forecast accuracy nits (2026-07-06 cleanup): annual consistency + cache-write."""

from __future__ import annotations

from analysis.spend_forecast import _call_cost_usd, _extract_usage, forecast_spend, load_defaults


def test_annual_equals_displayed_monthly_times_12():
    f = forecast_spend(
        {"id": "x", "name": "X", "expected_calls_per_day": 137,
         "simulation_model": "claude-sonnet-4-6",
         "tools": [{"name": "stripe", "service": "stripe",
                    "actions": [{"action": "get_customer", "description": ""}]}]},
        overrides={"model": "claude-sonnet-4-6"}, _skip_sensitivity=True)
    assert f["annual"] == f["point"] * 12  # CFO multiplies the shown monthly and gets this


def test_cache_creation_billed_at_write_premium():
    d = load_defaults()
    mk = "claude-opus-4-8"
    premium = _call_cost_usd(1000, 0, 0, mk, d, cache_creation=1000)
    plain = _call_cost_usd(1000, 0, 0, mk, d, cache_creation=0)
    assert round(premium / plain, 3) == 1.25


def test_extract_usage_returns_cache_creation_separately():
    u = _extract_usage({"response": {"usage": {
        "input_tokens": 100, "cache_read_input_tokens": 50,
        "cache_creation_input_tokens": 200, "output_tokens": 30}}})
    assert u == (350, 50, 200, 30)  # (total_in, cache_read, cache_creation, out)
