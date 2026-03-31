"""ActionGate client — manages sessions and tool calls against mock or live APIs."""

from __future__ import annotations

from typing import Any, Callable

import httpx


class ActionGateClient:
    """Client for interacting with an ActionGate server.

    Two modes:
      - sandbox (default): routes tool calls to ActionGate's mock APIs
      - live: checks enforce before calling the REAL tool function

    Sandbox usage:
        gate = ActionGateClient(agent_id="my-agent")
        result = gate.call_tool("stripe", "get_customer", {"customer_id": "cust_1042"})

    Live usage:
        gate = ActionGateClient(agent_id="my-agent", mode="live")
        gate.register_live_tool("stripe", "get_customer", real_get_customer_fn)
        result = gate.call_tool("stripe", "get_customer", {"customer_id": "cust_1042"})
        # Checks enforce first — if BLOCK, returns blocked. If ALLOW, calls real function.
    """

    def __init__(
        self,
        agent_id: str,
        server: str = "http://localhost:8000",
        mode: str = "sandbox",  # "sandbox" or "live"
        auto_session: bool = True,
    ):
        self.agent_id = agent_id
        self.server = server.rstrip("/")
        self.mode = mode
        self.auto_session = auto_session
        self.session_id: str | None = None
        self._http = httpx.Client(timeout=30.0)
        self._live_tools: dict[str, Callable] = {}
        self._session_context: list[str] = []  # auto-tracks "tool.action" calls made this session

        if mode == "sandbox" and auto_session:
            self.start_session()

    def start_session(self) -> str:
        """Create a new sandbox session. Returns session_id."""
        resp = self._http.post(
            f"{self.server}/mock/session",
            json={"agent_id": self.agent_id},
        )
        resp.raise_for_status()
        data = resp.json()
        self.session_id = data["session_id"]
        return self.session_id

    def register_live_tool(self, tool: str, action: str, fn: Callable):
        """Register a real tool function for live mode.

        When call_tool is called in live mode, if enforce allows it,
        this function is called instead of the mock.

        Usage:
            def real_get_customer(params):
                return stripe.Customer.retrieve(params["customer_id"])

            gate.register_live_tool("stripe", "get_customer", real_get_customer)
        """
        self._live_tools[f"{tool}.{action}"] = fn

    def check_enforce(self, tool: str, action: str, params: dict | None = None) -> dict:
        """Check enforcement policy for a tool.action.

        Automatically includes session context (prior tool calls this session)
        to support conditional policies like requires_prior.
        Also passes params so amount/value-based conditions can be evaluated.
        """
        resp = self._http.post(
            f"{self.server}/api/enforce",
            json={
                "agent_id": self.agent_id,
                "tool": tool,
                "action": action,
                "params": params or {},
                "session_context": list(self._session_context),
            },
        )
        resp.raise_for_status()
        return resp.json()

    def call_tool(self, tool: str, action: str, params: dict | None = None) -> Any:
        """Call a tool — through mocks (sandbox) or real APIs (live).

        Sandbox mode: routes to POST /mock/{tool}/{action}
        Live mode: checks enforce first, then calls the real function if allowed

        Session context is automatically updated after each ALLOW decision,
        enabling requires_prior conditional policies.
        """
        p = params or {}
        if self.mode == "live":
            result = self._call_live(tool, action, p)
        else:
            result = self._call_sandbox(tool, action, p)

        # Track in session context only on non-blocked calls
        if not (isinstance(result, dict) and (result.get("blocked") or result.get("pending_approval"))):
            self._session_context.append(f"{tool}.{action}")

        return result

    def _call_sandbox(self, tool: str, action: str, params: dict) -> dict:
        """Sandbox mode: call through ActionGate's mock endpoints."""
        if not self.session_id:
            self.start_session()

        resp = self._http.post(
            f"{self.server}/mock/{tool}/{action}",
            json=params,
            headers={
                "X-Session-ID": self.session_id,
                "X-Agent-ID": self.agent_id,
            },
        )
        resp.raise_for_status()
        return resp.json()

    def _call_live(self, tool: str, action: str, params: dict) -> Any:
        """Live mode: check enforce, then call the real tool if allowed."""
        enforce = self.check_enforce(tool, action, params=params)
        decision = enforce.get("decision", "ALLOW")

        if decision == "BLOCK":
            return {
                "blocked": True,
                "action": f"{tool}.{action}",
                "reason": enforce.get("message", "Blocked by policy"),
                "decision": "BLOCK",
            }

        if decision == "REQUIRE_APPROVAL":
            return {
                "pending_approval": True,
                "action": f"{tool}.{action}",
                "reason": enforce.get("message", "Requires approval"),
                "decision": "REQUIRE_APPROVAL",
            }

        # ALLOW — call the real function
        key = f"{tool}.{action}"
        fn = self._live_tools.get(key)
        if fn:
            return fn(params)
        else:
            raise RuntimeError(
                f"No live tool registered for {key}. "
                f"Call gate.register_live_tool('{tool}', '{action}', your_function)"
            )

    def reset_session(self):
        """Clear session context for a new conversation or task.

        Call this between separate agent conversations to prevent
        session context from one task affecting another.
        """
        self._session_context = []
        if self.mode == "sandbox" and self.auto_session:
            self.start_session()

    def get_session_context(self) -> list[str]:
        """Return the current session context (list of tool.action strings called so far)."""
        return list(self._session_context)

    def get_trace(self) -> dict:
        """Get the full trace for the current session (sandbox mode only)."""
        if not self.session_id:
            return {"steps": [], "total_steps": 0}

        resp = self._http.get(f"{self.server}/mock/session/{self.session_id}/trace")
        resp.raise_for_status()
        return resp.json()

    def register_agent(self, name: str, description: str, tools: list[dict]) -> dict:
        """Register this agent with ActionGate."""
        resp = self._http.post(
            f"{self.server}/api/authority/agents/register",
            json={"name": name, "description": description, "tools": tools},
        )
        resp.raise_for_status()
        return resp.json()

    def close(self):
        self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
