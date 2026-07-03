"""Persistent LLM-classification cache: round-trip, degradation, versioning, votes."""

from __future__ import annotations

import json
import sys
import types

import pytest

import authority.risk_classifier as rc
from conftest import REAL_CLASSIFY_WITH_LLM


def test_cache_roundtrip_survives_memory_loss():
    key = rc._cache_key("test_action_roundtrip", "a description")
    rc._cache_put(key, "test_action_roundtrip", "a description", ["moves_money"], False, 3)
    # Simulate a process restart: wipe L1, read must come back from SQLite
    rc._llm_cache.clear()
    assert rc._cache_get(key) == (["moves_money"], False)


def test_prompt_version_changes_cache_key(monkeypatch):
    k1 = rc._cache_key("some_action", "desc")
    monkeypatch.setattr(rc, "PROMPT_VERSION", rc.PROMPT_VERSION + 1)
    k2 = rc._cache_key("some_action", "desc")
    assert k1 != k2


def test_schema_keys_change_cache_key():
    base = rc._cache_key("act", "d")
    with_schema = rc._cache_key("act", "d", {"email": {}, "phone": {}})
    assert base != with_schema
    # order-insensitive
    assert with_schema == rc._cache_key("act", "d", {"phone": {}, "email": {}})


def test_cache_degrades_gracefully_without_db(monkeypatch):
    from pathlib import Path

    import db as _db

    monkeypatch.setattr(_db, "DB_PATH", Path("/nonexistent-dir/nope/x.db"))
    monkeypatch.setattr(rc, "_cache_table_ready", False)
    rc._llm_cache.clear()
    rc._pending_cache_rows.clear()
    key = rc._cache_key("no_db_action", "")
    assert rc._cache_get(key) is None
    # put must not raise — best-effort; L1 still works
    rc._cache_put(key, "no_db_action", "", ["deletes_data"], True, 1)
    assert rc._cache_get(key) == (["deletes_data"], True)
    rc._pending_cache_rows.clear()


def test_cache_write_survives_callers_open_transaction():
    """The live bug: create_agent classifies INSIDE an open write transaction
    on the app DB. The cache lives in its own file precisely so that write
    succeeds immediately — no lock contention, no 10s stall, no lost rows."""
    import db as _db

    rc._llm_cache.clear()
    rc._pending_cache_rows.clear()
    outer = _db.get_conn()
    outer.execute("CREATE TABLE IF NOT EXISTS _lock_probe (x)")
    outer.commit()
    outer.execute("INSERT INTO _lock_probe VALUES (1)")  # hold the app-DB write lock
    try:
        key = rc._cache_key("locked_db_action", "")
        rc._cache_put(key, "locked_db_action", "", ["moves_money"], False, 3)
        assert not rc._pending_cache_rows, "separate cache file must not contend with app-DB locks"
        # Survives L1 loss while the app transaction is STILL open.
        rc._llm_cache.clear()
        assert rc._cache_get(key) == (["moves_money"], False)
    finally:
        outer.rollback()
        outer.close()


class _FakeAnthropic:
    """Fake anthropic module whose client returns queued responses."""

    def __init__(self, payloads):
        self._payloads = list(payloads)
        outer = self

        class _Messages:
            def create(self, **kwargs):
                assert kwargs.get("temperature") == 0, "classification must run at temperature=0"
                payload = outer._payloads.pop(0)
                block = types.SimpleNamespace(text=json.dumps(payload))
                return types.SimpleNamespace(content=[block])

        class Anthropic:
            def __init__(self, api_key=None):
                self.messages = _Messages()

        self.Anthropic = Anthropic


def _run_real_llm(monkeypatch, action, payloads):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
    monkeypatch.setitem(sys.modules, "anthropic", _FakeAnthropic(payloads))
    rc._llm_cache.clear()
    return REAL_CLASSIFY_WITH_LLM(action, "vote test")


def test_majority_vote_drops_minority_labels(monkeypatch):
    result = _run_real_llm(monkeypatch, "vote_action_majority", [
        {"risk_labels": ["moves_money"], "reversible": False},
        {"risk_labels": ["moves_money", "touches_pii"], "reversible": True},
        {"risk_labels": ["moves_money"], "reversible": False},
    ])
    # moves_money 3/3 kept; touches_pii 1/3 dropped; irreversible 2/3 wins
    assert result == (["moves_money"], False)


def test_vote_failure_degrades_to_successful_votes(monkeypatch):
    class _Flaky(_FakeAnthropic):
        def __init__(self, payloads):
            super().__init__(payloads)
            fail_first = {"n": 0}
            orig_create = self.Anthropic("x").messages.create  # noqa: F841
            outer = self

            class _Messages:
                def create(self, **kwargs):
                    fail_first["n"] += 1
                    if fail_first["n"] == 1:
                        raise RuntimeError("transient API error")
                    payload = outer._payloads.pop(0)
                    block = types.SimpleNamespace(text=json.dumps(payload))
                    return types.SimpleNamespace(content=[block])

            class Anthropic:
                def __init__(self, api_key=None):
                    self.messages = _Messages()

            self.Anthropic = Anthropic

    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
    monkeypatch.setitem(sys.modules, "anthropic", _Flaky([
        {"risk_labels": ["sends_external"], "reversible": False},
        {"risk_labels": ["sends_external"], "reversible": False},
    ]))
    rc._llm_cache.clear()
    result = REAL_CLASSIFY_WITH_LLM("vote_action_flaky", "vote test")
    assert result == (["sends_external"], False)


def test_result_is_cached_after_vote(monkeypatch):
    _run_real_llm(monkeypatch, "vote_action_cached", [
        {"risk_labels": ["deletes_data"], "reversible": False},
        {"risk_labels": ["deletes_data"], "reversible": False},
        {"risk_labels": ["deletes_data"], "reversible": False},
    ])
    # Second call: fake module has no payloads left — must hit the cache
    monkeypatch.setitem(sys.modules, "anthropic", _FakeAnthropic([]))
    assert REAL_CLASSIFY_WITH_LLM("vote_action_cached", "vote test") == (["deletes_data"], False)
    # And survives L1 loss via SQLite
    rc._llm_cache.clear()
    assert REAL_CLASSIFY_WITH_LLM("vote_action_cached", "vote test") == (["deletes_data"], False)