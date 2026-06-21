"""Mock PagerDuty API — incidents, on-call, escalations."""

from sandbox.mocks.registry import register_mock, MockState, _gen_id


@register_mock("pagerduty", "create_incident")
def create_incident(params: dict, state: MockState) -> dict:
    inc = {
        "id": _gen_id("INC-"),
        "title": params.get("title", "New incident"),
        "status": "triggered",
        "severity": params.get("severity", "high"),
        "service": params.get("service", "api-prod"),
        "created": "2026-03-25T12:00:00",
    }
    state.incidents[inc["id"]] = inc
    return {"incident": inc}


@register_mock("pagerduty", "acknowledge_incident")
def acknowledge_incident(params: dict, state: MockState) -> dict:
    iid = params.get("incident_id", "INC-101")
    inc = state.incidents.get(iid)
    if inc:
        inc["status"] = "acknowledged"
    return {"incident_id": iid, "status": "acknowledged"}


@register_mock("pagerduty", "resolve_incident")
def resolve_incident(params: dict, state: MockState) -> dict:
    iid = params.get("incident_id", "INC-101")
    inc = state.incidents.get(iid)
    if inc:
        inc["status"] = "resolved"
    return {"incident_id": iid, "status": "resolved"}


@register_mock("pagerduty", "get_oncall")
def get_oncall(params: dict, state: MockState) -> dict:
    return {
        "oncall": [
            {"user": "alice@actiongate.io", "schedule": "Primary", "start": "2026-03-25T00:00:00", "end": "2026-03-26T00:00:00"},
            {"user": "bob@actiongate.io", "schedule": "Secondary", "start": "2026-03-25T00:00:00", "end": "2026-03-26T00:00:00"},
        ]
    }


@register_mock("pagerduty", "escalate_incident")
def escalate_incident(params: dict, state: MockState) -> dict:
    iid = params.get("incident_id", "INC-101")
    return {
        "incident_id": iid,
        "escalated_to": "engineering-managers",
        "level": 2,
        "status": "escalated",
    }


@register_mock("pagerduty", "list_incidents")
def list_incidents(params: dict, state: MockState) -> dict:
    return {"incidents": list(state.incidents.values()), "total": len(state.incidents)}
