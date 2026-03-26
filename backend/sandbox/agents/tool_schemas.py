"""Rich parameter schemas for each tool action — so the LLM knows what to pass."""

TOOL_SCHEMAS: dict[str, dict] = {
    # ── Stripe ──────────────────────────────────────────────────────────────
    "stripe__get_customer": {
        "properties": {"customer_id": {"type": "string", "description": "Customer ID (e.g. cust_1042)"}},
        "required": ["customer_id"],
    },
    "stripe__list_payments": {
        "properties": {"customer_id": {"type": "string", "description": "Filter by customer ID (optional)"}},
    },
    "stripe__get_invoice": {
        "properties": {"invoice_id": {"type": "string", "description": "Invoice ID"}},
    },
    "stripe__create_refund": {
        "properties": {
            "payment_id": {"type": "string", "description": "Payment ID to refund (e.g. pay_001)"},
            "amount": {"type": "integer", "description": "Refund amount in cents (e.g. 4900 = $49)"},
            "reason": {"type": "string", "description": "Reason for refund"},
        },
        "required": ["payment_id"],
    },
    "stripe__create_charge": {
        "properties": {
            "customer_id": {"type": "string", "description": "Customer to charge"},
            "amount": {"type": "integer", "description": "Amount in cents"},
            "description": {"type": "string", "description": "Charge description"},
        },
        "required": ["customer_id", "amount"],
    },
    "stripe__update_subscription": {
        "properties": {
            "subscription_id": {"type": "string", "description": "Subscription ID"},
            "plan": {"type": "string", "description": "New plan name"},
        },
    },
    "stripe__cancel_subscription": {
        "properties": {"subscription_id": {"type": "string", "description": "Subscription ID to cancel"}},
    },
    "stripe__delete_customer": {
        "properties": {"customer_id": {"type": "string", "description": "Customer ID to permanently delete"}},
        "required": ["customer_id"],
    },

    # ── Zendesk ─────────────────────────────────────────────────────────────
    "zendesk__get_ticket": {
        "properties": {"ticket_id": {"type": "string", "description": "Ticket ID (e.g. 4821)"}},
        "required": ["ticket_id"],
    },
    "zendesk__update_ticket": {
        "properties": {
            "ticket_id": {"type": "string", "description": "Ticket ID"},
            "status": {"type": "string", "description": "New status (open/pending/solved)"},
            "priority": {"type": "string", "description": "Priority (low/normal/high/urgent)"},
        },
        "required": ["ticket_id"],
    },
    "zendesk__close_ticket": {
        "properties": {"ticket_id": {"type": "string", "description": "Ticket ID to close"}},
        "required": ["ticket_id"],
    },
    "zendesk__create_ticket": {
        "properties": {
            "subject": {"type": "string", "description": "Ticket subject"},
            "requester": {"type": "string", "description": "Requester email"},
            "priority": {"type": "string", "description": "Priority level"},
        },
        "required": ["subject"],
    },
    "zendesk__add_comment": {
        "properties": {
            "ticket_id": {"type": "string", "description": "Ticket ID"},
            "body": {"type": "string", "description": "Comment text"},
            "public": {"type": "boolean", "description": "Visible to customer? (default true)"},
        },
        "required": ["ticket_id", "body"],
    },
    "zendesk__assign_ticket": {
        "properties": {
            "ticket_id": {"type": "string", "description": "Ticket ID"},
            "assignee": {"type": "string", "description": "Assignee email"},
        },
        "required": ["ticket_id", "assignee"],
    },
    "zendesk__list_tickets": {
        "properties": {"status": {"type": "string", "description": "Filter by status (optional)"}},
    },
    "zendesk__delete_ticket": {
        "properties": {"ticket_id": {"type": "string", "description": "Ticket ID to delete"}},
        "required": ["ticket_id"],
    },

    # ── Salesforce ──────────────────────────────────────────────────────────
    "salesforce__query_contacts": {
        "properties": {"query": {"type": "string", "description": "Search query (name or email)"}},
    },
    "salesforce__get_account": {
        "properties": {"account_id": {"type": "string", "description": "Account/contact ID (e.g. 003_jane)"}},
        "required": ["account_id"],
    },
    "salesforce__update_record": {
        "properties": {
            "record_id": {"type": "string", "description": "Record ID"},
            "fields": {"type": "object", "description": "Fields to update"},
        },
        "required": ["record_id", "fields"],
    },
    "salesforce__create_record": {
        "properties": {
            "name": {"type": "string", "description": "Contact name"},
            "email": {"type": "string", "description": "Email address"},
            "phone": {"type": "string", "description": "Phone number"},
            "account": {"type": "string", "description": "Account name"},
        },
        "required": ["name", "email"],
    },
    "salesforce__delete_record": {
        "properties": {"record_id": {"type": "string", "description": "Record ID to delete"}},
        "required": ["record_id"],
    },
    "salesforce__query_opportunities": {
        "properties": {"stage": {"type": "string", "description": "Filter by stage (optional)"}},
    },
    "salesforce__add_note": {
        "properties": {
            "record_id": {"type": "string", "description": "Record to attach note to"},
            "body": {"type": "string", "description": "Note content"},
        },
        "required": ["record_id", "body"],
    },
    "salesforce__get_contact_history": {
        "properties": {"contact_id": {"type": "string", "description": "Contact ID"}},
        "required": ["contact_id"],
    },

    # ── Email (SendGrid) ───────────────────────────────────────────────────
    "email__send_email": {
        "properties": {
            "to": {"type": "string", "description": "Recipient email address"},
            "subject": {"type": "string", "description": "Email subject line"},
            "body": {"type": "string", "description": "Email body text"},
        },
        "required": ["to", "subject", "body"],
    },
    "email__send_template_email": {
        "properties": {
            "to": {"type": "string", "description": "Recipient email"},
            "template_id": {"type": "string", "description": "Template ID (e.g. tmpl_refund)"},
            "variables": {"type": "object", "description": "Template variables"},
        },
        "required": ["to", "template_id"],
    },
    "email__list_templates": {"properties": {}},
    "email__get_email_status": {
        "properties": {"message_id": {"type": "string", "description": "Message ID to check"}},
    },

    # ── GitHub ──────────────────────────────────────────────────────────────
    "github__list_repos": {"properties": {}},
    "github__get_pull_request": {
        "properties": {"pr_number": {"type": "integer", "description": "PR number (e.g. 287)"}},
        "required": ["pr_number"],
    },
    "github__merge_pull_request": {
        "properties": {"pr_number": {"type": "integer", "description": "PR number to merge"}},
        "required": ["pr_number"],
    },
    "github__create_branch": {
        "properties": {
            "branch_name": {"type": "string", "description": "New branch name"},
            "base": {"type": "string", "description": "Base branch (default: main)"},
        },
        "required": ["branch_name"],
    },
    "github__delete_branch": {
        "properties": {"branch_name": {"type": "string", "description": "Branch to delete"}},
        "required": ["branch_name"],
    },
    "github__trigger_workflow": {
        "properties": {"workflow": {"type": "string", "description": "Workflow file (e.g. deploy.yml)"}},
    },
    "github__get_workflow_status": {
        "properties": {"run_id": {"type": "string", "description": "Workflow run ID"}},
    },
    "github__create_release": {
        "properties": {
            "tag": {"type": "string", "description": "Release tag (e.g. v1.2.3)"},
            "name": {"type": "string", "description": "Release name"},
        },
        "required": ["tag"],
    },
    "github__rollback_release": {
        "properties": {
            "current_tag": {"type": "string", "description": "Current release tag"},
            "target_tag": {"type": "string", "description": "Tag to roll back to"},
        },
        "required": ["target_tag"],
    },

    # ── AWS ─────────────────────────────────────────────────────────────────
    "aws__list_instances": {"properties": {}},
    "aws__start_instance": {
        "properties": {"instance_id": {"type": "string", "description": "EC2 instance ID (e.g. i-staging)"}},
        "required": ["instance_id"],
    },
    "aws__stop_instance": {
        "properties": {"instance_id": {"type": "string", "description": "EC2 instance ID"}},
        "required": ["instance_id"],
    },
    "aws__terminate_instance": {
        "properties": {"instance_id": {"type": "string", "description": "EC2 instance ID to terminate"}},
        "required": ["instance_id"],
    },
    "aws__scale_service": {
        "properties": {
            "service": {"type": "string", "description": "ECS service name"},
            "count": {"type": "integer", "description": "Desired task count"},
        },
        "required": ["service", "count"],
    },
    "aws__get_logs": {
        "properties": {"log_group": {"type": "string", "description": "CloudWatch log group path"}},
    },
    "aws__update_security_group": {
        "properties": {
            "security_group_id": {"type": "string", "description": "Security group ID"},
            "protocol": {"type": "string", "description": "Protocol (tcp/udp)"},
            "port": {"type": "integer", "description": "Port number"},
            "source": {"type": "string", "description": "Source CIDR (e.g. 0.0.0.0/0)"},
        },
        "required": ["security_group_id", "port"],
    },
    "aws__create_snapshot": {
        "properties": {"volume_id": {"type": "string", "description": "EBS volume ID"}},
    },
    "aws__delete_snapshot": {
        "properties": {"snapshot_id": {"type": "string", "description": "Snapshot ID to delete"}},
        "required": ["snapshot_id"],
    },
    "aws__update_env_vars": {
        "properties": {
            "service": {"type": "string", "description": "Service name"},
            "vars": {"type": "object", "description": "Environment variables to set"},
        },
        "required": ["service", "vars"],
    },

    # ── Slack ───────────────────────────────────────────────────────────────
    "slack__send_message": {
        "properties": {
            "user": {"type": "string", "description": "User ID or name to DM"},
            "text": {"type": "string", "description": "Message text"},
        },
        "required": ["user", "text"],
    },
    "slack__send_channel_message": {
        "properties": {
            "channel": {"type": "string", "description": "Channel name (e.g. #releases)"},
            "text": {"type": "string", "description": "Message text"},
        },
        "required": ["channel", "text"],
    },
    "slack__create_channel": {
        "properties": {"name": {"type": "string", "description": "Channel name"}},
        "required": ["name"],
    },
    "slack__list_channels": {"properties": {}},
    "slack__upload_file": {
        "properties": {
            "filename": {"type": "string", "description": "File name"},
            "channel": {"type": "string", "description": "Channel to upload to"},
        },
        "required": ["filename", "channel"],
    },

    # ── PagerDuty ───────────────────────────────────────────────────────────
    "pagerduty__create_incident": {
        "properties": {
            "title": {"type": "string", "description": "Incident title"},
            "severity": {"type": "string", "description": "Severity (critical/high/medium/low)"},
            "service": {"type": "string", "description": "Service name"},
        },
        "required": ["title"],
    },
    "pagerduty__acknowledge_incident": {
        "properties": {"incident_id": {"type": "string", "description": "Incident ID (e.g. INC-101)"}},
        "required": ["incident_id"],
    },
    "pagerduty__resolve_incident": {
        "properties": {"incident_id": {"type": "string", "description": "Incident ID"}},
        "required": ["incident_id"],
    },
    "pagerduty__get_oncall": {"properties": {}},
    "pagerduty__escalate_incident": {
        "properties": {"incident_id": {"type": "string", "description": "Incident ID to escalate"}},
        "required": ["incident_id"],
    },
    "pagerduty__list_incidents": {"properties": {}},

    # ── HubSpot ─────────────────────────────────────────────────────────────
    "hubspot__get_contact": {
        "properties": {"contact_id": {"type": "string", "description": "Contact ID (e.g. hs_001)"}},
        "required": ["contact_id"],
    },
    "hubspot__create_contact": {
        "properties": {
            "name": {"type": "string", "description": "Contact name"},
            "email": {"type": "string", "description": "Email address"},
            "phone": {"type": "string", "description": "Phone number"},
            "company": {"type": "string", "description": "Company name"},
        },
        "required": ["name", "email"],
    },
    "hubspot__update_contact": {
        "properties": {
            "contact_id": {"type": "string", "description": "Contact ID"},
            "name": {"type": "string", "description": "Updated name"},
            "email": {"type": "string", "description": "Updated email"},
        },
        "required": ["contact_id"],
    },
    "hubspot__delete_contact": {
        "properties": {"contact_id": {"type": "string", "description": "Contact ID to delete"}},
        "required": ["contact_id"],
    },
    "hubspot__list_deals": {"properties": {}},
    "hubspot__update_deal": {
        "properties": {
            "deal_id": {"type": "string", "description": "Deal ID"},
            "stage": {"type": "string", "description": "New stage"},
            "amount": {"type": "integer", "description": "Deal value"},
        },
        "required": ["deal_id"],
    },
    "hubspot__create_deal": {
        "properties": {
            "name": {"type": "string", "description": "Deal name"},
            "amount": {"type": "integer", "description": "Deal value"},
            "contact_id": {"type": "string", "description": "Associated contact"},
        },
        "required": ["name"],
    },
    "hubspot__get_company": {
        "properties": {"company_id": {"type": "string", "description": "Company ID"}},
    },
    "hubspot__query_contacts": {
        "properties": {"query": {"type": "string", "description": "Search query (name or company)"}},
    },
    "hubspot__add_note": {
        "properties": {
            "contact_id": {"type": "string", "description": "Contact ID"},
            "body": {"type": "string", "description": "Note text"},
        },
        "required": ["contact_id", "body"],
    },
    "hubspot__get_contact_activity": {
        "properties": {"contact_id": {"type": "string", "description": "Contact ID"}},
        "required": ["contact_id"],
    },

    # ── Gmail ───────────────────────────────────────────────────────────────
    "gmail__send_email": {
        "properties": {
            "to": {"type": "string", "description": "Recipient email"},
            "subject": {"type": "string", "description": "Subject line"},
            "body": {"type": "string", "description": "Email body"},
        },
        "required": ["to", "subject", "body"],
    },
    "gmail__read_inbox": {"properties": {}},
    "gmail__search_emails": {
        "properties": {"query": {"type": "string", "description": "Search query"}},
        "required": ["query"],
    },
    "gmail__create_draft": {
        "properties": {
            "to": {"type": "string", "description": "Recipient"},
            "subject": {"type": "string", "description": "Subject"},
            "body": {"type": "string", "description": "Body"},
        },
    },
    "gmail__send_draft": {
        "properties": {"draft_id": {"type": "string", "description": "Draft ID to send"}},
        "required": ["draft_id"],
    },
    "gmail__list_threads": {"properties": {}},
    "gmail__get_thread": {
        "properties": {"thread_id": {"type": "string", "description": "Thread ID"}},
        "required": ["thread_id"],
    },

    # ── Calendly ────────────────────────────────────────────────────────────
    "calendly__list_events": {"properties": {}},
    "calendly__create_invite_link": {
        "properties": {"event_type": {"type": "string", "description": "Event type (e.g. 30-min-demo)"}},
    },
    "calendly__cancel_event": {
        "properties": {"event_id": {"type": "string", "description": "Event ID to cancel"}},
        "required": ["event_id"],
    },
    "calendly__get_availability": {"properties": {}},
    "calendly__list_event_types": {"properties": {}},
}
