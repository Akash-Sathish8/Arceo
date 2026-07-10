"""Runtime policy enforcement against Arceo.

Call enforce() before a tool runs to get Arceo's decision (ALLOW / BLOCK /
REQUIRE_APPROVAL). Unlike capture, enforce is synchronous — you act on the
result — and authenticated (pass an Arceo JWT, or set ARCEO_TOKEN).

Fail-closed by default (v0.2.0, breaking): if Arceo is unreachable the
decision is BLOCK. Opt out per call with on_error="allow", or process-wide
with ARCEO_FAIL_MODE=allow (the break-glass for "an Arceo outage must not
halt my agents").
"""
from __future__ import annotations

import json
import os
import urllib.request
from typing import Optional

DEFAULT_BASE_URL = os.getenv("ARCEO_BASE_URL", "http://localhost:8000")


def _resolve_on_error(explicit: Optional[str]) -> str:
    """Explicit argument > ARCEO_FAIL_MODE env > fail-closed default."""
    if explicit in ("allow", "block"):
        return explicit
    env = os.getenv("ARCEO_FAIL_MODE", "").strip().lower()
    if env in ("allow", "block"):
        return env
    return "block"


def enforce(
    agent_id: str,
    tool: str,
    action: str,
    params: Optional[dict] = None,
    *,
    token: Optional[str] = None,
    base_url: str = DEFAULT_BASE_URL,
    timeout: float = 8.0,
    on_error: Optional[str] = None,
) -> dict:
    """Check a tool call against Arceo policies before running it.

    Returns the decision dict, e.g. {"decision": "ALLOW"} /
    {"decision": "BLOCK", "reason": "..."} / {"decision": "REQUIRE_APPROVAL", ...}.

    on_error controls behavior when Arceo is unreachable: "block" (default —
    fail closed; an unenforceable action does not run) or "allow" (don't halt
    the agent on an Arceo outage). Omitted, it falls back to the
    ARCEO_FAIL_MODE env var, then to "block". The returned dict carries an
    "error" key when the fallback was used.
    """
    body = json.dumps({
        "agent_id": agent_id, "tool": tool, "action": action, "params": params or {},
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = token or os.getenv("ARCEO_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    api_key = os.getenv("ARCEO_API_KEY")
    if api_key:
        headers["X-API-Key"] = api_key
    url = base_url.rstrip("/") + "/api/enforce"
    try:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        fallback = "ALLOW" if _resolve_on_error(on_error) == "allow" else "BLOCK"
        return {"decision": fallback, "error": str(e)}


class ArceoClient:
    """Convenience holder for base_url + token so you don't repeat them."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL, token: Optional[str] = None):
        self.base_url = base_url
        self.token = token or os.getenv("ARCEO_TOKEN")

    def enforce(self, agent_id: str, tool: str, action: str, params: Optional[dict] = None,
                *, on_error: Optional[str] = None) -> dict:
        return enforce(agent_id, tool, action, params,
                       token=self.token, base_url=self.base_url, on_error=on_error)
