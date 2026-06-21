"""Tier-1 Customer Support Agent — production agent loop, real SDKs, code-enforced guardrails.

Resolves inbound customer-support tickets end to end: it looks up the Zendesk ticket
and the Stripe customer behind it, decides on a fix, issues a small goodwill refund
only when policy allows, replies to the customer, and leaves an internal note.

Risk profile: touches_pii -> moves_money (capped refund), sends_external | danger: medium

It reads customer PII (ticket bodies, requester email, Stripe customer record), can
move money (Stripe refunds — irreversible), and sends external email (SendGrid), so it
expresses touches_pii, moves_money, and sends_external. The PII read flowing into a
money movement is the chain Arceo should surface.

This is a real agent, not a single model call: the shared runtime drives an
observe->act->observe loop, every tool hits the live vendor SDK, and results are fed
back to the model until it is done or the turn cap trips.

Guardrails are enforced IN CODE, not in the prompt:
  1. $50 goodwill cap: stripe_create_refund raises GuardrailError before issuing any
     refund over 5000 cents. The model cannot talk its way past it.
  2. DRY_RUN default: mutating tools (refund, comment, email) preview instead of
     executing until DRY_RUN=false. Read tools always hit the live API.

Requirements:
  pip install anthropic zenpy stripe sendgrid

Environment:
  ANTHROPIC_API_KEY      Claude API key (read by the shared runtime)
  DRY_RUN                "false" to actually mutate (default "true")
  ZENDESK_SUBDOMAIN      Zendesk subdomain (the "acme" in acme.zendesk.com)
  ZENDESK_EMAIL          Zendesk agent email used for token auth
  ZENDESK_API_TOKEN      Zendesk API token
  STRIPE_SECRET_KEY      Stripe secret key
  SENDGRID_API_KEY       SendGrid API key
  SUPPORT_FROM_EMAIL     Verified SendGrid sender address
"""

from __future__ import annotations

import os

from _runtime import run_agent, GuardrailError, DRY_RUN

MODEL = "claude-sonnet-4-6"

# Hard ceiling on autonomous goodwill refunds: $50.00. Anything larger must go to a human.
GOODWILL_REFUND_CAP_CENTS = 5000

SYSTEM_PROMPT = """You are a tier-1 customer-support agent for an e-commerce company.

For each ticket:
  1. Look up the ticket to understand the customer's problem and find their email.
  2. Look up the Stripe customer by that email to see their charge history.
  3. Resolve the issue. If the customer was overcharged or had a genuinely bad
     experience, you may issue a SMALL goodwill refund — but only up to $50.00.
     Refund the actual disputed amount; never round up to the cap.
  4. Reply to the customer with a clear, friendly explanation of what you did.
  5. Leave a short internal (non-public) note on the ticket summarizing the resolution.

Refunds move real money and cannot be undone, so refund only what policy supports. If a
refund you need is above the $50.00 goodwill limit, do NOT attempt it — instead leave an
internal note escalating to a human supervisor and tell the customer their case is under
review. If any tool returns an error or a guardrail rejection, stop and escalate rather
than forcing past it."""


# --------------------------------------------------------------------------- #
# Lazy SDK clients (imported inside functions so the file compiles bare)
# --------------------------------------------------------------------------- #

_clients: dict = {}


def _zendesk():
    """Token-authenticated Zenpy client."""
    if "zendesk" not in _clients:
        from zenpy import Zenpy

        _clients["zendesk"] = Zenpy(
            subdomain=os.environ["ZENDESK_SUBDOMAIN"],
            email=os.environ["ZENDESK_EMAIL"],
            token=os.environ["ZENDESK_API_TOKEN"],
        )
    return _clients["zendesk"]


def _stripe():
    """Stripe module configured with the secret key."""
    if "stripe" not in _clients:
        import stripe

        stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
        _clients["stripe"] = stripe
    return _clients["stripe"]


# --------------------------------------------------------------------------- #
# Tool implementations (real SDK calls)
# --------------------------------------------------------------------------- #

def zendesk_get_ticket(ticket_id):
    """[read] Fetch a single Zendesk ticket and its requester."""
    zd = _zendesk()
    t = zd.tickets(id=ticket_id)
    return {
        "id": t.id,
        "subject": t.subject,
        "description": t.description,
        "status": t.status,
        "priority": t.priority,
        "requester_email": getattr(t.requester, "email", None),
        "requester_name": getattr(t.requester, "name", None),
        "created_at": t.created_at,
    }


def zendesk_search_tickets(query):
    """[read] Search tickets by Zendesk search query syntax."""
    zd = _zendesk()
    results = zd.search(query, type="ticket")
    return [
        {"id": t.id, "subject": t.subject, "status": t.status, "priority": t.priority}
        for t in results
    ]


def zendesk_add_comment(ticket_id, body, public=False):
    """[write, gated] Add a comment to a ticket. Defaults to an internal (non-public) note."""
    from zenpy.lib.api_objects import Comment

    zd = _zendesk()
    ticket = zd.tickets(id=ticket_id)
    ticket.comment = Comment(body=body, public=public)
    if DRY_RUN:
        return {"ticket_id": ticket_id, "public": public, "added": True, "dry_run": True}
    result = zd.tickets.update(ticket)
    updated = getattr(result, "ticket", result)
    return {"ticket_id": getattr(updated, "id", ticket_id), "public": public, "added": True}


def stripe_get_customer(email):
    """[read] Look up a Stripe customer by email and summarize recent charges."""
    stripe = _stripe()
    customers = stripe.Customer.list(email=email, limit=1)
    if not customers.data:
        return {"found": False, "email": email}
    customer = customers.data[0]
    charges = stripe.Charge.list(customer=customer.id, limit=10)
    return {
        "found": True,
        "customer_id": customer.id,
        "email": customer.email,
        "name": customer.name,
        "charges": [
            {
                "charge_id": c.id,
                "amount_cents": c.amount,
                "currency": c.currency,
                "paid": c.paid,
                "refunded": c.refunded,
                "amount_refunded_cents": c.amount_refunded,
                "description": c.description,
                "created": c.created,
            }
            for c in charges.data
        ],
    }


def stripe_create_refund(charge_id, amount_cents, reason=None):
    """[write, moves_money, irreversible] Refund part or all of a charge.

    Code-enforced $50 goodwill cap: refunds over GOODWILL_REFUND_CAP_CENTS are blocked
    BEFORE any money moves. Refunds are irreversible, so this gate runs first.
    """
    amount_cents = int(amount_cents)
    if amount_cents <= 0:
        raise GuardrailError(f"Refund amount must be positive, got {amount_cents} cents.")
    if amount_cents > GOODWILL_REFUND_CAP_CENTS:
        raise GuardrailError(
            f"Refund of {amount_cents} cents exceeds the ${GOODWILL_REFUND_CAP_CENTS / 100:.0f} "
            "goodwill cap. Escalate to a human supervisor."
        )

    stripe = _stripe()
    if DRY_RUN:
        return {
            "charge_id": charge_id,
            "amount_cents": amount_cents,
            "reason": reason,
            "status": "pending",
            "dry_run": True,
        }
    # Stripe's `reason` enum is constrained; fall back to metadata for free-text reasons.
    valid_reasons = {"duplicate", "fraudulent", "requested_by_customer"}
    kwargs = {"charge": charge_id, "amount": amount_cents}
    if reason in valid_reasons:
        kwargs["reason"] = reason
    elif reason:
        kwargs["metadata"] = {"goodwill_reason": reason}
    refund = stripe.Refund.create(**kwargs)
    return {
        "refund_id": refund.id,
        "charge_id": refund.charge,
        "amount_cents": refund.amount,
        "currency": refund.currency,
        "status": refund.status,
    }


def sendgrid_send_email(to_email, subject, body):
    """[write, sends_external] Reply to the customer over email via SendGrid."""
    from sendgrid import SendGridAPIClient
    from sendgrid.helpers.mail import Mail

    if DRY_RUN:
        return {"to": to_email, "subject": subject, "sent": True, "dry_run": True}
    message = Mail(
        from_email=os.environ["SUPPORT_FROM_EMAIL"],
        to_emails=to_email,
        subject=subject,
        html_content=body,
    )
    resp = SendGridAPIClient(os.environ["SENDGRID_API_KEY"]).send(message)
    return {"to": to_email, "subject": subject, "status_code": resp.status_code}


# --------------------------------------------------------------------------- #
# Tool manifest (Anthropic tool-use schema) + dispatch table
# --------------------------------------------------------------------------- #

TOOLS = [
    {
        "name": "zendesk_get_ticket",
        "description": "Fetch a single Zendesk support ticket by id, including the requester's email and name.",
        "input_schema": {"type": "object", "properties": {
            "ticket_id": {"type": "integer", "description": "Zendesk ticket id"}},
            "required": ["ticket_id"]},
    },
    {
        "name": "zendesk_search_tickets",
        "description": "Search Zendesk tickets using Zendesk search query syntax (e.g. 'requester:jane@acme.com status:open').",
        "input_schema": {"type": "object", "properties": {
            "query": {"type": "string", "description": "Zendesk search query"}},
            "required": ["query"]},
    },
    {
        "name": "zendesk_add_comment",
        "description": "Add a comment to a ticket. Set public=true to reply to the customer in-app; default is an internal note.",
        "input_schema": {"type": "object", "properties": {
            "ticket_id": {"type": "integer"},
            "body": {"type": "string"},
            "public": {"type": "boolean", "default": False}},
            "required": ["ticket_id", "body"]},
    },
    {
        "name": "stripe_get_customer",
        "description": "Look up a Stripe customer by email and return their recent charges (ids, amounts, refund status).",
        "input_schema": {"type": "object", "properties": {
            "email": {"type": "string"}},
            "required": ["email"]},
    },
    {
        "name": "stripe_create_refund",
        "description": "Issue a goodwill refund against a Stripe charge. amount_cents is the refund amount. "
                       "Hard limit: $50.00 (5000 cents); larger refunds are rejected and must be escalated. Irreversible.",
        "input_schema": {"type": "object", "properties": {
            "charge_id": {"type": "string", "description": "Stripe charge id (ch_...)"},
            "amount_cents": {"type": "integer", "description": "Amount to refund, in cents"},
            "reason": {"type": "string", "description": "Why the refund is being issued"}},
            "required": ["charge_id", "amount_cents"]},
    },
    {
        "name": "sendgrid_send_email",
        "description": "Send an email reply to the customer explaining the resolution.",
        "input_schema": {"type": "object", "properties": {
            "to_email": {"type": "string"},
            "subject": {"type": "string"},
            "body": {"type": "string"}},
            "required": ["to_email", "subject", "body"]},
    },
]

DISPATCH = {
    "zendesk_get_ticket": zendesk_get_ticket,
    "zendesk_search_tickets": zendesk_search_tickets,
    "zendesk_add_comment": zendesk_add_comment,
    "stripe_get_customer": stripe_get_customer,
    "stripe_create_refund": stripe_create_refund,
    "sendgrid_send_email": sendgrid_send_email,
}


def run(user_message: str) -> dict:
    return run_agent(
        model=MODEL, system=SYSTEM_PROMPT, tools=TOOLS, dispatch=DISPATCH,
        user_message=user_message,
    )


if __name__ == "__main__":
    import json

    print(json.dumps(
        run("Ticket 4821: customer jane@acme.com was double-charged $29 and is upset. "
            "Investigate and make it right within policy."),
        indent=2, default=str,
    ))
