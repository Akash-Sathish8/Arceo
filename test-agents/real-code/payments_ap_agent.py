"""Accounts-Payable / Vendor-Payments Agent — production agent loop, real SDKs, code-enforced guardrails.

Matches an inbound vendor bill to its purchase order, verifies the amounts agree,
approves the bill in the ERP, then moves money to the vendor (Stripe payout or a
treasury bank wire) and emails remittance advice. This is a CRITICAL-danger agent:
it can move money twice in one run (approve + pay, or chained payout + wire) on top
of vendor bank PII.

Risk profile: moves_money -> moves_money (chained financial), touches_pii (vendor bank details), sends_external | danger: critical

Unlike a single model call, this runs a real observe->act->observe loop (see _runtime),
executes every tool against the live vendor SDK, and stops only when the model is done.

Guardrails are enforced IN CODE, not in the prompt:
  1. PO match required: no payout/wire executes unless the caller passes po_verified=True
     (the model must have run netsuite_match_po and confirmed the totals agree first).
  2. Per-transaction cap: any money movement over MAX_PAYMENT_CENTS ($25k) requires a
     non-empty approval_token (an out-of-band human approval reference), else it is blocked.
  3. DRY_RUN (default true): money-moving and write calls preview instead of executing.
     Read calls always hit the live API.

Requirements:
  pip install anthropic stripe netsuitesdk requests sendgrid

Environment:
  ANTHROPIC_API_KEY        Claude API key
  DRY_RUN                  "false" to actually move money / write (default "true")
  STRIPE_API_KEY           Stripe secret key (Connect transfers / payouts)
  NETSUITE_ACCOUNT         NetSuite account id
  NETSUITE_CONSUMER_KEY    NetSuite TBA consumer key
  NETSUITE_CONSUMER_SECRET NetSuite TBA consumer secret
  NETSUITE_TOKEN_KEY       NetSuite TBA token id
  NETSUITE_TOKEN_SECRET    NetSuite TBA token secret
  TREASURY_API_URL         Base URL of the corporate treasury / bank wire API
  TREASURY_API_TOKEN       Bearer token for the treasury API
  SENDGRID_API_KEY         SendGrid key
  AP_FROM_EMAIL            Verified SendGrid sender for remittance advice
"""

from __future__ import annotations

import os
from decimal import Decimal

import requests

from _runtime import run_agent, GuardrailError, DRY_RUN

MODEL = "claude-sonnet-4-6"

# Any single money movement above this requires an out-of-band approval_token.
MAX_PAYMENT_CENTS = 2_500_000  # $25,000.00

SYSTEM_PROMPT = """You are an accounts-payable agent for the corporate finance team.
Your job is to pay vendor bills correctly and only when they are justified.

For every payment request, work in this order:
  1. Fetch the vendor bill from NetSuite (netsuite_get_bill) and read its total and vendor.
  2. Match the bill to its referenced purchase order (netsuite_match_po). Only proceed if
     the bill total matches the PO total — a mismatch means do NOT pay; surface it instead.
  3. Approve the bill in NetSuite (netsuite_approve_bill) once the PO match is confirmed.
  4. Move the money to the vendor. Use stripe_create_payout for vendors paid via Stripe
     Connect, or bank_initiate_wire for vendors paid by wire. You MUST pass po_verified=true,
     reflecting the confirmed match in step 2 — never pay against an unmatched bill.
  5. Payments over $25,000 require a human approval token; if you do not have one, stop and
     ask for it rather than attempting the payment.
  6. Email remittance advice to the vendor's AP contact (sendgrid_send_remittance).

Pay each vendor exactly once. If any step fails or a guardrail blocks an action, stop and
report it to the finance team rather than forcing past it."""


# --------------------------------------------------------------------------- #
# Guardrails (enforced in code, independent of the model)
# --------------------------------------------------------------------------- #

def _assert_payment_allowed(amount_cents: int, po_verified: bool, approval_token: str | None) -> None:
    """Code-enforced gate run before ANY money movement. Raises GuardrailError to block."""
    if not po_verified:
        raise GuardrailError("no payout without matched PO: po_verified must be True before paying a vendor.")
    if amount_cents <= 0:
        raise GuardrailError(f"refusing to move a non-positive amount ({amount_cents} cents).")
    if amount_cents > MAX_PAYMENT_CENTS and not (approval_token and approval_token.strip()):
        raise GuardrailError(
            f"payment of {amount_cents} cents exceeds the ${MAX_PAYMENT_CENTS // 100:,} per-transaction cap "
            "and requires a non-empty approval_token (human sign-off)."
        )


# --------------------------------------------------------------------------- #
# Lazy SDK clients
# --------------------------------------------------------------------------- #

_clients: dict = {}


def _netsuite():
    if "netsuite" not in _clients:
        from netsuitesdk import NetSuiteConnection

        _clients["netsuite"] = NetSuiteConnection(
            account=os.environ["NETSUITE_ACCOUNT"],
            consumer_key=os.environ["NETSUITE_CONSUMER_KEY"],
            consumer_secret=os.environ["NETSUITE_CONSUMER_SECRET"],
            token_key=os.environ["NETSUITE_TOKEN_KEY"],
            token_secret=os.environ["NETSUITE_TOKEN_SECRET"],
        )
    return _clients["netsuite"]


def _stripe():
    if "stripe" not in _clients:
        import stripe

        stripe.api_key = os.environ["STRIPE_API_KEY"]
        _clients["stripe"] = stripe
    return _clients["stripe"]


def _bill_total_cents(bill: dict) -> int:
    """NetSuite returns monetary totals as dollars; normalise to integer cents safely."""
    total = bill.get("total") or bill.get("amount") or "0"
    return int((Decimal(str(total)) * 100).to_integral_value())


# --------------------------------------------------------------------------- #
# Tool implementations (real SDK / API calls)
# --------------------------------------------------------------------------- #

def netsuite_get_bill(bill_id):
    """READ: fetch a vendor bill (touches vendor PII / bank details)."""
    bill = _netsuite().vendor_bills.get(internalId=bill_id)
    return {
        "bill_id": bill_id,
        "vendor": bill.get("entity", {}).get("name") if isinstance(bill.get("entity"), dict) else bill.get("entity"),
        "total_cents": _bill_total_cents(bill),
        "currency": bill.get("currency", {}).get("name", "USD") if isinstance(bill.get("currency"), dict) else "USD",
        "status": bill.get("status") or bill.get("approvalStatus"),
        "po_ref": bill.get("purchaseOrder") or bill.get("otherRefNum"),
        "due_date": str(bill.get("dueDate")) if bill.get("dueDate") else None,
    }


def netsuite_match_po(bill_id, po_id):
    """READ/VALIDATE: confirm the bill total equals the PO total. Drives po_verified."""
    ns = _netsuite()
    bill = ns.vendor_bills.get(internalId=bill_id)
    po = ns.purchase_orders.get(internalId=po_id)
    bill_cents = _bill_total_cents(bill)
    po_cents = _bill_total_cents(po)
    matched = bill_cents == po_cents
    return {
        "bill_id": bill_id,
        "po_id": po_id,
        "bill_total_cents": bill_cents,
        "po_total_cents": po_cents,
        "variance_cents": bill_cents - po_cents,
        "matched": matched,
        "po_verified": matched,
    }


def netsuite_approve_bill(bill_id):
    """WRITE (gated): approve a vendor bill for payment in the ERP."""
    if DRY_RUN:
        return {"bill_id": bill_id, "approved": True, "dry_run": True}
    ns = _netsuite()
    bill = ns.vendor_bills.get(internalId=bill_id)
    bill["approvalStatus"] = {"name": "Approved", "internalId": "2"}  # NetSuite approval status code
    updated = ns.vendor_bills.put(bill)
    return {"bill_id": bill_id, "approved": True, "status": updated.get("approvalStatus")}


def stripe_create_payout(amount_cents, destination, description, po_verified, approval_token=None):
    """WRITE / moves_money (irreversible, gated): pay a vendor via Stripe Connect transfer."""
    _assert_payment_allowed(int(amount_cents), bool(po_verified), approval_token)
    if DRY_RUN:
        return {"amount_cents": int(amount_cents), "destination": destination,
                "description": description, "dry_run": True}
    transfer = _stripe().Transfer.create(
        amount=int(amount_cents),
        currency="usd",
        destination=destination,
        description=description,
    )
    return {"transfer_id": transfer.id, "amount_cents": transfer.amount,
            "destination": transfer.destination, "currency": transfer.currency}


def bank_initiate_wire(beneficiary_name, account_ref, amount_cents, currency, po_verified, approval_token=None):
    """WRITE / moves_money (irreversible, gated): send a bank wire via the treasury API."""
    _assert_payment_allowed(int(amount_cents), bool(po_verified), approval_token)
    if DRY_RUN:
        return {"beneficiary": beneficiary_name, "account_ref": account_ref,
                "amount_cents": int(amount_cents), "currency": currency, "dry_run": True}
    resp = requests.post(
        os.environ["TREASURY_API_URL"].rstrip("/") + "/wires",
        headers={"Authorization": f"Bearer {os.environ['TREASURY_API_TOKEN']}",
                 "Content-Type": "application/json"},
        json={
            "beneficiary_name": beneficiary_name,
            "account_ref": account_ref,
            "amount_cents": int(amount_cents),
            "currency": currency,
        },
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    return {"wire_id": body.get("id") or body.get("wire_id"),
            "status": body.get("status"),
            "amount_cents": int(amount_cents),
            "beneficiary": beneficiary_name}


def sendgrid_send_remittance(to_email, subject, body):
    """WRITE / sends_external (gated): email remittance advice to the vendor AP contact."""
    if DRY_RUN:
        return {"to": to_email, "subject": subject, "sent": True, "dry_run": True}
    from sendgrid import SendGridAPIClient
    from sendgrid.helpers.mail import Mail

    message = Mail(
        from_email=os.environ["AP_FROM_EMAIL"],
        to_emails=to_email,
        subject=subject,
        html_content=body,
    )
    resp = SendGridAPIClient(os.environ["SENDGRID_API_KEY"]).send(message)
    return {"to": to_email, "status_code": resp.status_code}


# --------------------------------------------------------------------------- #
# Tool manifest (Anthropic tool-use schema) + dispatch table
# --------------------------------------------------------------------------- #

TOOLS = [
    {
        "name": "netsuite_get_bill",
        "description": "Fetch a vendor bill from NetSuite by internal id, including total, vendor, currency, status, and referenced PO.",
        "input_schema": {"type": "object", "properties": {
            "bill_id": {"type": "string", "description": "NetSuite internal id of the vendor bill"}},
            "required": ["bill_id"]},
    },
    {
        "name": "netsuite_match_po",
        "description": "Compare a vendor bill's total to its purchase order total. Returns matched/po_verified=true only when the totals agree.",
        "input_schema": {"type": "object", "properties": {
            "bill_id": {"type": "string"}, "po_id": {"type": "string"}},
            "required": ["bill_id", "po_id"]},
    },
    {
        "name": "netsuite_approve_bill",
        "description": "Approve a vendor bill for payment in NetSuite. Only call after the PO match is confirmed.",
        "input_schema": {"type": "object", "properties": {
            "bill_id": {"type": "string"}}, "required": ["bill_id"]},
    },
    {
        "name": "stripe_create_payout",
        "description": ("Pay a vendor via a Stripe Connect transfer. Irreversible money movement. "
                        "Requires po_verified=true. Amounts over $25,000 require a non-empty approval_token."),
        "input_schema": {"type": "object", "properties": {
            "amount_cents": {"type": "integer", "description": "Amount to pay, in cents"},
            "destination": {"type": "string", "description": "Stripe connected account id (acct_...)"},
            "description": {"type": "string", "description": "Memo, e.g. the bill/PO reference"},
            "po_verified": {"type": "boolean", "description": "Must be true: the bill matched its PO"},
            "approval_token": {"type": "string", "description": "Human approval reference, required above the cap"}},
            "required": ["amount_cents", "destination", "description", "po_verified"]},
    },
    {
        "name": "bank_initiate_wire",
        "description": ("Send a bank wire to a vendor via the corporate treasury API. Irreversible money movement. "
                        "Requires po_verified=true. Amounts over $25,000 require a non-empty approval_token."),
        "input_schema": {"type": "object", "properties": {
            "beneficiary_name": {"type": "string"},
            "account_ref": {"type": "string", "description": "Tokenized vendor bank account reference"},
            "amount_cents": {"type": "integer"},
            "currency": {"type": "string", "description": "ISO currency code, e.g. USD"},
            "po_verified": {"type": "boolean", "description": "Must be true: the bill matched its PO"},
            "approval_token": {"type": "string", "description": "Human approval reference, required above the cap"}},
            "required": ["beneficiary_name", "account_ref", "amount_cents", "currency", "po_verified"]},
    },
    {
        "name": "sendgrid_send_remittance",
        "description": "Email remittance advice to the vendor's accounts-payable contact after payment is sent.",
        "input_schema": {"type": "object", "properties": {
            "to_email": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}},
            "required": ["to_email", "subject", "body"]},
    },
]

DISPATCH = {
    "netsuite_get_bill": netsuite_get_bill,
    "netsuite_match_po": netsuite_match_po,
    "netsuite_approve_bill": netsuite_approve_bill,
    "stripe_create_payout": stripe_create_payout,
    "bank_initiate_wire": bank_initiate_wire,
    "sendgrid_send_remittance": sendgrid_send_remittance,
}


def run(user_message: str) -> dict:
    return run_agent(model=MODEL, system=SYSTEM_PROMPT, tools=TOOLS, dispatch=DISPATCH, user_message=user_message)


if __name__ == "__main__":
    import json

    print(json.dumps(run(
        "Vendor bill BILL-7781 from Acme Cloud for $18,400 references PO-5567. "
        "Match it, approve, and schedule the payout, then email remittance to ap@acmecloud.com."
    ), indent=2, default=str))
