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

import json
from datetime import date, datetime
from pathlib import Path

import yaml

from analysis.spend_forecast import _call_cost_usd, _extract_usage, load_defaults

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
