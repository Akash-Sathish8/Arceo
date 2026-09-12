"""The /api/internal/cron/* endpoints (the Vercel scheduler path).

Additive to the standalone `python -m jobs.X` entrypoints, which remain the
canonical path for container platforms (deployment contract §4). The contract's
Vercel addendum (§9) sanctions these three endpoints for deploys where the
platform scheduler can only issue HTTP requests. The auth model is deliberately
narrow: refuse outright (503) when CRON_SECRET is unset, so the endpoints are
inert on every deploy that hasn't opted in, and constant-time-compare the
bearer otherwise.
"""

import pytest

CRON_PATHS = [
    "/api/internal/cron/snapshot-forecasts",
    "/api/internal/cron/weekly-digest",
    "/api/internal/cron/purge-llm-captures",
]


@pytest.mark.parametrize("path", CRON_PATHS)
def test_disabled_without_secret(client, monkeypatch, path):
    monkeypatch.delenv("CRON_SECRET", raising=False)
    r = client.get(path)
    assert r.status_code == 503
    assert "CRON_SECRET" in r.json()["detail"]


@pytest.mark.parametrize("path", CRON_PATHS)
def test_rejects_missing_or_wrong_bearer(client, monkeypatch, path):
    monkeypatch.setenv("CRON_SECRET", "cron-test-secret")
    assert client.get(path).status_code == 401
    r = client.get(path, headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401
    # The whole header is compared, not just the token — a bare token without
    # the Bearer prefix must not pass either.
    r = client.get(path, headers={"Authorization": "cron-test-secret"})
    assert r.status_code == 401


@pytest.mark.parametrize("path", CRON_PATHS)
def test_runs_job_with_correct_bearer(client, monkeypatch, path):
    monkeypatch.setenv("CRON_SECRET", "cron-test-secret")
    r = client.get(path, headers={"Authorization": "Bearer cron-test-secret"})
    assert r.status_code == 200
    # Each job returns its summary dict (idempotent no-ops on a fresh DB:
    # nothing to snapshot, no orgs due a digest, nothing past retention).
    assert isinstance(r.json(), dict)
