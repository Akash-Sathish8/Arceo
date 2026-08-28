"""Tier 2.2 and 2.8 — two failures the app used to hide from itself.

2.2: `/api/health` returned a static 200 with no dependency probe, and the
Dockerfile HEALTHCHECK polls it. Every failure that happens AFTER a successful
boot — Postgres fails over, credentials rotate, the bounded pool wedges — left
the container green while every real endpoint 500'd.

2.8: the scheduler's leader-lock acquire sat outside every try/except, so one
RedisError killed the thread permanently. All three job bodies are individually
guarded with "scheduler must never die"; the one call that could actually kill
it was the unguarded one.

Both are the same defect class as 2.3 and 2.9: the system's own report of its
health disagreed with reality, in the direction that keeps traffic flowing to a
broken instance.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

import main


# ── 2.2: liveness stays dumb, readiness gets real ────────────────────────────

def test_health_stays_a_pure_liveness_probe(client):
    """Explicitly pinned as UNCHANGED. A liveness probe that depends on Postgres
    restarts the container during a database blip — the opposite of the
    intent — and this one is also rate-limit exempt and load-tested."""
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_ready_reports_ready_when_the_database_answers(client):
    r = client.get("/api/ready")
    assert r.status_code == 200
    assert r.json()["status"] == "ready"


def test_ready_reports_503_when_the_database_is_gone(client, monkeypatch):
    """THE 2.2 test. This is the state that used to render as a green
    container: booted fine, database now unreachable, every real endpoint
    500ing, health check still 200."""
    main._ready_cache = None

    def _boom():
        raise RuntimeError("connection pool exhausted")

    monkeypatch.setattr(main, "get_db", _boom)
    r = client.get("/api/ready")
    assert r.status_code == 503
    assert r.json()["status"] == "not ready"
    assert "database" in r.json()["detail"]
    # Liveness must NOT follow readiness down, or the orchestrator kills a
    # container that would have recovered when the database came back.
    assert client.get("/api/health").status_code == 200
    main._ready_cache = None


def test_readiness_is_cached_so_it_cannot_be_used_to_hammer_the_pool(client):
    """`/api/ready` is unauthenticated AND rate-limit exempt, so without the
    cache it is a way to make the app open a database connection as fast as you
    can send requests — against a pool bounded at 10.

    Asserts on the cache tuple's IDENTITY rather than by counting `get_db`
    calls. Counting is the obvious approach and it is wrong here: the snapshot
    scheduler runs as a daemon thread during the suite and calls `get_db` too,
    so a global counter attributes its work to this endpoint. A fresh probe
    would rebind `_ready_cache` to a new tuple; the same object means no probe.
    """
    main._ready_cache = None
    assert client.get("/api/ready").status_code == 200
    first = main._ready_cache
    assert first is not None, "the first request should have populated the cache"

    for _ in range(24):
        assert client.get("/api/ready").status_code == 200
    assert main._ready_cache is first, (
        "the readiness probe re-ran within the cache window — the cache is not "
        "holding, and the endpoint is a free way to exhaust the connection pool"
    )
    main._ready_cache = None


def test_the_cache_expires_so_recovery_is_detected(client, monkeypatch):
    """The counterweight to the test above: caching must not make an instance
    permanently unready after a transient blip."""
    main._ready_cache = (time.time() - 3600, False, "database unreachable: Boom")
    r = client.get("/api/ready")
    assert r.status_code == 200, "a stale failure must not outlive the cache window"
    main._ready_cache = None


def test_ready_is_exempt_from_the_global_rate_limit():
    """A probe that gets 429'd marks the instance unready, which sheds its
    traffic onto siblings and cascades. Pinned as configuration, since
    exercising the limiter here would be slow and order-dependent."""
    assert "/api/ready" in main._RATE_LIMIT_EXEMPT_PATHS
    assert "/api/health" in main._RATE_LIMIT_EXEMPT_PATHS


# ── 2.2: the SPA catch-all must not answer for /api/ ──────────────────────────

_STATIC_EXISTS = (Path(main.__file__).parent / "static").exists()


@pytest.mark.skipif(
    not _STATIC_EXISTS,
    reason="the SPA catch-all is only registered when backend/static/ exists, "
           "which is gitignored — so this runs in a built container, not in CI",
)
def test_an_unknown_api_path_404s_instead_of_returning_the_spa(client):
    """The catch-all returned index.html with a 200 for ANY unmatched GET,
    including /api/..., and frontend/src/lib/api.ts turns a non-JSON 200 into
    `{} as T`. So a typo'd or removed endpoint reached the caller as an empty
    object: "no agents", "no policies", "no spend" — an empty state instead of
    an error."""
    r = client.get("/api/definitely-not-a-real-endpoint")
    assert r.status_code == 404
    assert "<!doctype html" not in r.text.lower()


def test_unknown_api_paths_404_even_without_the_catch_all(client):
    """Runs everywhere. Without backend/static/ the catch-all is not registered
    at all, so this asserts the baseline the guard preserves rather than the
    guard itself — if this ever returns 200, something has started serving
    unmatched API paths again."""
    assert client.get("/api/definitely-not-a-real-endpoint").status_code == 404


# ── 2.8: one Redis blip must not kill the scheduler ──────────────────────────

def _only_this_thread(fn):
    """Confine a patched `try_acquire_leader` to the calling thread.

    The REAL snapshot scheduler is already running as a daemon thread in the
    test process, and it calls the same function. Patching it globally makes the
    background thread raise our sentinel too, which surfaces as a
    PytestUnhandledThreadExceptionWarning and silently kills the real scheduler
    for the rest of the session. Everyone else just doesn't win the election.
    """
    import threading
    caller = threading.current_thread()

    def _wrapped(*a, **kw):
        if threading.current_thread() is not caller:
            return False
        return fn(*a, **kw)

    return _wrapped


class _StopLoop(BaseException):
    """Escape hatch for `while True`.

    ⚠️ Deliberately a BaseException, not an Exception. The guard under test
    catches `Exception` — that is the whole point of it — so an Exception-derived
    sentinel gets swallowed and the loop spins forever. (It did, on the first
    draft of this file: 2.8 GB of accumulated log records before it was killed.
    An inconvenient way to confirm the guard is doing its job.)
    """

def test_a_redis_error_in_the_leader_lock_no_longer_escapes(monkeypatch, caplog):
    """THE 2.8 test.

    `try_acquire_leader` does a bare `_client.set` with no fallback (by design),
    so a RedisError from a restart or failover propagated out of `while True:`
    and killed the daemon thread permanently — no supervision, no ERROR log.
    Dead with it: forecast snapshots, the weekly digest, and the only automated
    data-retention control we have.
    """
    import redis

    ticks = {"n": 0}

    def _explode(*_a, **_kw):
        ticks["n"] += 1
        if ticks["n"] >= 3:
            raise _StopLoop()
        raise redis.ConnectionError("MASTERDOWN")

    monkeypatch.setattr(main.shared_state, "try_acquire_leader", _only_this_thread(_explode))
    monkeypatch.setattr(main.time, "sleep", lambda _s: None)

    with caplog.at_level("ERROR"):
        with pytest.raises(_StopLoop):
            main._snapshot_scheduler_loop()

    # It kept ticking rather than dying on the first error.
    assert ticks["n"] == 3, "the loop exited on the first Redis error"
    assert any("leader-lock" in r.getMessage() for r in caplog.records), (
        "a tick that accomplished nothing must be logged at ERROR — the old "
        "failure was silent, which is why nobody noticed the thread was gone"
    )


def test_losing_the_lock_is_not_treated_as_an_error(monkeypatch, caplog):
    """The counterweight. Not winning the lock is the NORMAL state for every
    non-leader worker; logging it as an error would make the real failure
    above invisible in the noise."""
    ticks = {"n": 0}

    def _never_leader(*_a, **_kw):
        ticks["n"] += 1
        if ticks["n"] >= 3:
            raise _StopLoop()
        return False

    monkeypatch.setattr(main.shared_state, "try_acquire_leader", _only_this_thread(_never_leader))
    monkeypatch.setattr(main.time, "sleep", lambda _s: None)

    with caplog.at_level("ERROR"):
        with pytest.raises(_StopLoop):
            main._snapshot_scheduler_loop()

    assert not [r for r in caplog.records if r.levelname == "ERROR"], (
        "losing the leader election is routine, not an error"
    )
