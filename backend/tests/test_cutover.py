"""Post-roadmap PR-3: turnkey cutover — the RLS-active preflight.

verify_rls_active.py is the single most important post-cutover check: it proves
the app is connecting as a non-superuser role so RLS actually enforces (a
superuser silently bypasses even FORCED RLS). These exercise its `check()`
against a restricted role (passes) and the superuser the suite runs as (fails).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest

from db import DATABASE_URL

_SCRIPTS = Path(__file__).resolve().parent.parent.parent / "scripts"
_ROLE = "arceo_cutover_test_app"
_PW = "cutover_pw"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, _SCRIPTS / name)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _app_url() -> str:
    p = urlsplit(DATABASE_URL)
    return urlunsplit((p.scheme, f"{_ROLE}:{_PW}@{p.hostname}:{p.port or 5432}", p.path, "", ""))


@pytest.fixture()
def app_role():
    with psycopg.connect(DATABASE_URL, autocommit=True) as admin:
        admin.execute(f"DROP ROLE IF EXISTS {_ROLE}")
        admin.execute(f"CREATE ROLE {_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{_PW}'")
        admin.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {_ROLE}")
        admin.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {_ROLE}")
    yield
    with psycopg.connect(DATABASE_URL, autocommit=True) as admin:
        admin.execute(f"DROP OWNED BY {_ROLE}")
        admin.execute(f"DROP ROLE IF EXISTS {_ROLE}")


def test_verify_rls_passes_for_a_restricted_role(app_role):
    v = _load("verify_rls_active.py")
    assert v.check(_app_url()) is None  # RLS enforces: no error


def test_verify_rls_fails_for_a_superuser():
    v = _load("verify_rls_active.py")
    err = v.check(DATABASE_URL)  # the suite connects as the postgres superuser
    assert err is not None
    assert "superuser" in err.lower() or "bypassrls" in err.lower()
