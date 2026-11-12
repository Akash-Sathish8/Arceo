"""HTTP surface for sending prompts to a person's coding agent (plan section 5).

  GET     /api/prompts/agent-tokens          your connections (never the secret)
  POST    /api/prompts/agent-tokens          {label} -> {id, label, token, created_at}
                                             the plain `ap_...` key, shown ONCE
  DELETE  /api/prompts/agent-tokens/{id}     turn off one of YOUR connections
  POST    /api/prompts/{prompt_id}/send      {values} -> {id, expires_at, unfilled}
  POST    /api/prompts/sends/test            a canned "is it connected?" send for
                                             the Connect page's Test it button
  GET     /api/prompts/sends?limit=20        your recent sends: status + a short
                                             preview, never the full text

Roles: reading your own lists needs any signed-in member. Making a connection
and sending a prompt are writes, so they need the editor role, the same rule as
every other prompt write (main._rbac already 403s a viewer's POST; require_role
here keeps that true when a request also carries an X-API-Key, which _rbac
skips). Turning off one of your OWN connections needs no role: someone demoted
to viewer must still be able to switch off a key that keeps working
(main._RBAC_SELF_SERVICE lets that one DELETE through). A connection only ever
acts for the person who made it, so nobody can revoke or read anyone else's,
admins included.

Mounted in main.py BEFORE prompts.router, so GET /api/prompts/agent-tokens and
/api/prompts/sends are never read as a prompt id by GET /api/prompts/{prompt_id}.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

import shared_state
from auth import get_current_user

from . import agent_tokens, sends, store

router = APIRouter(prefix="/api/prompts", tags=["prompts-agent"])

RATE_LIMIT_TOKEN_CREATE_MAX = int(os.getenv("RATE_LIMIT_PROMPT_AGENT_TOKEN_MAX", "20"))
RATE_LIMIT_TOKEN_CREATE_WINDOW = int(os.getenv("RATE_LIMIT_PROMPT_AGENT_TOKEN_WINDOW", "3600"))
RATE_LIMIT_SEND_MAX = int(os.getenv("RATE_LIMIT_PROMPT_SEND_MAX", "30"))
RATE_LIMIT_SEND_WINDOW = int(os.getenv("RATE_LIMIT_PROMPT_SEND_WINDOW", "60"))


class TokenCreate(BaseModel):
    label: str = Field(default="", max_length=200)


class SendRequest(BaseModel):
    values: dict[str, str] = Field(default_factory=dict)


def _require_editor(user: dict) -> None:
    from main import require_role
    require_role(user, "editor")


def _limit(key: str, limit: int, window: int, message: str) -> None:
    if not shared_state.rate_limit_ok(key, limit, window):
        raise HTTPException(status_code=429, detail=message)


def _queue(user: dict, prompt_id, title, text) -> dict:
    try:
        return sends.create(user["sub"], user.get("org_id"), prompt_id, title, text)
    except sends.SendError as e:
        raise HTTPException(status_code=e.status, detail=str(e))


# ── connections ──────────────────────────────────────────────────────────

@router.get("/agent-tokens")
def list_agent_tokens(user: dict = Depends(get_current_user)):
    return {"tokens": agent_tokens.list_for_user(user["sub"], user.get("org_id"))}


@router.post("/agent-tokens")
def create_agent_token(req: TokenCreate, user: dict = Depends(get_current_user)):
    _require_editor(user)
    _limit(f"prompt-agent-token:{user.get('sub')}", RATE_LIMIT_TOKEN_CREATE_MAX, RATE_LIMIT_TOKEN_CREATE_WINDOW,
           "You've made a lot of connections in the last hour. Try again later.")
    try:
        return agent_tokens.create(user["sub"], user.get("org_id"), req.label, email=user.get("email"))
    except agent_tokens.LimitReached:
        raise HTTPException(status_code=409, detail=(
            f"You have {agent_tokens.MAX_ACTIVE_PER_USER} agent connections. "
            "Turn one off before adding another."))


@router.delete("/agent-tokens/{token_id}")
def revoke_agent_token(token_id: str = Path(..., max_length=64), user: dict = Depends(get_current_user)):
    # No role check: it only ever turns off the caller's own key (agent_tokens.revoke).
    row = agent_tokens.revoke(token_id, user["sub"], user.get("org_id"), email=user.get("email"))
    if row is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    return row


# ── the inbox ────────────────────────────────────────────────────────────

@router.get("/sends")
def list_sends(limit: int = Query(default=20, ge=1, le=sends.MAX_LISTED), user: dict = Depends(get_current_user)):
    return {"sends": sends.list_recent(user["sub"], user.get("org_id"), limit)}


@router.post("/sends/test")
def send_test(user: dict = Depends(get_current_user)):
    """A harmless canned prompt, so the Connect page can check an agent picks things up."""
    _require_editor(user)
    _limit(f"prompt-send:{user.get('sub')}", RATE_LIMIT_SEND_MAX, RATE_LIMIT_SEND_WINDOW,
           "That's a lot of sends in a minute. Try again shortly.")
    return {**_queue(user, None, sends.TEST_TITLE, sends.TEST_TEXT), "unfilled": []}


@router.post("/{prompt_id}/send")
def send_prompt(req: SendRequest, prompt_id: str = Path(..., max_length=64),
                user: dict = Depends(get_current_user)):
    """Fill in a prompt the caller can see and queue it for their connected agent (kept 24 hours)."""
    _require_editor(user)
    _limit(f"prompt-send:{user.get('sub')}", RATE_LIMIT_SEND_MAX, RATE_LIMIT_SEND_WINDOW,
           "That's a lot of sends in a minute. Try again shortly.")
    try:
        sends.check_values(req.values)
    except sends.SendError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    p = store.get_prompt(prompt_id, user.get("org_id"))   # same visibility as GET /api/prompts/{id}
    if not p:
        raise HTTPException(status_code=404, detail="Prompt not found")
    try:
        text = sends.fill_checked(p["body"], req.values)    # sized before it's built
    except sends.SendError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    out = _queue(user, prompt_id, p.get("title"), text)
    sends.count_use(prompt_id, user["sub"])   # one use per 10 min, shared with /use
    return {**out, "unfilled": sends.unfilled(p["body"], req.values)}
