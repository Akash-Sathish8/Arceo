"""Tests for the ActionGate Python SDK."""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def server():
    """Start a test server and return the base URL."""
    import os, tempfile
    os.environ.setdefault("TESTING", "1")

    import db
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    db.DB_PATH = tmp.name
    tmp.close()

    from main import app
    db.init_db()

    with TestClient(app) as client:
        # Patch httpx to use the test client
        yield client

    os.unlink(tmp.name)


class TestActionGateClient:
    def test_register_and_call(self, server):
        """Test the full SDK flow using the test client directly."""
        # Register agent
        resp = server.post("/api/authority/agents/register", json={
            "name": "SDK Test",
            "tools": [{"name": "stripe", "description": "Pay", "actions": [
                {"name": "get_customer", "description": "Lookup"},
            ]}],
        })
        assert resp.status_code == 200
        assert resp.json()["id"] == "sdk-test"

        # Create session
        resp = server.post("/mock/session", json={"agent_id": "sdk-test"})
        assert resp.status_code == 200
        session_id = resp.json()["session_id"]

        # Call tool
        resp = server.post("/mock/stripe/get_customer",
                           json={"customer_id": "cust_1042"},
                           headers={"X-Session-ID": session_id, "X-Agent-ID": "sdk-test"})
        assert resp.status_code == 200
        assert resp.json()["customer"]["name"] == "Jane Doe"

        # Get trace
        resp = server.get(f"/mock/session/{session_id}/trace")
        assert resp.status_code == 200
        trace = resp.json()
        assert trace["total_steps"] == 1
        assert trace["steps"][0]["tool"] == "stripe"
        assert trace["steps"][0]["decision"] == "ALLOW"

    def test_policy_enforcement_through_mock(self, server):
        """Test that policies block actions through mock endpoints."""
        # Login
        token = server.post("/api/auth/login",
                           json={"email": "admin@actiongate.io", "password": "admin123"}).json()["token"]
        headers = {"Authorization": f"Bearer {token}"}

        # Register agent
        server.post("/api/authority/agents/register", json={
            "name": "Policy Test",
            "tools": [{"name": "stripe", "description": "Pay", "actions": [
                {"name": "create_refund", "description": "Refund"},
            ]}],
        })

        # Create policy
        server.post("/api/authority/agent/policy-test/policies", headers=headers, json={
            "action_pattern": "stripe.create_refund",
            "effect": "BLOCK",
            "reason": "Blocked for testing",
        })

        # Call through mock — should be blocked
        session = server.post("/mock/session", json={"agent_id": "policy-test"}).json()
        resp = server.post("/mock/stripe/create_refund",
                           json={"payment_id": "pay_001"},
                           headers={"X-Session-ID": session["session_id"], "X-Agent-ID": "policy-test"})
        assert resp.status_code == 200
        assert resp.json()["blocked"] is True
        assert resp.json()["decision"] == "BLOCK"
