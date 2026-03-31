"""HTTP client for the Arceo backend."""

from __future__ import annotations

import sys
from arceo.models import ArceoTrace


class ArceoClient:
    def __init__(self, api_url="http://localhost:8000", api_key="", timeout=30.0):
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def analyze(self, trace: ArceoTrace) -> dict:
        """Send trace to backend. Returns raw response dict or None."""
        try:
            import httpx
        except ImportError:
            print("Arceo: httpx not installed, skipping backend. pip install httpx", file=sys.stderr)
            return None

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["X-API-Key"] = self.api_key

        try:
            resp = httpx.post(
                "%s/api/sdk/analyze-trace" % self.api_url,
                json=trace.to_api_payload(),
                headers=headers,
                timeout=self.timeout,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print("Arceo: Backend unreachable (%s), local analysis only." % e, file=sys.stderr)
            return None
