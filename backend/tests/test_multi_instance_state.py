"""Tier 2.7 — state that was correct in one process and wrong in two.

Nothing is broken today: the Dockerfile runs uvicorn with no `--workers`. This
arms itself on the first autoscaled deploy, which is exactly what the GCP
credits make imminent — so it is a "fix before the deploy, not after the
incident" item.

Three of the five ranked sub-items are addressed here. Two are deliberately not,
and the plan itself deprioritizes both:

  4. `_mock_sessions` — already a documented, accepted tradeoff, bounded and
     org-scoped, and a Redis move is partly unworkable because it holds a live
     `MockState` object rather than data.
  5. `GENERATED_SCENARIOS` — fails LOUDLY with a clean 404 rather than serving a
     wrong number. Off-wedge, lowest.

⚠️ The plan says the two dedupe flags "map 1:1 onto should_fire_once". That is
right for one of them and wrong for the other, which is the main thing these
tests encode — see the anomaly section.
"""

from __future__ import annotations

import time

import pytest

import main
import shared_state
from analysis import spend_forecast as sf


def _reset():
    """Defensive on purpose.

    These tests must remain RUNNABLE against a build that has none of the new
    symbols, so they fail on a real assertion ("nothing invalidated the other
    instances") rather than erroring in setup. An error proves a name is
    missing; only a failure proves the behaviour was wrong — and it is the
    behaviour this item is about.
    """
    shared_state._flush_for_tests()
    for mod, name in ((main, "_ANOMALY_CHECK_LAST"),
                      (sf, "_SENSITIVITY_CACHE"),
                      (sf, "_OVERRIDES_VERSION_LOCAL")):
        holder = getattr(mod, name, None)
        if hasattr(holder, "clear"):
            holder.clear()


@pytest.fixture(autouse=True)
def _clean():
    _reset()
    yield
    _reset()


# ── (1) Alert dedupe now crosses instances ──────────────────────────────────

def test_the_budget_alert_dedupe_is_shared_not_per_process():
    """The in-process dict gave one alert PER INSTANCE per month — a CFO seeing
    the same budget warning N times, where N is however many instances are up."""
    assert not hasattr(main, "_BUDGET_ALERT_FIRED"), (
        "the per-process dict is back; it cannot dedupe across instances"
    )
    key = "budgetalert:agent-1:2026-08"
    assert shared_state.should_fire_once(key, 60) is True, "first instance fires"
    assert shared_state.should_fire_once(key, 60) is False, "second instance must not"


def test_fired_recently_peeks_without_claiming():
    """The budget alert has to answer 'already alerted this month?' BEFORE doing
    a month-to-date audit scan with per-row decryption — it runs on the hot path
    of every captured LLM call. Claiming early would burn the token on a call
    that then decides not to alert, and nothing would ever be sent."""
    key = "budgetalert:agent-2:2026-08"
    assert shared_state.fired_recently(key) is False
    assert shared_state.fired_recently(key) is False, "peeking must not claim"
    assert shared_state.should_fire_once(key, 60) is True
    assert shared_state.fired_recently(key) is True


def test_the_anomaly_check_keeps_a_local_prefilter_on_purpose():
    """⚠️ Where the plan's '1:1 onto should_fire_once' is wrong.

    `should_fire_once` fails toward FIRING when Redis is unreachable — correct
    for a notification, and the convention enforcement.py already sets. But this
    debounce does not gate a message, it gates an 8-day `audit_log` scan with
    per-row AES-GCM decryption, on the hot path of `ingest_llm_call` — i.e. once
    per captured LLM call. Applying the fail-open posture unguarded would turn
    every capture into a decrypting 8-day scan during a Redis outage.

    So the local dict survives as a cheap pre-filter. Removing it would look
    like a simplification and would be a load incident.
    """
    assert hasattr(main, "_ANOMALY_CHECK_LAST"), (
        "the local pre-filter is gone — a Redis outage now costs an 8-day "
        "decrypting scan per captured LLM call"
    )
    assert hasattr(main, "_ANOMALY_CHECK_MAX_TRACKED"), "the pre-filter must be bounded"


def test_the_anomaly_prefilter_is_bounded():
    """It grew one entry per agent forever. It is a cache, not a ledger."""
    ceiling = getattr(main, "_ANOMALY_CHECK_MAX_TRACKED", None)
    assert ceiling is not None, "the pre-filter grows one entry per agent forever"
    assert ceiling > 0
    assert ceiling <= 100_000, "a 'bound' that never binds"


# ── (2) The sensitivity cache: the one that quotes list price forever ───────

def test_an_override_write_invalidates_every_instance_not_just_this_one():
    """THE 2.7 test.

    `clear_override_caches()` cleared the dict on whichever instance took the
    write. With no TTL on that cache, every OTHER instance kept quoting the
    org's list price indefinitely — for a customer who had just told us their
    negotiated contract rate.

    The version marker means no instance has to be told: it is part of the cache
    key, so the next read simply misses.
    """
    org = "org-under-test"
    before = sf._overrides_version(org)
    sf.clear_override_caches(org)
    sf._OVERRIDES_VERSION_LOCAL.clear()   # simulate a DIFFERENT instance reading
    after = sf._overrides_version(org)
    assert after != before, "other instances would still serve the old pricing"


def test_invalidation_is_scoped_to_the_org_that_wrote():
    """One customer saving a rate must not throw away every other customer's
    cached sensitivities — that turns a cheap write into a fleet-wide stampede
    of perturbation recomputes."""
    sf.clear_override_caches("org-a")
    sf._OVERRIDES_VERSION_LOCAL.clear()
    assert sf._overrides_version("org-a") != "0"
    assert sf._overrides_version("org-b") == "0"


def test_clearing_without_an_org_still_works_but_only_locally():
    """Back-compat for any caller that has no org in hand. It must not raise —
    but it also must not silently look like a cross-instance bust."""
    sf.clear_override_caches()          # must not raise
    sf._OVERRIDES_VERSION_LOCAL.clear()
    assert sf._overrides_version("org-c") == "0", "no org means no cross-instance bust"


def test_the_sensitivity_cache_has_a_ttl_and_a_ceiling():
    """It had neither. The key includes a hash of the agent config, so every
    edit to every agent added a permanent entry — an unbounded dict on a
    long-lived process."""
    assert sf._SENSITIVITY_TTL_SECONDS > 0
    assert sf._SENSITIVITY_MAX_ENTRIES > 0
    assert sf._SENSITIVITY_TTL_SECONDS <= 3600, (
        "a very long TTL re-creates the staleness this item is about"
    )


def test_a_missing_redis_degrades_to_the_old_behaviour_rather_than_failing(monkeypatch):
    """A pricing cache must not take forecasts down. Without Redis we lose
    cross-instance invalidation — which is exactly where we started — but the
    forecast still renders."""
    def _boom():
        raise RuntimeError("redis gone")

    monkeypatch.setattr(shared_state, "client", _boom)
    sf._OVERRIDES_VERSION_LOCAL.clear()
    assert sf._overrides_version("org-d") == "0"    # constant, no raise
    sf.bump_overrides_version("org-d")              # must not raise


# ── (3) The batch forecast cache picks up the same marker ──────────────────

def test_the_batch_forecast_cache_keys_on_the_override_version():
    """It always had a 10-minute TTL, so staleness was bounded and self-healing —
    which is why the plan ranks it below the sensitivity cache. Ten minutes is
    still the wrong answer for the case that matters: a customer enters their
    negotiated rate, refreshes the Spend Dashboard, and is quoted list price by
    whichever instance answers."""
    import inspect

    src = inspect.getsource(main.get_spend_forecasts_batch)
    assert "_overrides_version(org_id)" in src, (
        "the batch cache key no longer tracks override writes; a rate change "
        "takes up to _BATCH_CACHE_TTL_SECONDS to show up"
    )


def test_override_writes_pass_the_org_through():
    """`_bust_forecast_caches()` with no org only ever fixed the local instance.
    All three write paths must pass it."""
    import inspect

    src = inspect.getsource(main)
    assert "_bust_forecast_caches()" not in src, (
        "an override write path still busts caches without an org — other "
        "instances keep the stale pricing"
    )
    assert src.count("_bust_forecast_caches(_org(user))") == 3
