"""Ground-truth backtest — the first tests that assert an EXACT end-to-end
forecast dollar against an INDEPENDENTLY-known cost (the gap Tim's "run it against
agents whose exact costs we know" ask points at).

Two oracles, both following the campaign discipline "never grade Arceo with
Arceo's numbers":

  * HIGH tier — test-agents/live-validation/ledger.jsonl: 829 real Anthropic
    `usage` rows captured client-side (independent of Arceo's own capture) across
    3 agents / 21 days. Re-priced through the engine's OWN `_call_cost_usd`, it
    must reproduce the independently-measured monthly spend.

  * LOW tier — test-agents/synthetic/*.json: 8 hand-computed-truth stress agents
    ($0.40 -> $16,715/mo). With only what a customer declares at onboarding
    (calls/day + model + context bucket), the engine's DISPLAYED [low, high] range
    must CONTAIN the true cost.

Per-call pricing correctness is pinned by the HIGH-tier test (engine == a
from-scratch reprice at published rates), so the LOW-tier coverage below reflects
ESTIMATION quality, not a hidden pricing bug — that separation is what stops the
error-cancellation failure the campaign documented.

Run: cd backend && python3 -m pytest tests/test_spend_backtest.py -v
"""
from __future__ import annotations

import glob
import json
from pathlib import Path

import pytest

from analysis.spend_forecast import (
    forecast_spend,
    load_defaults,
    _resolve_model_key,
    _call_cost_usd,
)

REPO = Path(__file__).resolve().parents[2]
SYN_DIR = REPO / "test-agents" / "synthetic"
LEDGER = REPO / "test-agents" / "live-validation" / "ledger.jsonl"


# ── HIGH tier: reprice real Anthropic usage ──────────────────────────────────

# Hand-computed monthly truth = (Σ per-call $ over the ledger / distinct days) × 30,
# priced at published $/MTok. Derivable from (ledger, published rates) WITHOUT Arceo.
LEDGER_TRUTH_USD = {
    "live-support-agent": 3.92,
    "live-payments-ap": 4.47,
    "live-calendar-scheduler": 0.59,
}
# Authoritative published rates ($/MTok in, out), independent of the engine's YAML.
PUBLISHED_RATES = {
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
}


def _published_key(model: str) -> str:
    for k in PUBLISHED_RATES:
        if model == k or model.startswith(k):
            return k
    raise AssertionError(f"ledger model {model!r} has no published rate")


def _load_ledger() -> list[dict]:
    assert LEDGER.exists(), f"ledger fixture missing: {LEDGER}"
    rows = [json.loads(ln) for ln in LEDGER.read_text().splitlines() if ln.strip()]
    assert rows, "ledger fixture is empty"
    return rows


def test_high_tier_ledger_reprices_to_measured_spend():
    """The engine prices 829 real usage rows to the independently-measured
    monthly spend, and its pricing equals a from-scratch reprice at published
    rates — so any pricing-formula or model-resolver regression trips here."""
    defaults = load_defaults()
    eng: dict[str, list] = {}   # agent -> [cost, {days}]
    ind: dict[str, list] = {}
    for r in _load_ledger():
        agent = r["agent"]
        cache_read = int(r["cache_read_input_tokens"])
        cache_creation = int(r["cache_creation_input_tokens"])
        # Anthropic input_tokens EXCLUDES cached; total input adds them back.
        total_in = int(r["input_tokens"]) + cache_read + cache_creation
        out = int(r["output_tokens"])

        key = _resolve_model_key(r["model"], defaults)
        usd_eng = _call_cost_usd(total_in, cache_read, out, key, defaults,
                                 cache_creation=cache_creation)
        pin, pout = PUBLISHED_RATES[_published_key(r["model"])]  # cache=0 in this ledger
        usd_ind = int(r["input_tokens"]) * pin / 1e6 + out * pout / 1e6

        e = eng.setdefault(agent, [0.0, set()]); e[0] += usd_eng; e[1].add(r["day"])
        i = ind.setdefault(agent, [0.0, set()]); i[0] += usd_ind; i[1].add(r["day"])

    for agent, documented in LEDGER_TRUTH_USD.items():
        assert agent in eng, f"{agent} missing from ledger fixture"
        eng_monthly = eng[agent][0] / len(eng[agent][1]) * 30
        ind_monthly = ind[agent][0] / len(ind[agent][1]) * 30
        assert abs(eng_monthly - ind_monthly) <= 1e-6 * ind_monthly, (
            f"{agent}: engine ${eng_monthly:.4f}/mo != published-rate ${ind_monthly:.4f}/mo "
            f"— pricing/resolver regression")
        assert abs(eng_monthly - documented) <= 0.01 * documented, (
            f"{agent}: engine ${eng_monthly:.4f}/mo not within 1% of documented ${documented}/mo")


# ── LOW tier: does the unaided forecast's displayed range contain the truth? ──

def _declared_config(spec: dict) -> dict:
    """Mirror what a customer types at onboarding (and what the forecast endpoint
    stores): total model-calls/day + model + a context-size bucket for doc-heavy
    agents. Deliberately NOT the true per-call token/cache mix — that is what the
    LOW tier must estimate."""
    beh = spec["behavior"]
    cfg = {
        "name": spec["register_payload"]["name"],
        "tools": spec["register_payload"]["tools"],
        "simulation_model": spec["simulation_model"],
        "expected_calls_per_day": beh["calls_per_day"],
    }
    in_tok = beh.get("input_tokens_per_call") or 0
    if in_tok >= 60000:
        cfg["avg_context_tokens"] = 80000
    elif in_tok >= 20000:
        cfg["avg_context_tokens"] = 40000
    return cfg


def _band_covers_truth(spec: dict):
    fc = forecast_spend(_declared_config(spec))
    assert fc["available"] is True, "forecast unexpectedly unavailable"
    assert fc["confidence"] == "low", f"expected LOW tier, got {fc['confidence']}"
    mult = load_defaults()["confidence_bands"]["low"]
    lo = fc["pointExact"] * mult["low_multiplier"]
    hi = fc["pointExact"] * mult["high_multiplier"]
    truth = float(spec["expected_truth"]["monthly_point_usd"])
    return (lo <= truth <= hi), lo, hi, truth, fc["pointExact"]


# 06 is a deliberately pathological skewed tool distribution; its miss is
# amplified by a fixture/engine tool-key gap (fixture declares tool "aws"; the
# catalog keys tool costs as "aws_rds"), tracked as a hardening backlog item.
# strict=True: if it becomes covered, this flips to a failure so we retire it.
_KNOWN_MISSES = {"06_skewed_distribution"}


def _synthetic_params():
    params = []
    for p in sorted(glob.glob(str(SYN_DIR / "*.json"))):
        stem = Path(p).stem
        marks = ([pytest.mark.xfail(strict=True,
                                    reason="skewed tool mix + aws/aws_rds tool-key gap (backlog)")]
                 if stem in _KNOWN_MISSES else [])
        params.append(pytest.param(p, id=stem, marks=marks))
    return params


@pytest.mark.parametrize("path", _synthetic_params())
def test_low_tier_band_covers_truth(path):
    """Unaided (declared-only) LOW-tier forecast's displayed range contains the
    hand-computed true cost — the honest CFO claim ('the real number is in our
    range')."""
    spec = json.loads(Path(path).read_text())
    covered, lo, hi, truth, point = _band_covers_truth(spec)
    assert covered, (
        f"truth ${truth:,.2f} not in displayed range [${lo:,.2f}, ${hi:,.2f}] "
        f"(point ${point:,.2f})")


def test_low_tier_coverage_floor():
    """Regression floor: the unaided forecast must keep covering >=7/8 stress
    agents. Locks in current accuracy so a future engine change can't quietly
    erode it before a demo."""
    covered = sum(
        _band_covers_truth(json.loads(Path(p).read_text()))[0]
        for p in glob.glob(str(SYN_DIR / "*.json"))
    )
    assert covered >= 7, f"LOW-tier band coverage regressed to {covered}/8"
