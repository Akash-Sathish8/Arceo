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
    session_context: Optional[list] = None,
    token: Optional[str] = None,
    base_url: str = DEFAULT_BASE_URL,
    timeout: float = 8.0,
    on_error: Optional[str] = None,
) -> dict:
    """Check a tool call against Arceo policies before running it.

    Returns the decision dict, e.g. {"decision": "ALLOW"} /
    {"decision": "BLOCK", "reason": "..."} / {"decision": "REQUIRE_APPROVAL", ...}.

    session_context is the list of tool.action strings this agent has already
    executed this session, e.g. ["pagerduty.get_incident", "aws.list_instances"].
    Chain policies (requires_prior conditions — Arceo's headline IP) can ONLY
    fire when you pass it: a requires_prior policy with no context is treated as
    unmet, so the guarded action falls through to the default. Track executed
    actions yourself and pass them here, or use ArceoClient which does it for you.

    on_error controls behavior when Arceo is unreachable: "block" (default —
    fail closed; an unenforceable action does not run) or "allow" (don't halt
    the agent on an Arceo outage). Omitted, it falls back to the
    ARCEO_FAIL_MODE env var, then to "block". The returned dict carries an
    "error" key when the fallback was used.
    """
    body = json.dumps({
        "agent_id": agent_id, "tool": tool, "action": action, "params": params or {},
        "session_context": session_context or [],
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


def _auth_headers(token: Optional[str]) -> dict:
    headers = {"Content-Type": "application/json"}
    token = token or os.getenv("ARCEO_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    api_key = os.getenv("ARCEO_API_KEY")
    if api_key:
        headers["X-API-Key"] = api_key
    return headers


def _poll_decision(execution_id: int, *, token: Optional[str], base_url: str, timeout: float) -> str:
    """One status poll → 'PENDING' | 'ALLOW' | 'BLOCK'."""
    url = base_url.rstrip("/") + f"/api/enforce/status/{execution_id}"
    req = urllib.request.Request(url, headers=_auth_headers(token), method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8")).get("decision", "PENDING")


def enforce_and_wait(
    agent_id: str,
    tool: str,
    action: str,
    params: Optional[dict] = None,
    *,
    session_context: Optional[list] = None,
    token: Optional[str] = None,
    base_url: str = DEFAULT_BASE_URL,
    poll_interval: float = 2.0,
    max_wait: Optional[float] = None,
    on_error: Optional[str] = None,
) -> dict:
    """Enforce, and if a human's approval is required, BLOCK until they decide.

    One line for the common human-in-the-loop flow: the agent's code just waits
    here. ALLOW/BLOCK come straight back; REQUIRE_APPROVAL polls the held
    action's status every poll_interval seconds until it becomes ALLOW
    (approved) or BLOCK (rejected). max_wait=None waits indefinitely (Arceo
    never expires a pending action); set it to give up after N seconds and get
    back {"decision": "PENDING"} to handle yourself.
    """
    import time

    result = enforce(agent_id, tool, action, params, session_context=session_context,
                     token=token, base_url=base_url, on_error=on_error)
    if result.get("decision") != "REQUIRE_APPROVAL":
        return result
    execution_id = result.get("execution_id")
    if execution_id is None:
        return result  # nothing to poll (older backend) — surface as-is

    waited = 0.0
    while max_wait is None or waited < max_wait:
        time.sleep(poll_interval)
        waited += poll_interval
        try:
            decision = _poll_decision(execution_id, token=token, base_url=base_url, timeout=8.0)
        except Exception:
            continue  # transient — keep waiting (a restart doesn't lose the pending row)
        if decision in ("ALLOW", "BLOCK"):
            return {"decision": decision, "action": f"{tool}.{action}",
                    "agent_id": agent_id, "execution_id": execution_id}
    return {"decision": "PENDING", "action": f"{tool}.{action}",
            "agent_id": agent_id, "execution_id": execution_id}


class ArceoClient:
    """Convenience holder for base_url + token so you don't repeat them.

    Also tracks session context automatically: every action this client sees
    ALLOWed is remembered and sent as session_context on subsequent enforce
    calls, so chain policies (requires_prior) fire without you threading a list
    through your code. Pass session_context= explicitly to override, or call
    reset_session() at a task boundary. Set track_session=False to opt out.
    """

    def __init__(self, base_url: str = DEFAULT_BASE_URL, token: Optional[str] = None,
                 *, track_session: bool = True):
        self.base_url = base_url
        self.token = token or os.getenv("ARCEO_TOKEN")
        self.track_session = track_session
        self._session_context: list = []

    def reset_session(self) -> None:
        """Clear the tracked prior-action list (call at a task/session boundary)."""
        self._session_context = []

    def _remember(self, tool: str, action: str, result: dict) -> None:
        if self.track_session and result.get("decision") == "ALLOW":
            self._session_context.append(f"{tool}.{action}")

    def enforce(self, agent_id: str, tool: str, action: str, params: Optional[dict] = None,
                *, session_context: Optional[list] = None, on_error: Optional[str] = None) -> dict:
        ctx = session_context if session_context is not None else (self._session_context if self.track_session else None)
        result = enforce(agent_id, tool, action, params, session_context=ctx,
                         token=self.token, base_url=self.base_url, on_error=on_error)
        self._remember(tool, action, result)
        return result

    def enforce_and_wait(self, agent_id: str, tool: str, action: str, params: Optional[dict] = None,
                         *, session_context: Optional[list] = None, poll_interval: float = 2.0,
                         max_wait: Optional[float] = None, on_error: Optional[str] = None) -> dict:
        ctx = session_context if session_context is not None else (self._session_context if self.track_session else None)
        result = enforce_and_wait(agent_id, tool, action, params, session_context=ctx, token=self.token,
                                  base_url=self.base_url, poll_interval=poll_interval,
                                  max_wait=max_wait, on_error=on_error)
        self._remember(tool, action, result)
        return result
