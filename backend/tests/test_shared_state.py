"""Phase-3 PR-3: shared state survives a second worker.

These prove the properties that per-process dicts couldn't: a rate-limit window
shared across "workers" (no N-times bypass), pub/sub fan-out (a trace published
"on worker A" reaches a subscriber "on worker B"), and the primitives behind the
scheduler leader lock and notification dedup.
"""

from __future__ import annotations

import json
import uuid

import shared_state


def test_rate_limit_is_shared_not_per_worker():
    # One logical client, one shared window. Simulating "two workers" is just
    # two callers hitting the same Redis key — the limit must hold in aggregate,
    # NOT reset per caller (the old per-process dict gave each worker its own).
    key = "test:" + uuid.uuid4().hex
    limit, window = 5, 60
    allowed = sum(1 for _ in range(20) if shared_state.rate_limit_ok(key, limit, window))
    assert allowed == limit, f"expected exactly {limit} allowed across the shared window, got {allowed}"


def test_sliding_window_frees_up_after_expiry(monkeypatch):
    key = "test-slide:" + uuid.uuid4().hex
    # Fill the window at t=1000.
    monkeypatch.setattr(shared_state.time, "time", lambda: 1000.0)
    for _ in range(3):
        assert shared_state.rate_limit_ok(key, 3, 10)
    assert not shared_state.rate_limit_ok(key, 3, 10)
    # Jump past the window — the old entries age out, requests flow again.
    monkeypatch.setattr(shared_state.time, "time", lambda: 1020.0)
    assert shared_state.rate_limit_ok(key, 3, 10)


def test_pubsub_fanout_crosses_workers():
    import redis as _redis

    agent_id = "agent-" + uuid.uuid4().hex[:6]
    # A subscriber "on worker B": its own connection, subscribed to the channel.
    sub = _redis.Redis.from_url(shared_state.REDIS_URL, decode_responses=True)
    pubsub = sub.pubsub()
    pubsub.subscribe(shared_state.channel(agent_id, "org-x"))
    # Drain the subscribe-confirmation message.
    assert pubsub.get_message(timeout=1)["type"] == "subscribe"

    # "Worker A" publishes via the normal push path.
    entry = {"agent_id": agent_id, "tool": "stripe", "action": "create_refund"}
    shared_state.push_trace(agent_id, json.dumps(entry), "org-x")

    # Worker B's subscriber receives it.
    got = None
    for _ in range(10):
        msg = pubsub.get_message(timeout=1)
        if msg and msg["type"] == "message":
            got = json.loads(msg["data"])
            break
    pubsub.close()
    sub.close()
    assert got == entry, "trace published on one connection did not reach the other"


def test_buffer_drain_is_read_and_clear():
    agent_id = "agent-" + uuid.uuid4().hex[:6]
    for i in range(3):
        shared_state.push_trace(agent_id, json.dumps({"i": i}), "org-x")
    drained = [json.loads(e) for e in shared_state.drain_traces(agent_id, "org-x")]
    assert [d["i"] for d in drained] == [0, 1, 2]  # oldest-first
    assert shared_state.drain_traces(agent_id, "org-x") == []  # cleared


def test_leader_lock_admits_one():
    name = "sched-" + uuid.uuid4().hex[:6]
    assert shared_state.try_acquire_leader(name, 30) is True
    # A second worker trying the same tick loses.
    assert shared_state.try_acquire_leader(name, 30) is False


def test_fire_once_dedups():
    key = "block:" + uuid.uuid4().hex[:6]
    assert shared_state.should_fire_once(key, 60) is True
    assert shared_state.should_fire_once(key, 60) is False  # second worker: suppressed
