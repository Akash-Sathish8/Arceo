"""PR 2A — MED-001 / LOW-001 (admin-gate read surfaces) + MED-002 (demo-mode unify).

The RBAC middleware only gates mutating methods, so two sensitive GETs — the audit
trail (carries captured LLM prompts/responses) and org notification settings —
were readable by any authenticated role. Both now require admin.

demo_mode_enabled() is the single source of truth for DEMO_MODE so the boot guard,
JWT bypass, demo reset, and trace WebSocket can't disagree (they did — the WS
accepted 1/true/yes while everything else demanded exactly "true").
"""

from __future__ import annotations

import pytest

import auth


# ── MED-001 / LOW-001: admin-only read surfaces ────────────────────────────────

@pytest.mark.parametrize("path", ["/api/audit", "/api/notifications/settings"])
def test_non_admin_cannot_read_admin_surface(client, roles, path):
    for role in ("viewer", "editor"):
        r = client.get(path, headers=roles[role]["headers"])
        assert r.status_code == 403, f"{role} got {r.status_code} on {path} (expected 403)"


@pytest.mark.parametrize("path", ["/api/audit", "/api/notifications/settings"])
def test_admin_can_read_admin_surface(client, roles, path):
    r = client.get(path, headers=roles["admin"]["headers"])
    assert r.status_code == 200, r.text


# ── MED-002: demo-mode truthiness is unified ───────────────────────────────────

@pytest.mark.parametrize("val", ["1", "true", "TRUE", "yes", "on", "On"])
def test_demo_mode_enabled_accepts_truthy(monkeypatch, val):
    monkeypatch.setenv("DEMO_MODE", val)
    assert auth.demo_mode_enabled() is True


@pytest.mark.parametrize("val", ["", "0", "false", "no", "off"])
def test_demo_mode_disabled_for_falsy(monkeypatch, val):
    monkeypatch.setenv("DEMO_MODE", val)
    assert auth.demo_mode_enabled() is False


def test_demo_mode_unset_is_disabled(monkeypatch):
    monkeypatch.delenv("DEMO_MODE", raising=False)
    assert auth.demo_mode_enabled() is False
