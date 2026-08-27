"""Capture must stay fire-and-forget, but it must stop being SILENT.

`_post_async` swallowed every exception, so a pilot whose `ARCEO_API_KEY` was
missing, wrong, or revoked saw exactly what a working install sees: nothing. The
agent ran fine, calls went nowhere, and they waited for a forecast that could
never arrive — capture is key-required, and the high-confidence tier needs 50
captured calls in a rolling 7-day window.

That is the worst shape a failure can take on a pilot: invisible, and it degrades
the one number the product is sold on.

The contract that must NOT change is the one in the module docstring — capture
can never slow down or break the wrapped call. So these tests pin both halves:
it still never raises, and it now says something once per process.
"""

from __future__ import annotations

import os
import sys
import urllib.error

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "sdk")))

from arceo import _capture  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_warned(monkeypatch):
    """The once-per-process flag is module state; reset it between tests.

    `raising=False` on purpose: these tests must remain RUNNABLE against a build
    of `_capture` that has no diagnostics at all, so that they fail with a real
    assertion ("nothing was written") rather than an import error. A test that
    errors out proves the symbol is missing; a test that fails proves the
    behaviour is wrong, and only the second one is evidence."""
    monkeypatch.setattr(_capture, "_warned", False, raising=False)


def _drain(monkeypatch, *, api_key: str, raises: Exception | None):
    """Run _post_async's body synchronously and return what reached stderr.

    The real function spawns a daemon thread, which would make this test racy.
    We keep the code path identical and only replace the threading, so what is
    exercised is the same try/except the agent runs.
    """
    written: list[str] = []
    monkeypatch.setattr(_capture, "DEFAULT_API_KEY", api_key)
    monkeypatch.setattr(sys.stderr, "write", lambda s: written.append(s))
    monkeypatch.setattr(sys.stderr, "flush", lambda: None)

    def _urlopen(*_a, **_kw):
        if raises is not None:
            raise raises
        class _R:
            def close(self):
                pass
        return _R()

    monkeypatch.setattr(_capture.urllib.request, "urlopen", _urlopen)
    # Run the thread body inline instead of detaching it.
    monkeypatch.setattr(
        _capture.threading, "Thread",
        lambda target, daemon=False: type("T", (), {"start": staticmethod(target)})(),
    )
    _capture._post_async("http://arceo.test/api/agent/a/llm-call", {"usage": {}})
    return "".join(written)


def _http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("http://arceo.test", code, "nope", {}, None)


# ── It says something ────────────────────────────────────────────────────────

@pytest.mark.parametrize("code", [401, 403])
def test_a_rejected_key_is_reported_not_swallowed(monkeypatch, code):
    out = _drain(monkeypatch, api_key="ak_live_whatever", raises=_http_error(code))
    assert "[arceo]" in out
    assert str(code) in out
    # The message has to name the thing they can act on, not just fail.
    assert "ARCEO_API_KEY" in out


def test_a_missing_key_is_reported_before_the_server_even_answers(monkeypatch):
    """The most common setup mistake, and the one that looks least like one."""
    out = _drain(monkeypatch, api_key="", raises=None)
    assert "ARCEO_API_KEY is not set" in out
    assert "low-confidence" in out, "the message should say what it costs them"


def test_a_network_failure_is_reported_too(monkeypatch):
    out = _drain(monkeypatch, api_key="ak_live_whatever", raises=OSError("connection refused"))
    assert "[arceo]" in out
    assert "not being recorded" in out


def test_a_healthy_call_says_nothing(monkeypatch):
    """The counterweight. If this ever fails, every successful call is printing
    to a customer's logs."""
    assert _drain(monkeypatch, api_key="ak_live_whatever", raises=None) == ""


# ── ...exactly once ──────────────────────────────────────────────────────────

def test_it_warns_once_per_process_not_once_per_call(monkeypatch):
    """A busy agent makes thousands of calls. One diagnostic is a signal; one per
    call is a log flood that gets the SDK removed."""
    written: list[str] = []
    monkeypatch.setattr(sys.stderr, "write", lambda s: written.append(s))
    monkeypatch.setattr(sys.stderr, "flush", lambda: None)
    for _ in range(50):
        _capture._warn_once("something went wrong")
    assert len(written) == 1


# ── ...and never breaks the agent ────────────────────────────────────────────

@pytest.mark.parametrize("boom", [
    _http_error(401),
    _http_error(500),
    OSError("connection refused"),
    ValueError("garbage"),
])
def test_capture_never_raises_into_the_caller(monkeypatch, boom):
    """THE contract. Diagnostics must not have turned a best-effort reporter into
    something that can take an agent down."""
    _drain(monkeypatch, api_key="ak_live_whatever", raises=boom)  # must not raise


def test_a_broken_stderr_cannot_break_the_agent_either(monkeypatch):
    """Belt and braces: some hosts hand you a closed or read-only stderr, and the
    diagnostic path must not become the thing that crashes the process."""
    def _explode(_s):
        raise OSError("stderr is closed")

    monkeypatch.setattr(sys.stderr, "write", _explode)
    _capture._warn_once("anything")  # must not raise


# ── The sequence the Settings card actually issues ───────────────────────────
# Not a duplicate of the existing /api/keys coverage (test_agent_id_trust proves
# a key authenticates the proxy; test_rbac proves a viewer cannot mint one).
# What is pinned here is the CONTRACT THE UI DEPENDS ON: the full key comes back
# exactly once, and never again. The card shows it in a one-time reveal panel and
# tells the user it can never be shown again — if a later `SELECT *` refactor put
# the secret back into the list response, that promise would quietly become false
# and the key would start appearing in every dashboard render.

def test_the_full_key_is_returned_once_and_never_by_the_list(client, roles):
    admin = roles["admin"]
    created = client.post("/api/keys", headers=admin["headers"],
                          json={"name": "production-support-agent", "agent_id": ""})
    assert created.status_code == 200, created.text
    full_key = created.json()["key"]
    assert full_key, "create must return the key once"

    listed = client.get("/api/keys", headers=admin["headers"])
    assert listed.status_code == 200, listed.text
    body = listed.text
    assert full_key not in body, "the full API key leaked into the list response"
    row = [k for k in listed.json()["keys"] if k["name"] == "production-support-agent"][0]
    assert "key" not in row and "key_hash" not in row
    # The card renders "never used" off this, which is the main diagnostic a
    # pilot has for "my key is set but my agent isn't sending it".
    assert row["last_used"] is None


def test_a_viewer_can_still_read_the_list_they_just_cannot_change_it(client, roles):
    """The card shows the list to everyone and hides the buttons for non-admins.
    That is only honest if GET is actually permitted — RBAC gates mutations only
    (_MUTATING_METHODS), so a viewer must get 200 here, not 403."""
    client.post("/api/keys", headers=roles["admin"]["headers"], json={"name": "shared"})
    r = client.get("/api/keys", headers=roles["viewer"]["headers"])
    assert r.status_code == 200, r.text
    assert any(k["name"] == "shared" for k in r.json()["keys"])
    assert client.post("/api/keys", headers=roles["viewer"]["headers"],
                       json={"name": "nope"}).status_code == 403
