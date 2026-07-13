"""Regression tests for the dashboard QA fix pass.

Guards the two backend fixes:
  1. /api/workflows/optimize no longer 500s (LABEL_TRANSITIONS are dataclasses,
     not tuples) and is description-driven (heuristic fallback picks a subset).
  2. /api/authority/agents returns a per-effect policy breakdown so the dashboard
     card can tell an enforced BLOCK/ALLOW from a still-pending REQUIRE_APPROVAL.

Run from backend/:  venv/bin/python -m pytest tests/ -q
"""
import os

# DB isolation happens in conftest.py, which pytest imports before this module:
# it creates the scratch Postgres database and exports DATABASE_URL before any
# app import.
os.environ.setdefault("JWT_SECRET", "test-secret-for-qa-fixes-0123456789abcdef")

import pytest
from fastapi.testclient import TestClient

import main  # noqa: E402


# ── Fix 1a: optimize 500 — LABEL_TRANSITIONS shape ──────────────────────────
# The 500 was `for from_label, to_label, chain_name, severity in LABEL_TRANSITIONS`
# unpacking a LabelTransition dataclass as a 4-tuple. Guard the shape the loop
# now relies on (attribute access), so a revert or a field reorder fails loudly.

def test_label_transitions_are_dataclasses_not_tuples():
    from authority.chain_detector import LABEL_TRANSITIONS, LabelTransition

    assert len(LABEL_TRANSITIONS) >= 14
    for t in LABEL_TRANSITIONS:
        assert isinstance(t, LabelTransition)
        assert isinstance(t.from_label, str) and t.from_label
        assert isinstance(t.to_label, str) and t.to_label
        assert isinstance(t.name, str) and t.name
        assert t.severity in ("critical", "high", "medium")
        # It must NOT be tuple-unpackable into 4 names (the old bug):
        with pytest.raises(TypeError):
            _a, _b, _c, _d = t  # noqa: F841


# ── Fix 1b: optimize is description-driven (no-key heuristic) ────────────────
# The dry runner marked every action "used" → overprivileged always empty. The
# heuristic must pick only actions the description actually references.

def test_heuristic_needed_actions_is_description_sensitive():
    agent = {
        "tools": [
            {"name": "stripe", "actions": [
                {"action": "refund_payment", "description": "Issue a refund"},
                {"action": "delete_customer", "description": "Delete a billing record"},
            ]},
            {"name": "flights", "actions": [
                {"action": "search_flights", "description": "Search available flights"},
            ]},
        ]
    }

    refund_only = main._heuristic_needed_actions(agent, "issue a refund for the charge")
    assert "stripe.refund_payment" in refund_only
    assert "stripe.delete_customer" not in refund_only
    assert "flights.search_flights" not in refund_only

    # A different description selects a different subset — proves sensitivity.
    flight_only = main._heuristic_needed_actions(agent, "search for available flights")
    assert "flights.search_flights" in flight_only
    assert "stripe.refund_payment" not in flight_only

    # Empty description references nothing → nothing "needed" (all overprivileged).
    assert main._heuristic_needed_actions(agent, "") == set()


# ── Fix 2: list_agents returns policies_by_effect ───────────────────────────
# Full-stack guard on the isolated temp DB: a REQUIRE_APPROVAL policy must NOT
# read as enforced coverage (that was the phantom green "approved" check).

@pytest.fixture()
def client():
    # Context manager fires startup → init_db(), creating tables in the temp DB.
    with TestClient(main.app) as c:
        yield c


def _auth(client, email):
    client.post("/api/auth/signup", json={"email": email, "password": "pw12345678", "name": "QA"})
    r = client.post("/api/auth/login", json={"email": email, "password": "pw12345678"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_policies_by_effect_distinguishes_require_approval(client):
    h = _auth(client, "qa-effect@example.com")

    r = client.post("/api/authority/agents", headers=h, json={
        "name": "billing bot",
        "tools": [{"name": "stripe", "service": "stripe", "actions": [
            {"action": "refund_payment", "risk_labels": ["moves_money"], "reversible": False},
        ]}],
    })
    assert r.status_code == 200, r.text
    agent_id = "billing-bot"

    def by_effect():
        agents = client.get("/api/authority/agents", headers=h).json()["agents"]
        a = next(x for x in agents if x["id"] == agent_id)
        return a["policy_count"], a["policies_by_effect"]

    # No policy yet.
    count, eff = by_effect()
    assert count == 0
    assert eff == {"BLOCK": 0, "REQUIRE_APPROVAL": 0, "ALLOW": 0}

    # REQUIRE_APPROVAL is a PENDING gate, not enforced coverage: count rises but
    # BLOCK/ALLOW stay 0 → the card must NOT paint a green "approved" check.
    r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=h, json={
        "action_pattern": "stripe.refund_payment", "effect": "REQUIRE_APPROVAL",
    })
    assert r.status_code == 200, r.text
    count, eff = by_effect()
    assert count == 1
    assert eff["REQUIRE_APPROVAL"] == 1
    assert eff["BLOCK"] == 0 and eff["ALLOW"] == 0

    # A BLOCK policy IS enforced coverage.
    r = client.post(f"/api/authority/agent/{agent_id}/policies", headers=h, json={
        "action_pattern": "stripe.*", "effect": "BLOCK",
    })
    assert r.status_code == 200, r.text
    count, eff = by_effect()
    assert count == 2
    assert eff["BLOCK"] == 1 and eff["REQUIRE_APPROVAL"] == 1
