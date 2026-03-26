"""ActionGate client — manages sessions and tool calls against the mock server."""

from __future__ import annotations

import httpx


class ActionGateClient:
    """Client for interacting with an ActionGate server.

    Usage:
        gate = ActionGateClient(agent_id="my-agent")
        gate.start_session()
        result = gate.call_tool("stripe", "get_customer", {"customer_id": "cust_1042"})
        trace = gate.get_trace()
    """

    def __init__(
        self,
        agent_id: str,
        server: str = "http://localhost:8000",
        auto_session: bool = True,
    ):
        self.agent_id = agent_id
        self.server = server.rstrip("/")
        self.session_id: str | None = None
        self._http = httpx.Client(timeout=30.0)

        if auto_session:
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

    def call_tool(self, tool: str, action: str, params: dict | None = None) -> dict:
        """Call a tool through ActionGate's mock + enforce layer.

        Returns the mock response (or block/approval response).
        """
        if not self.session_id:
            self.start_session()

        resp = self._http.post(
            f"{self.server}/mock/{tool}/{action}",
            json=params or {},
            headers={
                "X-Session-ID": self.session_id,
                "X-Agent-ID": self.agent_id,
            },
        )
        resp.raise_for_status()
        return resp.json()

    def get_trace(self) -> dict:
        """Get the full trace for the current session."""
        if not self.session_id:
            return {"steps": [], "total_steps": 0}

        resp = self._http.get(f"{self.server}/mock/session/{self.session_id}/trace")
        resp.raise_for_status()
        return resp.json()

    def register_agent(self, name: str, description: str, tools: list[dict]) -> dict:
        """Register this agent with ActionGate.

        tools format: [{"name": "stripe", "description": "Payments",
                        "actions": [{"name": "get_customer", "description": "..."}]}]
        """
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
