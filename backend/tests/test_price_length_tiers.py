"""Tier 1.5 (length dimension): a model rate that changes with prompt size.

The companion to `test_price_time_dimension`, and deliberately its mirror image.

A rate can vary along two dimensions, and the two want OPPOSITE treatment by the
forecast:

  * TIME (`effective_price`) — a promo EXPIRES, so it must never be projected
    forward. Observed spend reprices at it; the forecast stays at sticker.
  * LENGTH (`price_tiers`) — a long prompt does NOT stop being long next month.
    An agent whose requests cross 200k tokens is billed at the extended tier
    today and will be next month too, so BOTH sides price at the tier.

Getting that asymmetry backwards in either direction is a real number on a CFO's
screen, so most of what follows is about WHICH caller tiers, not the arithmetic.

The defect this pins: we carried only the low tier for seven rows, so a
long-context agent on Gemini 2.5 Pro or any Grok was UNDER-forecast by up to 2x,
and the model-switch recommender quoted savings computed at a tier the agent's
own prompts would not have qualified for.

Boundaries are sourced from each vendor's own page (2026-08-27) and they do NOT
agree: Google gives the low rate at "<= 200k", xAI at "< 200k". The one-token
difference is theirs, and it is why the boundary is a number on the row instead
of a constant in the engine.
"""

from __future__ import annotations

import copy

import pytest

from analysis.spend_forecast import (
    _call_cost_usd,
    _effective_rates,
    compute_budget_fit,
    forecast_spend,
    load_defaults,
)

MTOK = 1_000_000

GOOGLE = "gemini-2-5-pro"      # $1.25/$10 -> $2.50/$15, low rate at <= 200,000
XAI = "grok-4-5"               # $2/$6     -> $4/$12,    low rate at <  200,000
FLAT = "claude-opus-4-8"       # $5/$25, no tier of any kind


# ── 1. The boundary, exactly where each vendor puts it ───────────────────────
# Not a rounded "about 200k". Google bills 200,000 tokens at the low rate and
# 200,001 at the high one; xAI bills 199,999 low and 200,000 high. A shared
# constant would have to be wrong for one of them.

@pytest.mark.parametrize("model,tokens,expected", [
    (GOOGLE, 199_999, (1.25, 10.00)),
    (GOOGLE, 200_000, (1.25, 10.00)),   # Google: "<= 200k" is still the low tier
    (GOOGLE, 200_001, (2.50, 15.00)),
    (XAI, 199_998, (2.00, 6.00)),
    (XAI, 199_999, (2.00, 6.00)),
    (XAI, 200_000, (4.00, 12.00)),      # xAI: ">= 200k" has already stepped up
    (XAI, 200_001, (4.00, 12.00)),
])
def test_each_vendors_boundary_is_its_own(model, tokens, expected):
    assert _effective_rates(load_defaults()["models"][model], input_tokens=tokens) == expected


def test_the_two_vendors_disagree_at_exactly_200k():
    """The whole reason the boundary lives on the row. If this ever passes with
    both at the same rate class, someone has replaced the per-row number with a
    shared constant and silently mispriced one of the two vendors."""
    m = load_defaults()["models"]
    google_at_200k = _effective_rates(m[GOOGLE], input_tokens=200_000)
    xai_at_200k = _effective_rates(m[XAI], input_tokens=200_000)
    assert google_at_200k == (1.25, 10.00), "Google's 200k should still be the base rate"
    assert xai_at_200k == (4.00, 12.00), "xAI's 200k should already be the extended rate"


def test_no_tokens_means_base_rate():
    """`input_tokens=None` is what a caller with no request in hand passes, and
    it must not guess a tier."""
    m = load_defaults()["models"]
    assert _effective_rates(m[GOOGLE]) == (1.25, 10.00)
    assert _effective_rates(m[GOOGLE], input_tokens=None) == (1.25, 10.00)


def test_an_untiered_row_is_untouched_at_any_length():
    m = load_defaults()["models"]
    for tokens in (0, 200_000, 5_000_000):
        assert _effective_rates(m[FLAT], input_tokens=tokens) == (5.00, 25.00)


# ── 2. Both tiers reach the money ────────────────────────────────────────────

def test_observed_call_cost_steps_at_the_boundary():
    d = load_defaults()
    # 1 MTok of prompt is well past 200k, so the whole request bills extended.
    assert _call_cost_usd(MTOK, 0, 0, GOOGLE, d) == 2.50
    assert _call_cost_usd(0, 0, MTOK, GOOGLE, d) == 10.00   # short prompt, base output rate
    # A 300k prompt with 1 MTok of output: the prompt crossed, so output is
    # billed at the extended rate too — both vendors tier the whole request.
    dear = _call_cost_usd(300_000, 0, MTOK, GOOGLE, d)
    cheap = _call_cost_usd(100_000, 0, MTOK, GOOGLE, d)
    assert dear == pytest.approx(300_000 * 2.50 / MTOK + 15.00)
    assert cheap == pytest.approx(100_000 * 1.25 / MTOK + 10.00)


def test_cached_tokens_count_toward_the_boundary():
    """Both vendors tier on the size of the PROMPT, not on the uncached
    remainder. A 250k prompt that is 90% cache-read is still a 250k prompt."""
    d = load_defaults()
    usd = _call_cost_usd(250_000, 225_000, 0, GOOGLE, d)
    # 25k billed at the extended input rate, 225k at extended minus the 0.90
    # discount — the discount ratio itself does not move (see the next test).
    expected = (25_000 * 2.50 + 225_000 * 2.50 * 0.10) / MTOK
    assert usd == pytest.approx(expected)


@pytest.mark.parametrize("model", [GOOGLE, "gemini-3-1-pro-preview", XAI,
                                   "grok-4-3", "grok-4-20-0309", "grok-build-0-1"])
def test_cache_discount_is_invariant_across_tiers(model):
    """Verified against both vendors' own pages 2026-08-27: the cached-input
    price scales by exactly the factor input does (grok-4-5 $0.30 -> $0.60
    against $2.00 -> $4.00), so the RATIO is unchanged. Tiering `cache_discount`
    as well would double-count it. This is the pin that stops a future reader
    from "finishing the job" by adding a discount to the tier block."""
    row = load_defaults()["models"][model]
    tier = row["price_tiers"][0]
    factor = tier["input_per_mtok"] / row["input_per_mtok"]
    d = load_defaults()
    # Same prompt shape on each side of the boundary: a fully-cached call must
    # scale by exactly the input factor and nothing else.
    below = _call_cost_usd(100_000, 100_000, 0, model, d)
    above = _call_cost_usd(400_000, 400_000, 0, model, d)
    assert above == pytest.approx(below * 4 * factor)


# ── 3. The forecast tiers too — the asymmetry with the time dimension ────────

def _agent(context_tokens: int) -> tuple[dict, dict]:
    cfg = {"agent_id": "len", "name": "len", "simulation_model": GOOGLE,
           "expected_calls_per_day": 100, "tools": [], "actions": []}
    ov = {"model": GOOGLE, "calls_per_day": 100,
          "input_tokens": context_tokens, "output_tokens": 2_000, "cache_hit": 0}
    return cfg, ov


def test_a_long_context_agent_is_forecast_at_the_tier_it_will_be_billed_at():
    """THE regression test. Before this change both agents priced at $1.25/$10,
    so the long-context one was under-forecast by roughly the tier factor."""
    short_cfg, short_ov = _agent(100_000)
    long_cfg, long_ov = _agent(400_000)
    short = forecast_spend(short_cfg, overrides=short_ov)
    long = forecast_spend(long_cfg, overrides=long_ov)
    # 4x the prompt at 2x the input rate — the LLM component alone is ~8x, and
    # the tier is what supplies the second factor of 2. Without it the ratio
    # collapses toward 4x (tool + infra costs are flat, so it lands under).
    ratio = long["pointExact"] / short["pointExact"]
    assert ratio > 5.0, f"long-context agent forecast only {ratio:.2f}x — tier not applied"


def test_the_forecast_still_refuses_the_dated_promo():
    """Guards the asymmetry from the other side. Adding the length dimension must
    not have made the forecast start honouring `effective_price` as well: a promo
    that expires still has to be excluded from money not yet spent.

    Sonnet 5 (sticker $3/$15, promo $2/$10 to 2026-08-31) against Sonnet 4.6
    (sticker $3/$15, no promo). Identical sticker and identical cache_discount,
    so with explicit token overrides — which bypass `tokenizer_inflation`, the
    only other field that differs — the two must forecast to the same number.
    If the promo leaked into the forecast, Sonnet 5 would come out cheaper."""
    d = load_defaults()["models"]
    assert (d["claude-sonnet-5"]["input_per_mtok"],
            d["claude-sonnet-5"]["output_per_mtok"]) == (3.00, 15.00)
    assert (d["claude-sonnet-4-6"]["input_per_mtok"],
            d["claude-sonnet-4-6"]["output_per_mtok"]) == (3.00, 15.00)
    assert d["claude-sonnet-5"]["effective_price"]["input_per_mtok"] == 2.00, \
        "fixture drifted — the promo row changed"

    def _point_on(model: str) -> float:
        cfg = {"agent_id": "promo", "name": "promo", "simulation_model": model,
               "expected_calls_per_day": 100, "tools": [], "actions": []}
        ov = {"model": model, "calls_per_day": 100,
              "input_tokens": 1_000, "output_tokens": 1_000, "cache_hit": 0}
        return forecast_spend(cfg, overrides=ov)["pointExact"]

    assert _point_on("claude-sonnet-5") == pytest.approx(_point_on("claude-sonnet-4-6"))


# ── 4. A negotiated rate is not a base for the public tier ───────────────────

def test_an_org_override_drops_the_public_tier():
    """Same defect class as #176. The override form has one input rate and one
    output rate and no tier dimension, so what the customer typed IS their rate.
    Layering the vendor's public 2x step on top would invent a contract term and
    overstate a long-context contract customer by up to 2x."""
    d = load_defaults()
    merged = copy.deepcopy(d)
    merged["models"][GOOGLE]["input_per_mtok"] = 0.50
    merged["models"][GOOGLE]["output_per_mtok"] = 4.00
    merged["models"][GOOGLE].pop("price_tiers", None)   # what load_defaults does
    assert _effective_rates(merged["models"][GOOGLE], input_tokens=400_000) == (0.50, 4.00)
    # And the un-overridden catalog still tiers, so the drop is scoped.
    assert _effective_rates(d["models"][GOOGLE], input_tokens=400_000) == (2.50, 15.00)


# ── 5. The recommender quotes a saving the agent could actually get ──────────

def test_lever_1_prices_a_tiered_candidate_at_the_agents_own_length():
    """Lever 1 reprices every candidate through `forecast_spend`, so the low-tier
    bug reached the recommendation text as well as the forecast.

    Concrete repro, found by sweeping base model x context x budget rather than
    assumed — the obvious fixtures do not reach it, because a tiered row only
    wins the ranking inside a narrow budget band. A 300k-token Opus agent on a
    $4,000 budget is offered a switch to gemini-3-1-pro-preview. The old engine
    costed that candidate at its <=200k rate ($2/$12) and quoted **$1,931/mo**.
    The agent's prompts are 300k, so it would really have paid **$3,822** — a 98%
    understatement, inside a cost tip telling a CFO to switch vendors.

    The floor below is computed from the row's own tier rates rather than
    hardcoded, so re-sourcing a price keeps the test honest instead of breaking
    it. It is deliberately loose (0.9x, and the LLM component only) — the point
    is that the quote cannot possibly have used the <=200k rate, which lands at
    barely half of it.
    """
    ctx, out_tokens, calls = 300_000, 2_000, 100
    cfg = {"agent_id": "lever", "name": "lever", "simulation_model": "claude-opus-4-8",
           "expected_calls_per_day": calls, "tools": [], "actions": []}
    ov = {"model": "claude-opus-4-8", "calls_per_day": calls,
          "input_tokens": ctx, "output_tokens": out_tokens, "cache_hit": 0}

    recs = compute_budget_fit(cfg, budget=4000, base_overrides=ov).get("recommendations", [])
    model_recs = [r for r in recs if r.get("lever") == "model"]
    assert model_recs, "no model lever produced; the repro no longer exercises this path"

    name = model_recs[0]["label"].split("Switch the model to ", 1)[-1].split(" (")[0]
    row = load_defaults()["models"][name]
    assert row.get("price_tiers"), (
        f"repro drifted: Lever 1 now picks {name}, which is not a tiered row. "
        "Re-sweep base model x context x budget to find a tiered candidate."
    )

    # 1. The quote is the candidate priced at THIS agent's prompt length.
    assert model_recs[0]["newPoint"] == \
        forecast_spend(cfg, overrides={**ov, "model": name})["point"]

    # 2. And that price is the EXTENDED tier, not the <=200k one the agent's own
    #    prompts do not qualify for.
    tier = row["price_tiers"][0]
    monthly_llm = (ctx * tier["input_per_mtok"] + out_tokens * tier["output_per_mtok"]) \
        / MTOK * calls * 30
    assert model_recs[0]["newPoint"] >= monthly_llm * 0.9, (
        f"{name} quoted at {model_recs[0]['newPoint']} for a {ctx:,}-token agent; "
        f"the extended tier alone is ~{monthly_llm:.0f}/mo, so this used the base rate"
    )
