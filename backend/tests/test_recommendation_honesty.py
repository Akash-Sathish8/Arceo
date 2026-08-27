"""Tier 1.5 (items 2-3, partial): the recommendation surface stops lying.

Three defects, all on screens a CFO reads:

1. RETIRED MODELS WERE RECOMMENDED. Nine of the 59 catalog rows are retired or
   deprecated, and before `status: retired` that was recorded only in prose
   comments, so nothing could read it. `gemini-1-5-flash` -- retired by Google,
   unlisted on their pricing page -- is the SECOND CHEAPEST row in the file, and
   budget-fit Lever 1 picks the cheapest model when nothing fits the budget.

2. MODEL CHOICE WAS MEASURED IN THE WRONG UNIT. Every other sensitivity row is
   one input moved +/-20%; model choice was the spread across the whole catalog,
   which measured 1514-2170% on the reference agents. Because the list is sorted
   descending it won every time, became `sensitivity[0]`, and the UI multiplies
   `sensitivity[0].pct` by the forecast to caption the panel -- telling the owner
   of a $714/mo agent that a swing moves cost by ~$15,494/mo.

3. A PROVIDER SWITCH WAS SILENT. The cheapest model is routinely another vendor.
   There is no residency policy in the product to enforce against, so this
   discloses rather than blocks.
"""

from __future__ import annotations

import json
import glob

import pytest

from analysis.spend_forecast import (
    compute_budget_fit,
    forecast_spend,
    is_recommendable,
    load_defaults,
    model_provider,
    _call_cost_usd,
)

RETIRED_CHEAP = "gemini-1-5-flash"   # 2nd cheapest row in the catalog
MTOK = 1_000_000


def _cfg_and_overrides(path: str):
    spec = json.load(open(path))
    b = spec["behavior"]
    cfg = {"agent_id": spec["id"], "name": spec["id"],
           "simulation_model": spec.get("simulation_model"),
           "expected_calls_per_day": b.get("calls_per_day"), "tools": [], "actions": []}
    ov = {"calls_per_day": b.get("calls_per_day"),
          "input_tokens": b.get("input_tokens_per_call"),
          "output_tokens": b.get("output_tokens_per_call"),
          "cache_hit": b.get("cache_hit_pct")}
    return spec["id"], cfg, ov


AGENTS = [_cfg_and_overrides(f) for f in sorted(glob.glob("../test-agents/synthetic/*.json"))]
assert AGENTS, "synthetic fixtures missing"


# ── 1. Retired rows are priced but never recommended ─────────────────────────

def test_the_catalog_actually_marks_its_retired_rows():
    models = load_defaults()["models"]
    retired = [k for k, v in models.items() if v.get("status") == "retired"]
    assert len(retired) == 9, retired
    assert RETIRED_CHEAP in retired


def test_a_retired_row_still_prices_historical_calls():
    """The whole point of keeping them: captured calls that used them must still
    reprice. `status` must not leak into the pricing path."""
    d = load_defaults()
    assert _call_cost_usd(MTOK, 0, 0, RETIRED_CHEAP, d) > 0
    assert is_recommendable(d["models"][RETIRED_CHEAP]) is False
    assert is_recommendable(d["models"]["claude-sonnet-4-6"]) is True


def test_the_retired_row_really_is_cheap_enough_to_have_been_picked():
    """Guards the premise, not just the fix. If this row stops being one of the
    cheapest, this suite quietly stops testing anything."""
    d = load_defaults()["models"]
    cost = lambda k: d[k]["input_per_mtok"] + d[k]["output_per_mtok"]
    rank = sorted(d, key=cost).index(RETIRED_CHEAP)
    assert rank <= 3, f"{RETIRED_CHEAP} is now rank {rank} by price"


@pytest.mark.parametrize("agent_id,cfg,ov", AGENTS)
def test_budget_fit_never_recommends_a_retired_model(agent_id, cfg, ov):
    # Budget of $1 guarantees nothing fits, forcing the "cheapest model" branch
    # -- the exact path that reached the retired row.
    fit = compute_budget_fit(cfg, budget=1, base_overrides=ov)
    models = load_defaults()["models"]
    for rec in fit.get("recommendations", []):
        if rec.get("lever") != "model":
            continue
        picked = rec["label"].split("Switch the model to ", 1)[-1].split(" (")[0]
        assert models.get(picked, {}).get("status") != "retired", \
            f"{agent_id}: recommended retired model {picked}"


# These two token mixes are the ones that actually reached a retired model on the
# pre-fix engine, found by sweeping input/output/budget rather than assumed. The
# eight synthetic fixtures do NOT reach it -- they are input-heavy, so gpt-5-nano
# or llama-3-1-8b wins there. Without these cases the parametrized test above is
# an invariant that holds vacuously, which is worth no more than no test at all.
@pytest.mark.parametrize("tin,tout,budget,expect_retired", [
    # "cheapest model" branch: nothing fits a $1 budget.
    (200, 200, 1, "gemini-1-5-flash"),
    # "most expensive that fits" branch: several options fit $50.
    (1000, 200, 50, "gemini-1-5-pro"),
])
def test_the_exact_cases_that_used_to_recommend_a_retired_model(tin, tout, budget, expect_retired):
    cfg = {"agent_id": "repro", "name": "repro", "simulation_model": "claude-sonnet-4-6",
           "expected_calls_per_day": 500, "tools": [], "actions": []}
    ov = {"calls_per_day": 500, "input_tokens": tin, "output_tokens": tout, "cache_hit": 0}
    recs = compute_budget_fit(cfg, budget=budget, base_overrides=ov).get("recommendations", [])
    picked = [r["label"] for r in recs if r.get("lever") == "model"]
    assert picked, "no model lever produced; the repro no longer exercises this path"
    assert expect_retired not in picked[0], picked[0]
    # And the replacement is a live model, not merely a different retired one.
    name = picked[0].split("Switch the model to ", 1)[-1].split(" (")[0]
    assert load_defaults()["models"][name].get("status") != "retired"


# ── 2. Model choice is off the +/-20% scale ──────────────────────────────────

@pytest.mark.parametrize("agent_id,cfg,ov", AGENTS)
def test_every_sensitivity_row_is_a_bounded_percentage(agent_id, cfg, ov):
    """THE regression test. A +/-20% perturbation cannot plausibly move cost by
    more than 100%; the old "Model choice" row hit 2170% here."""
    r = forecast_spend(cfg, overrides=ov)
    for row in r.get("sensitivity") or []:
        assert 0 <= row["pct"] <= 100, f"{agent_id}: {row['label']} = {row['pct']}%"


@pytest.mark.parametrize("agent_id,cfg,ov", AGENTS)
def test_model_choice_is_not_a_sensitivity_row(agent_id, cfg, ov):
    r = forecast_spend(cfg, overrides=ov)
    assert "Model choice" not in {row["label"] for row in (r.get("sensitivity") or [])}


@pytest.mark.parametrize("agent_id,cfg,ov", AGENTS)
def test_the_caption_driver_is_a_real_input(agent_id, cfg, ov):
    """The UI captions the panel from sensitivity[0] and multiplies the forecast
    by its pct. That figure must stay inside the same order of magnitude as the
    forecast itself."""
    r = forecast_spend(cfg, overrides=ov)
    rows = r.get("sensitivity") or []
    if not rows:
        pytest.skip("no sensitivity for this agent")
    assert rows[0]["pct"] <= 100
    assert round(r["point"] * rows[0]["pct"] / 100) <= r["point"]


@pytest.mark.parametrize("agent_id,cfg,ov", AGENTS)
def test_model_choice_reports_dollars_and_skips_retired(agent_id, cfg, ov):
    r = forecast_spend(cfg, overrides=ov)
    mc = r.get("modelChoice")
    if mc is None:
        pytest.skip("no baseline")
    assert mc["cheapestPoint"] <= mc["currentPoint"]
    models = load_defaults()["models"]
    assert models[mc["cheapestModel"]].get("status") != "retired"
    # No percentage and no ratio: both reproduce the defect in a different unit.
    assert "spreadRatio" not in mc and "pct" not in mc


# ── 3. A provider switch is disclosed ────────────────────────────────────────

def test_every_row_resolves_a_provider():
    """A row on an unmapped host would silently lose its disclosure."""
    unresolved = [k for k, v in load_defaults()["models"].items() if model_provider(v) is None]
    assert not unresolved, unresolved


def test_provider_comes_from_the_row_source_url():
    d = load_defaults()["models"]
    assert model_provider(d["claude-sonnet-4-6"]) == "Anthropic"
    assert model_provider(d["gpt-5-nano"]) == "OpenAI"
    assert model_provider(d["deepseek-v4-flash"]) == "DeepSeek"


@pytest.mark.parametrize("agent_id,cfg,ov", AGENTS)
def test_a_cross_provider_switch_says_so(agent_id, cfg, ov):
    fit = compute_budget_fit(cfg, budget=1, base_overrides=ov)
    for rec in fit.get("recommendations", []):
        if rec.get("lever") != "model":
            continue
        if rec.get("changesProvider"):
            assert rec["newProvider"] and rec["newProvider"] in rec["label"], rec["label"]
            assert "a different provider" in rec["label"]
