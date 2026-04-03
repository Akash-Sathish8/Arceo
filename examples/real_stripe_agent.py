"""Real Stripe agent monitored by Arceo.

This agent calls REAL Stripe test mode APIs. Arceo's @monitor captures
every tool call and analyzes the risk — without interfering with Stripe.

Usage:
    export ANTHROPIC_API_KEY=sk-ant-...
    python3 examples/real_stripe_agent.py
"""

import json
import os
import stripe
import anthropic
from arceo import monitor, tool

STRIPE_KEY = os.getenv("STRIPE_SECRET_KEY", "")
if not STRIPE_KEY:
    print("Set STRIPE_SECRET_KEY env var. Get a test key from dashboard.stripe.com")
    exit(1)
stripe.api_key = STRIPE_KEY


# ── Real Stripe tools ────────────────────────────────────────────────────

@tool(service="stripe", risk="touches_pii")
def stripe_get_customer(customer_id: str):
    """Look up a real Stripe customer."""
    c = stripe.Customer.retrieve(customer_id)
    return {"id": c.id, "name": c.name, "email": c.email, "created": c.created}


@tool(service="stripe", risk="touches_pii")
def stripe_list_customers(limit: int = 5):
    """List real Stripe customers."""
    customers = stripe.Customer.list(limit=limit)
    return [{"id": c.id, "name": c.name, "email": c.email} for c in customers.data]


@tool(service="stripe", risk="moves_money")
def stripe_list_payments(customer_id: str):
    """List real payment intents for a customer."""
    payments = stripe.PaymentIntent.list(customer=customer_id, limit=5)
    return [{"id": p.id, "amount": p.amount, "currency": p.currency, "status": p.status} for p in payments.data]


@tool(service="stripe", risk="moves_money")
def stripe_create_refund(payment_intent_id: str, amount: int = None):
    """Issue a real refund in Stripe test mode."""
    params = {"payment_intent": payment_intent_id}
    if amount:
        params["amount"] = amount
    try:
        refund = stripe.Refund.create(**params)
        return {"id": refund.id, "amount": refund.amount, "status": refund.status}
    except stripe.error.InvalidRequestError as e:
        return {"error": str(e)}


@tool(service="stripe")
def stripe_get_balance():
    """Get the real Stripe account balance."""
    balance = stripe.Balance.retrieve()
    return [{"currency": b.currency, "amount": b.amount} for b in balance.available]


# ── Agent ────────────────────────────────────────────────────────────────

@monitor(api_url="http://localhost:8000", verbose=True)
def billing_agent(prompt: str):
    """A billing agent that calls real Stripe APIs."""
    # List customers
    customers = stripe_list_customers(3)
    print(f"\nFound {len(customers)} customers")

    if customers:
        # Get first customer details
        customer = stripe_get_customer(customers[0]["id"])
        print(f"Customer: {customer.get('name')} ({customer.get('email')})")

        # Check their payments
        payments = stripe_list_payments(customers[0]["id"])
        print(f"Payments: {len(payments)}")

        # Check balance
        balance = stripe_get_balance()
        print(f"Balance: {balance}")

    return "done"


# ── Run ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Running billing agent against REAL Stripe test mode...\n")
    billing_agent("Check our customers and their payment status")
