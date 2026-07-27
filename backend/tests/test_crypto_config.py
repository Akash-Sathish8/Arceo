"""PR 4B — crypto/config hygiene (LOW-006, LOW-007, LOW-008).

LOW-006: prod boot-guard requiring encryption-at-rest.
LOW-007: redaction now masks common secret/credential formats.
LOW-008: CORS is scoped to real methods/headers instead of "*".
"""

from __future__ import annotations

import pytest

import encryption
import redaction


# ── LOW-006: production encryption boot-guard ──────────────────────────────────

def test_prod_refuses_boot_without_encryption(monkeypatch):
    monkeypatch.setenv("ARCEO_ENV", "production")
    monkeypatch.delenv("ARCEO_ENCRYPT_AT_REST", raising=False)
    with pytest.raises(RuntimeError):
        encryption.enforce_prod_encryption_policy()


def test_dev_allows_no_encryption(monkeypatch):
    monkeypatch.setenv("ARCEO_ENV", "dev")
    monkeypatch.delenv("ARCEO_ENCRYPT_AT_REST", raising=False)
    encryption.enforce_prod_encryption_policy()  # no raise


def test_encryption_on_requires_master_key(monkeypatch):
    monkeypatch.setenv("ARCEO_ENV", "production")
    monkeypatch.setenv("ARCEO_ENCRYPT_AT_REST", "true")
    monkeypatch.delenv("ARCEO_VAULT_MASTER_KEY", raising=False)
    with pytest.raises(RuntimeError):
        encryption.enforce_prod_encryption_policy()


# ── LOW-007: secret/credential redaction ───────────────────────────────────────

@pytest.mark.parametrize("secret", [
    "AKIAIOSFODNN7EXAMPLE",
    "sk-ant-abcdefghijklmnopqrstuvwxyz012345",
    "sk-abcdefghijklmnopqrstuvwxyz012345",
    "ghp_" + "a" * 36,
    "Bearer abcdefghijklmnopqrstuvwxyz012345",
])
def test_redacts_secret_formats(secret):
    out = redaction.redact_text(f"my credential is {secret} okay")
    assert "REDACTED_SECRET" in out
    # the raw secret material must be gone
    token = secret.split()[-1]
    assert token not in out


def test_redaction_leaves_ordinary_text_alone():
    text = "order 12345 for widget model-3 shipped"
    assert redaction.redact_text(text) == text


# ── LOW-008: CORS scoped, not wildcard ─────────────────────────────────────────

def test_cors_methods_not_wildcard(client):
    r = client.options("/api/health", headers={
        "Origin": "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
    })
    allow = r.headers.get("access-control-allow-methods", "")
    assert "*" not in allow
    assert "POST" in allow
