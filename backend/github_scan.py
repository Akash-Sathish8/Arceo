"""Whole-repo GitHub scan: find the agent files in a repo and hand each to the
extractor, reporting progress as a stream of events.

`scan_events` is an async generator shared by the JSON endpoint (which gathers
the events into one response) and the NDJSON streaming endpoint (which forwards
them as they happen so the dashboard can show live progress). It knows nothing
about the database or Anthropic: the caller passes an `extract` coroutine and the
ordered list of credentials to try.

Event shapes (every event has a `type`):
  stage    {stage: resolving|listing|fetching|extracting}
  repo     {owner, repo, branch, private, subpath, auth}
  listed   {candidates_total, candidates_scanned}
  progress {done, total, agent_files}           (while fetching)
  file     {path, status: queued|registered|skipped|failed, ...}
  done     {...summary, results}
  error    {status, code, detail}               (terminal)
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import AsyncIterator, Awaitable, Callable, Optional
from urllib.parse import quote

import httpx

logger = logging.getLogger("arceo.github_scan")

GITHUB_API = "https://api.github.com"
GITHUB_RAW = "https://raw.githubusercontent.com"

CANDIDATE_SCAN_CAP = 300
FETCH_CONCURRENCY = 8
EXTRACT_CONCURRENCY = 5

SKIP_DIRS = ("node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".git",
             ".next", "vendor", "site-packages")
VALID_EXT = ("py", "ts", "tsx", "js", "jsx", "mjs")
INDICATORS = tuple(s.lower() for s in (
    "anthropic", "openai", "langchain", "messages.create", "chat.completions.create",
    "@tool", "ChatAnthropic", "ChatOpenAI",
    # Frameworks/providers the original list missed — a file that only uses
    # one of these was filtered out and never extracted.
    "bedrock", "vertex", "vertexai", "litellm", "gemini", "google.generativeai",
    "genai", "crewai", "autogen", "llama_index", "llamaindex",
    # OpenAI Agents SDK. Its tool files import `from agents import
    # function_tool` and decorate with `@function_tool` — "@tool" is not a
    # substring of "@function_tool", so without these every tool-defining file
    # in an Agents SDK repo was filtered out.
    "function_tool", "from agents import",
    "modelcontextprotocol", "fastmcp", "mcp.server",
))
# Paths that look like agent code are read first, so the max_files budget is
# spent on the likeliest files rather than on whatever sorts first.
_PRIORITY_HINTS = ("agent", "tool", "bot", "assistant", "crew", "graph", "chain", "mcp")
_DEPRIORITIZE = ("test", "spec", "example", "docs/", "scripts/", "migrations/")

# A branch name lands inside a URL. Left unvalidated, a caller-supplied ref could
# carry path traversal or control characters and steer the fetch elsewhere.
_GIT_REF_RE = re.compile(r"^[A-Za-z0-9._/-]{1,255}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")


def valid_git_ref(ref: str) -> bool:
    return bool(_GIT_REF_RE.match(ref)) and ".." not in ref and not ref.startswith("/")


def parse_github_url(url: str) -> Optional[tuple[str, str, Optional[str], Optional[str]]]:
    """(owner, repo, ref, subpath) from anything a person is likely to paste, or
    None if it isn't a GitHub repo.

    Accepts `https://github.com/o/r`, `www.`, no scheme, `.git`, a trailing slash,
    `?tab=...` / `#readme`, `git@github.com:o/r.git`, and `/tree/<ref>/<dir>` or
    `/blob/<ref>/<file>`. The ref is taken as ONE path segment: a branch with a
    slash in its name (`release/1.2`) can't be told apart from a folder in a URL,
    so those go in the separate branch field.
    """
    s = (url or "").strip()
    if not s:
        return None
    ssh = re.match(r"^git@github\.com:([^/]+)/([^/]+?)(?:\.git)?/?$", s)
    if ssh:
        owner, repo = ssh.group(1), ssh.group(2)
        return (owner, repo, None, None) if _NAME_RE.match(owner) and _NAME_RE.match(repo) else None
    s = re.sub(r"^(?:https?://)?(?:www\.)?", "", s, flags=re.I)
    if not s.lower().startswith("github.com/"):
        return None
    s = s[len("github.com/"):]
    s = re.split(r"[?#]", s, maxsplit=1)[0]
    parts = [p for p in s.split("/") if p]
    if len(parts) < 2:
        return None
    owner, repo = parts[0], parts[1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not (_NAME_RE.match(owner) and _NAME_RE.match(repo)):
        return None
    ref = subpath = None
    if len(parts) >= 4 and parts[2] in ("tree", "blob"):
        ref = parts[3]
        rest = "/".join(parts[4:])
        subpath = rest or None
    return owner, repo, ref, subpath


@dataclass
class ScanAuth:
    token: Optional[str]
    source: str  # "app" | "org" | "server" | "none"
    label: str = ""

    def headers(self) -> dict:
        h = {"Accept": "application/vnd.github+json", "User-Agent": "arceo-scanner",
             "X-GitHub-Api-Version": "2022-11-28"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h


class _ScanError(Exception):
    def __init__(self, status: int, code: str, detail: str):
        super().__init__(detail)
        self.status, self.code, self.detail = status, code, detail


def _rate_limited(r: httpx.Response) -> bool:
    if r.status_code == 429:
        return True
    return r.status_code == 403 and r.headers.get("x-ratelimit-remaining") == "0"


def _rate_limit_error(r: httpx.Response, auth: ScanAuth) -> _ScanError:
    reset = r.headers.get("x-ratelimit-reset")
    when = ""
    if reset and reset.isdigit():
        mins = max(1, round((int(reset) - time.time()) / 60))
        when = f" It resets in about {mins} minute{'s' if mins != 1 else ''}."
    hint = ("" if auth.source in ("app", "org")
            else " Connect GitHub to scan on your own limit instead of the shared one.")
    return _ScanError(429, "rate_limited", f"GitHub's API rate limit was hit.{when}{hint}")


def _is_skipped_dir(path: str) -> bool:
    segs = path.split("/")[:-1]
    return any(s in SKIP_DIRS for s in segs)


def _priority(path: str) -> tuple[int, str]:
    low = path.lower()
    score = 0
    if any(h in low.rsplit("/", 1)[-1] for h in _PRIORITY_HINTS):
        score -= 2
    elif any(h in low for h in _PRIORITY_HINTS):
        score -= 1
    if any(d in low for d in _DEPRIORITIZE):
        score += 2
    return score, path


def friendly_extract_error(status: int, detail: str) -> tuple[str, str]:
    """(status, reason) for a per-file extraction failure. Never a raw exception
    string: those carried SDK internals into the UI."""
    if status == 422:
        return "skipped", ("This file has too many tools to extract in one pass"
                           if "too many tools" in (detail or "") else "No agent tools found in this file")
    if status == 409:
        return "failed", detail or "Name conflict"
    if status == 502 and "invalid JSON" in (detail or ""):
        return "failed", "Couldn't read an agent definition from this file"
    if status == 400 and "too large" in (detail or "").lower():
        return "skipped", "File is too large to extract (max 200KB)"
    ref = re.search(r"ref: ([^)]+)", detail or "")
    return "failed", f"Extraction failed{f' (ref {ref.group(1)})' if ref else ''}"


Extractor = Callable[[str, str], Awaitable[dict]]


async def scan_events(
    *,
    owner: str,
    repo: str,
    branch: Optional[str],
    subpath: Optional[str],
    max_files: int,
    auths: list[ScanAuth],
    extract: Extractor,
    max_file_bytes: int,
    max_scan_bytes: int,
    app_connected: bool = False,
    app_configured: bool = False,
) -> AsyncIterator[dict]:
    t0 = time.monotonic()
    try:
        async for ev in _scan(owner, repo, branch, subpath, max_files, auths, extract,
                              max_file_bytes, max_scan_bytes, app_connected, app_configured, t0):
            yield ev
    except _ScanError as e:
        yield {"type": "error", "status": e.status, "code": e.code, "detail": e.detail}


async def _scan(owner, repo, branch, subpath, max_files, auths, extract,
                max_file_bytes, max_scan_bytes, app_connected, app_configured, t0):
    yield {"type": "stage", "stage": "resolving"}
    if not auths:
        auths = [ScanAuth(None, "none")]

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        # ── Resolve: which credential can see the repo, and its default branch ──
        meta = None
        auth = None
        forbidden = False
        for cand in auths:
            try:
                r = await client.get(f"{GITHUB_API}/repos/{owner}/{repo}", headers=cand.headers())
            except httpx.HTTPError:
                raise _ScanError(502, "github_unreachable", "Couldn't reach GitHub. Try again in a moment.")
            if r.status_code == 200:
                try:
                    meta = r.json()
                except ValueError:
                    meta = {}
                auth = cand
                break
            if _rate_limited(r):
                raise _rate_limit_error(r, cand)
            if r.status_code == 403:
                forbidden = True
            # 401 (a revoked token) / 404 (this credential can't see it): try the next.
        if meta is None:
            if forbidden:
                raise _ScanError(403, "forbidden", (
                    f"GitHub refused access to {owner}/{repo}. If the organization "
                    "enforces SAML SSO, authorize the connection for it on GitHub."))
            if app_connected:
                raise _ScanError(404, "not_in_installation", (
                    f"We couldn't find {owner}/{repo}. If it's private, add it to "
                    "Arceo's GitHub access (Manage repositories) and scan again."))
            raise _ScanError(404, "not_found_or_private", (
                f"We couldn't find {owner}/{repo}. If it's a private repo, "
                + ("connect GitHub and grant Arceo access to it." if app_configured
                   else "this workspace needs a GitHub credential with access to it.")))

        private = bool(meta.get("private"))
        if private and auth.source == "server":
            # The server's own token must never read a tenant's private repo:
            # that's a credential the repo owner never granted.
            raise _ScanError(403, "private_needs_connect", (
                f"{owner}/{repo} is private. Connect GitHub and grant Arceo access to it to scan it."))

        used_branch = branch or meta.get("default_branch") or "main"
        yield {"type": "repo", "owner": owner, "repo": repo, "branch": used_branch,
               "private": private, "subpath": subpath, "auth": auth.source}

        # ── List the tree ──
        yield {"type": "stage", "stage": "listing"}
        headers = auth.headers()
        try:
            r = await client.get(
                f"{GITHUB_API}/repos/{owner}/{repo}/git/trees/{quote(used_branch, safe='')}?recursive=1",
                headers=headers)
        except httpx.HTTPError:
            raise _ScanError(502, "github_unreachable", "Couldn't reach GitHub. Try again in a moment.")
        if _rate_limited(r):
            raise _rate_limit_error(r, auth)
        if r.status_code in (404, 409, 422):
            raise _ScanError(404, "branch_not_found", (
                f"Branch '{used_branch}' wasn't found in {owner}/{repo}."
                if r.status_code == 404 else f"{owner}/{repo} is empty."))
        if r.status_code != 200:
            raise _ScanError(502, "github_error", f"GitHub returned an unexpected error ({r.status_code}). Try again.")
        try:
            tree_data = r.json()
        except ValueError:
            raise _ScanError(502, "github_error", "GitHub returned an unreadable file list. Try again.")

        prefix = (subpath.strip("/") + "/") if subpath else ""
        candidates: list[str] = []
        oversized: list[str] = []
        single_file = False
        for item in tree_data.get("tree", []) or []:
            if item.get("type") != "blob":
                continue
            path = item.get("path", "") or ""
            if prefix:
                if path == prefix.rstrip("/"):
                    single_file = True  # /blob/<ref>/<file>: scan exactly that file
                elif not path.startswith(prefix):
                    continue
            if _is_skipped_dir(path):
                continue
            ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
            if ext not in VALID_EXT:
                continue
            size = item.get("size")
            if isinstance(size, int) and size > max_file_bytes:
                oversized.append(path)
                continue
            candidates.append(path)
        if single_file:
            candidates = [p for p in candidates if p == prefix.rstrip("/")]
        if prefix and not candidates and not oversized:
            raise _ScanError(404, "path_not_found", (
                f"No code files under '{subpath}' in {owner}/{repo}@{used_branch}."))
        candidates.sort(key=_priority)
        tree_truncated = bool(tree_data.get("truncated"))
        to_scan = candidates[:CANDIDATE_SCAN_CAP]
        yield {"type": "listed", "candidates_total": len(candidates),
               "candidates_scanned": len(to_scan)}

        # ── Fetch in ordered batches, filtering by indicator ──
        yield {"type": "stage", "stage": "fetching"}
        sem = asyncio.Semaphore(FETCH_CONCURRENCY)
        use_api = private or auth.source == "app"
        fetch_headers = dict(headers)
        if use_api:
            fetch_headers["Accept"] = "application/vnd.github.raw"

        async def fetch(path: str):
            if use_api:
                url = (f"{GITHUB_API}/repos/{owner}/{repo}/contents/{quote(path)}"
                       f"?ref={quote(used_branch, safe='')}")
            else:
                url = f"{GITHUB_RAW}/{owner}/{repo}/{quote(used_branch, safe='')}/{quote(path)}"
            async with sem:
                try:
                    async with client.stream("GET", url, headers=fetch_headers) as resp:
                        if resp.status_code != 200:
                            return path, ("ratelimit" if resp.status_code in (403, 429) else "missing"), None
                        chunks: list[bytes] = []
                        size = 0
                        # MED-012: streamed with a running byte count, so an
                        # oversized blob is abandoned mid-transfer rather than
                        # fully buffered and only then measured.
                        async for chunk in resp.aiter_bytes():
                            size += len(chunk)
                            if size > max_file_bytes:
                                return path, "oversized", None
                            chunks.append(chunk)
                        return path, "ok", b"".join(chunks)
                except httpx.HTTPError:
                    return path, "error", None

        agent_files: list[dict] = []
        scanned = fetch_errors = scan_bytes = 0
        rate_limited = budget_hit = False
        batch = FETCH_CONCURRENCY * 2
        for i in range(0, len(to_scan), batch):
            if scan_bytes >= max_scan_bytes:
                budget_hit = True
                break
            results = await asyncio.gather(*(fetch(p) for p in to_scan[i:i + batch]))
            for path, status, data in results:  # gather keeps input order
                scanned += 1
                if status == "oversized":
                    oversized.append(path)
                    continue
                if status in ("ratelimit", "error"):
                    fetch_errors += 1
                    rate_limited = rate_limited or status == "ratelimit"
                    continue
                if status != "ok" or data is None:
                    continue
                scan_bytes += len(data)
                content = data.decode("utf-8", errors="replace")
                low = content.lower()
                if not any(ind in low for ind in INDICATORS):
                    continue
                if len(agent_files) < max_files:
                    agent_files.append({"path": path, "content": content})
                    yield {"type": "file", "path": path, "status": "queued"}
            yield {"type": "progress", "done": scanned, "total": len(to_scan),
                   "agent_files": len(agent_files)}
            if len(agent_files) >= max_files:
                break

    # ── Extract concurrently, reporting each file as it lands ──
    yield {"type": "stage", "stage": "extracting"}
    results: list[dict] = []
    esem = asyncio.Semaphore(EXTRACT_CONCURRENCY)

    async def run_one(f: dict) -> dict:
        async with esem:
            try:
                out = await extract(f["content"], f["path"])
                br = out.get("blast_radius")
                score = br.get("score") if isinstance(br, dict) else br
                band = br.get("band") if isinstance(br, dict) else None
                return {"path": f["path"], "status": "registered", "agent_id": out["id"],
                        "agent_name": out.get("name") or out["id"],
                        "tools_count": out.get("tools_count", 0),
                        "actions_count": out.get("actions_count", 0),
                        "model": out.get("model") or "",
                        "blast_radius": score, "risk_band": band,
                        "created": out.get("status") == "created"}
            except _ExtractFailure as e:
                status, reason = friendly_extract_error(e.status, e.detail)
                return {"path": f["path"], "status": status, "error": reason}
            except Exception:  # noqa: BLE001 — one bad file must not end the scan
                logger.exception("repo scan: extraction crashed for %s", f["path"])
                return {"path": f["path"], "status": "failed", "error": "Extraction failed"}

    for fut in asyncio.as_completed([run_one(f) for f in agent_files]):
        res = await fut
        results.append(res)
        yield {"type": "file", **res}

    order = {f["path"]: i for i, f in enumerate(agent_files)}
    results.sort(key=lambda r: order.get(r["path"], 0))

    candidates_capped = len(candidates) > CANDIDATE_SCAN_CAP
    max_files_reached = len(agent_files) >= max_files
    notes = []
    if tree_truncated:
        notes.append("GitHub returned a partial file list for this very large repo, so some files weren't seen. Scan a subfolder for full coverage")
    if candidates_capped:
        notes.append(f"Read the first {CANDIDATE_SCAN_CAP} of {len(candidates)} code files")
    if max_files_reached:
        notes.append(f"Stopped at the {max_files}-file limit, so there may be more agents. Scan a subfolder to go deeper")
    if fetch_errors:
        notes.append(f"{fetch_errors} file(s) couldn't be downloaded"
                     + (" because GitHub's rate limit was reached" if rate_limited else ""))
    if oversized:
        shown = ", ".join(oversized[:3])
        notes.append(f"{len(oversized)} file(s) skipped over the {max_file_bytes // 1024}KB "
                     f"per-file limit: {shown}" + ("…" if len(oversized) > 3 else ""))
    if budget_hit:
        notes.append(f"Stopped at the {max_scan_bytes // (1024 * 1024)}MB download budget, so there may be more agents")
    truncated = bool(tree_truncated or candidates_capped or max_files_reached or fetch_errors
                     or oversized or budget_hit)

    yield {
        "type": "done",
        "owner": owner,
        "repo": repo,
        "branch": used_branch,
        "private": private,
        "subpath": subpath,
        "files_scanned": scanned,
        "candidates_total": len(candidates),
        "candidates_scanned": len(to_scan),
        "agents_detected": len(agent_files),
        "agents_registered": len({r["agent_id"] for r in results if r["status"] == "registered"}),
        "truncated": truncated,
        "fetch_errors": fetch_errors,
        "scan_notes": notes,
        "elapsed_ms": int((time.monotonic() - t0) * 1000),
        "results": results,
    }


class _ExtractFailure(Exception):
    """Raised by the caller's extractor for an expected per-file failure."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


ExtractFailure = _ExtractFailure
