"""Tier 2.3 and 2.9 — two boot guards that decide what a broken deploy looks like.

Both exist for the same reason: the failure they prevent is one that **passes a
health check**. A container that comes up and answers 200 on /api/health while
429ing every login, or one that serves against a schema older than its code, is
worse than a container that never started — on Cloud Run a failed revision rolls
back on its own, while a healthy-but-wrong one takes traffic.

## 2.3 — Redis

`shared_state` deliberately has NO in-memory fallback, and `rate_limit_ok` fails
CLOSED (MED-007). So an unreachable Redis does not degrade Arceo, it bricks it:
signup, login, /api/enforce, /api/scan (the GitHub Action's endpoint), the LLM
proxy, LLM capture, live-trace ingest and the mock sandbox all 429.

⚠️ These tests must never be "fixed" by making the limiter fail open. That
posture is MED-007 and is pinned by `test_login_still_refuses_when_redis_is_down`
in test_concurrency_and_timeouts.py. A limiter that cannot count must not wave
brute-force traffic through. The guard here surfaces the dependency at boot
instead of at a customer's first login.

## 2.9 — migrations on boot

Production runs as the restricted `arceo_app` role; migrations need the owner
role. At head alembic degenerates to `SELECT version_num`, which `arceo_app` can
do — so steady-state restarts look fine and the problem stays hidden until the
first boot of a release carrying an unapplied revision, which is precisely the
deploy that matters.

⚠️ Turning the upgrade off is only half the fix. Without the head assertion it
trades a loud failure (permission denied, container does not start) for a silent
one (container starts, 500s on the first query needing the new column). Both
halves are pinned below.
"""

from __future__ import annotations

import pytest
import redis

import shared_state
import db as db_module


# ── 2.3: the Redis boot guard ────────────────────────────────────────────────

class _DeadRedis:
    """Stands in for a Redis that resolves but refuses connections — the shape a
    missing Serverless VPC connector actually produces, rather than a DNS
    failure."""

    def ping(self):
        raise redis.ConnectionError("Connection refused")


def test_a_real_deploy_refuses_to_boot_without_redis(monkeypatch):
    """THE 2.3 test. The alternative is a revision that serves 429s behind a
    passing health check."""
    monkeypatch.setattr(shared_state, "_client", _DeadRedis())
    monkeypatch.setenv("ARCEO_ENV", "production")
    with pytest.raises(RuntimeError) as e:
        shared_state.enforce_redis_reachable()
    msg = str(e.value)
    assert "REDIS_URL" in msg or "Redis is unreachable" in msg
    # The message has to carry the GCP-specific remedy, or the next person
    # reads this as "Redis is optional, it is only a cache".
    assert "Memorystore" in msg, "name the actual prerequisite on our target platform"


@pytest.mark.parametrize("env", ["dev", "local", "test", "ci"])
def test_dev_warns_instead_of_refusing(monkeypatch, caplog, env):
    """A laptop mid-`docker compose up` should get a readable warning, not a
    stack trace — and that warning is what explains why login is 429ing."""
    monkeypatch.setattr(shared_state, "_client", _DeadRedis())
    monkeypatch.setenv("ARCEO_ENV", env)
    with caplog.at_level("WARNING"):
        shared_state.enforce_redis_reachable()  # must not raise
    assert any("Redis is unreachable" in r.getMessage() for r in caplog.records), caplog.text


def test_unset_arceo_env_counts_as_production(monkeypatch):
    """Same default as every other guard: forgetting the variable must not
    silently downgrade the check."""
    monkeypatch.setattr(shared_state, "_client", _DeadRedis())
    monkeypatch.delenv("ARCEO_ENV", raising=False)
    with pytest.raises(RuntimeError):
        shared_state.enforce_redis_reachable()


def test_a_reachable_redis_is_silent(monkeypatch):
    """The counterweight — this runs against the suite's real Redis. If it ever
    fails, every healthy boot is raising or logging noise."""
    monkeypatch.setenv("ARCEO_ENV", "production")
    shared_state.enforce_redis_reachable()  # must not raise


# ── 2.9: the migration toggle ────────────────────────────────────────────────

@pytest.mark.parametrize("env,expected", [
    ("dev", True), ("local", True), ("test", True), ("ci", True),
    ("production", False), ("staging", False), ("", False),
])
def test_migrations_run_on_boot_only_in_dev(monkeypatch, env, expected):
    """Default on in dev so `docker compose up && boot` keeps working; off on a
    real deploy, where the app role cannot create tables."""
    monkeypatch.delenv("ARCEO_RUN_MIGRATIONS_ON_BOOT", raising=False)
    if env:
        monkeypatch.setenv("ARCEO_ENV", env)
    else:
        monkeypatch.delenv("ARCEO_ENV", raising=False)
    assert db_module.run_migrations_on_boot() is expected


@pytest.mark.parametrize("flag,expected", [
    ("1", True), ("true", True), ("yes", True), ("on", True), ("TRUE", True),
    ("0", False), ("false", False), ("no", False), ("off", False),
])
def test_the_override_works_in_both_directions(monkeypatch, flag, expected):
    """Matches ARCEO_PROXY_REQUIRE_KEY / ARCEO_BUDGET_ENFORCE — an operator can
    force it either way regardless of ARCEO_ENV. A one-way override would leave
    no escape hatch for a deploy that legitimately wants boot migrations."""
    monkeypatch.setenv("ARCEO_ENV", "production" if expected else "dev")
    monkeypatch.setenv("ARCEO_RUN_MIGRATIONS_ON_BOOT", flag)
    assert db_module.run_migrations_on_boot() is expected


def test_a_schema_behind_the_code_refuses_to_serve(monkeypatch):
    """The half that makes skipping migrations safe.

    Without this, turning the upgrade off would swap a loud failure (permission
    denied at boot) for a silent one (boots fine, 500s on the first query
    touching a column the migration should have added).
    """
    from alembic.config import Config
    from pathlib import Path

    cfg = Config(str(Path(db_module.__file__).parent / "alembic.ini"))

    class _Row(dict):
        pass

    class _Conn:
        def execute(self, *_a, **_kw):
            class _R:
                def fetchone(self_inner):
                    return {"version_num": "0001_baseline"}   # deliberately stale
            return _R()

    import contextlib

    @contextlib.contextmanager
    def _fake_db():
        yield _Conn()

    monkeypatch.setattr(db_module, "get_db", _fake_db)
    with pytest.raises(RuntimeError) as e:
        db_module._assert_schema_at_head(cfg)
    msg = str(e.value)
    assert "0001_baseline" in msg, "say which revision the database is actually on"
    assert "upgrade head" in msg, "say how to fix it"
    assert "OWNER" in msg or "owner" in msg, "say which role to run it as"


def test_a_schema_at_head_passes_silently(monkeypatch):
    """The counterweight. A correct deploy must not be blocked by the assertion
    that protects a wrong one."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    from pathlib import Path
    import contextlib

    cfg = Config(str(Path(db_module.__file__).parent / "alembic.ini"))
    head = ScriptDirectory.from_config(cfg).get_current_head()

    class _Conn:
        def execute(self, *_a, **_kw):
            class _R:
                def fetchone(self_inner):
                    return {"version_num": head}
            return _R()

    @contextlib.contextmanager
    def _fake_db():
        yield _Conn()

    monkeypatch.setattr(db_module, "get_db", _fake_db)
    db_module._assert_schema_at_head(cfg)  # must not raise


def test_a_never_migrated_database_is_named_as_such(monkeypatch):
    """Distinct from "behind": no alembic_version table at all means nobody ran
    migrations, and the operator needs to be told that rather than shown a
    confusing revision mismatch."""
    from alembic.config import Config
    from pathlib import Path
    import contextlib

    cfg = Config(str(Path(db_module.__file__).parent / "alembic.ini"))

    class _Conn:
        def execute(self, *_a, **_kw):
            raise RuntimeError('relation "alembic_version" does not exist')

    @contextlib.contextmanager
    def _fake_db():
        yield _Conn()

    monkeypatch.setattr(db_module, "get_db", _fake_db)
    with pytest.raises(RuntimeError) as e:
        db_module._assert_schema_at_head(cfg)
    assert "no Alembic" in str(e.value) or "version table" in str(e.value)
