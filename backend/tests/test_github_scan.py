"""The whole-repo GitHub scan: URL parsing, credential choice, error mapping,
tenant-safe agent ids, and the NDJSON stream. GitHub is a MockTransport and
the extractor is a fake Anthropic client, so nothing leaves the process."""

import json
import re
import types
import uuid

import httpx
import pytest

import github_scan
import main


# ── URL parsing ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("url,expected", [
    ("https://github.com/acme/bot", ("acme", "bot", None, None)),
    ("https://github.com/acme/bot/", ("acme", "bot", None, None)),
    ("https://github.com/acme/bot.git", ("acme", "bot", None, None)),
    ("http://www.github.com/acme/bot", ("acme", "bot", None, None)),
    ("github.com/acme/bot", ("acme", "bot", None, None)),
    ("https://github.com/acme/bot?tab=readme-ov-file", ("acme", "bot", None, None)),
    ("https://github.com/acme/bot#readme", ("acme", "bot", None, None)),
    ("git@github.com:acme/bot.git", ("acme", "bot", None, None)),
    ("https://github.com/acme/bot/tree/dev", ("acme", "bot", "dev", None)),
    ("https://github.com/acme/bot/tree/dev/agents/support", ("acme", "bot", "dev", "agents/support")),
    ("https://github.com/acme/bot/blob/main/src/agent.py", ("acme", "bot", "main", "src/agent.py")),
])
def test_parse_accepts_what_people_paste(url, expected):
    assert github_scan.parse_github_url(url) == expected


@pytest.mark.parametrize("url", [
    "", "https://gitlab.com/acme/bot", "https://github.com/acme", "not a url",
    "https://github.com/ac%me/bot", "https://github.com/acme/b@d",
])
def test_parse_rejects_non_repos(url):
    assert github_scan.parse_github_url(url) is None


# ── Harness ──────────────────────────────────────────────────────────────────

class _FakeMessages:
    """Stands in for the Anthropic client. A file declares its agent with an
    `AGENT_NAME=<name>` marker; no marker means no tools (→ skipped)."""

    def __init__(self):
        self.messages = self

    def create(self, **kw):
        content = kw["messages"][0]["content"]
        m = re.search(r"AGENT_NAME=([\w-]+)", content)
        body = ({"name": m.group(1), "model": "claude-haiku-4-5",
                 "tools": [{"name": "stripe", "actions": [{"name": "create_refund"}]}]}
                if m else {"name": "nothing", "tools": []})
        return types.SimpleNamespace(content=[types.SimpleNamespace(text=json.dumps(body))],
                                     stop_reason="end_turn")


@pytest.fixture()
def fake_llm(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setattr(main, "anthropic_client", lambda key: _FakeMessages())


def _mock_github(monkeypatch, files: dict, *, meta=None, tree_status=200, repo_status=200,
                 repo_headers=None, seen=None):
    """files: path → text. Every request URL is appended to `seen`."""
    meta = {"default_branch": "trunk", "private": False, **(meta or {})}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if seen is not None:
            seen.append((url, request.headers.get("authorization")))
        if "/git/trees/" in url:
            if tree_status != 200:
                return httpx.Response(tree_status, json={})
            return httpx.Response(200, json={"tree": [
                {"type": "blob", "path": p, "size": len(t)} for p, t in files.items()]})
        if "/contents/" in url or "raw.githubusercontent.com" in url:
            for p, t in files.items():
                if url.split("?")[0].endswith("/" + p):
                    return httpx.Response(200, text=t)
            return httpx.Response(404)
        if re.search(r"api\.github\.com/repos/[^/]+/[^/]+$", url):
            if repo_status != 200:
                return httpx.Response(repo_status, json={}, headers=repo_headers or {})
            return httpx.Response(200, json=meta)
        return httpx.Response(404)

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda *a, **k: real(transport=httpx.MockTransport(handler), timeout=k.get("timeout")))


def _scan(client, headers, url, **extra):
    return client.post("/api/authority/agents/extract-github", headers=headers, json={"url": url, **extra})


AGENT = "import anthropic\n# AGENT_NAME={}\n"


# ── Behaviour ────────────────────────────────────────────────────────────────

def test_default_branch_comes_from_the_repo(client, roles, fake_llm, monkeypatch):
    seen = []
    _mock_github(monkeypatch, {"agent.py": AGENT.format("x")}, seen=seen)
    r = _scan(client, roles["admin"]["headers"], "https://github.com/acme/bot")
    assert r.status_code == 200, r.text
    assert r.json()["branch"] == "trunk"
    assert any("/git/trees/trunk" in u for u, _ in seen)


def test_tree_url_scans_only_that_folder_on_that_branch(client, roles, fake_llm, monkeypatch):
    slug = f"folder-{uuid.uuid4().hex[:6]}"
    seen = []
    _mock_github(monkeypatch, {
        "agents/support/agent.py": AGENT.format(slug),
        "other/agent.py": AGENT.format("elsewhere"),
    }, seen=seen)
    r = _scan(client, roles["admin"]["headers"], "https://github.com/acme/bot/tree/dev/agents/support")
    body = r.json()
    assert r.status_code == 200, r.text
    assert body["branch"] == "dev"
    assert [x["path"] for x in body["results"]] == ["agents/support/agent.py"]


def test_same_scan_name_collision_does_not_overwrite(client, roles, fake_llm, monkeypatch):
    slug = f"twin-{uuid.uuid4().hex[:6]}"
    _mock_github(monkeypatch, {"a/agent.py": AGENT.format(slug), "b/tools.py": AGENT.format(slug)})
    body = _scan(client, roles["admin"]["headers"], "https://github.com/acme/bot").json()
    ids = sorted(x["agent_id"] for x in body["results"])
    assert len(set(ids)) == 2, ids
    assert body["agents_registered"] == 2


def test_another_workspace_owning_the_name_is_not_a_failure(client, two_orgs, fake_llm, monkeypatch):
    """The open demo gives every visitor a fresh tenant; the second visitor to
    scan the same public repo used to get 'already exists in another workspace'
    on every file."""
    slug = f"shared-{uuid.uuid4().hex[:6]}"
    _mock_github(monkeypatch, {"agent.py": AGENT.format(slug)})
    a = _scan(client, two_orgs["org_a"]["headers"], "https://github.com/acme/bot").json()
    b = _scan(client, two_orgs["org_b"]["headers"], "https://github.com/acme/bot").json()
    b_again = _scan(client, two_orgs["org_b"]["headers"], "https://github.com/acme/bot").json()

    assert a["results"][0]["status"] == "registered" and a["results"][0]["agent_id"] == slug
    assert b["results"][0]["status"] == "registered", b
    assert b["results"][0]["agent_id"].startswith(slug + "-")
    # A rescan in the same workspace updates, it doesn't mint yet another id.
    assert b_again["results"][0]["agent_id"] == b["results"][0]["agent_id"]


def test_non_agent_files_are_skipped_with_a_readable_reason(client, roles, fake_llm, monkeypatch):
    _mock_github(monkeypatch, {"client.py": "import openai\n"})
    body = _scan(client, roles["admin"]["headers"], "https://github.com/acme/bot").json()
    assert body["results"][0]["status"] == "skipped"
    assert body["results"][0]["error"] == "No agent tools found in this file"


def test_missing_repo_explains_private_possibility(client, roles, fake_llm, monkeypatch):
    _mock_github(monkeypatch, {}, repo_status=404)
    r = _scan(client, roles["admin"]["headers"], "https://github.com/acme/nope")
    assert r.status_code == 404
    assert "private" in r.json()["detail"]


def test_a_real_rate_limit_is_a_429(client, roles, fake_llm, monkeypatch):
    _mock_github(monkeypatch, {}, repo_status=403, repo_headers={"x-ratelimit-remaining": "0"})
    r = _scan(client, roles["admin"]["headers"], "https://github.com/acme/bot")
    assert r.status_code == 429
    assert "rate limit" in r.json()["detail"]


def test_a_403_that_isnt_a_rate_limit_is_not_reported_as_one(client, roles, fake_llm, monkeypatch):
    _mock_github(monkeypatch, {}, repo_status=403, repo_headers={"x-ratelimit-remaining": "4000"})
    r = _scan(client, roles["admin"]["headers"], "https://github.com/acme/bot")
    assert r.status_code == 403
    assert "rate limit" not in r.json()["detail"]


def test_github_unreachable_is_a_502_not_a_500(client, roles, fake_llm, monkeypatch):
    def boom(request):
        raise httpx.ConnectError("down")
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda *a, **k: real(transport=httpx.MockTransport(boom), timeout=k.get("timeout")))
    r = _scan(client, roles["admin"]["headers"], "https://github.com/acme/bot")
    assert r.status_code == 502


def test_unknown_branch_is_named(client, roles, fake_llm, monkeypatch):
    _mock_github(monkeypatch, {}, tree_status=404)
    r = _scan(client, roles["admin"]["headers"], "https://github.com/acme/bot", branch="nope")
    assert r.status_code == 404
    assert "nope" in r.json()["detail"]


def test_private_repo_is_never_read_with_the_server_token(client, roles, fake_llm, monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "server-wide")
    _mock_github(monkeypatch, {"agent.py": AGENT.format("secret")}, meta={"private": True})
    r = _scan(client, roles["admin"]["headers"], "https://github.com/acme/private")
    assert r.status_code == 403
    assert "Connect GitHub" in r.json()["detail"]


def test_missing_model_key_fails_before_touching_github(client, roles, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    seen = []
    _mock_github(monkeypatch, {"agent.py": AGENT.format("x")}, seen=seen)
    r = _scan(client, roles["admin"]["headers"], "https://github.com/acme/bot")
    assert r.status_code == 503
    assert seen == []


def test_bad_url_is_a_400(client, roles, fake_llm):
    r = _scan(client, roles["admin"]["headers"], "https://gitlab.com/acme/bot")
    assert r.status_code == 400


def test_stream_emits_ordered_events(client, roles, fake_llm, monkeypatch):
    slug = f"stream-{uuid.uuid4().hex[:6]}"
    _mock_github(monkeypatch, {"agent.py": AGENT.format(slug), "util.py": "x = 1\n"})
    r = client.post("/api/authority/agents/extract-github/stream", headers=roles["admin"]["headers"],
                    json={"url": "https://github.com/acme/bot"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ndjson")
    events = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    kinds = [e["type"] for e in events]
    assert kinds[0] == "stage" and kinds[-1] == "done"
    stages = [e["stage"] for e in events if e["type"] == "stage"]
    assert stages == ["resolving", "listing", "fetching", "extracting"]
    assert any(e["type"] == "repo" and e["branch"] == "trunk" for e in events)
    registered = [e for e in events if e["type"] == "file" and e["status"] == "registered"]
    assert registered and registered[0]["agent_id"] == slug


def test_stream_reports_github_errors_as_a_terminal_event(client, roles, fake_llm, monkeypatch):
    _mock_github(monkeypatch, {}, repo_status=404)
    r = client.post("/api/authority/agents/extract-github/stream", headers=roles["admin"]["headers"],
                    json={"url": "https://github.com/acme/nope"})
    events = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    assert events[-1]["type"] == "error"
    assert events[-1]["code"] == "not_found_or_private"


def test_viewers_cannot_scan(client, roles, fake_llm):
    r = client.post("/api/authority/agents/extract-github/stream", headers=roles["viewer"]["headers"],
                    json={"url": "https://github.com/acme/bot"})
    assert r.status_code == 403
