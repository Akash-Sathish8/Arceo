"""Mock Calendly API — events, scheduling, availability."""

from sandbox.mocks.registry import register_mock, MockState, _gen_id


@register_mock("calendly", "list_events")
def list_events(params: dict, state: MockState) -> dict:
    return {"events": state.calendar_events, "total": len(state.calendar_events)}


@register_mock("calendly", "create_invite_link")
def create_invite_link(params: dict, state: MockState) -> dict:
    return {
        "invite_link": {
            "url": f"https://calendly.com/actiongate/{_gen_id()}",
            "event_type": params.get("event_type", "30-min-demo"),
            "created": True,
        }
    }


@register_mock("calendly", "cancel_event")
def cancel_event(params: dict, state: MockState) -> dict:
    eid = params.get("event_id", "evt_001")
    for evt in state.calendar_events:
        if evt["id"] == eid:
            evt["status"] = "cancelled"
            return {"cancelled": True, "event": evt}
    return {"error": f"Event {eid} not found"}


@register_mock("calendly", "get_availability")
def get_availability(params: dict, state: MockState) -> dict:
    return {
        "available_slots": [
            {"date": "2026-03-26", "times": ["09:00", "10:00", "14:00", "15:30"]},
            {"date": "2026-03-27", "times": ["09:00", "11:00", "13:00", "16:00"]},
            {"date": "2026-03-28", "times": ["10:00", "14:00"]},
        ]
    }


@register_mock("calendly", "list_event_types")
def list_event_types(params: dict, state: MockState) -> dict:
    return {
        "event_types": [
            {"id": "et_001", "name": "30-Minute Demo", "duration": 30, "color": "#0066ff"},
            {"id": "et_002", "name": "60-Minute Deep Dive", "duration": 60, "color": "#00cc66"},
            {"id": "et_003", "name": "15-Minute Intro Call", "duration": 15, "color": "#ff6600"},
        ]
    }
