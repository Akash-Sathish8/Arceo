"""MED-009 + MED-012 — two unbounded reads.

MED-009: the body-size guard checked `Content-Length` and nothing else, so a
  chunked request (or one that simply omits the header) walked straight past the
  12MB cap — which is exactly what a client sending an oversized body would do.
MED-012: the repo scanner read each candidate file with `r.text` and no ceiling,
  so one crafted multi-GB blob could exhaust the worker before anything measured
  it. The branch name was also interpolated into a raw.githubusercontent.com URL
  unvalidated.
"""

from __future__ import annotations

import pytest

import main


# ── MED-009: the cap follows the bytes, not the header ────────────────────────

def test_declared_oversize_is_rejected_up_front(client):
    """Still the cheap path — reject before a byte of body arrives."""
    r = client.post("/api/auth/login", headers={"Content-Length": str(main.MAX_BODY_BYTES + 1)},
                    content=b"{}")
    assert r.status_code == 413


def test_chunked_oversize_is_rejected(client, monkeypatch):
    """The bypass: no Content-Length at all. httpx sends a generator body with
    Transfer-Encoding: chunked, so the old guard saw nothing to check."""
    monkeypatch.setattr(main, "MAX_BODY_BYTES", 2048)

    def _chunks():
        for _ in range(8):
            yield b"x" * 512  # 4096 total, past the 2048 cap

    r = client.post("/api/ingest/generic", content=_chunks())
    assert r.status_code == 413, r.text
    assert "too large" in r.json()["detail"].lower()


def test_chunked_body_under_the_cap_still_works(client, monkeypatch):
    """The guard must not break ordinary chunked requests."""
    monkeypatch.setattr(main, "MAX_BODY_BYTES", 1024 * 1024)

    def _chunks():
        yield b'{"agent_id": "x", '
        yield b'"steps": []}'

    r = client.post("/api/ingest/generic", content=_chunks())
    assert r.status_code != 413, r.text


def test_unparseable_content_length_falls_through_to_the_counter(client, monkeypatch):
    """A junk header used to be swallowed by `except ValueError: pass` and then
    nothing else checked. Now the byte counter still applies."""
    monkeypatch.setattr(main, "MAX_BODY_BYTES", 512)
    r = client.post("/api/ingest/generic", headers={"Content-Length": "not-a-number"},
                    content=b"y" * 4096)
    # Starlette may reject the malformed header itself; either way it must not be
    # a success, and must never reach a handler with an over-cap body.
    assert r.status_code in (400, 413, 422), r.text


# ── MED-012: per-file and whole-scan byte ceilings ────────────────────────────

def test_byte_caps_are_configured_sanely():
    assert 0 < main.GITHUB_MAX_FILE_BYTES <= 8 * 1024 * 1024
    assert main.GITHUB_MAX_SCAN_BYTES >= main.GITHUB_MAX_FILE_BYTES


@pytest.mark.parametrize("ref", ["main", "release/1.2", "feature_x", "v1.0.0", "a-b.c/d"])
def test_valid_refs_are_accepted(ref):
    assert main._valid_git_ref(ref) is True


@pytest.mark.parametrize("ref", [
    "../../etc/passwd",       # traversal
    "/absolute",              # anchors elsewhere
    "main\nInjected",         # control chars in a URL
    "main with spaces",
    "branch?query=1",
    "branch#frag",
    "",                       # empty
    "x" * 300,                # absurd length
])
def test_hostile_refs_are_rejected(ref):
    assert main._valid_git_ref(ref) is False


def test_extract_github_rejects_a_bad_branch(client, roles):
    r = client.post("/api/authority/agents/extract-github", headers=roles["admin"]["headers"],
                    json={"url": "https://github.com/acme/repo", "branch": "../../etc/passwd"})
    assert r.status_code == 400
    assert "branch" in r.json()["detail"].lower()


def test_oversized_repo_files_are_skipped_and_reported(client, roles, monkeypatch):
    """A crafted blob is abandoned mid-stream instead of being buffered whole, and
    the caller is told the scan didn't cover it."""
    import httpx

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(main, "GITHUB_MAX_FILE_BYTES", 1024)

    tree = {"tree": [{"type": "blob", "path": "huge_agent.py"},
                     {"type": "blob", "path": "small_agent.py"}]}

    def _handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "api.github.com" in url:
            return httpx.Response(200, json=tree)
        if "huge_agent.py" in url:
            # 64KB of agent-looking content — well past the 1KB cap.
            return httpx.Response(200, text="import anthropic\n" + ("# pad\n" * 10_000))
        return httpx.Response(200, text="nothing interesting here")

    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda *a, **k: real(transport=httpx.MockTransport(_handler), timeout=k.get("timeout")))

    r = client.post("/api/authority/agents/extract-github", headers=roles["admin"]["headers"],
                    json={"url": "https://github.com/acme/repo"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["truncated"] is True
    assert any("per-file limit" in n for n in body["scan_notes"]), body["scan_notes"]
    # The oversized file was never registered as an agent.
    assert all(res["path"] != "huge_agent.py" for res in body["results"])


def test_openai_agents_sdk_files_are_detected(client, roles, monkeypatch):
    """An OpenAI Agents SDK tool file must reach extraction.

    Its only framework markers are `from agents import function_tool` and the
    `@function_tool` decorator. "@tool" is NOT a substring of "@function_tool",
    so before the indicator list carried these two strings every tool-defining
    file in an Agents SDK repo was filtered out and the scan registered only the
    plumbing around it.
    """
    import httpx

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    tree = {"tree": [{"type": "blob", "path": "airline/tools.py"},
                     {"type": "blob", "path": "airline/demo_data.py"}]}

    def _handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "api.github.com" in url:
            return httpx.Response(200, json=tree)
        if "tools.py" in url:
            return httpx.Response(200, text=(
                "from agents import RunContextWrapper, function_tool\n\n"
                "@function_tool(name_override='issue_compensation')\n"
                "async def issue_compensation(amount: int) -> str:\n"
                "    return 'issued'\n"))
        # No LLM-SDK marker anywhere — must stay filtered out.
        return httpx.Response(200, text="SEAT_MAP = {'12A': 'window'}\n")

    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda *a, **k: real(transport=httpx.MockTransport(_handler), timeout=k.get("timeout")))

    r = client.post("/api/authority/agents/extract-github", headers=roles["admin"]["headers"],
                    json={"url": "https://github.com/openai/openai-cs-agents-demo"})
    assert r.status_code == 200, r.text
    body = r.json()
    scanned = {res["path"] for res in body["results"]}
    assert "airline/tools.py" in scanned, body
    assert "airline/demo_data.py" not in scanned, body
