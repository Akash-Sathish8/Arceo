"""Mock Salesforce API — CRM contacts, accounts, records."""

from sandbox.mocks.registry import register_mock, MockState, _gen_id


@register_mock("salesforce", "query_contacts")
def query_contacts(params: dict, state: MockState) -> dict:
    query = params.get("query", "").lower()
    contacts = state.sf_contacts
    if query:
        contacts = [c for c in contacts if query in c["name"].lower() or query in c["email"].lower()]
    return {"contacts": contacts, "total": len(contacts)}


@register_mock("salesforce", "get_account")
def get_account(params: dict, state: MockState) -> dict:
    aid = params.get("account_id", "003_jane")
    contact = next((c for c in state.sf_contacts if c["id"] == aid), None)
    if not contact:
        return {"error": f"Account {aid} not found"}
    return {
        "account": {
            "id": aid, "name": contact["account"], "industry": "Technology",
            "annual_revenue": 5000000, "employees": 150,
            "primary_contact": contact["name"], "email": contact["email"],
        }
    }


@register_mock("salesforce", "update_record")
def update_record(params: dict, state: MockState) -> dict:
    rid = params.get("record_id", "003_jane")
    fields = params.get("fields", {})
    for c in state.sf_contacts:
        if c["id"] == rid:
            c.update(fields)
            return {"record": c, "updated": True}
    return {"error": f"Record {rid} not found"}


@register_mock("salesforce", "create_record")
def create_record(params: dict, state: MockState) -> dict:
    record = {
        "id": _gen_id("003_"),
        "name": params.get("name", "New Contact"),
        "email": params.get("email", "new@example.com"),
        "phone": params.get("phone", ""),
        "account": params.get("account", "Unknown"),
        "title": params.get("title", ""),
    }
    state.sf_contacts.append(record)
    return {"record": record, "created": True}


@register_mock("salesforce", "delete_record")
def delete_record(params: dict, state: MockState) -> dict:
    rid = params.get("record_id")
    for i, c in enumerate(state.sf_contacts):
        if c["id"] == rid:
            removed = state.sf_contacts.pop(i)
            state.deleted_items.append({"type": "sf_record", "id": rid, "data": removed})
            return {"deleted": True, "id": rid}
    return {"error": f"Record {rid} not found"}


@register_mock("salesforce", "query_opportunities")
def query_opportunities(params: dict, state: MockState) -> dict:
    return {
        "opportunities": [
            {"id": "opp_001", "name": "Enterprise Deal", "stage": "Negotiation", "amount": 120000},
            {"id": "opp_002", "name": "Mid-market Expansion", "stage": "Qualified", "amount": 45000},
        ],
        "total": 2,
    }


@register_mock("salesforce", "add_note")
def add_note(params: dict, state: MockState) -> dict:
    return {
        "note": {
            "id": _gen_id("note_"), "record_id": params.get("record_id", "003_jane"),
            "body": params.get("body", ""), "created": "2026-03-25T12:00:00",
        }
    }


@register_mock("salesforce", "get_contact_history")
def get_contact_history(params: dict, state: MockState) -> dict:
    cid = params.get("contact_id", "003_jane")
    contact = next((c for c in state.sf_contacts if c["id"] == cid), None)
    return {
        "contact_id": cid,
        "history": [
            {"type": "email", "subject": "Welcome to Enterprise plan", "date": "2025-06-15"},
            {"type": "call", "notes": "Discussed upgrade options", "date": "2025-11-20"},
            {"type": "meeting", "subject": "QBR", "date": "2026-01-15"},
        ],
        "contact_name": contact["name"] if contact else "Unknown",
    }
