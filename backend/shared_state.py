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

# Sync client for the fast request-path ops (rate limit, publish, locks). The
# WS subscribe loop uses redis.asyncio separately (see subscribe_channel).
_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)


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

    aclient = aioredis.Redis.from_url(REDIS_URL, decode_responses=True)
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


# ── Test support ──────────────────────────────────────────────────────────────

def _flush_for_tests() -> None:
    """Clear the (test) Redis database. conftest calls this between tests."""
    _client.flushdb()
