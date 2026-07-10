"""Shared pytest config: environment isolation + deterministic LLM stubbing.

This module is imported by pytest BEFORE any test module, which matters:
db.py resolves DB_PATH at import time, so ARCEO_DB_PATH must be set here —
otherwise a test module that transitively imports db would point writes
(including the persistent LLM-classification cache) at the developer's real
actiongate.db.

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
os.environ["ARCEO_DB_PATH"] = os.path.join(_TEST_DIR, "test.db")
os.environ.setdefault("JWT_SECRET", "test-secret-not-for-prod")
os.environ["ANTHROPIC_API_KEY"] = ""

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
        org_id = conn.execute("SELECT org_id FROM users WHERE email = ?", (email,)).fetchone()["org_id"]
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
