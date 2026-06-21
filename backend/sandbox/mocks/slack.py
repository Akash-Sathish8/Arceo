"""Mock Slack API — messages, channels, files."""

from sandbox.mocks.registry import register_mock, MockState, _gen_id


@register_mock("slack", "send_message")
def send_message(params: dict, state: MockState) -> dict:
    msg = {
        "id": _gen_id("msg_"), "channel": params.get("user", "U_unknown"),
        "text": params.get("text", ""), "type": "dm",
        "timestamp": "2026-03-25T12:00:00",
    }
    state.slack_messages.append(msg)
    return {"message": msg, "ok": True}


@register_mock("slack", "send_channel_message")
def send_channel_message(params: dict, state: MockState) -> dict:
    msg = {
        "id": _gen_id("msg_"), "channel": params.get("channel", "#general"),
        "text": params.get("text", ""), "type": "channel",
        "timestamp": "2026-03-25T12:00:00",
    }
    state.slack_messages.append(msg)
    return {"message": msg, "ok": True}


@register_mock("slack", "create_channel")
def create_channel(params: dict, state: MockState) -> dict:
    return {
        "channel": {
            "id": _gen_id("C"),
            "name": params.get("name", "new-channel"),
            "created": True,
        }
    }


@register_mock("slack", "list_channels")
def list_channels(params: dict, state: MockState) -> dict:
    return {
        "channels": [
            {"id": "C001", "name": "general", "members": 42},
            {"id": "C002", "name": "engineering", "members": 15},
            {"id": "C003", "name": "releases", "members": 20},
            {"id": "C004", "name": "incidents", "members": 12},
        ]
    }


@register_mock("slack", "upload_file")
def upload_file(params: dict, state: MockState) -> dict:
    return {
        "file": {
            "id": _gen_id("F"),
            "name": params.get("filename", "report.pdf"),
            "channel": params.get("channel", "#general"),
            "size": 24576,
            "uploaded": True,
        }
    }
