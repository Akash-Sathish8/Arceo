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
import urllib.request
from typing import Any, Optional

DEFAULT_BASE_URL = os.getenv("ARCEO_BASE_URL", "http://localhost:8000")


def _post_async(url: str, payload: dict, timeout: float = 5.0) -> None:
    """Fire-and-forget POST in a daemon thread. Never raises into the caller."""
    def _run() -> None:
        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                url, data=data, headers={"Content-Type": "application/json"}, method="POST"
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
) -> None:
    """Report one captured LLM call to Arceo (async, best-effort)."""
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
    _post_async(base_url.rstrip("/") + f"/api/agent/{agent_id}/llm-call", payload)


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
) -> Any:
    """Wrap an Anthropic or OpenAI client so each completion is reported to Arceo.

        client = wrap_llm(Anthropic(), "my-agent-id")
        client.messages.create(...)   # captured automatically

    Returns the same client (its create method is patched in place). Capture is
    async + best-effort: it never alters the response and never raises. Streaming
    calls (stream=True) are skipped — usage isn't available until the stream is
    consumed.
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
        if not kwargs.get("stream"):
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
                )
            except Exception:
                pass  # capture must never affect the real call
        return resp

    resource.create = patched
    return client
