"""Mock Gmail API — email, threads, drafts."""

from sandbox.mocks.registry import register_mock, MockState, _gen_id


@register_mock("gmail", "send_email")
def send_email(params: dict, state: MockState) -> dict:
    email = {
        "id": _gen_id("gm_"),
        "to": params.get("to", "prospect@example.com"),
        "from": "sales@actiongate.io",
        "subject": params.get("subject", ""),
        "body": params.get("body", ""),
        "status": "sent",
    }
    state.emails_sent.append(email)
    return {"email": email}


@register_mock("gmail", "read_inbox")
def read_inbox(params: dict, state: MockState) -> dict:
    return {
        "messages": [
            {"id": "gm_in_001", "from": "sarah@bigcorp.com", "subject": "Re: Enterprise pricing",
             "snippet": "Thanks for the proposal. Can we schedule a call?", "date": "2026-03-24", "unread": True},
            {"id": "gm_in_002", "from": "mike@techfirm.io", "subject": "Follow up - demo request",
             "snippet": "We'd love to see a demo of the platform.", "date": "2026-03-23", "unread": True},
            {"id": "gm_in_003", "from": "noreply@linkedin.com", "subject": "New connection request",
             "snippet": "Lisa Wang wants to connect with you.", "date": "2026-03-23", "unread": False},
        ],
        "total_unread": 2,
    }


@register_mock("gmail", "search_emails")
def search_emails(params: dict, state: MockState) -> dict:
    query = params.get("query", "")
    return {
        "query": query,
        "results": [
            {"id": "gm_s_001", "from": "sarah@bigcorp.com", "subject": "Enterprise pricing inquiry",
             "snippet": "We're interested in your enterprise plan for 200 seats.", "date": "2026-03-20"},
            {"id": "gm_s_002", "from": "sarah@bigcorp.com", "subject": "Re: Enterprise pricing",
             "snippet": "The proposal looks good. Let's discuss volume discounts.", "date": "2026-03-24"},
        ],
        "total": 2,
    }


@register_mock("gmail", "create_draft")
def create_draft(params: dict, state: MockState) -> dict:
    return {
        "draft": {
            "id": _gen_id("draft_"),
            "to": params.get("to", ""),
            "subject": params.get("subject", ""),
            "body": params.get("body", ""),
            "status": "draft",
        }
    }


@register_mock("gmail", "send_draft")
def send_draft(params: dict, state: MockState) -> dict:
    draft_id = params.get("draft_id", "draft_001")
    email = {
        "id": _gen_id("gm_"),
        "draft_id": draft_id,
        "status": "sent",
    }
    state.emails_sent.append(email)
    return {"sent": True, "message_id": email["id"]}


@register_mock("gmail", "list_threads")
def list_threads(params: dict, state: MockState) -> dict:
    return {"threads": state.gmail_threads, "total": len(state.gmail_threads)}


@register_mock("gmail", "get_thread")
def get_thread(params: dict, state: MockState) -> dict:
    tid = params.get("thread_id", "thread_001")
    thread = next((t for t in state.gmail_threads if t["id"] == tid), None)
    if not thread:
        return {"error": f"Thread {tid} not found"}
    return {
        "thread": thread,
        "messages": [
            {"id": "gm_t_001", "from": "sales@actiongate.io", "body": "Hi Sarah, here's our enterprise pricing...", "date": "2026-03-19"},
            {"id": "gm_t_002", "from": "sarah@bigcorp.com", "body": "Thanks! We're interested in the 200-seat plan.", "date": "2026-03-20"},
            {"id": "gm_t_003", "from": "sales@actiongate.io", "body": "Great! I've attached a custom proposal.", "date": "2026-03-21"},
            {"id": "gm_t_004", "from": "sarah@bigcorp.com", "body": thread["snippet"], "date": thread["date"]},
        ],
    }
