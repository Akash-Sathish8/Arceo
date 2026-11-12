"""ARCEO_OPEN_DEMO_LOGIN: any credentials land in a fresh, empty, isolated
tenant; real accounts still authenticate; off by default."""

import uuid
from datetime import datetime, timedelta

import pytest

from tests.conftest import _signup_org


@pytest.fixture()
def open_login(monkeypatch):
    monkeypatch.setenv("ARCEO_OPEN_DEMO_LOGIN", "true")
    yield
    monkeypatch.delenv("ARCEO_OPEN_DEMO_LOGIN", raising=False)


def _login(client, email, password):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def test_same_credentials_get_a_fresh_empty_org_every_time(client, open_login):
    creds = (f"visitor-{uuid.uuid4().hex[:6]}@example.com", "x")
    a = _login(client, *creds)
    b = _login(client, *creds)
    assert a.status_code == 200 and b.status_code == 200, (a.text, b.text)
    assert a.json()["user"]["org_id"] != b.json()["user"]["org_id"]
    assert a.json()["user"]["email"] == creds[0]   # what was typed, not the stored marker
    for r in (a, b):
        h = {"Authorization": f"Bearer {r.json()['token']}"}
        assert client.get("/api/auth/me", headers=h).status_code == 200
        assert client.get("/api/authority/agents", headers=h).json()["agents"] == []


def test_a_bare_username_and_empty_password_work(client, open_login):
    r = _login(client, "carolina", "")
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email"] == "carolina"


def test_real_accounts_still_authenticate_normally(client, open_login):
    org = _signup_org(client, f"real-{uuid.uuid4().hex[:6]}@example.com")
    r = _login(client, org["email"], "pw12345678")
    assert r.status_code == 200
    assert r.json()["user"]["org_id"] == org["org_id"]
    # Wrong password does NOT reach the real org: it gets a fresh one instead.
    r2 = _login(client, org["email"], "not-the-password")
    assert r2.status_code == 200
    assert r2.json()["user"]["org_id"] != org["org_id"]


def test_flag_off_keeps_the_401_contract(client, monkeypatch):
    monkeypatch.delenv("ARCEO_OPEN_DEMO_LOGIN", raising=False)
    r = _login(client, f"nobody-{uuid.uuid4().hex[:6]}@example.com", "x")
    assert r.status_code == 401


def test_demo_mode_endpoint_reports_the_flag(client, open_login):
    assert client.get("/api/demo-mode").json()["open_login"] is True


def test_purge_removes_only_old_open_demo_orgs(client, open_login):
    from db import get_db
    from jobs.purge_demo_orgs import purge_demo_orgs

    old = _login(client, "old-visitor", "x").json()["user"]["org_id"]
    fresh = _login(client, "fresh-visitor", "x").json()["user"]["org_id"]
    real = _signup_org(client, f"keep-{uuid.uuid4().hex[:6]}@example.com")["org_id"]
    with get_db() as conn:
        stale = (datetime.utcnow() - timedelta(days=8)).isoformat()
        conn.execute("UPDATE organizations SET created_at = %s WHERE id IN (%s, %s)", (stale, old, real))

    purge_demo_orgs()

    with get_db() as conn:
        left = {r["id"] for r in conn.execute(
            "SELECT id FROM organizations WHERE id IN (%s, %s, %s)", (old, fresh, real)).fetchall()}
    assert old not in left
    assert fresh in left and real in left
