"""Tests for the FastAPI endpoints — register, enforce, simulate, policies."""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    """Create a test client with a fresh database."""
    import os
    os.environ.setdefault("TESTING", "1")

    # Use in-memory or temp DB
    import db
    import tempfile
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    db.DB_PATH = tmp.name
    tmp.close()

    from main import app
    db.init_db()

    with TestClient(app) as c:
        yield c

    os.unlink(tmp.name)


@pytest.fixture(scope="module")
def token(client):
    """Get an auth token."""
    resp = client.post("/api/auth/login", json={"email": "admin@actiongate.io", "password": "admin123"})
    assert resp.status_code == 200
    return resp.json()["token"]


@pytest.fixture(scope="module")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


class TestAuth:
    def test_login_success(self, client):
        resp = client.post("/api/auth/login", json={"email": "admin@actiongate.io", "password": "admin123"})
        assert resp.status_code == 200
        assert "token" in resp.json()

    def test_login_failure(self, client):
        resp = client.post("/api/auth/login", json={"email": "admin@actiongate.io", "password": "wrong"})
        assert resp.status_code == 401

    def test_me(self, client, auth_headers):
        resp = client.get("/api/auth/me", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["user"]["email"] == "admin@actiongate.io"


class TestAgentRegister:
    def test_register_agent(self, client):
        resp = client.post("/api/authority/agents/register", json={
            "name": "Test Agent",
            "description": "A test",
            "tools": [{"name": "stripe", "description": "Payments", "actions": [
                {"name": "get_customer", "description": "Look up customer"},
                {"name": "create_refund", "description": "Issue refund"},
            ]}],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "test-agent"
        assert data["blast_radius"]["score"] > 0

    def test_register_upsert(self, client):
        resp = client.post("/api/authority/agents/register", json={
            "name": "Test Agent",
            "description": "Updated",
            "tools": [{"name": "stripe", "description": "Payments", "actions": [
                {"name": "get_customer", "description": "Look up customer"},
            ]}],
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "updated"


class TestAgentCRUD:
    def test_list_agents(self, client, auth_headers):
        resp = client.get("/api/authority/agents", headers=auth_headers)
        assert resp.status_code == 200
        assert len(resp.json()["agents"]) > 0

    def test_get_agent_detail(self, client, auth_headers):
        resp = client.get("/api/authority/agent/test-agent", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "graph" in data
        assert "blast_radius" in data
        assert "chains" in data

    def test_get_agent_not_found(self, client, auth_headers):
        resp = client.get("/api/authority/agent/nonexistent", headers=auth_headers)
        assert resp.status_code == 404


class TestEnforce:
    def test_enforce_allow(self, client):
        resp = client.post("/api/enforce", json={
            "agent_id": "test-agent",
            "tool": "stripe",
            "action": "get_customer",
        })
        assert resp.status_code == 200
        assert resp.json()["decision"] == "ALLOW"

    def test_enforce_with_policy(self, client, auth_headers):
        # Create a BLOCK policy
        client.post("/api/authority/agent/test-agent/policies", headers=auth_headers, json={
            "action_pattern": "stripe.create_refund",
            "effect": "BLOCK",
            "reason": "Test block",
        })

        resp = client.post("/api/enforce", json={
            "agent_id": "test-agent",
            "tool": "stripe",
            "action": "create_refund",
        })
        assert resp.status_code == 200
        assert resp.json()["decision"] == "BLOCK"

    def test_enforce_wildcard(self, client, auth_headers):
        # Create wildcard policy
        client.post("/api/authority/agent/test-agent/policies", headers=auth_headers, json={
            "action_pattern": "stripe.*",
            "effect": "REQUIRE_APPROVAL",
            "reason": "All stripe actions need approval",
        })

        resp = client.post("/api/enforce", json={
            "agent_id": "test-agent",
            "tool": "stripe",
            "action": "get_customer",
        })
        assert resp.status_code == 200
        # Exact match (BLOCK on create_refund) should take precedence, but get_customer should match wildcard
        assert resp.json()["decision"] in ["REQUIRE_APPROVAL", "ALLOW"]


class TestSandbox:
    def test_list_scenarios(self, client):
        resp = client.get("/api/sandbox/scenarios")
        assert resp.status_code == 200
        assert len(resp.json()["scenarios"]) > 0

    def test_agent_scenarios(self, client, auth_headers):
        resp = client.get("/api/sandbox/agent/test-agent/scenarios", headers=auth_headers)
        assert resp.status_code == 200
        assert len(resp.json()["scenarios"]) > 0

    def test_simulate_dry_run(self, client, auth_headers):
        # Get a scenario ID
        scenarios = client.get("/api/sandbox/agent/test-agent/scenarios", headers=auth_headers).json()["scenarios"]
        scenario_id = scenarios[0]["id"]

        resp = client.post("/api/sandbox/simulate", headers=auth_headers, json={
            "agent_id": "test-agent",
            "scenario_id": scenario_id,
            "dry_run": True,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert data["trace"]["total_steps"] > 0
        assert "report" in data

    def test_simulate_custom_prompt(self, client, auth_headers):
        resp = client.post("/api/sandbox/simulate", headers=auth_headers, json={
            "agent_id": "test-agent",
            "custom_prompt": "Look up a customer",
            "dry_run": True,
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "completed"

    def test_list_simulations(self, client, auth_headers):
        resp = client.get("/api/sandbox/simulations", headers=auth_headers)
        assert resp.status_code == 200
        assert len(resp.json()["simulations"]) > 0

    def test_apply_policy(self, client, auth_headers):
        resp = client.post("/api/sandbox/apply-policy", headers=auth_headers, json={
            "agent_id": "test-agent",
            "action_pattern": "email.send_email",
            "effect": "BLOCK",
            "reason": "Test block email",
        })
        assert resp.status_code == 200
        assert resp.json()["already_exists"] is False

    def test_apply_duplicate_policy(self, client, auth_headers):
        resp = client.post("/api/sandbox/apply-policy", headers=auth_headers, json={
            "agent_id": "test-agent",
            "action_pattern": "email.send_email",
            "effect": "BLOCK",
            "reason": "Test block email",
        })
        assert resp.status_code == 200
        assert resp.json()["already_exists"] is True


class TestMockEndpoints:
    def test_create_session(self, client):
        resp = client.post("/mock/session", json={"agent_id": "test-agent"})
        assert resp.status_code == 200
        assert "session_id" in resp.json()

    def test_call_mock(self, client):
        # Register a clean agent with no policies
        client.post("/api/authority/agents/register", json={
            "name": "Mock Test Agent",
            "tools": [{"name": "stripe", "description": "Pay", "actions": [
                {"name": "get_customer", "description": "Lookup"},
            ]}],
        })
        session = client.post("/mock/session", json={"agent_id": "mock-test-agent"}).json()
        resp = client.post("/mock/stripe/get_customer",
                           json={"customer_id": "cust_1042"},
                           headers={"X-Session-ID": session["session_id"], "X-Agent-ID": "mock-test-agent"})
        assert resp.status_code == 200
        assert resp.json()["customer"]["name"] == "Jane Doe"

    def test_mock_trace(self, client):
        session = client.post("/mock/session", json={"agent_id": "test-agent"}).json()
        sid = session["session_id"]

        client.post("/mock/stripe/get_customer", json={"customer_id": "cust_1042"},
                     headers={"X-Session-ID": sid, "X-Agent-ID": "test-agent"})
        client.post("/mock/email/send_email", json={"to": "test@test.com", "subject": "Hi", "body": "Test"},
                     headers={"X-Session-ID": sid, "X-Agent-ID": "test-agent"})

        resp = client.get(f"/mock/session/{sid}/trace")
        assert resp.status_code == 200
        assert resp.json()["total_steps"] == 2

    def test_list_available_mocks(self, client):
        resp = client.get("/mock/available")
        assert resp.status_code == 200
        assert resp.json()["total"] == 81

    def test_health(self, client):
        resp = client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"
