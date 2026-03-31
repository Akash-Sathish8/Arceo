"""Test local risk inference and chain detection."""

from arceo.analysis.risk import infer_risk, infer_verb, detect_chains_local
from arceo.models import ArceoToolCall


def test_read_only():
    hints, ro = infer_risk("stripe", "get_customer")
    assert ro is True

def test_refund_moves_money():
    hints, ro = infer_risk("stripe", "create_refund")
    assert "moves_money" in hints
    assert ro is False

def test_delete_data():
    hints, ro = infer_risk("aws", "delete_snapshot")
    assert "deletes_data" in hints

def test_send_external():
    hints, ro = infer_risk("gmail", "send_email")
    assert "sends_external" in hints

def test_deploy_changes_prod():
    hints, ro = infer_risk("github", "trigger_workflow")
    assert "changes_production" in hints

def test_service_risk_stripe():
    hints, _ = infer_risk("stripe", "some_action")
    assert "moves_money" in hints

def test_arg_keys_pii():
    hints, _ = infer_risk("custom", "do_thing", ["email", "phone"])
    assert "touches_pii" in hints

def test_arg_keys_money():
    hints, _ = infer_risk("custom", "process", ["amount", "currency"])
    assert "moves_money" in hints

def test_verb_read():
    assert infer_verb("get_customer") == "read"
    assert infer_verb("list_users") == "read"

def test_verb_delete():
    assert infer_verb("delete_account") == "delete"

def test_verb_send():
    assert infer_verb("send_email") == "send"

def test_verb_transact():
    assert infer_verb("refund_payment") == "transact"

def test_chain_exfiltration():
    calls = [
        ArceoToolCall(tool_name="stripe", action_name="get_customer", inferred_risk_hints=["touches_pii"]),
        ArceoToolCall(tool_name="gmail", action_name="send_email", inferred_risk_hints=["sends_external"]),
    ]
    chains = detect_chains_local(calls)
    assert len(chains) > 0
    assert chains[0]["chain_name"] == "potential_exfiltration"

def test_chain_fraud():
    calls = [
        ArceoToolCall(tool_name="stripe", action_name="get_customer", inferred_risk_hints=["touches_pii"]),
        ArceoToolCall(tool_name="stripe", action_name="create_refund", inferred_risk_hints=["moves_money"]),
    ]
    chains = detect_chains_local(calls)
    names = [c["chain_name"] for c in chains]
    assert "pii_to_financial" in names

def test_no_chain_for_reads():
    calls = [
        ArceoToolCall(tool_name="stripe", action_name="get_customer", inferred_risk_hints=["touches_pii"], is_read_only=True),
        ArceoToolCall(tool_name="stripe", action_name="list_payments", inferred_risk_hints=["touches_pii"], is_read_only=True),
    ]
    # Both are read-only PII — no cross-label chain
    chains = detect_chains_local(calls)
    cross = [c for c in chains if c["chain_name"] != ""]
    # No dangerous chains between two read-only PII actions
    assert not any(c["severity"] == "critical" for c in chains if "exfiltration" in c["chain_name"])
