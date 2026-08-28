"""Tier 2.6 — Arceo can finally see what it spends on its own key.

The gate read a counter its own spend never moved. `_capture_llm_call` runs at
exactly two sites (the LLM proxy and /api/agent/{id}/llm-call), both of which
record the CUSTOMER's spend on the CUSTOMER's key. Meanwhile eleven
`messages.create` call sites across six modules resolve their key with
`os.getenv("ANTHROPIC_API_KEY")` — ours — and discarded `response.usage`
entirely.

The three sandbox gates make this concrete: `_budget_gate(agent_id, org)` with
`reserve=False` and no matching `_budget_settle`. They read the customer's
captured dollars and never write anything. So a cap could never trip on Arceo's
own work, which is why metering has to land before gating.

## Why the meter is at the client constructor

Instrumenting eleven call sites is the shape that drifts, and it drifts in the
comfortable direction: a forgotten site makes gross margin look BETTER than it
is. `llm_models.anthropic_client()` was already the mandated construction point,
so metering there covers every existing path and every future one.

⚠️ The end-to-end test below is the load-bearing one, and it exists because the
first implementation passed a unit check while metering nothing: `cogs.record()`
returned the correct dollar figure, but `spend_adjust` returns early on a cold
key (correct for settling a reservation, wrong for accrual), so the counter
stayed empty. Asserting on the return value alone would have shipped that.
"""

from __future__ import annotations

import pytest

import cogs
import llm_models
import shared_state


# A real Anthropic usage shape. input_tokens EXCLUDES cached tokens, which is
# the convention that makes cache-heavy calls easy to under-price.
_USAGE = {
    "input_tokens": 10_000,
    "output_tokens": 2_000,
    "cache_read_input_tokens": 5_000,
    "cache_creation_input_tokens": 0,
}
# Hand-computed against claude-haiku-4-5 ($1.00/MTok in, $5.00/MTok out,
# cache_discount 0.90 → cached reads bill at 10% of input):
#   10,000 uncached in  @ $1.00/MTok  = $0.010000
#    5,000 cached  in   @ $0.10/MTok  = $0.000500
#    2,000        out   @ $5.00/MTok  = $0.010000
_EXPECTED_USD = 0.0205


class _FakeMessages:
    def __init__(self, usage=_USAGE, model="claude-haiku-4-5-20251001"):
        self.usage, self.model, self.calls = usage, model, 0

    def create(self, **kwargs):
        self.calls += 1
        return type("R", (), {"usage": self.usage, "model": self.model})()


class _FakeClient:
    def __init__(self, **kw):
        self.messages = _FakeMessages(**kw)


@pytest.fixture(autouse=True)
def _clean_counters():
    shared_state._flush_for_tests()
    yield
    shared_state._flush_for_tests()


# ── Pricing uses the customer catalog, deliberately ──────────────────────────

def test_our_own_spend_is_priced_with_the_same_catalog_we_show_customers():
    """If Arceo priced its own COGS from a second private table, the two would
    drift and gross margin would stop being comparable to the number we put in
    front of the customer — which is the number the product is sold on."""
    assert cogs.price("claude-haiku-4-5-20251001", _USAGE) == pytest.approx(_EXPECTED_USD)


def test_cached_tokens_are_priced_at_the_discount_not_full_rate():
    """Anthropic's input_tokens excludes cached reads. Treating the two as
    interchangeable over-counts a cache-heavy call by ~10x on the cached
    portion — in the direction that would make our margin look worse than it is,
    which is the error nobody goes looking for."""
    all_uncached = dict(_USAGE, input_tokens=15_000, cache_read_input_tokens=0)
    assert cogs.price("claude-haiku-4-5-20251001", all_uncached) > \
        cogs.price("claude-haiku-4-5-20251001", _USAGE)


@pytest.mark.parametrize("model", ["claude-sonnet-4-6", "claude-haiku-4-5-20251001",
                                   "claude-opus-4-8"])
def test_every_model_we_actually_call_is_priceable(model):
    """llm_models declares exactly these three. A model id that does not resolve
    prices at the catalog default and silently mis-states margin, so this pins
    the join between what we CALL and what we can PRICE."""
    assert cogs.price(model, _USAGE) > 0


def test_a_response_with_no_usage_records_nothing_rather_than_guessing():
    assert cogs.price("claude-haiku-4-5-20251001", None) == 0.0
    assert cogs.record("claude-haiku-4-5-20251001", None) == 0.0


# ── The counter actually moves (the one that caught the real bug) ────────────

def test_a_metered_call_moves_the_counter_end_to_end():
    """⚠️ THE test. The first implementation used `spend_adjust`, which returns
    early when the key does not exist — correct for settling a reservation, wrong
    for accrual, and the first call of any month is exactly the cold-key case.
    `cogs.record()` returned $0.0205 the whole time while the counter stayed
    empty. Assert on the COUNTER, never on the return value alone."""
    client = _FakeClient()
    wrapped = llm_models._MeteredAnthropic(client)

    assert shared_state.spend_total(cogs.scope_for()) is None
    wrapped.messages.create(model="claude-haiku-4-5-20251001", messages=[])
    assert shared_state.spend_total(cogs.scope_for()) == pytest.approx(_EXPECTED_USD)


def test_spend_accrues_across_calls():
    wrapped = llm_models._MeteredAnthropic(_FakeClient())
    for _ in range(3):
        wrapped.messages.create(model="claude-haiku-4-5-20251001", messages=[])
    assert shared_state.spend_total(cogs.scope_for()) == pytest.approx(_EXPECTED_USD * 3)


def test_accrue_creates_a_cold_counter_where_adjust_refuses_to():
    """Pins the distinction between the two primitives. `spend_adjust` must keep
    refusing a cold key — creating one there would invent money in a CUSTOMER's
    budget ledger — so COGS needed its own primitive rather than a relaxation of
    that one."""
    shared_state.spend_adjust("cogs:test-cold:2026-08", 1.23)
    assert shared_state.spend_total("cogs:test-cold:2026-08") is None, \
        "spend_adjust must not create counters"
    shared_state.spend_accrue("cogs:test-cold:2026-08", 1.23)
    assert shared_state.spend_total("cogs:test-cold:2026-08") == pytest.approx(1.23)


# ── Attribution ──────────────────────────────────────────────────────────────

def test_spend_is_attributed_to_the_requesting_org():
    import db

    token = db.current_org.set("org-abc")
    try:
        llm_models._MeteredAnthropic(_FakeClient()).messages.create(
            model="claude-haiku-4-5-20251001", messages=[])
        assert cogs.scope_for() == f"cogs:org-abc:{cogs.datetime.utcnow():%Y-%m}"
        assert shared_state.spend_total("cogs:org-abc:"
                                        f"{cogs.datetime.utcnow():%Y-%m}") == \
            pytest.approx(_EXPECTED_USD)
    finally:
        db.current_org.reset(token)


def test_unattributable_spend_lands_in_a_real_bucket_not_the_bin():
    """Work with no request behind it (the scheduler, a CLI job) still costs
    money. Dropping it would make margin look better than it is; a large
    `cogs:system` bucket is itself the signal that attribution is broken."""
    assert cogs.scope_for().startswith(f"cogs:{cogs.UNATTRIBUTED_ORG}:")


# ── It must never break the work it measures ────────────────────────────────

def test_a_metering_failure_never_breaks_the_llm_call(monkeypatch):
    """This sits on the return path of every LLM call in the product. A metering
    bug that took down simulations would be strictly worse than the missing
    number it was added to provide."""
    def _explode(*_a, **_kw):
        raise RuntimeError("redis is gone")

    monkeypatch.setattr(shared_state, "spend_accrue", _explode)
    wrapped = llm_models._MeteredAnthropic(_FakeClient())
    resp = wrapped.messages.create(model="claude-haiku-4-5-20251001", messages=[])
    assert resp.usage == _USAGE, "the caller must still get its response"


def test_the_wrapper_is_transparent_for_everything_else():
    """The SDK surface must be unchanged, or call sites start special-casing it."""
    inner = _FakeClient()
    wrapped = llm_models._MeteredAnthropic(inner)
    inner.some_other_attr = "passthrough"
    assert wrapped.some_other_attr == "passthrough"
    assert wrapped.messages.calls == 0
    wrapped.messages.create(model="claude-haiku-4-5-20251001", messages=[])
    assert inner.messages.calls == 1, "the real client must receive the call"


def test_metering_can_be_turned_off_for_a_call_that_is_not_our_cost():
    """Reserved for a customer-supplied key. Nothing uses it today — the LLM
    proxy forwards raw over httpx and never builds a client here — but the
    distinction has to exist before someone adds that path."""
    wrapped = llm_models._MeteredAnthropic(_FakeClient(), meter=False)
    wrapped.messages.create(model="claude-haiku-4-5-20251001", messages=[])
    assert shared_state.spend_total(cogs.scope_for()) is None


# ── (2) the extraction endpoints finally have a limiter ─────────────────────

def test_extraction_endpoints_are_rate_limited_per_org():
    """They were the only Arceo-BILLED LLM paths with no per-endpoint limiter,
    while every peer had one. The global 1000/60s backstop is not a substitute:
    it is IP-keyed for bearer callers and fail_open=True — DoS hygiene, not a
    cost control. Worst case without this was 1000 extract-github requests/min
    x 25 files = 25,000 Haiku extractions per minute on our key."""
    import main
    import inspect

    for fn in (main.extract_agent_from_code, main.extract_agents_from_github):
        src = inspect.getsource(fn)
        assert 'check_rate_limit(f"extract:' in src, f"{fn.__name__} is unguarded"
        assert "RATE_LIMIT_EXTRACT_MAX" in src

    # Keyed per ORG: the cost lands on us per tenant, and an IP key would let one
    # customer's CI runners rotate around it.
    assert main.RATE_LIMIT_EXTRACT_MAX < main.RATE_LIMIT_LLM_MAX, (
        "one extract-github request is up to 25 Haiku calls at max_tokens=8000 — "
        "it must not share a ceiling with single-call endpoints"
    )


# ── The two LLM endpoints that had no gate at all ───────────────────────────

def test_the_previously_ungated_llm_endpoints_now_gate():
    """2.6's findings named two endpoints with no `_budget_gate` at all:

      /api/sandbox/simulate/multi — the MORE expensive sibling of the gated
          /api/sandbox/simulate, since N agents each run their own LLM loop.
      /api/workflows/optimize     — worse, and missed by the original finding:
          no gate, no _run_heavy_job wrapper, and no dry_run guard on the LLM
          path, so with ANTHROPIC_API_KEY set it ALWAYS ran the full
          multi-agent loop on our key.

    Both burn Arceo's key, so both now carry the same gate their peers do.
    """
    import inspect

    import main

    for fn in (main._run_multi_agent_simulation_impl,
               main.optimize_workflow_permissions):
        assert "_budget_gate(" in inspect.getsource(fn), f"{fn.__name__} is ungated"


# ── The number has to be readable, or 2.6 is code without an answer ─────────

def test_the_cogs_endpoint_reports_our_spend_and_the_customers_separately(client, roles):
    """The two figures are different KINDS of claim and the response has to say
    so — one is a Redis indicator we lose on a flush, the other is the audit-log
    system of record."""
    r = client.get("/api/cogs", headers=roles["admin"]["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) >= {"month", "arceoSpendUsd", "customerSpendUsd", "costRatio", "basis"}
    # No spend yet in a fresh org: our counter is cold (None, not a confident 0)
    # while the customer's is a real, reconstructible zero.
    assert body["arceoSpendUsd"] is None
    assert body["customerSpendUsd"] == 0
    assert "not revenue margin" in body["basis"], (
        "the basis line must stop costRatio being read as margin — Arceo does "
        "not bill per token, so that reading would be wrong in a board deck"
    )


def test_a_non_admin_cannot_read_the_accounts_commercial_data(client, roles):
    for who in ("editor", "viewer"):
        r = client.get("/api/cogs", headers=roles[who]["headers"])
        assert r.status_code == 403, f"{who} could read COGS: {r.status_code}"


def test_the_endpoint_reflects_metered_spend(client, roles):
    """End-to-end again: meter a call against this org, then read it back
    through the API rather than out of Redis."""
    import db

    org_id = roles["admin"]["org_id"]
    token = db.current_org.set(org_id)
    try:
        llm_models._MeteredAnthropic(_FakeClient()).messages.create(
            model="claude-haiku-4-5-20251001", messages=[])
    finally:
        db.current_org.reset(token)

    body = client.get("/api/cogs", headers=roles["admin"]["headers"]).json()
    assert body["arceoSpendUsd"] == pytest.approx(_EXPECTED_USD, abs=1e-4)
