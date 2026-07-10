"""Shared pytest config: environment isolation + deterministic LLM stubbing.

This module is imported by pytest BEFORE any test module, which matters:
db.py resolves DATABASE_URL at import time, so the test database must be
created and DATABASE_URL exported here — otherwise a test module that
transitively imports db would bind its pool to the developer's dev database.

ANTHROPIC_API_KEY is forced to "" so no test can hit the live API even though
backend/.env contains a key (main.py's load_dotenv(override=False) will not
replace an existing value). The LLM layer is replaced with a fixture replay:
a fixture MISS returns None — the "LLM unavailable" path, which keeps keyword
labels (fail toward flagging). It must NOT return [], which would read as an
affirmative "benign" verdict and veto weak labels.
"""

from __future__ import annotations

import json
import os
import tempfile

_TEST_DIR = tempfile.mkdtemp(prefix="arceo-test-")
# The LLM cache stays SQLite and resolves its own path — point it at a tempdir
# so tests never write beside the repo.
os.environ["ARCEO_LLM_CACHE_PATH"] = os.path.join(_TEST_DIR, "llm_cache.db")
os.environ.setdefault("JWT_SECRET", "test-secret-not-for-prod")
os.environ.setdefault("ARCEO_ENV", "test")  # lets DEMO_MODE tests run without a prod-guard trip
# Shared state runs on a dedicated Redis DB (flushed between tests) so a real
# store is exercised — no in-memory fallback to mask multi-worker bugs.
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/15")
os.environ["ANTHROPIC_API_KEY"] = ""

# Fresh Postgres database per session (dropped and recreated so every run
# starts clean), then exported as DATABASE_URL before any app import. The
# suite's isolation model is unchanged: one shared session DB, unique
# orgs/emails per test. Server credentials match docker-compose.yml and CI.
_TEST_DATABASE_URL = os.environ.get(
    "ARCEO_TEST_DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/arceo_test",
)


def _recreate_test_db(url: str) -> None:
    import psycopg
    from urllib.parse import urlsplit

    dbname = urlsplit(url).path.lstrip("/")
    admin_url = url.rsplit("/", 1)[0] + "/postgres"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')
        admin.execute(f'CREATE DATABASE "{dbname}"')


_recreate_test_db(_TEST_DATABASE_URL)
os.environ["DATABASE_URL"] = _TEST_DATABASE_URL

# Migrate once up front so test modules that hit the DB directly at import
# don't depend on a TestClient (whose lifespan runs init_db) starting first.
# init_db()'s own upgrade call then no-ops.
from alembic import command as _alembic_command  # noqa: E402
from alembic.config import Config as _AlembicConfig  # noqa: E402

_alembic_command.upgrade(
    _AlembicConfig(os.path.join(os.path.dirname(__file__), "..", "alembic.ini")), "head"
)

import pytest  # noqa: E402

import authority.risk_classifier as _rc  # noqa: E402

# The real function, saved before any per-test monkeypatching — cache/vote
# tests exercise it directly against a fake anthropic module.
REAL_CLASSIFY_WITH_LLM = _rc.classify_with_llm

_FIXTURES_PATH = os.path.join(os.path.dirname(__file__), "eval", "llm_fixtures.json")
_MISSING_FIXTURE_KEYS: list[str] = []


def _load_fixtures() -> dict:
    if not os.path.exists(_FIXTURES_PATH):
        return {}
    with open(_FIXTURES_PATH) as f:
        return json.load(f)


_FIXTURES = _load_fixtures()


@pytest.fixture(autouse=True)
def stub_llm_classifier(monkeypatch):
    """Replay recorded LLM classifications; miss -> None (unavailable, not benign)."""
    import authority.risk_classifier as rc

    def stub(action_name: str, description: str = "", schema_props=None, candidates=None):
        key = f"{action_name}||{description}"
        hit = _FIXTURES.get(key)
        if hit is None:
            _MISSING_FIXTURE_KEYS.append(key)
            return None
        return list(hit["labels"]), bool(hit["reversible"])

    monkeypatch.setattr(rc, "classify_with_llm", stub)
    rc._llm_cache.clear()
    rc._pending_cache_rows.clear()
    yield
    rc._llm_cache.clear()
    rc._pending_cache_rows.clear()


@pytest.fixture(autouse=True)
def _reset_shared_state():
    """Flush the test Redis DB between tests so rate-limit windows, live-trace
    buffers, and leader locks don't bleed across tests (every test's signup/
    login shares one TestClient IP, which would trip the auth limiter mid-suite).
    """
    import shared_state
    shared_state._flush_for_tests()
    yield
    shared_state._flush_for_tests()


# ── Shared HTTP fixtures ──────────────────────────────────────────────────────
# The session-scoped temp DB persists across tests, so fixtures use unique
# emails per invocation. Existing per-file TestClient/_auth patterns keep
# working; these exist so new tests (cross-tenant, security baseline) don't
# each reinvent signup plumbing.


@pytest.fixture()
def client():
    """App client; entering the context runs startup (init_db seeds the default org)."""
    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app) as c:
        yield c


def _signup_org(client, email: str) -> dict:
    """Create an account (signup mints a fresh org — the tenant boundary)."""
    password = "pw12345678"
    r = client.post("/api/auth/signup", json={"email": email, "password": password, "name": email.split("@")[0]})
    assert r.status_code == 200, f"signup failed: {r.text}"
    token = r.json()["token"]

    from db import get_db

    with get_db() as conn:
        org_id = conn.execute("SELECT org_id FROM users WHERE email = %s", (email,)).fetchone()["org_id"]
    return {
        "token": token,
        "org_id": org_id,
        "email": email,
        "headers": {"Authorization": f"Bearer {token}"},
    }


@pytest.fixture()
def two_orgs(client):
    """Two isolated tenants, for cross-org leak tests: {org_a: {...}, org_b: {...}}."""
    import uuid

    suffix = uuid.uuid4().hex[:8]
    return {
        "org_a": _signup_org(client, f"org-a-{suffix}@example.com"),
        "org_b": _signup_org(client, f"org-b-{suffix}@example.com"),
    }


def pytest_sessionfinish(session, exitstatus):
    if _MISSING_FIXTURE_KEYS:
        unique = sorted(set(_MISSING_FIXTURE_KEYS))
        print(f"\n[conftest] {len(unique)} LLM fixture misses (stub returned None). "
              f"If any are requires_llm eval cases, run evals/regen_fixtures.py. First few:")
        for k in unique[:8]:
            print(f"  {k}")
