"""Mock SendGrid API — outbound email."""

from sandbox.mocks.registry import register_mock, MockState, _gen_id


@register_mock("email", "send_email")
def send_email(params: dict, state: MockState) -> dict:
    email = {
        "id": _gen_id("msg_"),
        "to": params.get("to", "customer@example.com"),
        "from": "support@actiongate.io",
        "subject": params.get("subject", "No subject"),
        "body": params.get("body", ""),
        "status": "delivered",
    }
    state.emails_sent.append(email)
    return {"email": email}


@register_mock("email", "send_template_email")
def send_template_email(params: dict, state: MockState) -> dict:
    email = {
        "id": _gen_id("msg_"),
        "to": params.get("to", "customer@example.com"),
        "template_id": params.get("template_id", "tmpl_welcome"),
        "variables": params.get("variables", {}),
        "status": "delivered",
    }
    state.emails_sent.append(email)
    return {"email": email}


@register_mock("email", "list_templates")
def list_templates(params: dict, state: MockState) -> dict:
    return {
        "templates": [
            {"id": "tmpl_welcome", "name": "Welcome Email", "subject": "Welcome to ActionGate!"},
            {"id": "tmpl_refund", "name": "Refund Confirmation", "subject": "Your refund has been processed"},
            {"id": "tmpl_receipt", "name": "Payment Receipt", "subject": "Payment receipt"},
            {"id": "tmpl_account_deleted", "name": "Account Deleted", "subject": "Your account has been deleted"},
        ]
    }


@register_mock("email", "get_email_status")
def get_email_status(params: dict, state: MockState) -> dict:
    mid = params.get("message_id", "msg_001")
    sent = next((e for e in state.emails_sent if e["id"] == mid), None)
    if sent:
        return {"message_id": mid, "status": sent["status"], "delivered_at": "2026-03-25T12:01:00"}
    return {"message_id": mid, "status": "delivered", "delivered_at": "2026-03-25T12:01:00"}
