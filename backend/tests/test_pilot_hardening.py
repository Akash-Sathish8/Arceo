"""Starter tests guarding the pilot-hardening fixes.

Run from backend/:  venv/bin/python -m pytest tests/ -q
"""
from authority.risk_classifier import classify_with_fallback
from analysis.spend_forecast import forecast_spend


def labels(tool, action, desc=""):
    return set(classify_with_fallback(tool, action, desc).risk_labels)


# ── Classifier: dangerous agent/dev primitives are flagged ──────────────────

def test_bash_is_high_risk_irreversible():
    m = classify_with_fallback("bash", "Bash", "Execute bash commands")
    assert "changes_production" in m.risk_labels
    assert "deletes_data" in m.risk_labels
    assert m.reversible is False


def test_code_execution_flagged():
    assert labels("tools", "code_execution", "Executes code") >= {"changes_production", "deletes_data"}


def test_file_write_flagged():
    assert "changes_production" in labels("files", "Write", "Write content to a file")


# ── Classifier: browser/benign actions are NOT mislabeled (the false positives) ──

def test_browser_actions_not_destructive():
    assert labels("puppeteer", "puppeteer_select", "Select a dropdown option") == set()
    assert labels("puppeteer", "puppeteer_navigate", "Navigate to a URL") == set()


def test_web_search_is_not_shell_execution():
    # "Execute a web search ..." must not read as code execution
    assert labels("web_search", "search", "Execute a web search with allowed domains") == set()


# ── Classifier: real SaaS risks still flagged (regression guard) ────────────

def test_destructive_saas_still_flagged():
    assert "deletes_data" in labels("aws", "drop_table", "Drop a database table")
    assert "moves_money" in labels("stripe", "create_refund", "Refund a charge")
    assert labels("zendesk", "get_ticket", "Read a ticket") == set()  # read-only


# ── Forecast availability honesty ───────────────────────────────────────────

def test_forecast_unavailable_without_data():
    out = forecast_spend({"id": "bare", "name": "Bare", "tools": []})
    assert out["available"] is False
    assert out["reason"] == "no_data"


def test_forecast_available_with_declared_volume():
    out = forecast_spend({"id": "a", "name": "A", "tools": []}, overrides={"runs_per_day": 100})
    assert out["available"] is True
    assert out["point"] is not None and out["point"] >= 0
