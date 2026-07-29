"""MED-006 / MED-007 / MED-008 — the three concurrency + timeout findings.

They compound, which is why they ship together:

  MED-006 — seven LLM handlers were sync `def`, so Starlette ran them in AnyIO's
    fixed 40-token threadpool and each held a token for the whole multi-minute
    job. ~40 concurrent sweeps took every slot, and since login and /api/enforce
    are also sync `def`, the entire instance stalled for every tenant.
  MED-008 — the OpenAI-compatible client had no timeout, so the SDK's 600s default
    applied and one hung upstream pinned a MED-006 threadpool slot for ten minutes.
  MED-007 — the synchronous Redis client was called straight from async middleware,
    so a blocking socket read ran ON the event-loop thread.
"""

from __future__ import annotations

import anyio
import pytest
import redis

import llm_models
import main
import shared_state


# ── MED-008: the OpenAI-compatible client is bounded ──────────────────────────

def _stub_openai_sdk(monkeypatch) -> dict:
    """Inject a fake `openai` module and return the kwargs the client was built
    with. The SDK is an OPTIONAL dependency — it's in neither requirements.txt nor
    the CI lockfile — so importorskip here would mean MED-008 ships with its
    assertions silently skipped in CI. Stubbing keeps them running everywhere."""
    import sys
    import types

    captured: dict = {}
    mod = types.ModuleType("openai")

    class _OpenAI:
        def __init__(self, **kw):
            captured.update(kw)

    mod.OpenAI = _OpenAI
    monkeypatch.setitem(sys.modules, "openai", mod)
    return captured


def test_openai_client_carries_a_bounded_timeout_and_retry_cap(monkeypatch):
    """It was the lone LLM path with neither — anthropic_client() and the Ollama
    call both already passed one."""
    captured = _stub_openai_sdk(monkeypatch)
    llm_models.openai_client(api_key="test-key", base_url="https://provider.invalid")

    assert captured["timeout"] == llm_models.OPENAI_TIMEOUT
    assert captured["max_retries"] == llm_models.OPENAI_MAX_RETRIES
    assert captured["base_url"] == "https://provider.invalid"
    # Well under the SDK's 600s default, which is the whole point.
    assert llm_models.OPENAI_TIMEOUT <= 120


def test_openai_timeout_is_env_tunable(monkeypatch):
    monkeypatch.setenv("ARCEO_OPENAI_TIMEOUT", "12.5")
    import importlib
    importlib.reload(llm_models)
    try:
        assert llm_models.OPENAI_TIMEOUT == 12.5
    finally:
        monkeypatch.delenv("ARCEO_OPENAI_TIMEOUT", raising=False)
        importlib.reload(llm_models)


def test_runner_builds_its_openai_client_through_the_helper(monkeypatch):
    """Pins the contract: _call_openai must not construct OpenAI() directly again."""
    seen = {}

    def _spy(api_key=None, base_url=None):
        seen["called"] = True
        raise RuntimeError("stop here — construction is all we're checking")

    monkeypatch.setattr(llm_models, "openai_client", _spy)
    from sandbox import runner
    with pytest.raises(RuntimeError):
        runner._call_openai("gpt-4o", "sys", [], [], base_url="https://example.invalid")
    assert seen.get("called") is True


# ── MED-007: Redis fail posture is explicit ───────────────────────────────────

def _redis_down(monkeypatch):
    def _boom(*a, **k):
        raise redis.ConnectionError("connection refused")
    monkeypatch.setattr(shared_state, "_SLIDING_WINDOW", _boom)


def test_rate_limit_fails_closed_by_default(monkeypatch):
    """A limiter that can't count must not wave traffic through — this is what
    protects login from brute force."""
    _redis_down(monkeypatch)
    assert shared_state.rate_limit_ok("auth-ip:1.2.3.4", 10, 900) is False


def test_rate_limit_fails_open_when_asked(monkeypatch):
    """The broad per-caller limit is DoS hygiene, not a security control. Failing
    it closed would take the whole API down with the cache."""
    _redis_down(monkeypatch)
    assert shared_state.rate_limit_ok("global:ip:1.2.3.4", 600, 60, fail_open=True) is True


def test_login_still_refuses_when_redis_is_down(client, monkeypatch):
    """End to end: the auth limiter is fail-closed, so a Redis outage can't be used
    to strip brute-force protection."""
    _redis_down(monkeypatch)
    r = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "x"})
    assert r.status_code == 429


def test_the_api_stays_up_when_redis_is_down(client, monkeypatch):
    """...while the global limiter degrades to unlimited rather than 500ing or
    503ing every route."""
    _redis_down(monkeypatch)
    assert client.get("/api/health").status_code == 200


def test_redis_clients_have_socket_timeouts():
    """Shipped in PR #127; pinned here so it can't regress — an unbounded socket
    read is what made the event-loop stall unbounded too."""
    assert shared_state.REDIS_TIMEOUT > 0
    kw = shared_state._client.get_connection_kwargs()
    assert kw.get("socket_timeout") == shared_state.REDIS_TIMEOUT
    assert kw.get("socket_connect_timeout") == shared_state.REDIS_TIMEOUT


# ── MED-006: heavy jobs are bounded and don't own the threadpool ──────────────

def test_the_heavy_handlers_are_async(client):
    """The core of the fix: a sync `def` handler holds an AnyIO threadpool token
    for its entire multi-minute run. These are wrappers now."""
    import inspect
    for name in ("run_sandbox_simulation", "run_multi_agent_simulation",
                 "run_prelaunch_audit_endpoint", "run_regression_test_endpoint",
                 "run_red_team_endpoint", "run_boundary_test_endpoint", "run_sweep"):
        fn = getattr(main, name)
        assert inspect.iscoroutinefunction(fn), f"{name} is still a sync def"


def test_the_limiter_is_well_below_the_threadpool_size():
    """40 is AnyIO's default capacity. If the heavy limiter approached it, the fix
    would be decorative — the point is that slots remain for auth and enforce."""
    assert 0 < main.HEAVY_JOB_CONCURRENCY <= 16
    assert main._heavy_job_limiter.total_tokens == main.HEAVY_JOB_CONCURRENCY


# These drive the limiter directly. anyio is installed but no pytest async plugin
# is, so each runs its own loop rather than adding a test dependency.

def test_only_n_heavy_jobs_run_at_once():
    """The invariant: concurrency never exceeds the limiter, no matter how many
    callers arrive at once."""
    import time

    live = 0
    peak = 0

    def _slow_job():
        nonlocal live, peak
        live += 1
        peak = max(peak, live)
        time.sleep(0.05)
        live -= 1
        return "done"

    async def _drive():
        async with anyio.create_task_group() as tg:
            for _ in range(main.HEAVY_JOB_CONCURRENCY * 3):
                tg.start_soon(main._run_heavy_job, _slow_job)

    anyio.run(_drive)
    assert peak <= main.HEAVY_JOB_CONCURRENCY, f"peak concurrency {peak}"


def test_queued_callers_get_503_rather_than_waiting_forever(monkeypatch):
    """Backpressure has to be visible. An unbounded queue just moves the stall."""
    import time

    from fastapi import HTTPException

    monkeypatch.setattr(main, "HEAVY_JOB_QUEUE_TIMEOUT", 0.05)
    monkeypatch.setattr(main, "_heavy_job_limiter", anyio.CapacityLimiter(1))
    captured = {}

    async def _drive():
        async with anyio.create_task_group() as tg:
            tg.start_soon(main._run_heavy_job, lambda: time.sleep(0.5))
            await anyio.sleep(0.05)  # let the blocker take the only slot
            try:
                await main._run_heavy_job(lambda: "should never run")
            except HTTPException as exc:
                captured["exc"] = exc

    anyio.run(_drive)
    assert captured["exc"].status_code == 503
    assert "capacity" in captured["exc"].detail.lower()


def test_a_slot_is_released_even_when_the_job_raises():
    """A leaked slot would shrink capacity permanently, one failed sweep at a time."""
    before = main._heavy_job_limiter.available_tokens

    def _explode():
        raise ValueError("job failed")

    async def _drive():
        with pytest.raises(ValueError):
            await main._run_heavy_job(_explode)

    anyio.run(_drive)
    assert main._heavy_job_limiter.available_tokens == before


def test_the_job_result_is_returned_unchanged():
    def _job(a, b, *, c):
        return {"sum": a + b + c}

    assert anyio.run(lambda: main._run_heavy_job(_job, 1, 2, c=3)) == {"sum": 6}


def test_a_light_route_stays_responsive_while_heavy_jobs_are_queued(client, monkeypatch):
    """The finding's own verification: launch far more heavy jobs than the pool
    allows, and assert a lightweight route still answers instead of queuing behind
    them. Uses the real HTTP stack with a stubbed job body."""
    import threading
    import time

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    admin_headers = None

    def _slow_impl(req, user):
        time.sleep(0.4)
        return {"ok": True}

    monkeypatch.setattr(main, "_run_sweep_impl", _slow_impl)

    r = client.post("/api/auth/signup", json={
        "email": f"load-{id(monkeypatch)}@example.com", "password": "pw12345678",
        "org_name": "LoadTest"})
    assert r.status_code == 200, r.text
    admin_headers = {"Authorization": f"Bearer {r.json()['token']}"}

    errors: list = []

    def _fire():
        try:
            client.post("/api/sandbox/sweep", headers=admin_headers,
                        json={"agent_id": "nonexistent", "dry_run": True})
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=_fire) for _ in range(main.HEAVY_JOB_CONCURRENCY * 2)]
    for t in threads:
        t.start()
    time.sleep(0.15)  # let them pile up

    t0 = time.time()
    health = client.get("/api/health")
    elapsed = time.time() - t0

    for t in threads:
        t.join(timeout=30)

    assert health.status_code == 200
    assert elapsed < 1.0, f"/api/health took {elapsed:.2f}s behind queued heavy jobs"
