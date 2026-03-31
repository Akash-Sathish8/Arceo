"""MCP Server: Enterprise Billing Agent

Simulates the tool surface of a billing agent at a large SaaS company.
This agent handles the full billing lifecycle:
  - Usage metering and aggregation
  - Invoice generation and delivery
  - Payment processing and collection
  - Dunning (failed payment retries)
  - Revenue recognition and reporting
  - Customer account management
  - Finance team notifications

Connected systems: Stripe, NetSuite, Salesforce, Snowflake, Slack, SendGrid

Run: python mcp-servers/billing_agent.py
Then connect via Arceo: POST /api/authority/agents/connect/mcp
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json

TOOLS = [
    # ── Stripe (Payment Processing) ──────────────────────────────
    {
        "name": "stripe_get_customer",
        "description": "Retrieve customer record from Stripe including payment methods, default source, and metadata. Used before any billing action to verify account state.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string", "description": "Stripe customer ID (cus_xxx)"},
            },
            "required": ["customer_id"],
        },
    },
    {
        "name": "stripe_create_invoice",
        "description": "Generate a new invoice for a customer. Pulls line items from usage records. Can apply coupons, tax rates, and custom line items.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string"},
                "line_items": {"type": "array", "items": {"type": "object"}},
                "auto_advance": {"type": "boolean", "description": "If true, auto-finalize and send"},
                "due_date": {"type": "string", "description": "ISO date for payment due"},
                "tax_rate_id": {"type": "string"},
                "coupon_id": {"type": "string"},
            },
            "required": ["customer_id"],
        },
    },
    {
        "name": "stripe_finalize_invoice",
        "description": "Finalize a draft invoice, making it immutable. Triggers email to customer. Cannot be undone.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "invoice_id": {"type": "string", "description": "Stripe invoice ID (in_xxx)"},
            },
            "required": ["invoice_id"],
        },
    },
    {
        "name": "stripe_void_invoice",
        "description": "Void a finalized invoice. Used when billing error detected. Customer is not charged. Creates a credit note automatically.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "invoice_id": {"type": "string"},
                "reason": {"type": "string", "description": "Why the invoice is being voided"},
            },
            "required": ["invoice_id"],
        },
    },
    {
        "name": "stripe_create_refund",
        "description": "Issue a refund for a paid invoice or charge. Refund can be partial or full. Triggers accounting adjustment.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "payment_intent_id": {"type": "string"},
                "amount": {"type": "integer", "description": "Amount in cents. Omit for full refund."},
                "reason": {"type": "string", "enum": ["duplicate", "fraudulent", "requested_by_customer"]},
            },
            "required": ["payment_intent_id"],
        },
    },
    {
        "name": "stripe_retry_payment",
        "description": "Retry a failed payment on an open invoice. Used in dunning workflow. Updates payment method if new one provided.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "invoice_id": {"type": "string"},
                "payment_method_id": {"type": "string", "description": "Optional: use a different payment method"},
            },
            "required": ["invoice_id"],
        },
    },
    {
        "name": "stripe_update_subscription",
        "description": "Change a customer's subscription plan, quantity, or billing cycle. Prorates automatically.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "subscription_id": {"type": "string"},
                "plan_id": {"type": "string"},
                "quantity": {"type": "integer"},
                "proration_behavior": {"type": "string", "enum": ["create_prorations", "none", "always_invoice"]},
            },
            "required": ["subscription_id"],
        },
    },
    {
        "name": "stripe_cancel_subscription",
        "description": "Cancel a customer's subscription. Can be immediate or at period end. Triggers dunning exit and churn tracking.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "subscription_id": {"type": "string"},
                "cancel_at_period_end": {"type": "boolean"},
                "cancellation_reason": {"type": "string"},
            },
            "required": ["subscription_id"],
        },
    },
    {
        "name": "stripe_list_payment_intents",
        "description": "List recent payment intents for a customer. Shows successful, failed, and pending payments.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string"},
                "status": {"type": "string", "enum": ["succeeded", "requires_payment_method", "requires_action", "processing"]},
                "limit": {"type": "integer"},
            },
            "required": ["customer_id"],
        },
    },

    # ── NetSuite (ERP / Accounting) ──────────────────────────────
    {
        "name": "netsuite_create_journal_entry",
        "description": "Create a journal entry in NetSuite for revenue recognition, adjustments, or accruals. Debits and credits must balance.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "memo": {"type": "string"},
                "lines": {"type": "array", "items": {"type": "object", "properties": {
                    "account_id": {"type": "string"},
                    "debit": {"type": "number"},
                    "credit": {"type": "number"},
                    "department": {"type": "string"},
                }}},
                "posting_date": {"type": "string"},
            },
            "required": ["lines"],
        },
    },
    {
        "name": "netsuite_get_customer_balance",
        "description": "Get outstanding balance, credit limit, and aging report for a customer in NetSuite.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string"},
                "include_aging": {"type": "boolean"},
            },
            "required": ["customer_id"],
        },
    },
    {
        "name": "netsuite_create_credit_memo",
        "description": "Issue a credit memo against a customer's account. Used for billing errors, goodwill credits, or contract adjustments.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string"},
                "amount": {"type": "number"},
                "reason": {"type": "string"},
                "apply_to_invoice": {"type": "string", "description": "Optional invoice ID to apply credit against"},
            },
            "required": ["customer_id", "amount"],
        },
    },
    {
        "name": "netsuite_close_period",
        "description": "Close an accounting period. Prevents further journal entries. Irreversible without controller approval.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "period": {"type": "string", "description": "e.g. 2026-03"},
            },
            "required": ["period"],
        },
    },

    # ── Salesforce (CRM / Contracts) ─────────────────────────────
    {
        "name": "salesforce_get_account",
        "description": "Retrieve full account record including contract details, subscription tier, and billing contact.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "account_id": {"type": "string"},
            },
            "required": ["account_id"],
        },
    },
    {
        "name": "salesforce_get_contract",
        "description": "Get contract terms: start date, end date, ACV, payment terms, auto-renewal clause.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "contract_id": {"type": "string"},
            },
            "required": ["contract_id"],
        },
    },
    {
        "name": "salesforce_update_opportunity",
        "description": "Update opportunity stage, close date, or amount. Used when billing changes affect pipeline.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "opportunity_id": {"type": "string"},
                "stage": {"type": "string"},
                "amount": {"type": "number"},
                "close_date": {"type": "string"},
            },
            "required": ["opportunity_id"],
        },
    },

    # ── Snowflake (Usage Metering) ───────────────────────────────
    {
        "name": "snowflake_query_usage",
        "description": "Query aggregated usage data for a customer from the billing data warehouse. Returns compute hours, API calls, storage GB, etc.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string"},
                "metric": {"type": "string", "enum": ["compute_hours", "api_calls", "storage_gb", "bandwidth_gb", "seats"]},
                "period_start": {"type": "string"},
                "period_end": {"type": "string"},
            },
            "required": ["customer_id", "metric"],
        },
    },
    {
        "name": "snowflake_get_billing_summary",
        "description": "Get pre-calculated billing summary for a customer: total usage, overage, committed spend, remaining credits.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string"},
                "period": {"type": "string", "description": "e.g. 2026-03"},
            },
            "required": ["customer_id"],
        },
    },

    # ── Slack (Finance Team Notifications) ────────────────────────
    {
        "name": "slack_send_finance_alert",
        "description": "Post a message to the #finance-alerts Slack channel. Used for payment failures, large refunds, and anomalies.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "channel": {"type": "string", "description": "Slack channel name"},
                "message": {"type": "string"},
                "severity": {"type": "string", "enum": ["info", "warning", "critical"]},
                "customer_id": {"type": "string"},
            },
            "required": ["message"],
        },
    },
    {
        "name": "slack_send_dm",
        "description": "Send a direct message to a specific person (e.g., account executive or finance controller).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "user_email": {"type": "string"},
                "message": {"type": "string"},
            },
            "required": ["user_email", "message"],
        },
    },

    # ── SendGrid (Customer Billing Emails) ────────────────────────
    {
        "name": "sendgrid_send_invoice_email",
        "description": "Send invoice PDF to customer's billing contact. Uses branded template with payment link.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "to_email": {"type": "string"},
                "customer_name": {"type": "string"},
                "invoice_id": {"type": "string"},
                "amount_due": {"type": "number"},
                "due_date": {"type": "string"},
                "payment_link": {"type": "string"},
            },
            "required": ["to_email", "invoice_id", "amount_due"],
        },
    },
    {
        "name": "sendgrid_send_dunning_email",
        "description": "Send payment failure notification to customer. Part of the automated dunning sequence (attempt 1, 2, 3, final).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "to_email": {"type": "string"},
                "customer_name": {"type": "string"},
                "attempt_number": {"type": "integer", "description": "1-4, determines email tone"},
                "amount_due": {"type": "number"},
                "update_payment_link": {"type": "string"},
            },
            "required": ["to_email", "attempt_number", "amount_due"],
        },
    },
    {
        "name": "sendgrid_send_refund_confirmation",
        "description": "Send refund confirmation email to customer with refund amount and expected timeline.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "to_email": {"type": "string"},
                "customer_name": {"type": "string"},
                "refund_amount": {"type": "number"},
                "original_invoice_id": {"type": "string"},
            },
            "required": ["to_email", "refund_amount"],
        },
    },
]


class MCPHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        # JSON-RPC: tools/list
        if body.get("method") == "tools/list":
            response = {
                "jsonrpc": "2.0",
                "id": body.get("id", 1),
                "result": {"tools": TOOLS},
            }
            self._respond(200, response)
            return

        self._respond(404, {"error": "unknown method"})

    def do_GET(self):
        if self.path == "/tools/list":
            self._respond(200, {"tools": TOOLS})
            return
        if self.path == "/health":
            self._respond(200, {"status": "ok", "agent": "billing-agent", "tools": len(TOOLS)})
            return
        self._respond(404, {"error": "not found"})

    def _respond(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        print(f"  MCP: {args[0]}")


if __name__ == "__main__":
    port = 3100
    print(f"Billing Agent MCP Server")
    print(f"  {len(TOOLS)} tools across 6 services")
    print(f"  Stripe (9), NetSuite (4), Salesforce (3), Snowflake (2), Slack (2), SendGrid (3)")
    print(f"  Listening on http://localhost:{port}")
    print(f"  Connect via Arceo: POST /api/authority/agents/connect/mcp")
    print(f'    {{"url": "http://localhost:{port}", "agent_name": "Billing Agent"}}')
    print()
    HTTPServer(("localhost", port), MCPHandler).serve_forever()
