"""Invoice reconciliation (Tier 2 flagship, 2026-07-12): "Arceo tracked $X,
your invoice says $Y."

Pins: flexible CSV parsing (provider exports differ and change), org-wide
captured-spend aggregation by provider, verdict bands + honest gap causes,
and the API round-trip including org isolation on the new table.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

import pytest

from analysis.invoice_reconciliation import (
    aggregate_captured_spend,
    normalize_provider,
    parse_invoice_csv,
    reconcile,
    window_bounds,
)


# ── CSV parsing ───────────────────────────────────────────────────────────────

def test_parses_anthropic_style_export():
    csv_text = (
        "usage_date,model_version,cost_usd\n"
        "2026-06-01,claude-sonnet-4-6,1.25\n"
        "2026-06-01,claude-haiku-4-5,0.10\n"
        "2026-06-02,claude-sonnet-4-6,2.00\n"
    )
    p = parse_invoice_csv(csv_text)
    assert p["total_usd"] == 3.35
    assert (p["period_start"], p["period_end"]) == ("2026-06-01", "2026-06-02")
    assert p["columns"] == {"cost": "cost_usd", "date": "usage_date", "model": "model_version"}
    assert len(p["line_items"]) == 3
    assert p["line_items"][0]["model"] == "claude-sonnet-4-6"


def test_parses_openai_style_export_with_dollar_signs():
    csv_text = (
        "date,model,amount\n"
        "06/01/2026,gpt-4o,\"$1,200.50\"\n"
        "06/02/2026,gpt-4o-mini,$0.75\n"
    )
    p = parse_invoice_csv(csv_text)
    assert p["total_usd"] == 1201.25
    assert p["period_start"] == "2026-06-01"


def test_cost_only_csv_still_works():
    p = parse_invoice_csv("cost\n10.00\n5.50\n")
    assert p["total_usd"] == 15.50
    assert p["period_start"] is None  # no dates → reconcile assumes last 30d


def test_missing_cost_column_is_a_plain_english_error():
    with pytest.raises(ValueError, match="cost column"):
        parse_invoice_csv("date,tokens\n2026-06-01,100\n")


def test_unparseable_cost_rows_are_skipped_not_fatal():
    p = parse_invoice_csv("cost\n10.00\nN/A\n2.00\n")
    assert p["total_usd"] == 12.00
    assert p["rows_skipped"] == 1


# ── Captured-spend aggregation ────────────────────────────────────────────────

def _llm_row(provider: str, model: str, day: str, in_tokens: int = 1_000_000,
             out_tokens: int = 0) -> dict:
    return {
        "resource": f"{provider}:{model}",
        "timestamp": f"{day}T12:00:00",
        "detail": json.dumps({
            "model": model,
            "response": {"usage": {"input_tokens": in_tokens, "output_tokens": out_tokens,
                                   "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0}},
        }),
    }


def test_aggregation_filters_by_provider_and_sums_by_day():
    rows = [
        _llm_row("anthropic", "claude-sonnet-4-6", "2026-06-01"),  # $3.00
        _llm_row("anthropic", "claude-haiku-4-5", "2026-06-02"),   # $1.00
        _llm_row("openai", "gpt-4o", "2026-06-01"),                # skipped: other provider
    ]
    agg = aggregate_captured_spend(rows, "anthropic")
    assert agg["calls"] == 2
    assert agg["total_usd"] == 4.00
    assert agg["by_day"] == {"2026-06-01": 3.00, "2026-06-02": 1.00}
    assert agg["by_model"]["claude-sonnet-4-6"] == 3.00


def test_provider_aliases_normalize():
    assert normalize_provider("Gemini") == "google"
    assert normalize_provider("Claude") == "anthropic"
    assert normalize_provider("openai") == "openai"


# ── Reconciliation verdicts ───────────────────────────────────────────────────

def _recon(invoice_total: float, tracked_total: float) -> dict:
    return reconcile(
        {"total_usd": invoice_total, "period_start": "2026-06-01", "period_end": "2026-06-30"},
        {"total_usd": tracked_total, "calls": 10, "by_day": {}, "by_model": {}},
    )


def test_verdict_bands():
    assert _recon(100, 97)["verdict"] == "reconciled"    # 3% gap
    assert _recon(100, 85)["verdict"] == "partial"       # 15% gap
    assert _recon(100, 40)["verdict"] == "large_gap"     # 60% gap
    assert _recon(0, 5)["verdict"] == "no_invoice_total"


def test_gap_causes_match_direction():
    under = _recon(100, 60)   # tracked < invoice → uncaptured traffic leads
    assert "never saw" in under["causes"][0]
    over = _recon(100, 140)   # tracked > invoice → price drift leads
    assert "today's catalog rates" in over["causes"][0]
    assert _recon(100, 99)["causes"] == []  # reconciled → nothing to explain


def test_by_day_alignment_includes_days_seen_by_either_side():
    r = reconcile(
        {"total_usd": 5.0, "period_start": "2026-06-01", "period_end": "2026-06-03",
         "line_items": [{"day": "2026-06-01", "model": None, "usd": 5.0}]},
        {"total_usd": 3.0, "calls": 1, "by_day": {"2026-06-02": 3.0}, "by_model": {}},
    )
    days = {d["day"]: d for d in r["byDay"]}
    assert days["2026-06-01"] == {"day": "2026-06-01", "invoiceUsd": 5.0, "trackedUsd": 0.0}
    assert days["2026-06-02"] == {"day": "2026-06-02", "invoiceUsd": 0.0, "trackedUsd": 3.0}


def test_window_bounds_are_end_exclusive():
    start, end = window_bounds("2026-06-01", "2026-06-30")
    assert start.startswith("2026-06-01")
    assert end.startswith("2026-07-01")  # inclusive period → exclusive bound


# ── API round-trip + org isolation ────────────────────────────────────────────

def _signup(client, email: str) -> dict:
    """Local twin of conftest._signup_org — importing the conftest as a module
    re-executes its module-level test-DB recreation and kills every pooled
    connection mid-session. Fixtures are safe; module imports are not."""
    r = client.post("/api/auth/signup",
                    json={"email": email, "password": "pw12345678", "name": "t"})
    assert r.status_code == 200, f"signup failed: {r.text}"
    return {"headers": {"Authorization": f"Bearer {r.json()['token']}"}}


def test_manual_import_reconciles_via_api(client):
    org = _signup(client, f"invoice-{uuid.uuid4().hex[:8]}@example.com")

    r = client.post("/api/cost/invoices", headers=org["headers"], json={
        "provider": "anthropic", "source": "manual", "total_usd": 42.00,
        "period_start": "2026-06-01", "period_end": "2026-06-30",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["invoiceUsd"] == 42.00
    assert body["trackedUsd"] == 0.0        # fresh org, nothing captured
    assert body["verdict"] == "large_gap"   # honest: we saw none of this bill
    assert body["isDemo"] is False
    assert body["pricedAtCurrentRates"] is True

    listed = client.get("/api/cost/invoices", headers=org["headers"]).json()["invoices"]
    assert len(listed) == 1 and listed[0]["provider"] == "anthropic"

    again = client.get("/api/cost/reconciliation", headers=org["headers"])
    assert again.status_code == 200 and again.json()["invoiceUsd"] == 42.00


def test_csv_import_via_api_and_delete(client):
    org = _signup(client, f"invoice-{uuid.uuid4().hex[:8]}@example.com")

    r = client.post("/api/cost/invoices", headers=org["headers"], json={
        "provider": "anthropic", "source": "csv", "filename": "june.csv",
        "csv_text": "usage_date,cost_usd\n2026-06-01,10.00\n2026-06-02,12.50\n",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["invoiceUsd"] == 22.50
    assert body["periodStart"] == "2026-06-01"
    inv_id = body["invoiceId"]

    d = client.delete(f"/api/cost/invoices/{inv_id}", headers=org["headers"])
    assert d.status_code == 200
    assert client.get("/api/cost/reconciliation", headers=org["headers"]).status_code == 404


def test_invoices_are_org_isolated(two_orgs, client):
    a, b = two_orgs["org_a"], two_orgs["org_b"]
    r = client.post("/api/cost/invoices", headers=a["headers"], json={
        "provider": "openai", "source": "manual", "total_usd": 10.0,
    })
    inv_id = r.json()["invoiceId"]
    # Org B can't read, reconcile, or delete org A's import.
    assert client.get("/api/cost/invoices", headers=b["headers"]).json()["invoices"] == []
    assert client.get(f"/api/cost/reconciliation?invoice_id={inv_id}",
                      headers=b["headers"]).status_code == 404
    assert client.delete(f"/api/cost/invoices/{inv_id}", headers=b["headers"]).status_code == 404


def test_bad_imports_rejected(client):
    org = _signup(client, f"invoice-{uuid.uuid4().hex[:8]}@example.com")
    assert client.post("/api/cost/invoices", headers=org["headers"], json={
        "provider": "", "source": "manual", "total_usd": 10.0}).status_code == 400
    assert client.post("/api/cost/invoices", headers=org["headers"], json={
        "provider": "anthropic", "source": "manual", "total_usd": 0}).status_code == 400
    assert client.post("/api/cost/invoices", headers=org["headers"], json={
        "provider": "anthropic", "source": "csv", "csv_text": "date,tokens\nx,1\n"}).status_code == 400


def test_reconciliation_with_captured_traffic(client):
    """The demo-beat path end to end: real captured calls + an imported bill
    that lands within 5% → verdict 'reconciled', per-day alignment populated."""
    org = _signup(client, f"invoice-{uuid.uuid4().hex[:8]}@example.com")

    r = client.post("/api/authority/agents/register", headers=org["headers"], json={
        "name": f"Recon Test Agent {uuid.uuid4().hex[:6]}",
        "description": "reconciliation fixture", "tools": [],
    })
    assert r.status_code == 200, r.text
    agent_id = r.json()["id"]

    from db import get_db
    with get_db() as conn:
        org_id = conn.execute(
            "SELECT org_id FROM agents WHERE id = %s", (agent_id,)).fetchone()["org_id"]
        day1 = (datetime.utcnow() - timedelta(days=3)).strftime("%Y-%m-%d")
        day2 = (datetime.utcnow() - timedelta(days=2)).strftime("%Y-%m-%d")
        for day in (day1, day2):  # 1M input tokens of sonnet-4-6 = $3.00/call
            conn.execute(
                "INSERT INTO audit_log (user_id, user_email, action, resource, detail, org_id, timestamp) "
                "VALUES (NULL, %s, 'LLM_CALL', 'anthropic:claude-sonnet-4-6', %s, %s, %s)",
                (agent_id, json.dumps({"model": "claude-sonnet-4-6", "response": {
                    "usage": {"input_tokens": 1_000_000, "output_tokens": 0,
                              "cache_read_input_tokens": 0,
                              "cache_creation_input_tokens": 0}}}),
                 org_id, f"{day}T12:00:00"),
            )

    r = client.post("/api/cost/invoices", headers=org["headers"], json={
        "provider": "anthropic", "source": "manual", "total_usd": 6.20,
        "period_start": day1, "period_end": day2,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["trackedUsd"] == 6.00          # 2 × $3.00, priced from the catalog
    assert body["verdict"] == "reconciled"     # $0.20 gap on $6.20 is within 5%
    assert body["coveragePct"] == 97
    assert body["causes"] == []                # reconciled → nothing to explain
