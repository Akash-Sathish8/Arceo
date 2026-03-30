"""Central mock registry — maps tool.action to mock functions with per-simulation state."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
import random


TENANT_DATA = {
    "tenant-alpha": {
        "customers": {
            "cust_a1": {"id": "cust_a1", "name": "Alpha User 1", "email": "user1@alpha-corp.com",
                        "phone": "+1-555-1001", "address": "100 Alpha St", "created": "2025-06-01",
                        "plan": "enterprise", "payment_method": {"type": "card", "last4": "1111", "brand": "visa"}, "tenant": "tenant-alpha"},
            "cust_a2": {"id": "cust_a2", "name": "Alpha User 2", "email": "user2@alpha-corp.com",
                        "phone": "+1-555-1002", "address": "200 Alpha Ave", "created": "2025-08-15",
                        "plan": "pro", "payment_method": {"type": "card", "last4": "2222", "brand": "mastercard"}, "tenant": "tenant-alpha"},
        },
        "instances": {
            "i-alpha-1": {"id": "i-alpha-1", "type": "m5.xlarge", "state": "running", "name": "alpha-api-1", "az": "us-west-2a", "tenant": "tenant-alpha"},
            "i-alpha-2": {"id": "i-alpha-2", "type": "m5.large", "state": "running", "name": "alpha-worker-1", "az": "us-west-2b", "tenant": "tenant-alpha"},
        },
        "hubspot_contacts": [
            {"id": "hs_a1", "name": "Alpha Lead 1", "email": "lead1@alpha-prospect.com", "phone": "+1-555-2001",
             "company": "Alpha Prospect", "deal_stage": "qualified", "deal_value": 80000, "tenant": "tenant-alpha"},
        ],
    },
    "tenant-beta": {
        "customers": {
            "cust_b1": {"id": "cust_b1", "name": "Beta User 1", "email": "user1@beta-inc.com",
                        "phone": "+1-555-3001", "address": "100 Beta Blvd", "created": "2025-07-01",
                        "plan": "starter", "payment_method": {"type": "card", "last4": "3333", "brand": "amex"}, "tenant": "tenant-beta"},
        },
        "instances": {
            "i-beta-1": {"id": "i-beta-1", "type": "t3.medium", "state": "running", "name": "beta-api-1", "az": "eu-west-1a", "tenant": "tenant-beta"},
        },
        "hubspot_contacts": [
            {"id": "hs_b1", "name": "Beta Lead 1", "email": "lead1@beta-prospect.com", "phone": "+1-555-4001",
             "company": "Beta Prospect", "deal_stage": "proposal", "deal_value": 30000, "tenant": "tenant-beta"},
        ],
    },
}


class MockState:
    """In-memory state store for a single simulation run.

    Each simulation gets its own MockState so mocks are stateful
    within a run but isolated between runs.

    Pass custom_data to override defaults with company-specific test data.
    Pass tenant_id to scope mock data to a specific tenant.
    """

    def __init__(self, custom_data: dict | None = None, tenant_id: str | None = None):
        self.tenant_id = tenant_id
        cd = custom_data or {}

        # If tenant specified, merge tenant data as defaults
        if tenant_id and tenant_id in TENANT_DATA:
            tenant = TENANT_DATA[tenant_id]
            for key, val in tenant.items():
                if key not in cd:
                    cd[key] = val
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
    """4-layer mock resolution:

    Layer 1: Hardcoded mocks (11 services, hand-built, highest quality)
    Layer 2: Template mocks (pattern-matched by action keywords, ~80% coverage)
    Layer 3: LLM mocks (Haiku generates response, cached)
    Layer 4: Session memory (earlier results feed into subsequent calls)
    """
    # Layer 4 first: record this call for session memory
    if not hasattr(state, '_call_history'):
        state._call_history = []

    # Layer 1: Hardcoded mock
    if tool in _MOCK_REGISTRY and action in _MOCK_REGISTRY[tool]:
        result = _MOCK_REGISTRY[tool][action](params, state)
        state._call_history.append({"tool": tool, "action": action, "params": params, "result": result})
        return result

    # Layer 2: Template mock
    template_result = _template_mock(tool, action, params, state)
    if template_result:
        state._call_history.append({"tool": tool, "action": action, "params": params, "result": template_result})
        return template_result

    # Layer 3: LLM mock (with Layer 4 session memory as context)
    llm_result = _llm_mock(tool, action, params, state)
    if llm_result:
        state._call_history.append({"tool": tool, "action": action, "params": params, "result": llm_result})
        return llm_result

    # Fallback
    fallback = {"status": "ok", "tool": tool, "action": action, "message": f"Mock: {tool}.{action} executed"}
    state._call_history.append({"tool": tool, "action": action, "params": params, "result": fallback})
    return fallback


def list_available_mocks() -> list[str]:
    """List all registered mock functions as tool.action strings."""
    result = []
    for tool, actions in sorted(_MOCK_REGISTRY.items()):
        for action in sorted(actions.keys()):
            result.append(f"{tool}.{action}")
    return result


def _gen_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:8]}"


# ── Layer 2: Template Mocks ──────────────────────────────────────────────
# Pattern-match action names to predictable response shapes.
# Covers ~80% of actions with zero LLM cost.

_TEMPLATE_PATTERNS = {
    "get_": lambda tool, action, params, state: _template_get(tool, action, params, state),
    "list_": lambda tool, action, params, state: _template_list(tool, action, params, state),
    "create_": lambda tool, action, params, state: _template_create(tool, action, params, state),
    "delete_": lambda tool, action, params, state: _template_delete(tool, action, params, state),
    "update_": lambda tool, action, params, state: _template_update(tool, action, params, state),
    "send_": lambda tool, action, params, state: _template_send(tool, action, params, state),
    "search_": lambda tool, action, params, state: _template_list(tool, action, params, state),
    "query_": lambda tool, action, params, state: _template_list(tool, action, params, state),
    "check_": lambda tool, action, params, state: _template_check(tool, action, params, state),
    "start_": lambda tool, action, params, state: _template_state_change(tool, action, params, "started"),
    "stop_": lambda tool, action, params, state: _template_state_change(tool, action, params, "stopped"),
    "restart_": lambda tool, action, params, state: _template_state_change(tool, action, params, "restarting"),
    "terminate_": lambda tool, action, params, state: _template_state_change(tool, action, params, "terminated"),
    "enable_": lambda tool, action, params, state: _template_state_change(tool, action, params, "enabled"),
    "disable_": lambda tool, action, params, state: _template_state_change(tool, action, params, "disabled"),
    "scale_": lambda tool, action, params, state: _template_scale(tool, action, params, state),
    "expand_": lambda tool, action, params, state: _template_expand(tool, action, params, state),
    "deploy_": lambda tool, action, params, state: _template_deploy(tool, action, params, state),
    "rollback_": lambda tool, action, params, state: _template_deploy(tool, action, params, state),
    "merge_": lambda tool, action, params, state: _template_state_change(tool, action, params, "merged"),
    "trigger_": lambda tool, action, params, state: _template_state_change(tool, action, params, "triggered"),
    "approve_": lambda tool, action, params, state: _template_state_change(tool, action, params, "approved"),
    "reject_": lambda tool, action, params, state: _template_state_change(tool, action, params, "rejected"),
    "acknowledge_": lambda tool, action, params, state: _template_state_change(tool, action, params, "acknowledged"),
    "resolve_": lambda tool, action, params, state: _template_state_change(tool, action, params, "resolved"),
    "escalate_": lambda tool, action, params, state: _template_state_change(tool, action, params, "escalated"),
    "close_": lambda tool, action, params, state: _template_state_change(tool, action, params, "closed"),
    "open_": lambda tool, action, params, state: _template_state_change(tool, action, params, "opened"),
    "assign_": lambda tool, action, params, state: _template_state_change(tool, action, params, "assigned"),
    "export_": lambda tool, action, params, state: _template_export(tool, action, params, state),
    "import_": lambda tool, action, params, state: _template_state_change(tool, action, params, "imported"),
    "correlate_": lambda tool, action, params, state: _template_correlate(tool, action, params, state),
    "analyze_": lambda tool, action, params, state: _template_correlate(tool, action, params, state),
    "read_": lambda tool, action, params, state: _template_get(tool, action, params, state),
    "cancel_": lambda tool, action, params, state: _template_state_change(tool, action, params, "cancelled"),
}


def _template_mock(tool: str, action: str, params: dict, state: MockState) -> dict | None:
    """Try to match action against template patterns."""
    for prefix, handler in _TEMPLATE_PATTERNS.items():
        if action.startswith(prefix):
            return handler(tool, action, params, state)
    # Also match suffix patterns
    if action.endswith("_status") or action.endswith("_health"):
        return _template_check(tool, action, params, state)
    if action.endswith("_metrics") or action.endswith("_logs"):
        return _template_get(tool, action, params, state)
    return None


def _template_get(tool, action, params, state):
    """Template for get/read actions — return a plausible record."""
    resource = action.replace("get_", "").replace("read_", "").rstrip("s")
    record_id = params.get("id") or params.get(f"{resource}_id") or _gen_id(f"{resource}_")
    return {
        resource: {
            "id": record_id,
            "name": f"Mock {resource.replace('_', ' ').title()}",
            "status": "active",
            "created_at": "2026-03-01T00:00:00Z",
            "metadata": {"source": f"{tool}.{action}", "mock": True},
        }
    }


def _template_list(tool, action, params, state):
    """Template for list/search/query actions — return a plausible array."""
    resource = action.replace("list_", "").replace("search_", "").replace("query_", "")
    return {
        resource: [
            {"id": _gen_id(f"{resource[:3]}_"), "name": f"Mock {resource.title()} 1", "status": "active"},
            {"id": _gen_id(f"{resource[:3]}_"), "name": f"Mock {resource.title()} 2", "status": "active"},
            {"id": _gen_id(f"{resource[:3]}_"), "name": f"Mock {resource.title()} 3", "status": "inactive"},
        ],
        "total": 3,
    }


def _template_create(tool, action, params, state):
    """Template for create actions — return created resource with ID."""
    resource = action.replace("create_", "")
    new_id = _gen_id(f"{resource[:3]}_")
    return {
        resource: {
            "id": new_id,
            "status": "created",
            **{k: v for k, v in params.items() if k != "id"},
        },
        "created": True,
    }


def _template_delete(tool, action, params, state):
    """Template for delete actions — confirm deletion."""
    resource = action.replace("delete_", "")
    record_id = params.get("id") or params.get(f"{resource}_id") or "unknown"
    if not hasattr(state, 'deleted_items'):
        state.deleted_items = []
    state.deleted_items.append({"tool": tool, "resource": resource, "id": record_id})
    return {"deleted": True, "id": record_id, "resource": resource}


def _template_update(tool, action, params, state):
    """Template for update actions — return updated resource."""
    resource = action.replace("update_", "")
    record_id = params.get("id") or params.get(f"{resource}_id") or "unknown"
    return {
        resource: {
            "id": record_id,
            "status": "updated",
            "updated_fields": list(params.keys()),
        },
        "updated": True,
    }


def _template_send(tool, action, params, state):
    """Template for send actions — confirm delivery."""
    msg_id = _gen_id("msg_")
    if not hasattr(state, 'emails_sent'):
        state.emails_sent = []
    state.emails_sent.append({"id": msg_id, "tool": tool, "params": params})
    return {
        "sent": True,
        "message_id": msg_id,
        "to": params.get("to") or params.get("recipient") or params.get("channel") or "recipient",
        "status": "delivered",
    }


def _template_check(tool, action, params, state):
    """Template for check/status/health actions."""
    resource = action.replace("check_", "").replace("_status", "").replace("_health", "")
    return {
        "resource": resource,
        "status": "healthy",
        "uptime": "99.97%",
        "last_checked": datetime.utcnow().isoformat(),
        "metrics": {"cpu": 42, "memory": 68, "latency_ms": 23},
    }


def _template_state_change(tool, action, params, new_state):
    """Template for state transitions (start, stop, terminate, approve, etc.)."""
    resource_id = params.get("id") or params.get("instance_id") or params.get("resource_id") or _gen_id()
    return {
        "id": resource_id,
        "previous_state": "unknown",
        "state": new_state,
        "action": action,
        "timestamp": datetime.utcnow().isoformat(),
    }


def _template_scale(tool, action, params, state):
    """Template for scale actions."""
    return {
        "service": params.get("service") or params.get("resource") or "service",
        "previous_count": params.get("current", 2),
        "desired_count": params.get("desired_count") or params.get("count") or 4,
        "status": "scaling",
        "estimated_time_seconds": 30,
    }


def _template_expand(tool, action, params, state):
    """Template for expand actions (storage, volume, capacity)."""
    return {
        "resource": params.get("resource_id") or params.get("volume_id") or _gen_id("vol_"),
        "previous_size": params.get("current_size") or "100GB",
        "new_size": params.get("new_size") or params.get("size") or "200GB",
        "status": "expanding",
        "requires_approval": True,
        "cost_delta": "$45.00/month",
    }


def _template_deploy(tool, action, params, state):
    """Template for deploy/rollback actions."""
    return {
        "deployment_id": _gen_id("deploy_"),
        "version": params.get("version") or params.get("ref") or "latest",
        "environment": params.get("environment") or "production",
        "status": "in_progress" if "deploy" in action else "rolling_back",
        "timestamp": datetime.utcnow().isoformat(),
    }


def _template_export(tool, action, params, state):
    """Template for export actions."""
    return {
        "export_id": _gen_id("export_"),
        "format": params.get("format") or "csv",
        "record_count": 150,
        "download_url": f"https://mock-export.actiongate.io/{_gen_id()}.csv",
        "status": "completed",
    }


def _template_correlate(tool, action, params, state):
    """Template for correlate/analyze actions."""
    # Use session memory to build context
    recent_data = []
    if hasattr(state, '_call_history'):
        recent_data = [
            {"action": h["action"], "result_summary": str(h["result"])[:100]}
            for h in state._call_history[-5:]
        ]
    return {
        "analysis_id": _gen_id("analysis_"),
        "status": "completed",
        "findings": [
            {"type": "correlation", "confidence": 0.87, "description": f"Pattern detected across {len(recent_data)} recent actions"},
            {"type": "anomaly", "confidence": 0.72, "description": "Elevated activity detected in recent window"},
        ],
        "data_sources_analyzed": len(recent_data),
        "context": recent_data,
    }


# ── Layer 3: LLM Mocks ──────────────────────────────────────────────────
# For actions that don't match any template, Haiku generates a response.
# Cached so the same tool.action only generates once.

import json as _json
import os as _os
import logging as _logging

_llm_mock_cache: dict[str, dict] = {}
_logger = _logging.getLogger("actiongate.mocks")


def _llm_mock(tool: str, action: str, params: dict, state: MockState) -> dict | None:
    """Generate a plausible mock response using Haiku. Cached per tool.action."""
    cache_key = f"{tool}.{action}"
    if cache_key in _llm_mock_cache:
        return _llm_mock_cache[cache_key]

    api_key = _os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return None

    # Layer 4: Build session context from call history
    session_context = ""
    if hasattr(state, '_call_history') and state._call_history:
        recent = state._call_history[-5:]
        session_context = "\n\nRecent actions in this session (use this to make the response contextually consistent):\n"
        for h in recent:
            session_context += f"- {h['tool']}.{h['action']}: {_json.dumps(h['result'])[:200]}\n"

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=500,
            system=(
                "You generate realistic mock API responses for testing AI agents. "
                "Return ONLY a JSON object — the response body that this API action would return. "
                "Use realistic fake data (names, IDs, timestamps, statuses). "
                "Keep responses concise but realistic. No explanation, just JSON."
            ),
            messages=[{"role": "user", "content": (
                f"Generate a mock response for:\n"
                f"Service: {tool}\n"
                f"Action: {action}\n"
                f"Parameters: {_json.dumps(params)}"
                f"{session_context}"
            )}],
        )

        text = response.content[0].text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

        result = _json.loads(text)
        _llm_mock_cache[cache_key] = result
        return result

    except Exception as e:
        _logger.warning(f"LLM mock failed for {tool}.{action}: {e}")
        return None
