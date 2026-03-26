"""Mock Zendesk API — support tickets."""

from sandbox.mocks.registry import register_mock, MockState, _gen_id


@register_mock("zendesk", "get_ticket")
def get_ticket(params: dict, state: MockState) -> dict:
    tid = params.get("ticket_id", "4821")
    ticket = state.tickets.get(str(tid))
    if not ticket:
        return {"error": f"Ticket {tid} not found"}
    return {"ticket": ticket}


@register_mock("zendesk", "update_ticket")
def update_ticket(params: dict, state: MockState) -> dict:
    tid = str(params.get("ticket_id", "4821"))
    ticket = state.tickets.get(tid)
    if not ticket:
        return {"error": f"Ticket {tid} not found"}
    for key in ("status", "priority", "subject", "assignee"):
        if key in params:
            ticket[key] = params[key]
    return {"ticket": ticket, "updated": True}


@register_mock("zendesk", "close_ticket")
def close_ticket(params: dict, state: MockState) -> dict:
    tid = str(params.get("ticket_id", "4821"))
    ticket = state.tickets.get(tid)
    if not ticket:
        return {"error": f"Ticket {tid} not found"}
    ticket["status"] = "closed"
    return {"ticket": ticket}


@register_mock("zendesk", "create_ticket")
def create_ticket(params: dict, state: MockState) -> dict:
    tid = _gen_id()[:4]
    ticket = {
        "id": tid, "subject": params.get("subject", "New ticket"),
        "status": "open", "priority": params.get("priority", "normal"),
        "requester": params.get("requester", "unknown@email.com"),
        "assignee": None, "created": "2026-03-25T12:00:00", "comments": [],
    }
    state.tickets[tid] = ticket
    return {"ticket": ticket}


@register_mock("zendesk", "add_comment")
def add_comment(params: dict, state: MockState) -> dict:
    tid = str(params.get("ticket_id", "4821"))
    ticket = state.tickets.get(tid)
    if not ticket:
        return {"error": f"Ticket {tid} not found"}
    comment = {"author": "agent", "body": params.get("body", ""), "created": "2026-03-25T12:00:00"}
    ticket["comments"].append(comment)
    return {"comment": comment, "public": params.get("public", True)}


@register_mock("zendesk", "assign_ticket")
def assign_ticket(params: dict, state: MockState) -> dict:
    tid = str(params.get("ticket_id", "4821"))
    ticket = state.tickets.get(tid)
    if not ticket:
        return {"error": f"Ticket {tid} not found"}
    ticket["assignee"] = params.get("assignee", "agent@actiongate.io")
    return {"ticket": ticket}


@register_mock("zendesk", "list_tickets")
def list_tickets(params: dict, state: MockState) -> dict:
    status = params.get("status")
    tickets = list(state.tickets.values())
    if status:
        tickets = [t for t in tickets if t["status"] == status]
    return {"tickets": tickets, "total": len(tickets)}


@register_mock("zendesk", "delete_ticket")
def delete_ticket(params: dict, state: MockState) -> dict:
    tid = str(params.get("ticket_id"))
    ticket = state.tickets.pop(tid, None)
    if ticket:
        state.deleted_items.append({"type": "ticket", "id": tid, "data": ticket})
    return {"deleted": True, "id": tid}
