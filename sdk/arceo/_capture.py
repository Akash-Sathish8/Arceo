"""Capture LLM completions and report token usage to Arceo.

The report feeds Arceo's cost forecaster: once ~50 calls land in a 7-day window
the forecast moves to its high-confidence tier. Capture is async (a daemon
thread) and wrapped in try/except end to end, so it can never slow down or break
the wrapped call.

By default only token usage + request *shape* (provider, model, message/tool
counts) is sent — never prompt or response content. Pass capture_prompts=True to
also include the system prompt.
"""
from __future__ import annotations

import json
import os
import threading
import time
import types
import urllib.request
from typing import Any, Optional

DEFAULT_BASE_URL = os.getenv("ARCEO_BASE_URL", "http://localhost:8000")
DEFAULT_API_KEY = os.getenv("ARCEO_API_KEY", "")


def _post_async(url: str, payload: dict, timeout: float = 5.0, api_key: Optional[str] = None) -> None:
    """Fire-and-forget POST in a daemon thread. Never raises into the caller.

    The capture endpoint (/api/agent/{id}/llm-call) requires a valid X-API-Key
    scoped to the agent's org — without one it 401s and, since capture is
    best-effort, the call is silently dropped and NOTHING is recorded. Supply the
    key explicitly (api_key=) or via the ARCEO_API_KEY env var.
    """
    key = api_key or DEFAULT_API_KEY

    def _run() -> None:
        try:
            data = json.dumps(payload).encode("utf-8")
            headers = {"Content-Type": "application/json"}
            if key:
                headers["X-API-Key"] = key
            req = urllib.request.Request(
                url, data=data, headers=headers, method="POST"
            )
            urllib.request.urlopen(req, timeout=timeout).close()
        except Exception:
            pass  # capture is best-effort; never break the agent

    threading.Thread(target=_run, daemon=True).start()


def _usage_dict(response: Any) -> Optional[dict]:
    """Pull the provider's usage block as a plain dict (Anthropic or OpenAI shape)."""
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    if usage is None:
        return None
    if hasattr(usage, "model_dump"):
        try:
            return usage.model_dump()
        except Exception:
            pass
    if isinstance(usage, dict):
        return usage
    out: dict = {}
    for k in ("input_tokens", "output_tokens", "cache_read_input_tokens",
              "cache_creation_input_tokens", "prompt_tokens", "completion_tokens"):
        v = getattr(usage, k, None)
        if v is not None:
            out[k] = v
    details = getattr(usage, "prompt_tokens_details", None)
    if details is not None:
        cached = getattr(details, "cached_tokens", None)
        if cached is not None:
            out["prompt_tokens_details"] = {"cached_tokens": cached}
    return out or None


def _roles(messages) -> list:
    out = []
    for m in messages or []:
        role = m.get("role", "") if isinstance(m, dict) else getattr(m, "role", "")
        out.append({"role": role})
    return out


def _tool_names(tools) -> list:
    out = []
    for t in tools or []:
        name = t.get("name", "") if isinstance(t, dict) else getattr(t, "name", "")
        out.append({"name": name})
    return out


def report_llm_call(
    agent_id: str,
    *,
    provider: str,
    model: str,
    response: Any,
    base_url: str = DEFAULT_BASE_URL,
    system: Any = "",
    messages: Optional[list] = None,
    tools: Optional[list] = None,
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    latency_ms: float = 0,
    capture_prompts: bool = False,
    api_key: Optional[str] = None,
) -> None:
    """Report one captured LLM call to Arceo (async, best-effort).

    api_key is the Arceo X-API-Key the capture endpoint requires (falls back to
    the ARCEO_API_KEY env var). Without a valid key the endpoint 401s and the
    call is silently dropped — capture is best-effort by design."""
    usage = _usage_dict(response)
    resp_payload: dict = {}
    if usage:
        resp_payload["usage"] = usage
    rid = getattr(response, "id", None)
    if rid:
        resp_payload["id"] = rid
    resp_payload["model"] = getattr(response, "model", None) or model

    system_str = ""
    if capture_prompts and system:
        system_str = json.dumps(system) if isinstance(system, (list, dict)) else str(system)

    payload = {
        "provider": provider,
        "model": model,
        "system": system_str,
        "messages": _roles(messages),     # count + role only, no content
        "tools": _tool_names(tools),      # count + name only
        "max_tokens": max_tokens,
        "temperature": temperature,
        "latency_ms": int(latency_ms),
        "response": resp_payload,
    }
    _post_async(base_url.rstrip("/") + f"/api/agent/{agent_id}/llm-call", payload, api_key=api_key)


def _get(obj: Any, key: str, default=None):
    """Attribute-or-key access, so we handle both SDK objects and raw dicts."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _accumulate_anthropic(acc: dict, event: Any) -> None:
    """Fold one Anthropic stream event into the usage accumulator.

    input_tokens (+ cache tokens) arrive on message_start; output_tokens is
    reported cumulatively on each message_delta, so the last one is the total."""
    et = _get(event, "type")
    if et == "message_start":
        msg = _get(event, "message")
        if msg is not None:
            acc["id"] = _get(msg, "id") or acc.get("id")
            acc["model"] = _get(msg, "model") or acc.get("model")
            u = _get(msg, "usage")
            if u is not None:
                for k in ("input_tokens", "output_tokens",
                          "cache_read_input_tokens", "cache_creation_input_tokens"):
                    v = _get(u, k)
                    if v is not None:
                        acc["usage"][k] = v
    elif et == "message_delta":
        u = _get(event, "usage")
        if u is not None:
            ot = _get(u, "output_tokens")
            if ot is not None:
                acc["usage"]["output_tokens"] = ot  # cumulative → final value


def _accumulate_openai(acc: dict, chunk: Any) -> None:
    """Fold one OpenAI stream chunk. Usage is only present on the final chunk and
    only when the caller passed stream_options={"include_usage": True}; without
    that the accumulator stays empty and we report nothing (honest no-op)."""
    cid = _get(chunk, "id")
    if cid:
        acc["id"] = cid
    cmodel = _get(chunk, "model")
    if cmodel:
        acc["model"] = cmodel
    u = _get(chunk, "usage")
    if u is not None:
        for k in ("prompt_tokens", "completion_tokens", "total_tokens"):
            v = _get(u, k)
            if v is not None:
                acc["usage"][k] = v
        details = _get(u, "prompt_tokens_details")
        if details is not None:
            cached = _get(details, "cached_tokens")
            if cached is not None:
                acc["usage"]["prompt_tokens_details"] = {"cached_tokens": cached}


class _CapturingStream:
    """Transparent proxy over a provider stream.

    Yields every item unchanged; once the stream is fully consumed (StopIteration),
    exited, or closed, it reports the accumulated usage exactly once. Best-effort:
    a capture failure never interrupts iteration, and unknown attributes/methods
    delegate to the wrapped stream so `with`, `.close()`, `.text_stream`, etc. keep
    working."""

    def __init__(self, inner: Any, on_item, on_done):
        self._inner = inner
        self._iter = iter(inner)
        self._on_item = on_item
        self._on_done = on_done
        self._done = False

    def __iter__(self):
        return self

    def __next__(self):
        try:
            item = next(self._iter)
        except StopIteration:
            self._finish()
            raise
        try:
            self._on_item(item)
        except Exception:
            pass
        return item

    def _finish(self) -> None:
        if not self._done:
            self._done = True
            try:
                self._on_done()
            except Exception:
                pass

    def __enter__(self):
        enter = getattr(self._inner, "__enter__", None)
        if enter is not None:
            enter()
        return self

    def __exit__(self, *exc):
        try:
            exit_ = getattr(self._inner, "__exit__", None)
            if exit_ is not None:
                return exit_(*exc)
        finally:
            self._finish()
        return False

    def close(self):
        self._finish()
        close = getattr(self._inner, "close", None)
        if close is not None:
            return close()

    def __getattr__(self, name):
        # Only reached for attributes this proxy doesn't define — delegate them.
        return getattr(self._inner, name)


def _wrap_stream(resp: Any, provider: str, agent_id: str, base_url: str,
                 kwargs: dict, t0: float, capture_prompts: bool,
                 api_key: Optional[str] = None) -> Any:
    """Return a proxy stream that reports usage once the caller finishes consuming
    it. Falls back to the raw stream if anything goes wrong (never breaks it)."""
    acc: dict = {"id": None, "model": None, "usage": {}}
    on_item = ((lambda ev: _accumulate_anthropic(acc, ev)) if provider == "anthropic"
               else (lambda ch: _accumulate_openai(acc, ch)))

    def on_done() -> None:
        if not acc["usage"]:
            return  # no usage seen (e.g. OpenAI without include_usage) — report nothing
        response = types.SimpleNamespace(
            usage=acc["usage"], id=acc["id"], model=acc["model"] or kwargs.get("model"))
        report_llm_call(
            agent_id,
            provider=provider,
            model=kwargs.get("model") or acc["model"] or "unknown",
            response=response,
            base_url=base_url,
            system=kwargs.get("system", ""),
            messages=kwargs.get("messages"),
            tools=kwargs.get("tools"),
            max_tokens=kwargs.get("max_tokens"),
            temperature=kwargs.get("temperature"),
            latency_ms=(time.time() - t0) * 1000,
            capture_prompts=capture_prompts,
            api_key=api_key,
        )

    return _CapturingStream(resp, on_item, on_done)


def _detect_provider(client: Any) -> str:
    mod = (type(client).__module__ or "").lower()
    if "anthropic" in mod:
        return "anthropic"
    if "openai" in mod:
        return "openai"
    if hasattr(client, "messages") and hasattr(getattr(client, "messages"), "create"):
        return "anthropic"
    if hasattr(client, "chat"):
        return "openai"
    raise ValueError("Could not detect provider; pass provider='anthropic' or 'openai'.")


def wrap_llm(
    client: Any,
    agent_id: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    provider: Optional[str] = None,
    capture_prompts: bool = False,
    api_key: Optional[str] = None,
) -> Any:
    """Wrap an Anthropic or OpenAI client so each completion is reported to Arceo.

        client = wrap_llm(Anthropic(), "my-agent-id", api_key="ag_...")
        client.messages.create(...)   # captured automatically

    Returns the same client (its create method is patched in place). Capture is
    async + best-effort: it never alters the response and never raises.

    api_key is the Arceo X-API-Key the capture endpoint requires (mint one at
    /api/keys or Settings → API keys; falls back to the ARCEO_API_KEY env var).
    WITHOUT a valid key the endpoint 401s and — because capture is best-effort —
    nothing is recorded and your forecast never leaves the low-confidence tier.

    Streaming calls (stream=True) are captured too: the returned stream is wrapped
    in a transparent proxy that reports usage once you finish consuming it. For
    Anthropic this always works (usage rides in the stream events). For OpenAI it
    works only when you pass stream_options={"include_usage": True} — otherwise the
    API never sends usage and there is nothing honest to report.
    """
    provider = provider or _detect_provider(client)

    if provider == "anthropic":
        resource = client.messages
    elif provider == "openai":
        resource = client.chat.completions
    else:
        raise ValueError(f"Unsupported provider: {provider}")

    original = resource.create

    def patched(*args, **kwargs):
        t0 = time.time()
        resp = original(*args, **kwargs)
        if kwargs.get("stream"):
            try:
                return _wrap_stream(resp, provider, agent_id, base_url, kwargs, t0, capture_prompts, api_key)
            except Exception:
                return resp  # never break the stream
        try:
            report_llm_call(
                agent_id,
                provider=provider,
                model=kwargs.get("model") or getattr(resp, "model", "unknown"),
                response=resp,
                base_url=base_url,
                system=kwargs.get("system", ""),
                messages=kwargs.get("messages"),
                tools=kwargs.get("tools"),
                max_tokens=kwargs.get("max_tokens"),
                temperature=kwargs.get("temperature"),
                latency_ms=(time.time() - t0) * 1000,
                capture_prompts=capture_prompts,
                api_key=api_key,
            )
        except Exception:
            pass  # capture must never affect the real call
        return resp

    resource.create = patched
    return client
