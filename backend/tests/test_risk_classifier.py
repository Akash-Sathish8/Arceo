"""Tests for the risk classifier — keyword heuristics and fallback logic."""

import pytest
from authority.risk_classifier import classify_action, classify_with_fallback, schema_hints


class TestClassifyAction:
    def test_delete_action(self):
        labels, reversible = classify_action("delete_user", "")
        assert "deletes_data" in labels
        assert "touches_pii" in labels
        assert reversible is False

    def test_send_email(self):
        labels, reversible = classify_action("send_email", "")
        assert "sends_external" in labels
        assert reversible is False

    def test_create_refund(self):
        labels, reversible = classify_action("create_refund", "")
        assert "moves_money" in labels

    def test_get_customer(self):
        labels, reversible = classify_action("get_customer", "")
        assert "touches_pii" in labels
        assert reversible is True

    def test_deploy_service(self):
        labels, reversible = classify_action("deploy_service", "Deploy to production")
        assert "changes_production" in labels

    def test_safe_action(self):
        labels, reversible = classify_action("list_templates", "")
        assert labels == []
        assert reversible is True

    def test_description_adds_labels(self):
        labels, _ = classify_action("do_thing", "Send notification to customer email")
        assert "sends_external" in labels
        assert "touches_pii" in labels

    def test_terminate_is_irreversible(self):
        _, reversible = classify_action("terminate_instance", "")
        assert reversible is False

    def test_cancel_is_irreversible(self):
        _, reversible = classify_action("cancel_subscription", "")
        assert reversible is False


class TestSchemaHints:
    def test_email_property(self):
        extra = schema_hints({"email": {"type": "string"}, "body": {"type": "string"}})
        assert "touches_pii" in extra

    def test_phone_property(self):
        extra = schema_hints({"phone": {"type": "string"}})
        assert "touches_pii" in extra

    def test_no_pii_properties(self):
        extra = schema_hints({"amount": {"type": "integer"}, "currency": {"type": "string"}})
        assert extra == []

    def test_empty_properties(self):
        assert schema_hints({}) == []
        assert schema_hints(None) == []


class TestClassifyWithFallback:
    def test_hardcoded_catalog_takes_precedence(self):
        result = classify_with_fallback("stripe", "create_refund", "")
        assert result.tool == "stripe"
        assert result.action == "create_refund"
        assert "moves_money" in result.risk_labels
        assert result.reversible is False

    def test_unknown_tool_uses_heuristic(self):
        result = classify_with_fallback("my_custom_tool", "delete_record", "Remove a database record")
        assert "deletes_data" in result.risk_labels
        assert result.reversible is False

    def test_schema_augments_heuristic(self):
        result = classify_with_fallback(
            "my_tool", "process_data", "",
            input_schema={"properties": {"email": {"type": "string"}}},
        )
        assert "touches_pii" in result.risk_labels
