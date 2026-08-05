#!/usr/bin/env python3
"""Arceo Agent Security Scan — GitHub Action runtime.

Detects changed agent files, POSTs them to Arceo's /api/scan endpoint, renders
the report, posts it as a PR comment (when applicable), writes to the workflow
step summary, and exits non-zero if the verdict is "fail".

Env vars (set by action.yml):
    ARCEO_API_KEY       — required, X-API-Key header value
    ARCEO_API_URL       — base URL (default https://api.arceo.dev)
    ARCEO_THRESHOLD     — blast-radius cutoff (default 60)
    ARCEO_COMMENT_MODE  — "pr-comment" | "none"
    ARCEO_PATHS         — comma-separated file extensions
    ARCEO_MAX_FILES     — cap on files sent per run
    GITHUB_TOKEN        — for PR comment API call

GitHub-provided env (always present in Actions):
    GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_BASE_REF, GITHUB_SHA,
    GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY, GITHUB_API_URL
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────

API_KEY = os.environ.get("ARCEO_API_KEY", "").strip()
API_URL = os.environ.get("ARCEO_API_URL", "https://api.arceo.dev").rstrip("/")
THRESHOLD = int(os.environ.get("ARCEO_THRESHOLD", "60"))
COMMENT_MODE = os.environ.get("ARCEO_COMMENT_MODE", "pr-comment")
PATHS = [p.strip() for p in os.environ.get("ARCEO_PATHS", ".py,.ts,.tsx,.js,.jsx,.mjs").split(",") if p.strip()]
MAX_FILES = int(os.environ.get("ARCEO_MAX_FILES", "25"))

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_EVENT_NAME = os.environ.get("GITHUB_EVENT_NAME", "")
GITHUB_EVENT_PATH = os.environ.get("GITHUB_EVENT_PATH", "")
GITHUB_BASE_REF = os.environ.get("GITHUB_BASE_REF", "")
GITHUB_REPOSITORY = os.environ.get("GITHUB_REPOSITORY", "")
GITHUB_API_URL = os.environ.get("GITHUB_API_URL", "https://api.github.com")
GITHUB_STEP_SUMMARY = os.environ.get("GITHUB_STEP_SUMMARY", "")

# Same skip list as the backend's GitHub walker (main.py:1222)
SKIP_DIRS = {"node_modules", "venv", ".venv", "__pycache__", "dist", "build", ".git", ".next", "vendor"}

# Same LLM SDK indicators as backend (main.py:1224, 1272)
LLM_INDICATORS = (
    "anthropic", "openai", "langchain", "langgraph", "messages.create",
    "@tool", "crewai", "from mcp", "import mcp", "autogen", "llamaindex",
    "BaseCallbackHandler", "tools=", "tool_use", "function_call",
)

MAX_FILE_BYTES = 200_000  # matches backend cap


# ── File discovery ────────────────────────────────────────────────────────

def changed_files() -> list[str]:
    """Return list of files changed in this event.

    For pull_request: diff between base and HEAD.
    For push: diff of last commit. Falls back to walking the repo if git fails.
    """
    try:
        if GITHUB_EVENT_NAME == "pull_request" and GITHUB_BASE_REF:
            subprocess.run(["git", "fetch", "origin", GITHUB_BASE_REF, "--depth=1"],
                           check=False, capture_output=True)
            result = subprocess.run(
                ["git", "diff", "--name-only", f"origin/{GITHUB_BASE_REF}...HEAD"],
                capture_output=True, text=True, check=True,
            )
        else:
            result = subprocess.run(
                ["git", "diff", "--name-only", "HEAD~1..HEAD"],
                capture_output=True, text=True, check=True,
            )
        files = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if files:
            return files
    except subprocess.CalledProcessError:
        pass

    # Fallback: walk the full tree (first push, shallow clone, etc.)
    out = []
    for root, dirs, fs in os.walk("."):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in fs:
            out.append(os.path.join(root, f).lstrip("./"))
    return out


def filter_agent_files(paths: list[str]) -> list[dict]:
    """Keep only files matching extensions, not in skip dirs, with LLM indicators.

    Returns list of {path, content}.
    """
    kept: list[dict] = []
    for p in paths:
        # Skip if in any excluded directory
        parts = Path(p).parts
        if any(seg in SKIP_DIRS for seg in parts):
            continue
        # Skip if not a target extension
        if not any(p.endswith(ext) for ext in PATHS):
            continue
        try:
            content = Path(p).read_text(encoding="utf-8", errors="replace")
        except (FileNotFoundError, IsADirectoryError):
            continue
        if len(content) > MAX_FILE_BYTES:
            continue
        # Quick substring screen — backend will Haiku-extract; we don't want to send everything
        lower = content.lower()
        if not any(ind.lower() in lower for ind in LLM_INDICATORS):
            continue
        kept.append({"path": p, "content": content})
        if len(kept) >= MAX_FILES:
            break
    return kept


# ── API call ──────────────────────────────────────────────────────────────

def call_scan(files: list[dict]) -> dict:
    """POST files to /api/scan, return parsed response."""
    if not API_KEY:
        print("::error::ARCEO_API_KEY is not set", file=sys.stderr)
        sys.exit(1)

    headers = {"X-API-Key": API_KEY, "Content-Type": "application/json"}
    body = {"files": files, "threshold": THRESHOLD}
    url = f"{API_URL}/api/scan"

    try:
        status, text = _post_json(url, headers, body, timeout=120.0)
    except TransportError as e:
        print(f"::error::Failed to reach Arceo at {url}: {_clean_cmd(e)}", file=sys.stderr)
        sys.exit(1)

    if status == 401:
        print("::error::API key rejected by Arceo (401). Check ARCEO_API_KEY secret.", file=sys.stderr)
        sys.exit(1)
    if status != 200:
        print(f"::error::Arceo returned {status}: {_clean_cmd(text[:500])}", file=sys.stderr)
        sys.exit(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # httpx's resp.json() raised here too, but as an unhandled traceback in the
        # customer's log. A 200 carrying non-JSON means something sits in front of
        # the API (proxy, captive portal, error page) — say so plainly.
        print(f"::error::Arceo returned a non-JSON 200 response: {_clean_cmd(text[:300])}",
              file=sys.stderr)
        sys.exit(1)


# ── Markdown report ───────────────────────────────────────────────────────

SEVERITY_BADGE = {
    "critical": "🛑 critical",
    "high": "⚠️ high",
    "medium": "🟡 medium",
    "low": "🟢 low",
}

VERDICT_BADGE = {
    "pass": "✅ **PASS**",
    "warn": "⚠️ **WARN**",
    "fail": "🛑 **FAIL**",
}


def _clean_cmd(s) -> str:
    """Strip CR/LF so untrusted text (a response body, a scanned agent name) in a
    ::error::/::warning:: line can't inject a second workflow command (LOW-012)."""
    return str(s).replace("\r", " ").replace("\n", " ")


class TransportError(Exception):
    """The request never got an HTTP response (DNS, TCP, TLS, timeout)."""


def _post_json(url: str, headers: dict, payload: dict, timeout: float) -> tuple[int, str]:
    """POST JSON and return `(status_code, body_text)`.

    MED-018: this replaces httpx so the action has ZERO third-party dependencies.
    It runs inside the CUSTOMER's CI, holding their Arceo API key and a
    GITHUB_TOKEN, and `pip install httpx` there resolved whatever the index served
    at that moment — an unpinned, unhashed install is a supply-chain foothold in
    someone else's pipeline, for a package we use to make two JSON POSTs. Stdlib
    removes the install step entirely rather than pinning a transitive tree that
    someone then has to keep refreshing.

    urllib raises HTTPError on 4xx/5xx where httpx returns a response, so that is
    normalised back here — every existing call site branches on the status code and
    should not have to care. Genuine transport failures raise TransportError, which
    is the case the callers already handle separately. TLS verification is urllib's
    default (`ssl.create_default_context`); it is not weakened anywhere.
    """
    body = json.dumps(payload).encode()
    # httpx set Content-Type automatically for `json=`; urllib does not. Defaulting
    # it here (rather than at each call site) is what keeps the GitHub API call
    # correct — that one never set the header explicitly because it never had to.
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", **headers,
                 "Content-Length": str(len(body))},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        # A real HTTP response that happened to be an error status.
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # URLError, socket.timeout, ssl.SSLError, ...
        raise TransportError(str(e)) from e


def _md(s) -> str:
    """Escape markdown/table metacharacters in untrusted values before embedding
    them in a PR comment (LOW-013): pipes break tables, backticks break code spans,
    and CR/LF break list/table structure. Scanned repo file paths + agent names
    flow through here, so a crafted repo can't inject markdown into the comment."""
    return (str(s).replace("\\", "\\\\").replace("`", "\\`")
            .replace("|", "\\|").replace("\r", " ").replace("\n", " "))


def render_markdown(result: dict) -> str:
    """Render the scan response as PR-comment-ready markdown."""
    summary = result.get("summary", {})
    agents = result.get("agents", [])
    verdict = summary.get("verdict", "pass")

    lines: list[str] = []
    lines.append(f"## Arceo Agent Security Scan — {VERDICT_BADGE.get(verdict, verdict)}")
    lines.append("")
    lines.append(
        f"**Files scanned:** {summary.get('files_scanned', 0)}  ·  "
        f"**Agents found:** {summary.get('agents_found', 0)}  ·  "
        f"**Max blast radius:** {summary.get('max_blast_radius', 0)} / 100  ·  "
        f"**Critical chains:** {summary.get('critical_chains', 0)}  ·  "
        f"**Threshold:** {summary.get('threshold', THRESHOLD)}"
    )
    lines.append("")

    # Coverage caveat: files the scanner couldn't read at all. Shown even on a
    # pass — a clean verdict over unread files is exactly the false assurance the
    # gate exists to avoid.
    unscannable = summary.get("unscannable_files", 0)
    if unscannable:
        paths = summary.get("unscannable_paths") or []
        shown = ", ".join(f"`{_md(p)}`" for p in paths[:5])
        more = f" (+{len(paths) - 5} more)" if len(paths) > 5 else ""
        lines.append(
            f"⚠️ **{unscannable} file(s) could not be scanned** — this verdict does "
            f"not cover them: {shown}{more}"
        )
        lines.append("")

    # Why the build failed — the gate fails on distrust signals (critical chains,
    # opaque/unclassifiable capability, arbitrary code execution), NOT on raw
    # blast radius. A powerful-but-honest agent WARNs. Make the reason actionable.
    fail_reasons = summary.get("fail_reasons", [])
    if verdict == "fail" and fail_reasons:
        lines.append("**Why this failed:**")
        for r in fail_reasons:
            lines.append(f"- {_md(r)}")
        lines.append("")
    elif verdict == "warn":
        lines.append(
            "_High blast radius, but everything is classified with no critical "
            "chains or code execution — flagged for review, not blocked._")
        lines.append("")

    if not agents:
        lines.append("_No agent code detected in the scanned files._")
        return "\n".join(lines)

    # Per-agent breakdown
    for agent in agents:
        br = agent.get("blast_radius", {})
        score = br.get("score", 0)
        lines.append(f"### `{_md(agent['file'])}` — `{_md(agent['name'])}`  ·  score **{score} / 100**")
        lines.append("")

        # Risk-label counts row
        label_counts = []
        for label in ("moves_money", "touches_pii", "deletes_data", "sends_external", "changes_production"):
            n = br.get(label, 0)
            if n:
                label_counts.append(f"`{label}`: **{n}**")
        if br.get("irreversible_actions"):
            label_counts.append(f"`irreversible`: **{br['irreversible_actions']}**")
        if label_counts:
            lines.append("**Risk labels:** " + "  ·  ".join(label_counts))
            lines.append("")

        # Chains
        chains = agent.get("chains", [])
        if chains:
            lines.append("**Dangerous chains detected:**")
            lines.append("")
            lines.append("| Severity | Chain | Why it matters |")
            lines.append("|---|---|---|")
            for c in chains:
                sev = SEVERITY_BADGE.get(c["severity"], _md(c["severity"]))
                lines.append(f"| {sev} | **{_md(c['name'])}** | {_md(c['description'])} |")
            lines.append("")
        else:
            lines.append("_No dangerous chains detected for this agent._")
            lines.append("")

    # Footer
    lines.append("---")
    lines.append("_Posted by [Arceo Agent Security](https://arceo.dev). Tune the threshold or comment-mode in your workflow inputs._")
    return "\n".join(lines)


# ── PR comment ────────────────────────────────────────────────────────────

def pr_number() -> int | None:
    if not GITHUB_EVENT_PATH or not os.path.exists(GITHUB_EVENT_PATH):
        return None
    try:
        with open(GITHUB_EVENT_PATH) as f:
            event = json.load(f)
        return event.get("pull_request", {}).get("number")
    except Exception:
        return None


def post_pr_comment(body: str) -> None:
    pr = pr_number()
    if pr is None:
        return
    if not GITHUB_TOKEN or not GITHUB_REPOSITORY:
        print("::warning::GITHUB_TOKEN or GITHUB_REPOSITORY missing; skipping PR comment.", file=sys.stderr)
        return
    url = f"{GITHUB_API_URL}/repos/{GITHUB_REPOSITORY}/issues/{pr}/comments"
    try:
        status, text = _post_json(
            url,
            {
                "Authorization": f"Bearer {GITHUB_TOKEN}",
                "Accept": "application/vnd.github+json",
            },
            {"body": body},
            timeout=30.0,
        )
        if status not in (200, 201):
            print(f"::warning::PR comment failed ({status}): {_clean_cmd(text[:300])}", file=sys.stderr)
    except TransportError as e:
        print(f"::warning::PR comment request failed: {_clean_cmd(e)}", file=sys.stderr)


# ── Main ──────────────────────────────────────────────────────────────────

def main() -> int:
    paths = changed_files()
    files = filter_agent_files(paths)

    if not files:
        msg = "## Arceo Agent Security Scan — ✅ no agent code in this diff"
        if GITHUB_STEP_SUMMARY:
            Path(GITHUB_STEP_SUMMARY).write_text(msg + "\n")
        print(msg)
        return 0

    print(f"Scanning {len(files)} file(s) at {API_URL}/api/scan ...", flush=True)
    result = call_scan(files)

    markdown = render_markdown(result)
    print(markdown)

    if GITHUB_STEP_SUMMARY:
        with open(GITHUB_STEP_SUMMARY, "a") as f:
            f.write(markdown + "\n")

    if COMMENT_MODE == "pr-comment":
        post_pr_comment(markdown)

    summary = result.get("summary", {})
    verdict = summary.get("verdict", "pass")
    if verdict == "fail":
        reasons = "; ".join(summary.get("fail_reasons", [])) or "distrust signal"
        print(f"::error::Arceo verdict: FAIL — {_clean_cmd(reasons)}", file=sys.stderr)
        return 1
    if verdict == "warn":
        print(f"::warning::Arceo verdict: WARN (blast radius {summary.get('max_blast_radius', 0)} "
              f"is high but classified — no critical chain, opaque capability, or code execution)",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
