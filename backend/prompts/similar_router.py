"""HTTP surface for prompt matching (plan section 1, "Where matching shows up").

  POST /api/prompts/similar                  a draft (typed or pasted) -> matches
  GET  /api/prompts/{prompt_id}/similar      the Similar prompts row, signed in
  GET  /api/public/prompts/{prompt_id}/similar
                                             the same row on a public share page;
                                             public, published candidates only

Mounted in main.py BEFORE prompts.router so these paths are never read as a
prompt id by GET /api/prompts/{prompt_id}.

POST /similar is limited per user (RATE_LIMIT_PROMPT_SIMILAR_*): the page asks at
most about twice a second while someone types, so the default only stops scripts.
The AI second opinion on Save has its own per-org limit (similarity_judge).
"""

from __future__ import annotations

import os
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

import shared_state
from auth import get_current_user

from . import similarity, store
from .router import MAX_BODY_CHARS
from .template import VariableSpec

router = APIRouter(prefix="/api/prompts", tags=["prompts-similar"])
public_router = APIRouter(prefix="/api/public/prompts", tags=["prompts-public"])

MAX_K = 20
RATE_LIMIT_SIMILAR_MAX = int(os.getenv("RATE_LIMIT_PROMPT_SIMILAR_MAX", "120"))
RATE_LIMIT_SIMILAR_WINDOW = int(os.getenv("RATE_LIMIT_PROMPT_SIMILAR_WINDOW", "60"))


class SimilarRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=MAX_BODY_CHARS)
    title: Optional[str] = Field(default=None, max_length=200)
    description: Optional[str] = Field(default=None, max_length=2_000)
    use_case: Optional[str] = Field(default=None, max_length=80)
    variables: dict[str, VariableSpec] = Field(default_factory=dict)
    exclude_id: Optional[str] = Field(default=None, max_length=64)
    k: int = Field(default=5, ge=1, le=MAX_K)
    mode: Literal["live", "save"] = "live"


def _draft(req: SimilarRequest) -> dict:
    """The plain-JSON draft shape similarity.match_draft takes."""
    return {
        "body": req.body,
        "title": req.title or "",
        "description": req.description or "",
        "use_case": req.use_case or "",
        "variables": {n: v.model_dump(exclude_none=True) for n, v in req.variables.items()},
    }


@router.post("/similar")
def similar_draft(req: SimilarRequest, user: dict = Depends(get_current_user)):
    # DoS hygiene, like the global limiter: fail open if Redis is down.
    if not shared_state.rate_limit_ok(f"prompt-similar:{user.get('sub')}", RATE_LIMIT_SIMILAR_MAX,
                                      RATE_LIMIT_SIMILAR_WINDOW, fail_open=True):
        raise HTTPException(status_code=429, detail="That's a lot of checks in a minute. Try again shortly.")
    matches = similarity.match_draft(_draft(req), user.get("org_id"), exclude_id=req.exclude_id,
                                     k=req.k, mode=req.mode)
    return {"matches": matches}


@router.get("/{prompt_id}/similar")
def similar_to(prompt_id: str, k: int = Query(default=6, ge=1, le=MAX_K),
               user: dict = Depends(get_current_user)):
    org_id = user.get("org_id")
    if not store.get_prompt(prompt_id, org_id):   # same visibility rule as GET /api/prompts/{id}
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"matches": similarity.similar_to_prompt(prompt_id, org_id, k=k)}


@public_router.get("/{prompt_id}/similar")
def public_similar_to(prompt_id: str, k: int = Query(default=6, ge=1, le=MAX_K)):
    if not store.get_prompt(prompt_id, None):      # public + published only
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"matches": similarity.similar_to_prompt(prompt_id, None, k=k, public_only=True)}
