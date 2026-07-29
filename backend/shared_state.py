"""Cross-worker shared state on Redis (Phase 3, PR-3).

Everything here used to live in per-process dicts, which broke the moment a
second worker existed: rate limits became N-times bypassable, a live trace
pushed on worker A never reached a WebSocket subscriber on worker B, and the
snapshot scheduler ran once per worker. This module is the single shared store.

There is deliberately NO in-memory fallback — a fallback would silently
re-introduce the exact multi-worker bugs this replaces. REDIS_URL must point at
a reachable Redis (docker-compose provides one locally and in CI).
"""

from __future__ import annotations

import os
import time
import uuid

import redis

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

# Socket timeouts (MED-007, partial): every call below sits on a request path, and
# the spend gate now blocks on one. Without these a degraded-but-reachable Redis
# hangs the caller until the OS gives up. Bounded here so a wedged Redis surfaces
# as a fast redis.RedisError the caller can fall back from. (The remaining half of
# MED-007 — calling these from async code via to_thread — is tracked separately.)
REDIS_TIMEOUT = float(os.environ.get("REDIS_TIMEOUT_SECONDS", "2"))

# Sync client for the fast request-path ops (rate limit, publish, locks). The
# WS subscribe loop uses redis.asyncio separately (see subscribe_channel).
_client = redis.Redis.from_url(
    REDIS_URL, decode_responses=True,
    socket_timeout=REDIS_TIMEOUT, socket_connect_timeout=REDIS_TIMEOUT,
)


def client() -> "redis.Redis":
    return _client


# ── Rate limiting: atomic sliding window ──────────────────────────────────────
# One Lua script so the check-and-increment can't race between workers (the old
# read-modify-write on a Python dict let two workers each admit the Nth request).
_SLIDING_WINDOW = _client.register_script(
    """
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    local member = ARGV[4]
    redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
    local count = redis.call('ZCARD', key)
    if count >= limit then
        return 0
    end
    redis.call('ZADD', key, now, member)
    redis.call('EXPIRE', key, window)
    return 1
    """
)


def rate_limit_ok(key: str, limit: int, window_seconds: int) -> bool:
    """True if this request is within the limit; False if it should be throttled."""
    now = time.time()
    member = f"{now}:{uuid.uuid4().hex}"
    allowed = _SLIDING_WINDOW(keys=[f"rl:{key}"], args=[now, window_seconds, limit, member])
    return bool(allowed)


# ── Live traces: bounded per-agent buffer + pub/sub fan-out ───────────────────
_TRACE_MAX = 500          # bound the poll buffer per agent
_TRACE_TTL = 300          # seconds; matches the old in-memory 5-min window


def _trace_key(agent_id: str) -> str:
    return f"trace:list:{agent_id}"


def channel(agent_id: str) -> str:
    return f"trace:chan:{agent_id}"


def push_trace(agent_id: str, entry_json: str) -> None:
    """Append to the agent's recent buffer AND publish for live subscribers.

    entry_json is a JSON string (already serialized by the caller). Publishing
    is what makes a trace pushed on any worker reach a WS subscriber on any
    other worker.
    """
    key = _trace_key(agent_id)
    pipe = _client.pipeline()
    pipe.lpush(key, entry_json)
    pipe.ltrim(key, 0, _TRACE_MAX - 1)
    pipe.expire(key, _TRACE_TTL)
    pipe.execute()
    _client.publish(channel(agent_id), entry_json)


def drain_traces(agent_id: str) -> list[str]:
    """Return the recent buffer (newest-last) and clear it — the poll endpoint's
    read-and-clear semantics, now atomic across workers."""
    key = _trace_key(agent_id)
    pipe = _client.pipeline()
    pipe.lrange(key, 0, -1)
    pipe.delete(key)
    items, _ = pipe.execute()
    return list(reversed(items))  # lpush stores newest-first; callers want oldest-first


def subscribe_channel(agent_id: str):
    """Async pubsub subscribed to this agent's channel, for the WS handler.

    Uses redis.asyncio so the WS coroutine can await messages without blocking
    the event loop. Caller is responsible for closing it.
    """
    import redis.asyncio as aioredis

    aclient = aioredis.Redis.from_url(
        REDIS_URL, decode_responses=True,
        socket_timeout=REDIS_TIMEOUT, socket_connect_timeout=REDIS_TIMEOUT,
    )
    pubsub = aclient.pubsub()
    return aclient, pubsub


# ── Distributed primitives: leader lock + fire-once dedup ─────────────────────

def try_acquire_leader(name: str, ttl_seconds: int) -> bool:
    """Best-effort leader election via SETNX+TTL. The holder re-acquires on each
    tick; if it dies, the lock expires and another worker takes over. Used so
    the snapshot scheduler runs on exactly one worker."""
    return bool(_client.set(f"leader:{name}", "1", nx=True, ex=ttl_seconds))


def should_fire_once(key: str, ttl_seconds: int) -> bool:
    """True the first time this key is seen within the TTL, False after — so two
    workers deciding the same BLOCK don't both fire a notification."""
    return bool(_client.set(f"once:{key}", "1", nx=True, ex=ttl_seconds))


# ── Spend counters: atomic month-to-date totals (MED-004) ─────────────────────
# The budget gate used to read month-to-date spend out of `audit_log`, compare it
# to the cap, and only then let the call through. That read-then-spend sequence is
# a TOCTOU window: a burst of concurrent calls all observe "under budget" before
# any of their spend is recorded, so the cap is routinely overshot. These counters
# move the check-and-increment into one atomic Redis op instead.
#
# A counter is authoritative only while it exists; it is seeded (`spend_hydrate`)
# from `audit_log` on a cold key and then maintained incrementally. The TTL
# outlives the month it keys, so a stale month's counter disappears on its own.
_SPEND_TTL = 40 * 24 * 3600

# Reserve-then-settle: the caller charges an estimate BEFORE the billable call and
# corrects it to the real cost after. Redis Lua truncates numbers to integers on
# return, so every dollar amount crosses the boundary as a string.
_SPEND_RESERVE = _client.register_script(
    """
    local key = KEYS[1]
    local cap = tonumber(ARGV[1])
    local amount = tonumber(ARGV[2])
    local ttl = tonumber(ARGV[3])
    local current = redis.call('GET', key)
    if not current then
        return {'cold', '0'}
    end
    if tonumber(current) >= cap then
        return {'over', current}
    end
    local total = redis.call('INCRBYFLOAT', key, amount)
    redis.call('EXPIRE', key, ttl)
    return {'ok', total}
    """
)

# Adjust an existing counter without creating one: a settle against a counter that
# has since expired must not resurrect it holding only that delta (which would
# under-count the month). Absent key -> no-op; the next cold read re-hydrates from
# audit_log and gets the truth.
_SPEND_ADJUST = _client.register_script(
    """
    local key = KEYS[1]
    if redis.call('EXISTS', key) == 0 then
        return 0
    end
    redis.call('INCRBYFLOAT', key, ARGV[1])
    redis.call('EXPIRE', key, tonumber(ARGV[2]))
    return 1
    """
)


def _spend_key(scope: str) -> str:
    return f"spend:{scope}"


def spend_reserve(scope: str, cap: float, amount: float) -> tuple[str, float]:
    """Atomically check the counter against `cap` and, if under, add `amount`.

    Returns (status, total): `ok` (reserved, total includes the reservation),
    `over` (at/above the cap — nothing added), or `cold` (no counter yet — the
    caller must `spend_hydrate` from the system of record and retry).
    """
    status, total = _SPEND_RESERVE(keys=[_spend_key(scope)], args=[cap, amount, _SPEND_TTL])
    return status, float(total)


def spend_hydrate(scope: str, value: float) -> None:
    """Seed a cold counter from the system of record. SET NX, so a concurrent
    hydrate or an already-counted reservation is never clobbered."""
    _client.set(_spend_key(scope), repr(float(value)), nx=True, ex=_SPEND_TTL)


def spend_adjust(scope: str, delta: float) -> None:
    """Apply a correction to a live counter (settle a reservation to its real cost,
    or release it entirely with the negative of what was reserved)."""
    _SPEND_ADJUST(keys=[_spend_key(scope)], args=[repr(float(delta)), _SPEND_TTL])


def spend_total(scope: str) -> float | None:
    """Current counter value, or None if cold. Read-only; for tests + diagnostics."""
    raw = _client.get(_spend_key(scope))
    return None if raw is None else float(raw)


# ── WebSocket connection caps ─────────────────────────────────────────────────
_WS_CONN_TTL = 3600  # safety expiry so a crashed worker's slot count self-heals


def ws_acquire_slot(agent_id: str, limit: int) -> bool:
    """Claim one live-trace WS slot for an agent (MED-008). INCR-then-check so the
    count is correct across workers; on overflow, DECR back and refuse. A TTL on
    the counter means a worker that dies without releasing can't leak slots."""
    key = f"ws:conns:{agent_id}"
    n = _client.incr(key)
    if n == 1:
        _client.expire(key, _WS_CONN_TTL)
    if n > limit:
        _client.decr(key)
        return False
    return True


def ws_release_slot(agent_id: str) -> None:
    """Release a slot claimed by ws_acquire_slot; floors at 0 so a stale/expired
    counter can't go negative."""
    key = f"ws:conns:{agent_id}"
    if _client.decr(key) < 0:
        _client.set(key, 0)


# ── Test support ──────────────────────────────────────────────────────────────

def _flush_for_tests() -> None:
    """Clear the (test) Redis database. conftest calls this between tests."""
    _client.flushdb()
