"""The Arceo GitHub App ("Connect with GitHub"), used to scan private repos.

A GitHub App rather than an OAuth App: the person installing it picks exactly
which repositories Arceo can see, the permission is read-only (Contents +
Metadata), and every token we use is a short-lived installation token. That
replaces the old choice of a server-wide token reading repos their owners
never granted (see `_github_scan_token`) or asking customers to paste a PAT.

Flow (all browser redirects, so the org binding rides in a signed cookie):
  1. POST /api/integrations/github/connect (bearer auth) → a signed start ticket.
  2. GET  /api/integrations/github/start?ticket=… sets an HttpOnly state cookie
     and redirects to GitHub's OAuth authorize page.
  3. GET  /api/integrations/github/callback?code=…&state=… exchanges the code
     for a user token and lists the installations THAT GitHub user can access.
     Only an installation on that list is linked, so a forged `installation_id`
     query parameter can't attach someone else's installation. No installation
     yet → redirect to the install page; GitHub comes back to the callback.

Env (all required for `configured()`): GITHUB_APP_ID, GITHUB_APP_SLUG,
GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY (PEM;
literal `\\n` escapes are accepted so it fits in a single-line env var).
Setup steps: docs/GITHUB_APP_SETUP.md.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from typing import Optional

import httpx
import jwt

API = "https://api.github.com"
STATE_COOKIE = "arceo_gh_state"
STATE_TTL = 15 * 60
TICKET_TTL = 2 * 60

_ENV = ("GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID",
        "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY")


class InstallationGone(Exception):
    """The installation was uninstalled or suspended on GitHub."""


class GithubAppError(Exception):
    """GitHub rejected an App call; `code` is safe to put in a redirect."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def configured() -> bool:
    return all(os.getenv(k) for k in _ENV)


def slug() -> str:
    return os.getenv("GITHUB_APP_SLUG", "")


def install_url(state: str = "") -> str:
    base = f"https://github.com/apps/{slug()}/installations/new"
    return f"{base}?state={state}" if state else base


def _private_key() -> str:
    return os.getenv("GITHUB_APP_PRIVATE_KEY", "").replace("\\n", "\n")


def app_jwt() -> str:
    now = int(time.time())
    return jwt.encode({"iat": now - 60, "exp": now + 9 * 60, "iss": os.getenv("GITHUB_APP_ID")},
                      _private_key(), algorithm="RS256")


def _headers(token: str) -> dict:
    return {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}",
            "User-Agent": "arceo", "X-GitHub-Api-Version": "2022-11-28"}


# ── Signed tickets / state (HMAC over JWT_SECRET) ────────────────────────────

def _secret() -> bytes:
    from auth import SECRET_KEY
    return hashlib.sha256(("gh-app:" + SECRET_KEY).encode()).digest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign(payload: dict, ttl: int) -> str:
    body = dict(payload, exp=int(time.time()) + ttl, n=secrets.token_hex(8))
    raw = _b64(json.dumps(body, separators=(",", ":")).encode())
    mac = _b64(hmac.new(_secret(), raw.encode(), hashlib.sha256).digest())
    return f"{raw}.{mac}"


def verify(token: str, kind: str) -> Optional[dict]:
    try:
        raw, mac = (token or "").split(".", 1)
        want = _b64(hmac.new(_secret(), raw.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(mac, want):
            return None
        body = json.loads(_unb64(raw))
    except Exception:  # noqa: BLE001 — any malformed token is simply invalid
        return None
    if body.get("k") != kind or int(body.get("exp", 0)) < time.time():
        return None
    return body


# ── Installation tokens (cached until shortly before expiry) ─────────────────

_token_cache: dict[int, tuple[str, float]] = {}
_cache_lock = threading.Lock()


async def installation_token(installation_id: int) -> str:
    with _cache_lock:
        hit = _token_cache.get(installation_id)
        if hit and hit[1] - 300 > time.time():
            return hit[0]
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(f"{API}/app/installations/{installation_id}/access_tokens",
                              headers=_headers(app_jwt()))
    if r.status_code in (403, 404):
        # 404: uninstalled. 403: suspended. Either way the link is dead.
        raise InstallationGone()
    if r.status_code != 201:
        raise GithubAppError("token_failed", f"GitHub returned {r.status_code} minting a token")
    body = r.json()
    token = body["token"]
    try:
        from datetime import datetime
        exp = datetime.fromisoformat(body["expires_at"].replace("Z", "+00:00")).timestamp()
    except Exception:  # noqa: BLE001
        exp = time.time() + 3000
    with _cache_lock:
        _token_cache[installation_id] = (token, exp)
    return token


def forget_token(installation_id: int) -> None:
    with _cache_lock:
        _token_cache.pop(installation_id, None)


# ── OAuth leg: prove which installations the connecting user can access ─────

async def exchange_code(code: str) -> str:
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post("https://github.com/login/oauth/access_token", headers={"Accept": "application/json"},
                              data={"client_id": os.getenv("GITHUB_APP_CLIENT_ID"),
                                    "client_secret": os.getenv("GITHUB_APP_CLIENT_SECRET"),
                                    "code": code})
    try:
        body = r.json()
    except ValueError:
        body = {}
    token = body.get("access_token")
    if r.status_code != 200 or not token:
        raise GithubAppError("oauth_failed", body.get("error") or f"status {r.status_code}")
    return token


async def user_installations(user_token: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(f"{API}/user/installations?per_page=100", headers=_headers(user_token))
    if r.status_code != 200:
        raise GithubAppError("installations_failed", f"status {r.status_code}")
    out = []
    for inst in r.json().get("installations", []) or []:
        acct = inst.get("account") or {}
        out.append({"id": int(inst["id"]), "account": acct.get("login", ""),
                    "account_type": acct.get("type", ""),
                    "repository_selection": inst.get("repository_selection", "")})
    return out


async def installation_repos(installation_id: int, cap: int = 300) -> list[dict]:
    token = await installation_token(installation_id)
    repos: list[dict] = []
    async with httpx.AsyncClient(timeout=20.0) as client:
        page = 1
        while len(repos) < cap:
            r = await client.get(f"{API}/installation/repositories?per_page=100&page={page}",
                                 headers=_headers(token))
            if r.status_code in (401, 403, 404):
                forget_token(installation_id)
                raise InstallationGone()
            if r.status_code != 200:
                raise GithubAppError("repos_failed", f"status {r.status_code}")
            batch = r.json().get("repositories", []) or []
            for repo in batch:
                repos.append({"full_name": repo.get("full_name"), "private": bool(repo.get("private")),
                              "default_branch": repo.get("default_branch"),
                              "pushed_at": repo.get("pushed_at") or "",
                              "description": repo.get("description") or ""})
            if len(batch) < 100:
                break
            page += 1
    repos.sort(key=lambda x: x["pushed_at"], reverse=True)
    return repos[:cap]
