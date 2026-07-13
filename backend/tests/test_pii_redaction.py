"""Phase-5 PR-2: obvious PII is masked before it's stored.

An ingested trace carrying an email, card number, SSN, and phone gets those
values redacted in the stored trace_json — while the structure (tool, action,
field names) is preserved.
"""

from __future__ import annotations

import json
import uuid

import pytest

import redaction
from db import get_db


# ── unit: the redactor itself ─────────────────────────────────────────────────

def test_redact_text_masks_common_pii(monkeypatch):
    monkeypatch.setenv("ARCEO_PII_REDACTION", "true")
    out = redaction.redact_text("email jane@acme.com card 4111 1111 1111 1111 ssn 123-45-6789 ph 555-123-4567")
    assert "jane@acme.com" not in out and "[REDACTED_EMAIL]" in out
    assert "4111 1111 1111 1111" not in out and "[REDACTED_CARD]" in out
    assert "123-45-6789" not in out and "[REDACTED_SSN]" in out
    assert "[REDACTED_PHONE]" in out


def test_non_card_digit_run_left_alone(monkeypatch):
    monkeypatch.setenv("ARCEO_PII_REDACTION", "true")
    # An order id that's card-shaped but fails Luhn stays put (no over-masking).
    assert redaction.redact_text("order 1234567890123456") == "order 1234567890123456"


def test_disabled_is_noop(monkeypatch):
    monkeypatch.setenv("ARCEO_PII_REDACTION", "false")
    assert redaction.redact_text("jane@acme.com") == "jane@acme.com"


def test_redact_value_recurses(monkeypatch):
    monkeypatch.setenv("ARCEO_PII_REDACTION", "true")
    out = redaction.redact_value({"to": "jane@acme.com", "items": ["ok", "bob@x.io"]})
    assert out["to"] == "[REDACTED_EMAIL]"
    assert out["items"][1] == "[REDACTED_EMAIL]" and out["items"][0] == "ok"


# ── end-to-end: ingestion masks before store ──────────────────────────────────

def test_ingested_trace_is_redacted_at_rest(client, two_orgs, monkeypatch):
    monkeypatch.setenv("ARCEO_PII_REDACTION", "true")
    a = two_orgs["org_a"]
    r = client.post("/api/ingest/generic", headers=a["headers"], json={
        "agent_name": "pii-agent-" + uuid.uuid4().hex[:6],
        "actions": [{
            "tool": "sendgrid", "action": "send_email",
            "params": {"to": "customer@example.com", "note": "call 555-123-4567"},
            "result": {"status": "sent", "ssn": "123-45-6789"},
        }],
    })
    assert r.status_code == 200, r.text
    sim_id = r.json()["simulation_id"]

    with get_db() as conn:
        raw = conn.execute("SELECT trace_json FROM simulations WHERE id = %s", (sim_id,)).fetchone()["trace_json"]

    # Values masked, structure kept.
    assert "customer@example.com" not in raw
    assert "123-45-6789" not in raw
    assert "555-123-4567" not in raw
    assert "[REDACTED_EMAIL]" in raw and "[REDACTED_SSN]" in raw
    trace = json.loads(raw)
    step = trace["steps"][0]
    assert step["tool"] == "sendgrid" and step["action"] == "send_email"
    assert "to" in step["params"] and "note" in step["params"]  # field names intact
