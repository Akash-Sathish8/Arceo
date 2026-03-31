"""Test the smart tool name parser."""

from arceo.parser import parse_tool_name


def test_double_underscore():
    assert parse_tool_name("stripe__create_refund") == ("stripe", "create_refund")

def test_dot_separator():
    assert parse_tool_name("Stripe.CreateRefund") == ("stripe", "create_refund")

def test_bare_action():
    assert parse_tool_name("create_refund") == ("unknown", "create_refund")

def test_colon_separator():
    assert parse_tool_name("stripe:refund:create") == ("stripe", "refund_create")

def test_camel_case_with_tool_suffix():
    t, a = parse_tool_name("StripeCreateRefundTool")
    assert t == "stripe"
    assert "create" in a and "refund" in a

def test_gmail():
    assert parse_tool_name("gmail_send_message") == ("gmail", "send_message")

def test_compound_service():
    assert parse_tool_name("aws_ec2_terminate_instances") == ("aws_ec2", "terminate_instances")

def test_hyphen():
    t, a = parse_tool_name("terminate-instances")
    assert a == "terminate_instances"

def test_search_api():
    t, a = parse_tool_name("SearchAPI")
    assert a == "search"

def test_empty():
    assert parse_tool_name("") == ("unknown", "unknown")

def test_known_service_single():
    assert parse_tool_name("slack_send_message") == ("slack", "send_message")

def test_salesforce():
    assert parse_tool_name("salesforce_get_contact") == ("salesforce", "get_contact")
