"""MED-018 — the customer scan action must carry no third-party dependencies.

`.github/actions/scan/run.py` runs inside the CUSTOMER's CI, where their
ARCEO_API_KEY and a GITHUB_TOKEN are both in scope. It used to `pip install
--quiet httpx` there: unpinned and unhashed, i.e. whatever the index served at
that moment, executed in someone else's pipeline. The fix removes the dependency
rather than pinning a transitive tree, so the install step is gone entirely.

run.py had no test coverage at all before this, which is why the transport rewrite
gets some: the behaviour that must survive swapping httpx for urllib is that a
4xx/5xx is a RETURNED status (httpx's shape) and not a raised exception (urllib's).
Every call site branches on the status code.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

_RUN_PY = Path(__file__).resolve().parents[2] / ".github" / "actions" / "scan" / "run.py"


def _load_run_module(monkeypatch):
    """Import run.py by path. It reads config from the environment at import time,
    so the required vars are set first."""
    monkeypatch.setenv("ARCEO_API_KEY", "test-key")
    monkeypatch.setenv("ARCEO_API_URL", "https://api.example.test")
    spec = importlib.util.spec_from_file_location("arceo_scan_run", _RUN_PY)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["arceo_scan_run"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def run_mod(monkeypatch):
    return _load_run_module(monkeypatch)


class _FakeResponse:
    """Stands in for the object urlopen returns as a context manager."""

    def __init__(self, status: int, body: bytes):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


# ── The dependency itself ─────────────────────────────────────────────────────

def test_run_py_imports_no_third_party_modules():
    """The point of the finding: nothing to install means nothing to pin."""
    source = _RUN_PY.read_text()
    assert "import httpx" not in source
    assert "import requests" not in source


def test_action_yml_runs_no_install_step():
    """Parsed, not grepped — the file explains the removed `pip install` in a
    comment, and a substring check would match its own rationale."""
    import yaml

    action = yaml.safe_load((_RUN_PY.parent / "action.yml").read_text())
    commands = " ".join(step.get("run", "") for step in action["runs"]["steps"])
    # Comments are already gone; what is left is what actually executes.
    assert "pip install" not in commands, "the customer action must install nothing"
    assert "pip3 install" not in commands


# ── The httpx-shaped contract the call sites depend on ────────────────────────

def test_error_status_is_returned_not_raised(run_mod, monkeypatch):
    """urllib raises HTTPError on 4xx/5xx where httpx returned a response. Every
    call site branches on the status code, so the helper must normalise it back."""
    def _boom(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {},
                                     _FakeIO(b'{"detail":"nope"}'))

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    status, text = run_mod._post_json("https://api.example.test/api/scan",
                                      {"X-API-Key": "k"}, {"files": []}, timeout=5)
    assert status == 401
    assert "nope" in text


def test_success_returns_status_and_body(run_mod, monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda req, timeout=None: _FakeResponse(200, b'{"summary":{}}'))
    status, text = run_mod._post_json("https://api.example.test/api/scan",
                                      {"X-API-Key": "k"}, {"files": []}, timeout=5)
    assert status == 200
    assert json.loads(text) == {"summary": {}}


def test_transport_failure_raises_transport_error(run_mod, monkeypatch):
    """A connection that never produced a response is a different case from an HTTP
    error status, and the callers handle it separately."""
    def _boom(req, timeout=None):
        raise urllib.error.URLError("name resolution failed")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    with pytest.raises(run_mod.TransportError):
        run_mod._post_json("https://api.example.test/api/scan", {}, {}, timeout=5)


def test_content_type_defaults_to_json(run_mod, monkeypatch):
    """httpx set this automatically for `json=`; urllib does not. The GitHub PR
    comment call never set it explicitly, so the default is load-bearing."""
    seen = {}

    def _capture(req, timeout=None):
        seen["headers"] = {k.lower(): v for k, v in req.header_items()}
        seen["body"] = req.data
        return _FakeResponse(201, b"{}")

    monkeypatch.setattr(urllib.request, "urlopen", _capture)
    run_mod._post_json("https://api.github.test/repos/x/y/issues/1/comments",
                       {"Authorization": "Bearer t"}, {"body": "hello"}, timeout=5)

    assert seen["headers"]["content-type"] == "application/json"
    assert seen["headers"]["authorization"] == "Bearer t"
    assert json.loads(seen["body"]) == {"body": "hello"}


def test_explicit_content_type_is_not_overridden(run_mod, monkeypatch):
    seen = {}

    def _capture(req, timeout=None):
        seen["headers"] = {k.lower(): v for k, v in req.header_items()}
        return _FakeResponse(200, b"{}")

    monkeypatch.setattr(urllib.request, "urlopen", _capture)
    run_mod._post_json("https://api.example.test/api/scan",
                       {"Content-Type": "application/json; charset=utf-8"},
                       {"files": []}, timeout=5)
    assert seen["headers"]["content-type"] == "application/json; charset=utf-8"


class _FakeIO:
    """Minimal file-like for HTTPError's `fp` argument."""

    def __init__(self, data: bytes):
        self._data = data

    def read(self):
        return self._data
