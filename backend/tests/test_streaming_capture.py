"""Phase-6 PR-4: the SDK captures STREAMING LLM calls, not just buffered ones.

Before this, wrap_llm skipped stream=True entirely — an agent that streamed half
its calls looked half as expensive to the forecaster. Now the returned stream is
wrapped in a transparent proxy that reports usage once the caller finishes
consuming it. Best-effort: it never alters items and never breaks the stream.

The SDK is a standalone package under sdk/; add it to the path so CI (which runs
backend/tests) exercises it.
"""

from __future__ import annotations

import os
import sys
import types

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "sdk")))

from arceo import _capture  # noqa: E402


NS = types.SimpleNamespace


@pytest.fixture()
def captured(monkeypatch):
    """Record report_llm_call invocations instead of firing the async POST."""
    calls = []
    monkeypatch.setattr(_capture, "report_llm_call",
                        lambda agent_id, **kw: calls.append({"agent_id": agent_id, **kw}))
    return calls


# ── Fake provider streams ──────────────────────────────────────────────────────

def _anthropic_stream():
    yield NS(type="message_start", message=NS(
        id="msg_1", model="claude-x",
        usage=NS(input_tokens=100, output_tokens=1,
                 cache_read_input_tokens=10, cache_creation_input_tokens=0)))
    yield NS(type="content_block_delta")
    yield NS(type="message_delta", usage=NS(output_tokens=42))  # cumulative → final
    yield NS(type="message_stop")


def _openai_stream(with_usage=True):
    yield NS(id="c1", model="gpt-4o", choices=[NS(delta=NS(content="hi"))], usage=None)
    yield NS(id="c1", model="gpt-4o", choices=[NS(delta=NS(content="!"))], usage=None)
    if with_usage:
        yield NS(id="c1", model="gpt-4o", choices=[],
                 usage=NS(prompt_tokens=50, completion_tokens=20, total_tokens=70,
                          prompt_tokens_details=NS(cached_tokens=8)))


def _fake_client(provider, stream_factory):
    """A minimal Anthropic/OpenAI-shaped client whose create() returns a stream."""
    resource = NS(create=lambda **kw: stream_factory())
    if provider == "anthropic":
        return NS(messages=resource)
    return NS(chat=NS(completions=resource))


# ── Tests ──────────────────────────────────────────────────────────────────────

def test_anthropic_stream_usage_captured_after_consumption(captured):
    client = _capture.wrap_llm(_fake_client("anthropic", _anthropic_stream),
                               "agent-x", provider="anthropic")
    stream = client.messages.create(model="claude-x", messages=[{"role": "user"}], stream=True)
    # Nothing reported until the stream is consumed.
    assert captured == []
    events = list(stream)
    assert len(events) == 4                      # every event passed through, unchanged
    assert len(captured) == 1
    usage = captured[0]["response"].usage
    assert usage["input_tokens"] == 100
    assert usage["output_tokens"] == 42          # final cumulative value, not the initial 1
    assert usage["cache_read_input_tokens"] == 10


def test_openai_stream_with_include_usage_captured(captured):
    client = _capture.wrap_llm(_fake_client("openai", lambda: _openai_stream(True)),
                               "agent-o", provider="openai")
    stream = client.chat.completions.create(model="gpt-4o", messages=[], stream=True,
                                            stream_options={"include_usage": True})
    chunks = list(stream)
    assert len(chunks) == 3
    assert len(captured) == 1
    usage = captured[0]["response"].usage
    assert usage["prompt_tokens"] == 50
    assert usage["completion_tokens"] == 20
    assert usage["prompt_tokens_details"] == {"cached_tokens": 8}


def test_openai_stream_without_usage_reports_nothing(captured):
    client = _capture.wrap_llm(_fake_client("openai", lambda: _openai_stream(False)),
                               "agent-o", provider="openai")
    stream = client.chat.completions.create(model="gpt-4o", messages=[], stream=True)
    chunks = list(stream)
    assert len(chunks) == 2          # items still flow
    assert captured == []            # no usage available → honest no-op, no crash


def test_stream_items_are_not_altered(captured):
    src = list(_anthropic_stream())
    client = _capture.wrap_llm(_fake_client("anthropic", lambda: iter(src)),
                               "agent-x", provider="anthropic")
    out = list(client.messages.create(stream=True))
    # Same objects, same order — the proxy is transparent.
    assert out == src


def test_capture_failure_never_breaks_the_stream(captured, monkeypatch):
    # If the per-item accumulator blows up, iteration must still complete.
    monkeypatch.setattr(_capture, "_accumulate_anthropic",
                        lambda acc, ev: (_ for _ in ()).throw(RuntimeError("boom")))
    client = _capture.wrap_llm(_fake_client("anthropic", _anthropic_stream),
                               "agent-x", provider="anthropic")
    events = list(client.messages.create(stream=True))
    assert len(events) == 4          # stream survived the capture error


def test_non_streaming_call_still_captured(captured):
    resp = NS(id="msg", model="claude-x", usage=NS(input_tokens=5, output_tokens=7))
    client = NS(messages=NS(create=lambda **kw: resp))
    wrapped = _capture.wrap_llm(client, "agent-x", provider="anthropic")
    got = wrapped.messages.create(model="claude-x", messages=[])
    assert got is resp               # buffered response returned unchanged
    assert len(captured) == 1        # and still reported


def test_context_manager_stream_reports_on_exit(captured):
    # A stream used as a context manager reports usage when the block exits, even
    # if not every event is pulled.
    class CtxStream:
        def __init__(self, gen):
            self._gen = gen
            self.entered = self.exited = False
        def __enter__(self):
            self.entered = True
            return self
        def __exit__(self, *a):
            self.exited = True
            return False
        def __iter__(self):
            return self._gen

    client = _capture.wrap_llm(_fake_client("anthropic", lambda: CtxStream(_anthropic_stream())),
                               "agent-x", provider="anthropic")
    with client.messages.create(stream=True) as stream:
        for _ in stream:
            pass
    assert len(captured) == 1
    assert captured[0]["response"].usage["output_tokens"] == 42
