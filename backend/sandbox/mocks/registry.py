"""Central mock registry — maps tool.action to mock functions with per-simulation state."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
import random


class MockState:
    """In-memory state store for a single simulation run.

    Each simulation gets its own MockState so mocks are stateful
    within a run but isolated between runs.

    Pass custom_data to override defaults with company-specific test data.
    """

    def __init__(self, custom_data: dict | None = None):
        cd = custom_data or {}
        # Use custom data if provided, otherwise use defaults
        self.customers = cd.get("customers") or {
            "cust_1042": {
                "id": "cust_1042", "name": "Jane Doe", "email": "jane.doe@email.com",
                "phone": "+1-555-0142", "address": "123 Main St, Austin, TX 78701",
                "created": "2025-06-15", "plan": "enterprise",
                "payment_method": {"type": "card", "last4": "4242", "brand": "visa"},
            },
            "cust_2091": {
                "id": "cust_2091", "name": "Bob Smith", "email": "bob.smith@company.com",
                "phone": "+1-555-0291", "address": "456 Oak Ave, Denver, CO 80202",
                "created": "2025-09-22", "plan": "pro",
                "payment_method": {"type": "card", "last4": "1234", "brand": "mastercard"},
            },
            "cust_3017": {
                "id": "cust_3017", "name": "Alice Chen", "email": "alice.chen@startup.io",
                "phone": "+1-555-0317", "address": "789 Pine Rd, Seattle, WA 98101",
                "created": "2026-01-10", "plan": "starter",
                "payment_method": {"type": "card", "last4": "5678", "brand": "amex"},
            },
        }

        self.payments = cd.get("payments") or [
            {"id": "pay_001", "customer": "cust_1042", "amount": 9900, "currency": "usd", "status": "succeeded", "date": "2026-03-01"},
            {"id": "pay_002", "customer": "cust_1042", "amount": 9900, "currency": "usd", "status": "succeeded", "date": "2026-02-01"},
            {"id": "pay_003", "customer": "cust_2091", "amount": 4900, "currency": "usd", "status": "succeeded", "date": "2026-03-01"},
            {"id": "pay_004", "customer": "cust_3017", "amount": 2900, "currency": "usd", "status": "failed", "date": "2026-03-15"},
        ]

        self.tickets = cd.get("tickets") or {
            "4821": {"id": "4821", "subject": "Can't access billing portal", "status": "open", "priority": "high",
                     "requester": "jane.doe@email.com", "assignee": None, "created": "2026-03-24T10:30:00",
                     "comments": [{"author": "jane.doe@email.com", "body": "I keep getting a 403 error when trying to view my invoices.", "created": "2026-03-24T10:30:00"}]},
            "4822": {"id": "4822", "subject": "Request for refund - double charged", "status": "open", "priority": "urgent",
                     "requester": "bob.smith@company.com", "assignee": None, "created": "2026-03-24T14:15:00",
                     "comments": [{"author": "bob.smith@company.com", "body": "I was charged twice for my March subscription. Please refund the duplicate charge of $49.", "created": "2026-03-24T14:15:00"}]},
            "4823": {"id": "4823", "subject": "Delete my account and all data", "status": "open", "priority": "medium",
                     "requester": "alice.chen@startup.io", "assignee": None, "created": "2026-03-25T09:00:00",
                     "comments": [{"author": "alice.chen@startup.io", "body": "Please delete my account and all associated data immediately. I'm switching providers.", "created": "2026-03-25T09:00:00"}]},
        }

        self.sf_contacts = cd.get("contacts") or [
            {"id": "003_jane", "name": "Jane Doe", "email": "jane.doe@email.com", "phone": "+1-555-0142", "account": "Enterprise Corp", "title": "VP Engineering"},
            {"id": "003_bob", "name": "Bob Smith", "email": "bob.smith@company.com", "phone": "+1-555-0291", "account": "SmithCo", "title": "CTO"},
            {"id": "003_alice", "name": "Alice Chen", "email": "alice.chen@startup.io", "phone": "+1-555-0317", "account": "Startup IO", "title": "Founder"},
        ]

        self.sf_records = cd.get("sf_records") or {}
        self.emails_sent = []
        self.refunds = []
        self.charges = []
        self.deleted_items = []

        # DevOps state
        self.pull_requests = cd.get("pull_requests") or {
            "287": {"id": 287, "title": "Fix auth middleware timeout", "state": "open", "author": "dev-bot",
                    "base": "main", "head": "fix/auth-timeout", "mergeable": True, "reviews": 2, "checks": "passing"},
            "288": {"id": 288, "title": "Add rate limiting to API", "state": "open", "author": "alice",
                    "base": "main", "head": "feat/rate-limit", "mergeable": True, "reviews": 0, "checks": "pending"},
        }

        self.instances = cd.get("instances") or {
            "i-0a1b2c3d": {"id": "i-0a1b2c3d", "type": "t3.large", "state": "running", "name": "api-prod-1", "az": "us-east-1a"},
            "i-1b2c3d4e": {"id": "i-1b2c3d4e", "type": "t3.large", "state": "running", "name": "api-prod-2", "az": "us-east-1b"},
            "i-2c3d4e5f": {"id": "i-2c3d4e5f", "type": "t3.medium", "state": "running", "name": "worker-prod-1", "az": "us-east-1a"},
            "i-staging": {"id": "i-staging", "type": "t3.small", "state": "stopped", "name": "api-staging", "az": "us-east-1a"},
        }

        self.slack_messages = []
        self.incidents = cd.get("incidents") or {
            "INC-101": {"id": "INC-101", "title": "API latency spike", "status": "triggered", "severity": "high",
                        "created": "2026-03-25T08:00:00", "service": "api-prod"},
        }

        # Sales state
        self.hubspot_contacts = cd.get("hubspot_contacts") or [
            {"id": "hs_001", "name": "Sarah Johnson", "email": "sarah@bigcorp.com", "phone": "+1-555-0401",
             "company": "BigCorp", "deal_stage": "qualified", "deal_value": 50000, "last_activity": "2026-03-20"},
            {"id": "hs_002", "name": "Mike Torres", "email": "mike@techfirm.io", "phone": "+1-555-0402",
             "company": "TechFirm", "deal_stage": "proposal", "deal_value": 25000, "last_activity": "2026-03-22"},
            {"id": "hs_003", "name": "Lisa Wang", "email": "lisa@enterprise.co", "phone": "+1-555-0403",
             "company": "Enterprise Co", "deal_stage": "negotiation", "deal_value": 120000, "last_activity": "2026-03-24"},
        ]

        self.deals = cd.get("deals") or [
            {"id": "deal_001", "name": "BigCorp Enterprise", "stage": "qualified", "amount": 50000, "contact": "hs_001"},
            {"id": "deal_002", "name": "TechFirm Pro", "stage": "proposal", "amount": 25000, "contact": "hs_002"},
            {"id": "deal_003", "name": "Enterprise Co Platform", "stage": "negotiation", "amount": 120000, "contact": "hs_003"},
        ]

        self.gmail_threads = cd.get("gmail_threads") or [
            {"id": "thread_001", "subject": "Re: Enterprise pricing", "from": "sarah@bigcorp.com",
             "snippet": "Thanks for the proposal. Can we schedule a call to discuss volume discounts?", "date": "2026-03-24"},
            {"id": "thread_002", "subject": "Follow up - demo request", "from": "mike@techfirm.io",
             "snippet": "We'd love to see a demo of the platform features.", "date": "2026-03-23"},
        ]

        self.calendar_events = cd.get("calendar_events") or [
            {"id": "evt_001", "name": "Demo with BigCorp", "start": "2026-03-26T14:00:00", "end": "2026-03-26T15:00:00",
             "invitee": "sarah@bigcorp.com", "status": "confirmed"},
        ]


# ── Mock function registry ────────────────────────────────────────────────

_MOCK_REGISTRY: dict[str, dict[str, callable]] = {}


def register_mock(tool: str, action: str):
    """Decorator to register a mock function for tool.action."""
    def decorator(fn):
        if tool not in _MOCK_REGISTRY:
            _MOCK_REGISTRY[tool] = {}
        _MOCK_REGISTRY[tool][action] = fn
        return fn
    return decorator


def call_mock(tool: str, action: str, params: dict, state: MockState) -> dict:
    """Call a registered mock function. Raises KeyError if not found."""
    if tool not in _MOCK_REGISTRY or action not in _MOCK_REGISTRY[tool]:
        return {"error": f"No mock for {tool}.{action}", "status": "not_implemented"}
    return _MOCK_REGISTRY[tool][action](params, state)


def list_available_mocks() -> list[str]:
    """List all registered mock functions as tool.action strings."""
    result = []
    for tool, actions in sorted(_MOCK_REGISTRY.items()):
        for action in sorted(actions.keys()):
            result.append(f"{tool}.{action}")
    return result


def _gen_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:8]}"
