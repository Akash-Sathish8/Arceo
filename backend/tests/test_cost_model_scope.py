"""Cost-model scope/labeling fixes (2026-07-06 MVP accuracy pass).

A CFO catches an indefensible number in the room, so:
- a single-record PII read must not be priced at the HIPAA per-violation max,
- a money-moving action must not be priced as a production outage,
- a genuine bulk export must carry the full regulatory exposure.
"""

from __future__ import annotations

from analysis.cost_model import generate_cost_report


def _report(action, labels, reversible=True, tool="t"):
    agent = {"id": "a", "name": "A", "tools": [
        {"name": tool, "actions": [
            {"action": action, "description": "", "risk_labels": labels, "reversible": reversible},
        ]},
    ]}
    return generate_cost_report(agent)


def _max_for(report, capability):
    items = [i for i in report.items if i.capability == capability]
    return max((i.per_incident_max_usd for i in items), default=0.0)


def test_single_pii_read_not_priced_at_violation_max():
    r = _report("get_customer", ["touches_pii"])
    # Per-record min (~$500), not the $50k HIPAA per-violation ceiling.
    assert _max_for(r, "touches_pii") <= 1000, r.items[0].per_incident_max_usd


def test_money_action_not_priced_as_production_outage():
    r = _report("create_refund", ["moves_money", "changes_production"], reversible=False)
    # The changes_production ($50k operational) line must be suppressed.
    assert _max_for(r, "changes_production") == 0
    assert _max_for(r, "moves_money") > 0


def test_bulk_export_keeps_full_regulatory_exposure():
    r = _report("bulk_export_contacts", ["bulk_export", "touches_pii"])
    # A bulk exposure is the real per-violation risk — full max, no reversibility
    # discount (can't un-leak).
    assert _max_for(r, "bulk_export") >= 25000
    assert _max_for(r, "touches_pii") >= 25000


def test_exposure_labels_skip_reversibility_discount():
    # sends_external at full cost even though the action is reversible.
    r = _report("send_email", ["sends_external"], reversible=True)
    full = _report("send_email", ["sends_external"], reversible=False)
    assert _max_for(r, "sends_external") == _max_for(full, "sends_external")
