"""Mock Stripe API — payments, refunds, subscriptions, customers."""

from sandbox.mocks.registry import register_mock, MockState, _gen_id


@register_mock("stripe", "get_customer")
def get_customer(params: dict, state: MockState) -> dict:
    cid = params.get("customer_id", "cust_1042")
    customer = state.customers.get(cid)
    if not customer:
        return {"error": f"No such customer: {cid}"}
    return {"customer": customer}


@register_mock("stripe", "list_payments")
def list_payments(params: dict, state: MockState) -> dict:
    cid = params.get("customer_id")
    payments = state.payments
    if cid:
        payments = [p for p in payments if p["customer"] == cid]
    return {"payments": payments, "total": len(payments)}


@register_mock("stripe", "get_invoice")
def get_invoice(params: dict, state: MockState) -> dict:
    return {
        "invoice": {
            "id": params.get("invoice_id", "inv_001"),
            "customer": "cust_1042", "amount": 9900, "currency": "usd",
            "status": "paid", "period_start": "2026-03-01", "period_end": "2026-03-31",
        }
    }


@register_mock("stripe", "create_refund")
def create_refund(params: dict, state: MockState) -> dict:
    refund = {
        "id": _gen_id("re_"), "payment": params.get("payment_id", "pay_001"),
        "amount": params.get("amount", 9900), "currency": "usd",
        "status": "succeeded", "reason": params.get("reason", "requested_by_customer"),
    }
    state.refunds.append(refund)
    return {"refund": refund}


@register_mock("stripe", "create_charge")
def create_charge(params: dict, state: MockState) -> dict:
    charge = {
        "id": _gen_id("ch_"), "customer": params.get("customer_id", "cust_1042"),
        "amount": params.get("amount", 5000), "currency": "usd",
        "status": "succeeded", "description": params.get("description", ""),
    }
    state.charges.append(charge)
    return {"charge": charge}


@register_mock("stripe", "update_subscription")
def update_subscription(params: dict, state: MockState) -> dict:
    return {
        "subscription": {
            "id": params.get("subscription_id", "sub_001"),
            "customer": params.get("customer_id", "cust_1042"),
            "plan": params.get("plan", "enterprise"), "status": "active",
            "updated": True,
        }
    }


@register_mock("stripe", "cancel_subscription")
def cancel_subscription(params: dict, state: MockState) -> dict:
    return {
        "subscription": {
            "id": params.get("subscription_id", "sub_001"),
            "status": "canceled", "canceled_at": "2026-03-25T12:00:00",
        }
    }


@register_mock("stripe", "delete_customer")
def delete_customer(params: dict, state: MockState) -> dict:
    cid = params.get("customer_id", "cust_1042")
    customer = state.customers.pop(cid, None)
    if customer:
        state.deleted_items.append({"type": "customer", "id": cid, "data": customer})
    return {"deleted": True, "id": cid}
