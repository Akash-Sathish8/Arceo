"""Tier 2 price hygiene (2026-07-12): fallback sync, row metadata, and
non-Anthropic usage shapes.

Three regression classes this pins:
1. The no-pyyaml fallback JSON is GENERATED from the YAML — this suite fails
   the moment the YAML changes without `scripts/gen_cost_defaults_fallback.py`
   being rerun (the old hand-maintained dict had drifted to 11 of ~35 models
   with stale rates).
2. Every model row carries auditable freshness metadata (verified_on +
   source_url) so `scripts/check_price_freshness.py` can warn in CI.
3. `_extract_usage` handles OpenAI and Gemini shapes — until now only the
   Anthropic branch was pinned, so a regression in the other branches would
   have shipped silently.
"""

from __future__ import annotations

import copy
import json
from datetime import date, datetime
from pathlib import Path

import yaml

from analysis.spend_forecast import (
    _call_cost_usd,
    _extract_usage,
    catalog_calibration_date,
    load_defaults,
)

_ANALYSIS = Path(__file__).resolve().parent.parent / "analysis"
_YAML = _ANALYSIS / "cost_defaults_operational.yaml"
_FALLBACK = _ANALYSIS / "cost_defaults_operational.fallback.json"


# ── 1. Generated fallback stays in sync ───────────────────────────────────────

def test_fallback_json_matches_yaml_exactly():
    # If this fails: python3 scripts/gen_cost_defaults_fallback.py
    assert json.loads(_FALLBACK.read_text()) == yaml.safe_load(_YAML.read_text())


# ── 2. Every model row is auditable ──────────────────────────────────────────

def test_every_model_row_has_freshness_metadata():
    models = yaml.safe_load(_YAML.read_text())["models"]
    for key, row in models.items():
        assert row.get("source_url", "").startswith("https://"), f"{key}: missing source_url"
        checked = datetime.strptime(str(row.get("verified_on")), "%Y-%m-%d").date()
        assert checked <= date.today(), f"{key}: verified_on is in the future"


def test_extra_metadata_does_not_break_pricing():
    # source_url / verified_on ride inside the same row dicts _call_cost_usd
    # reads — make sure pricing only looks at the rate fields.
    d = load_defaults()
    assert _call_cost_usd(1_000_000, 0, 0, "claude-opus-4-8", d) == 5.00


# ── 2b. The date we SHOW is the oldest thing behind the number ───────────────
# `last_calibrated` is hand-set when the YAML body is recalibrated, so it tracks
# the NEWEST work on the file. Published alone it let one freshly-verified row
# drag the customer-visible date forward while most of the catalog stayed old —
# the CFO PDF printed "Price catalog last calibrated 2026-08-09" while 45 of 59
# rows were still at verified_on 2026-07-12. False for 76% of the rows it priced.

def test_published_date_is_never_newer_than_the_oldest_priced_row():
    """The invariant: whatever we show, EVERY row has been verified since it."""
    d = load_defaults()
    shown = date.fromisoformat(catalog_calibration_date(d))
    for key, row in d["models"].items():
        checked = date.fromisoformat(str(row["verified_on"]))
        assert shown <= checked, f"{key} verified {checked}, but we advertise {shown}"


def test_published_date_does_not_just_echo_last_calibrated():
    # Guards the actual regression: returning defaults["last_calibrated"] passes
    # nothing above if the catalog happens to be uniform, so pin the real case.
    d = load_defaults()
    oldest = min(str(r["verified_on"]) for r in d["models"].values())
    assert catalog_calibration_date(d) == min(str(d["last_calibrated"]), oldest)


def test_a_fresh_row_cannot_drag_the_date_forward():
    d = copy.deepcopy(load_defaults())
    d["last_calibrated"] = "2026-12-01"
    next(iter(d["models"].values()))["verified_on"] = "2026-12-01"
    # One row re-verified today says nothing about the other 58.
    assert catalog_calibration_date(d) == "2026-07-12"


def test_a_row_with_no_verified_on_is_skipped_not_read_as_fresh():
    # test_every_model_row_has_freshness_metadata already fails the build for
    # this; the point here is that it degrades safely rather than silently
    # publishing today's date for an unaudited row.
    d = copy.deepcopy(load_defaults())
    d["models"]["claude-opus-4-8"].pop("verified_on")
    assert catalog_calibration_date(d) == "2026-07-12"


# ── 3. Non-Anthropic usage shapes ─────────────────────────────────────────────
# Tuple shape: (total_input, cache_read, cache_creation, output)

def test_openai_shape_prompt_tokens_include_cached():
    u = _extract_usage({"response": {"usage": {
        "prompt_tokens": 400, "completion_tokens": 50,
        "prompt_tokens_details": {"cached_tokens": 100}}}})
    assert u == (400, 100, 0, 50)  # total stays 400; no cache-write concept


def test_openai_shape_without_details_has_zero_cached():
    u = _extract_usage({"response": {"usage": {
        "prompt_tokens": 400, "completion_tokens": 50}}})
    assert u == (400, 0, 0, 50)


def test_gemini_shape_under_usage_metadata():
    # Gemini's native payload has usageMetadata, not usage.
    u = _extract_usage({"response": {"usageMetadata": {
        "promptTokenCount": 500, "candidatesTokenCount": 80,
        "cachedContentTokenCount": 200}}})
    assert u == (500, 200, 0, 80)


def test_cached_tokens_clamped_to_total_input():
    # A malformed payload can't produce negative non-cached input.
    u = _extract_usage({"response": {"usage": {
        "prompt_tokens": 100, "completion_tokens": 10,
        "prompt_tokens_details": {"cached_tokens": 999}}}})
    assert u == (100, 100, 0, 10)


def test_no_usage_block_returns_none():
    assert _extract_usage({"response": {"id": "x"}}) is None
    assert _extract_usage({"response": {"usage": {"weird": 1}}}) is None


def test_openai_cache_discount_applied_in_cost():
    # gpt-4o cache_discount is 0.50: cached input bills at HALF the input rate,
    # not Anthropic's 10%. 1M input fully cached vs fully uncached.
    d = load_defaults()
    uncached = _call_cost_usd(1_000_000, 0, 0, "gpt-4o", d)
    fully_cached = _call_cost_usd(1_000_000, 1_000_000, 0, "gpt-4o", d)
    assert round(fully_cached / uncached, 2) == round(
        1.0 - d["models"]["gpt-4o"]["cache_discount"], 2)


def test_gemini_cost_uses_declared_discount():
    d = load_defaults()
    row = d["models"]["gemini-2-5-pro"]
    uncached = _call_cost_usd(1_000_000, 0, 0, "gemini-2-5-pro", d)
    fully_cached = _call_cost_usd(1_000_000, 1_000_000, 0, "gemini-2-5-pro", d)
    assert round(fully_cached / uncached, 2) == round(1.0 - row["cache_discount"], 2)
