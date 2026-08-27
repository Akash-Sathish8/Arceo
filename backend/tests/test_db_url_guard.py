"""Tier 2.1 — the production database guard must not fail open on Cloud Run.

`db.py` refused to fall back to the local docker-compose database only when one
of four PaaS environment variables was present: RAILWAY_ENVIRONMENT,
FLY_APP_NAME, RENDER, PRODUCTION. Google Cloud Run sets none of those — it sets
K_SERVICE — so on the platform we are actually deploying to the guard no-opped
and DATABASE_URL silently became postgresql://postgres:postgres@localhost:5432.

**The fix is not to add K_SERVICE.** A platform allowlist fails open on every
platform it has not heard of, which is precisely how this happened; `auth.py`
and `encryption.py` were inverted for that reason and `db.py` was the last one
left. The guard now refuses everywhere unless ARCEO_ENV opts in.

⚠️ Why this is worth more than "the app won't start": on most misconfigured
deploys it is loud, because init_db() runs `alembic upgrade head` against the
bogus URL and the revision dies. The dangerous case is a host where something
DOES answer on 127.0.0.1:5432 — **the Cloud SQL Auth Proxy sidecar binds exactly
there**. Nothing crashes; we attach to an unintended database and migrate it.
That case is `test_the_cloud_sql_proxy_topology_is_the_one_that_loses_data`.

These tests re-import the module under a patched environment, because the guard
runs at import time — which is the whole point of it (a deploy fails before it
can touch anything, not on first query).
"""

from __future__ import annotations

import importlib
import sys

import pytest


def _reimport_db(monkeypatch, *, database_url=None, arceo_env=None, extra_env=None):
    """Re-execute db.py's module body under a controlled environment.

    Returns the module on success; the RuntimeError is left to propagate so the
    caller can assert on it.
    """
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("ARCEO_ENV", raising=False)
    for k in ("RAILWAY_ENVIRONMENT", "FLY_APP_NAME", "RENDER", "PRODUCTION",
              "K_SERVICE", "K_REVISION", "GAE_ENV", "GOOGLE_CLOUD_PROJECT"):
        monkeypatch.delenv(k, raising=False)

    if database_url is not None:
        monkeypatch.setenv("DATABASE_URL", database_url)
    if arceo_env is not None:
        monkeypatch.setenv("ARCEO_ENV", arceo_env)
    for k, v in (extra_env or {}).items():
        monkeypatch.setenv(k, v)

    monkeypatch.delitem(sys.modules, "db", raising=False)
    return importlib.import_module("db")


@pytest.fixture(autouse=True)
def _restore_db_module():
    """Every test here reloads `db`. Put the real one back afterwards or the
    rest of the suite gets a module bound to a throwaway environment."""
    saved = sys.modules.get("db")
    yield
    if saved is not None:
        sys.modules["db"] = saved
    else:
        sys.modules.pop("db", None)


# ── The regression: Cloud Run ────────────────────────────────────────────────

def test_cloud_run_no_longer_falls_through_to_localhost(monkeypatch):
    """THE test. K_SERVICE is Cloud Run's marker and was in no allowlist, so the
    old guard treated a production revision as a developer laptop."""
    with pytest.raises(RuntimeError) as e:
        _reimport_db(monkeypatch, extra_env={"K_SERVICE": "arceo-backend",
                                             "K_REVISION": "arceo-backend-00001-abc"})
    assert "DATABASE_URL" in str(e.value)
    assert "ARCEO_ENV" in str(e.value), "the error must say how to fix it locally"


def test_the_cloud_sql_proxy_topology_is_the_one_that_loses_data(monkeypatch):
    """The case that does NOT announce itself.

    A Cloud Run revision with a Cloud SQL Auth Proxy sidecar has a live Postgres
    on 127.0.0.1:5432. Under the old guard the fallback URL would have connected
    successfully and `alembic upgrade head` would have run against whatever
    database the proxy fronts — no crash, no warning, wrong database migrated.

    The guard has to fire on the environment alone, never on whether the
    fallback happens to be reachable, so this asserts the refusal holds even
    when the URL would have worked.
    """
    with pytest.raises(RuntimeError) as e:
        _reimport_db(monkeypatch, extra_env={
            "K_SERVICE": "arceo-backend",
            "CLOUD_SQL_CONNECTION_NAME": "proj:us-central1:arceo-prod",
        })
    assert "Cloud SQL Auth Proxy" in str(e.value), (
        "the message should name the topology it is protecting, or the next "
        "person will read this as a pedantic config check and set ARCEO_ENV=dev"
    )


# ── The general shape: unknown hosts fail closed ─────────────────────────────

@pytest.mark.parametrize("marker", [
    None,                                    # a bare VM / plain Docker / a laptop
    {"AWS_EXECUTION_ENV": "AWS_ECS_FARGATE"},
    {"WEBSITE_INSTANCE_ID": "azure-app-service"},
    {"KUBERNETES_SERVICE_HOST": "10.0.0.1"},
])
def test_an_unrecognised_host_fails_closed(monkeypatch, marker):
    """The point of inverting the guard. None of these were on the old allowlist
    either, and every one of them is a real deployment target. The old guard let
    all of them through; a platform allowlist is only ever as good as its most
    recent update."""
    with pytest.raises(RuntimeError):
        _reimport_db(monkeypatch, extra_env=marker)


# ── ...and dev still works ───────────────────────────────────────────────────

@pytest.mark.parametrize("env", ["dev", "local", "test", "ci", "DEV", "Local"])
def test_a_declared_dev_environment_still_gets_the_compose_default(monkeypatch, env):
    """The counterweight. If this fails, every developer's laptop stops booting
    and the guard gets reverted rather than fixed. Case-insensitive because
    ARCEO_ENV is lowercased before comparison."""
    db = _reimport_db(monkeypatch, arceo_env=env)
    assert db.DATABASE_URL == "postgresql://postgres:postgres@localhost:5432/arceo"


def test_an_explicit_url_is_always_honoured(monkeypatch):
    """The guard is about the FALLBACK, not about DATABASE_URL. A production
    deploy that sets it must boot with no ARCEO_ENV at all."""
    db = _reimport_db(monkeypatch, database_url="postgresql://u:p@10.0.0.5:5432/arceo")
    assert db.DATABASE_URL == "postgresql://u:p@10.0.0.5:5432/arceo"


def test_an_explicit_url_wins_even_on_cloud_run(monkeypatch):
    db = _reimport_db(monkeypatch, database_url="postgresql://u:p@10.0.0.5:5432/arceo",
                      extra_env={"K_SERVICE": "arceo-backend"})
    assert db.DATABASE_URL == "postgresql://u:p@10.0.0.5:5432/arceo"


def test_the_old_platform_markers_are_gone_entirely(monkeypatch):
    """Not cosmetic. Leaving `_PROD_MARKERS` behind invites someone to "fix" the
    next platform by appending to it, which reinstates the allowlist this item
    exists to remove."""
    db = _reimport_db(monkeypatch, arceo_env="dev")
    assert not hasattr(db, "_PROD_MARKERS")


# ── One definition of "dev", shared by every guard ───────────────────────────

def test_every_boot_guard_agrees_on_what_dev_means():
    """These guards are independent and all fail closed, so a disagreement does
    not raise — it half-boots with one protection silently disabled. Four copies
    of the set is how that happens; this pins them to one."""
    import envcheck
    import auth
    import encryption

    assert auth._DEV_ENVS is envcheck.DEV_ENVS
    assert encryption._DEV_ENVS is envcheck.DEV_ENVS


def test_unset_arceo_env_is_production(monkeypatch):
    """The load-bearing default. Forgetting the variable on a laptop costs a
    startup error with instructions; the inverse default would cost the guard."""
    import envcheck

    monkeypatch.delenv("ARCEO_ENV", raising=False)
    assert envcheck.is_dev_env() is False
    monkeypatch.setenv("ARCEO_ENV", "production")
    assert envcheck.is_dev_env() is False
    monkeypatch.setenv("ARCEO_ENV", "staging")
    assert envcheck.is_dev_env() is False, "staging is a real deploy, not a laptop"
