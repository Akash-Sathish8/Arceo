"""Mock HubSpot API — CRM contacts, deals, companies."""

from sandbox.mocks.registry import register_mock, MockState, _gen_id


@register_mock("hubspot", "get_contact")
def get_contact(params: dict, state: MockState) -> dict:
    cid = params.get("contact_id", "hs_001")
    contact = next((c for c in state.hubspot_contacts if c["id"] == cid), None)
    if not contact:
        return {"error": f"Contact {cid} not found"}
    return {"contact": contact}


@register_mock("hubspot", "create_contact")
def create_contact(params: dict, state: MockState) -> dict:
    contact = {
        "id": _gen_id("hs_"),
        "name": params.get("name", "New Contact"),
        "email": params.get("email", "new@example.com"),
        "phone": params.get("phone", ""),
        "company": params.get("company", "Unknown"),
        "deal_stage": "new", "deal_value": 0,
        "last_activity": "2026-03-25",
    }
    state.hubspot_contacts.append(contact)
    return {"contact": contact, "created": True}


@register_mock("hubspot", "update_contact")
def update_contact(params: dict, state: MockState) -> dict:
    cid = params.get("contact_id", "hs_001")
    for c in state.hubspot_contacts:
        if c["id"] == cid:
            for key in ("name", "email", "phone", "company"):
                if key in params:
                    c[key] = params[key]
            return {"contact": c, "updated": True}
    return {"error": f"Contact {cid} not found"}


@register_mock("hubspot", "delete_contact")
def delete_contact(params: dict, state: MockState) -> dict:
    cid = params.get("contact_id")
    for i, c in enumerate(state.hubspot_contacts):
        if c["id"] == cid:
            removed = state.hubspot_contacts.pop(i)
            state.deleted_items.append({"type": "hubspot_contact", "id": cid, "data": removed})
            return {"deleted": True, "id": cid}
    return {"error": f"Contact {cid} not found"}


@register_mock("hubspot", "list_deals")
def list_deals(params: dict, state: MockState) -> dict:
    return {"deals": state.deals, "total": len(state.deals)}


@register_mock("hubspot", "update_deal")
def update_deal(params: dict, state: MockState) -> dict:
    did = params.get("deal_id", "deal_001")
    for d in state.deals:
        if d["id"] == did:
            for key in ("stage", "amount", "name"):
                if key in params:
                    d[key] = params[key]
            return {"deal": d, "updated": True}
    return {"error": f"Deal {did} not found"}


@register_mock("hubspot", "create_deal")
def create_deal(params: dict, state: MockState) -> dict:
    deal = {
        "id": _gen_id("deal_"),
        "name": params.get("name", "New Deal"),
        "stage": params.get("stage", "qualified"),
        "amount": params.get("amount", 0),
        "contact": params.get("contact_id", ""),
    }
    state.deals.append(deal)
    return {"deal": deal, "created": True}


@register_mock("hubspot", "get_company")
def get_company(params: dict, state: MockState) -> dict:
    return {
        "company": {
            "id": params.get("company_id", "comp_001"),
            "name": "BigCorp", "industry": "Technology",
            "size": "500-1000", "revenue": "$50M-$100M",
            "website": "https://bigcorp.com",
        }
    }


@register_mock("hubspot", "query_contacts")
def query_contacts(params: dict, state: MockState) -> dict:
    query = params.get("query", "").lower()
    contacts = state.hubspot_contacts
    if query:
        contacts = [c for c in contacts if query in c["name"].lower() or query in c.get("company", "").lower()]
    return {"contacts": contacts, "total": len(contacts)}


@register_mock("hubspot", "add_note")
def add_note(params: dict, state: MockState) -> dict:
    return {
        "note": {
            "id": _gen_id("note_"),
            "contact_id": params.get("contact_id", "hs_001"),
            "body": params.get("body", ""),
            "created": "2026-03-25T12:00:00",
        }
    }


@register_mock("hubspot", "get_contact_activity")
def get_contact_activity(params: dict, state: MockState) -> dict:
    cid = params.get("contact_id", "hs_001")
    contact = next((c for c in state.hubspot_contacts if c["id"] == cid), None)
    return {
        "contact_id": cid,
        "contact_name": contact["name"] if contact else "Unknown",
        "activities": [
            {"type": "email_open", "subject": "Pricing proposal", "date": "2026-03-22"},
            {"type": "page_view", "url": "/pricing", "date": "2026-03-23"},
            {"type": "form_submit", "form": "Demo Request", "date": "2026-03-24"},
        ],
    }
