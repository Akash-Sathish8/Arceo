"""Post-roadmap hardening PR-1: security headers + structured access log.

Every response carries the standard hardening headers; HSTS is withheld in dev
(so local/HTTP-pilot instances work) and sent everywhere else. Privileged/mutating
API calls emit exactly one structured JSON access-log line — metadata only, never
bodies or PII — the SOC2 "structured privileged-action events" control.
"""

from __future__ import annotations

import json
import logging
import uuid

import main


def test_security_headers_present_on_api(client):
    r = client.get("/api/health")
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Referrer-Policy"] == "no-referrer"
    assert "default-src 'self'" in r.headers["Content-Security-Policy"]


def test_hsts_absent_in_dev(client, monkeypatch):
    monkeypatch.setattr(main, "_IS_DEV_ENV", True)
    r = client.get("/api/health")
    assert "Strict-Transport-Security" not in r.headers


def test_hsts_present_outside_dev(client, monkeypatch):
    monkeypatch.setattr(main, "_IS_DEV_ENV", False)
    r = client.get("/api/health")
    assert "max-age=" in r.headers.get("Strict-Transport-Security", "")


def _access_lines(caplog):
    return [json.loads(rec.message) for rec in caplog.records
            if rec.name == "arceo.access"]


def test_privileged_call_emits_one_structured_line(client, roles, caplog):
    admin = roles["admin"]
    with caplog.at_level(logging.INFO, logger="arceo.access"):
        r = client.post("/api/authority/agents", headers=admin["headers"],
                        json={"name": "acc-" + uuid.uuid4().hex[:6], "tools": []})
    assert r.status_code == 200
    lines = _access_lines(caplog)
    assert len(lines) == 1
    line = lines[0]
    assert line["event"] == "privileged_api"
    assert line["method"] == "POST"
    assert line["path"] == "/api/authority/agents"
    assert line["status"] == 200
    assert line["actor"].startswith("user:")
    assert "latency_ms" in line
    # No request body / PII leaks into the log line.
    assert "acc-" not in json.dumps(line)


def test_read_only_call_is_not_access_logged(client, roles, caplog):
    admin = roles["admin"]
    with caplog.at_level(logging.INFO, logger="arceo.access"):
        client.get("/api/authority/agents", headers=admin["headers"])
    assert _access_lines(caplog) == []


def test_health_is_not_access_logged(client, caplog):
    with caplog.at_level(logging.INFO, logger="arceo.access"):
        client.get("/api/health")
    assert _access_lines(caplog) == []
