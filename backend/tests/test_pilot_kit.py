"""Tier 4.4 — the pilot kit states numbers the engine computes.

`docs/pilot/CONFIDENCE_AND_LIMITS.md` is the honesty contract: the document a
beta customer reads to find out what our forecast means and where it stops. It
quotes the confidence gate and all three band multipliers.

Item 1.13 is the reason this file exists. Four separate UI surfaces described
that same gate in their own words and three of them were wrong — including two
that printed into a PDF and left the building. The frontend now guards its copy
(`frontend/src/lib/confidence.test.ts`); a markdown document handed to a customer
has exactly the same failure mode and none of the type checking, so it gets the
same treatment.

⚠️ These assertions are deliberately coarse — they check the NUMBERS, not the
prose. A doc can still be misleading while passing this file. What it cannot do
is quote a band or a gate the engine does not implement.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from analysis.spend_forecast import (
    LIVE_TRACE_MIN_ACTIVE_DAYS, LIVE_TRACE_MIN_CALLS, load_defaults,
)

KIT = Path(__file__).resolve().parents[2] / "docs" / "pilot"
CONTRACT = KIT / "CONFIDENCE_AND_LIMITS.md"

#: The gate restated monthly, the way the customer-facing copy states it.
#: Mirrors frontend/src/lib/confidence.ts — same derivation, same rounding.
WINDOW_DAYS = 7
MONTHLY_EQUIV = round((LIVE_TRACE_MIN_CALLS / WINDOW_DAYS) * 30 / 5) * 5


@pytest.fixture(scope="module")
def contract() -> str:
    # A hard failure, not a skip. A pilot-kit test that silently skips when the
    # kit is missing reports success forever and is worse than no test — the
    # same shape as the Agent Security check that passes while skipping its scan.
    assert CONTRACT.is_file(), f"the honesty contract is missing: {CONTRACT}"
    return CONTRACT.read_text(encoding="utf-8")


def test_the_kit_is_all_present():
    """Every piece the plan promises a customer, minus retention, which lives one
    level up because Tier 3.2 owns it — one document, two owners."""
    for name in ("README.md", "PILOT_OFFER.md", "CONFIDENCE_AND_LIMITS.md", "ONBOARDING.md"):
        assert (KIT / name).is_file(), f"pilot kit is missing {name}"
    assert (KIT.parent / "DATA_RETENTION.md").is_file()
    assert not (KIT / "DATA_RETENTION.md").exists(), (
        "retention was copied into the kit — now there are two, and they will disagree"
    )


def test_the_contract_states_the_real_gate(contract):
    assert str(LIVE_TRACE_MIN_CALLS) in contract
    assert re.search(rf"{LIVE_TRACE_MIN_ACTIVE_DAYS}\+? distinct days", contract), (
        "the active-days half of the gate is not stated"
    )
    assert "rolling" in contract.lower(), "nothing tells the reader the window rolls"


def test_the_contract_states_the_monthly_rate(contract):
    """The whole point of 1.13's answer: '50 in a rolling week' is not checkable
    by a customer against their own agent, and '~215 a month' is. 4.2 screens on
    this number, so the document a prospect reads has to carry it."""
    assert str(MONTHLY_EQUIV) in contract, (
        f"the contract does not state the monthly equivalent ({MONTHLY_EQUIV})"
    )
    # ⚠️ Presence alone is a weak assertion: the doc states the figure more than
    # once, so mutating one instance still passed a bare `in` check. What matters
    # is that EVERY monthly figure in the document agrees — a contract that says
    # 215 in one paragraph and 400 in another is worse than one that says neither.
    # Scoped to the GATE claim ("roughly N calls a month"). A bare "N calls a
    # month" also matches the doc's illustrative low-volume example ("if your
    # agent runs at 20 calls a month"), which is not a claim about the gate —
    # the third time in this file a substring guard caught the correct sentence.
    quoted = re.findall(r"roughly (\d{2,4})\s+(?:LLM\s+)?calls a month", contract)
    assert quoted, "no monthly call figure found at all"
    assert set(quoted) == {str(MONTHLY_EQUIV)}, (
        f"the contract quotes conflicting monthly rates: {sorted(set(quoted))}, "
        f"engine says {MONTHLY_EQUIV}"
    )


def test_the_contract_admits_the_cap(contract):
    """The 2026-08-28 decision was that the cap STAYS and the copy says so. A
    document that states the gate but implies it always arrives has re-created
    the exact defect #217 removed from four surfaces."""
    assert re.search(r"never reach|will never|cannot reach", contract, re.I), (
        "the contract never says a below-rate agent is permanently capped"
    )
    # ⚠️ Ban the CLAIM, not the substring. The first cut of this test banned bare
    # /accumulat/ and failed on the contract's own "Nothing accumulates" — which
    # is the correct statement, the exact opposite of the defect. That is the
    # same over-firing that made the frontend guard ban the literal "7 days"
    # when the window genuinely is 7 days (see cfoReport.test.ts). A guard that
    # punishes the accurate sentence pushes copy toward vague, not toward true.
    for promise in (r"narrows as evidence accumulates",
                    r"accumulate\s+(30|thirty)",
                    r"(30|thirty)\+?\s*days of live",
                    r"tightens as agents accumulate",
                    r"once we capture",
                    r"confidence (improves|rises|grows) over time"):
        assert not re.search(promise, contract, re.I), (
            f"the contract promises arrival by time: /{promise}/"
        )


def test_the_contract_quotes_the_real_bands(contract):
    """All three bands, from the same YAML the forecast reads."""
    bands = load_defaults()["confidence_bands"]
    for tier in ("low", "medium", "high"):
        for edge in ("low_multiplier", "high_multiplier"):
            value = bands[tier][edge]
            assert f"{value:.2f}" in contract, (
                f"{tier}.{edge} = {value:.2f} is not stated in the honesty contract"
            )


def test_the_contract_does_not_resurrect_worst_case_dollars(contract):
    """Retired product-wide in #174 because the per-incident figures were not
    defensible. The pilot kit is exactly where it would creep back in."""
    # Same discipline: the contract DISCLAIMS worst-case dollars in prose, so the
    # phrase legitimately appears. What must never appear is an actual figure.
    assert not re.search(r"worst[- ]case[^.]{0,60}\$\s?[0-9]", contract, re.I), (
        "a worst-case dollar FIGURE is back in the customer-facing kit"
    )


def test_the_offer_has_no_unresolved_decision_left_in_it():
    """`PILOT_OFFER.md` ships with a support-channel decision block addressed to
    Reza. It is fine in the repo and NOT fine in a customer's inbox, so this
    fails once the block is removed — at which point delete this test with it.

    Deliberately inverted: while the block is present this test PASSES and
    records why. It is a marker, not a gate.
    """
    offer = (KIT / "PILOT_OFFER.md").read_text(encoding="utf-8")
    if "DECISION NEEDED" in offer:
        pytest.skip("support channel still undecided — see PILOT_OFFER.md")
    assert "Slack Connect" in offer or "email" in offer.lower(), (
        "the decision block was removed without leaving a support channel behind"
    )
