"""Phase-1 A1: the unrecognized-model cap lives inside _detect_tier.

An unpriced model means the dominant cost driver is a guess — no volume of
trace data may upgrade confidence past LOW. Previously the cap was a post-hoc
check in forecast_spend, so any other caller of _detect_tier could claim high
confidence on a guessed price.
"""

from __future__ import annotations

from analysis.spend_forecast import LIVE_TRACE_MIN_CALLS, _detect_tier

HEAVY_TRAFFIC = LIVE_TRACE_MIN_CALLS * 10


def test_unrecognized_model_caps_at_low_despite_heavy_live_traffic():
    assert _detect_tier([{"t": 1}], HEAVY_TRAFFIC, model_recognized=False) == "low"


def test_unrecognized_model_caps_at_low_despite_sandbox_traces():
    assert _detect_tier([{"t": 1}, {"t": 2}], 0, model_recognized=False) == "low"


def test_recognized_model_tiers_unchanged():
    assert _detect_tier(None, HEAVY_TRAFFIC, model_recognized=True) == "high"
    assert _detect_tier([{"t": 1}], 0, model_recognized=True) == "medium"
    assert _detect_tier(None, 0, model_recognized=True) == "low"


def test_default_keeps_legacy_signature_working():
    # Callers that don't pass model_recognized get the old behavior.
    assert _detect_tier(None, HEAVY_TRAFFIC) == "high"
