"""Tier 1.5 (time dimension): a model rate that changes on a known date.

The defect this pins: the price book was used for two different questions and
only one of them wants today's price.

  * "What WILL we spend?" (forecast) — money not yet spent, so it must project
    the STICKER rate. A promo that expires must never be carried forward.
  * "What DID we spend?" (daily chart, month-to-date, anomalies, the budget
    counter) — must reprice at the rate the vendor ACTUALLY billed.

Both used sticker, so every observed Claude Sonnet 5 call was billed to the CFO
at $3/$15 while Anthropic charged $2/$10 — a 50% overstatement of money already
spent (equivalently: the real bill lands 33% below sticker).

The split is the whole fix, so most of what follows is about WHICH caller gets a
date, not about the arithmetic.
"""

from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta

import pytest

from analysis.spend_forecast import (
    _call_cost_usd,
    _effective_rates,
    _pricing_note,
    call_cost_from_detail,
    compute_live_rolling_averages,
    compute_month_to_date_spend,
    compute_spend_timeseries,
    load_defaults,
)

PROMO = "claude-sonnet-5"          # $2/$10 through 2026-08-31, sticker $3/$15
NO_PROMO = "claude-opus-4-8"       # $5/$25, no dated rate
UNTIL = "2026-08-31"
MTOK = 1_000_000


def _row(ts: datetime, model: str = PROMO, tin: int = MTOK, tout: int = 0) -> dict:
    return {
        "timestamp": ts.isoformat(),
        "detail": json.dumps({
            "model": model,
            "response": {"usage": {"input_tokens": tin, "output_tokens": tout,
                                   "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0}},
        }),
    }


# ── 1. The rate in force ─────────────────────────────────────────────────────

def test_sticker_is_unchanged():
    # The promo lives in effective_price; the row's own rate stays the standard
    # one. If this moves, the forecast silently starts projecting the discount.
    row = load_defaults()["models"][PROMO]
    assert (row["input_per_mtok"], row["output_per_mtok"]) == (3.00, 15.00)
    assert row["effective_price"]["until"] == UNTIL


@pytest.mark.parametrize("at,expected", [
    (None,           (3.00, 15.00)),   # no date asked → standing rate
    ("2026-08-01",   (2.00, 10.00)),   # inside the promo
    (UNTIL,          (2.00, 10.00)),   # `until` is INCLUSIVE
    ("2026-09-01",   (3.00, 15.00)),   # the day after — sticker
    ("2027-01-01",   (3.00, 15.00)),
])
def test_effective_rates_by_date(at, expected):
    assert _effective_rates(load_defaults()["models"][PROMO], at) == expected


def test_a_row_without_a_promo_ignores_the_date_entirely():
    mp = load_defaults()["models"][NO_PROMO]
    assert _effective_rates(mp, None) == _effective_rates(mp, "2026-08-01") == (5.00, 25.00)


def test_datetime_and_date_objects_work_not_just_strings():
    mp = load_defaults()["models"][PROMO]
    assert _effective_rates(mp, datetime(2026, 8, 15, 9, 30)) == (2.00, 10.00)
    assert _effective_rates(mp, datetime(2026, 8, 15).date()) == (2.00, 10.00)


def test_omitting_at_prices_at_sticker():
    # THE critical default. Every existing caller — including the 829-call
    # ground-truth backtest, which asserts published rates — omits `at`.
    d = load_defaults()
    assert _call_cost_usd(MTOK, 0, 0, PROMO, d) == 3.00
    assert _call_cost_usd(0, 0, MTOK, PROMO, d) == 15.00


def test_a_dated_call_is_priced_at_what_was_billed():
    d = load_defaults()
    assert _call_cost_usd(MTOK, 0, 0, PROMO, d, at="2026-08-15") == 2.00
    assert _call_cost_usd(0, 0, MTOK, PROMO, d, at="2026-08-15") == 10.00


def test_the_overstatement_this_item_exists_to_fix():
    d = load_defaults()
    billed = _call_cost_usd(MTOK, 0, MTOK, PROMO, d, at="2026-08-15")   # 2 + 10
    shown_before = _call_cost_usd(MTOK, 0, MTOK, PROMO, d)              # 3 + 15
    assert (billed, shown_before) == (12.00, 18.00)
    assert round((shown_before / billed - 1) * 100) == 50   # we overstated by 50%
    assert round((1 - billed / shown_before) * 100) == 33   # real bill is 33% below


# ── 2. The split: which caller gets a date ───────────────────────────────────

def test_backward_looking_callers_reprice_at_the_billed_rate():
    ts = datetime(2026, 8, 15, 12, 0, 0)
    rows = [_row(ts)]

    assert compute_month_to_date_spend(rows, now=datetime(2026, 8, 20)) == 2.00

    series = compute_spend_timeseries(rows, days=30)
    day = next((d for d in series if d["date"] == "2026-08-15"), None)
    assert day is not None and day["usd"] == 2.00

    detail = json.loads(rows[0]["detail"])
    assert call_cost_from_detail(detail, at=ts) == 2.00


def test_the_forecast_input_stays_at_sticker_even_for_in_promo_calls():
    """The subtle one, and the reason this isn't a one-line change.

    `compute_live_rolling_averages` reads historical rows but its output is a
    FORECAST input — forecast_spend projects `llm_cost_per_call` forward at the
    live tier. Pricing these at the promo would carry a discount that expires
    into next month's forecast and under-forecast by the full step the day it
    lapses.
    """
    rows = [_row(datetime(2026, 8, 15, 12, 0, 0), tin=MTOK, tout=MTOK)]
    assert compute_live_rolling_averages(rows)["llm_cost_per_call"] == 18.00  # 3 + 15


def test_the_budget_counter_and_month_to_date_agree():
    # They are reconciled against each other (MED-004) — a drift between them
    # would let the counter and the reported spend disagree.
    ts = datetime(2026, 8, 15, 12, 0, 0)
    rows = [_row(ts)]
    per_call = call_cost_from_detail(json.loads(rows[0]["detail"]), at=ts)
    assert per_call == compute_month_to_date_spend(rows, now=datetime(2026, 8, 20))


# ── 3. A negotiated rate beats a public promo ────────────────────────────────

def test_org_rate_override_drops_the_public_promo(monkeypatch):
    """Otherwise a customer on a contract rate gets silently repriced at
    Anthropic's public discount. Overrides can only patch the sticker fields
    (_OVERRIDE_MODEL_SUBKEYS), so effective_price would survive the merge and
    win — the same defect class as #176 (list price beating a negotiated one).
    """
    import analysis.spend_forecast as sf

    monkeypatch.setattr(sf, "_fetch_org_overrides",
                        lambda _o: ([("model", PROMO, "input_per_mtok", 1.50)], True))
    monkeypatch.setattr(sf, "_fetch_org_default_model", lambda _o: None)

    merged = sf.load_defaults("org-with-a-contract")
    assert "effective_price" not in merged["models"][PROMO]
    # Their negotiated $1.50 applies on every date, promo window or not.
    assert _call_cost_usd(MTOK, 0, 0, PROMO, merged, at="2026-08-15") == 1.50
    assert _call_cost_usd(MTOK, 0, 0, PROMO, merged) == 1.50


def test_a_non_rate_override_leaves_the_promo_alone(monkeypatch):
    # Overriding cache_discount says nothing about the headline rate.
    import analysis.spend_forecast as sf

    monkeypatch.setattr(sf, "_fetch_org_overrides",
                        lambda _o: ([("model", PROMO, "cache_discount", 0.5)], True))
    monkeypatch.setattr(sf, "_fetch_org_default_model", lambda _o: None)

    merged = sf.load_defaults("org-tweaking-cache")
    assert _call_cost_usd(MTOK, 0, 0, PROMO, merged, at="2026-08-15") == 2.00


def test_the_shared_catalog_is_not_mutated_by_an_org_merge(monkeypatch):
    import analysis.spend_forecast as sf

    monkeypatch.setattr(sf, "_fetch_org_overrides",
                        lambda _o: ([("model", PROMO, "input_per_mtok", 1.50)], True))
    monkeypatch.setattr(sf, "_fetch_org_default_model", lambda _o: None)
    sf.load_defaults("org-with-a-contract")
    monkeypatch.undo()
    assert "effective_price" in load_defaults()["models"][PROMO]


# ── 4. Saying so ─────────────────────────────────────────────────────────────

def test_note_warns_before_the_rate_moves():
    note = _pricing_note(PROMO, load_defaults(), today="2026-08-26")
    assert note and UNTIL in note
    assert "50% more expensive" in note
    assert "2026-09-01" in note          # names the day the bill changes
    assert "no forecast changes" in note  # the forecast is already at sticker


def test_note_explains_the_step_after_it_happens():
    note = _pricing_note(PROMO, load_defaults(), today="2026-09-05")
    assert note and "ended" in note


def test_note_stops_once_the_old_rate_has_left_the_observed_window():
    assert _pricing_note(PROMO, load_defaults(), today="2026-11-01") is None


def test_no_note_for_a_model_with_a_flat_rate():
    assert _pricing_note(NO_PROMO, load_defaults(), today="2026-08-26") is None


def test_note_covers_a_model_the_agent_was_only_OBSERVED_running():
    # A model-switching agent's cost can move on a date that has nothing to do
    # with the model it declared.
    note = _pricing_note(
        NO_PROMO, load_defaults(),
        observed_models=[{"model": PROMO, "calls": 40, "costShare": 0.9}],
        today="2026-08-26",
    )
    assert note and PROMO in note


def test_note_avoids_a_single_percentage_when_the_two_rates_move_differently():
    d = copy.deepcopy(load_defaults())
    d["models"][PROMO]["effective_price"] = {
        "input_per_mtok": 1.50, "output_per_mtok": 10.00, "until": UNTIL,
    }
    note = _pricing_note(PROMO, d, today="2026-08-26")
    # input doubles, output rises 50% — one "about X%" would be false of one.
    assert note and "100% more expensive on input and 50% on output" in note
