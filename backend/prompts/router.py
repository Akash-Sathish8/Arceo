"""HTTP surface for the prompt library.

Arceo's first APIRouter: main.py stays a single `include_router`. Phase 1 is
the stateless scorer, prompt text in, cost + danger out, nothing stored.
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import shared_state
from auth import get_current_user

from .cost import score_cost
from .danger import score_danger
from .template import VariableSpec, variables_in

router = APIRouter(prefix="/api/prompts", tags=["prompts"])

# Scoring can make up to one free count_tokens call per Anthropic model, so it
# gets its own budget rather than riding the general API limit.
RATE_LIMIT_SCORE_MAX = int(os.getenv("RATE_LIMIT_PROMPT_SCORE_MAX", "60"))
RATE_LIMIT_SCORE_WINDOW = int(os.getenv("RATE_LIMIT_PROMPT_SCORE_WINDOW", "60"))
MAX_BODY_CHARS = 100_000
MAX_MODELS = 12


class ScoreRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=MAX_BODY_CHARS)
    variables: dict[str, VariableSpec] = Field(default_factory=dict)
    expected_output_tokens: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    models: Optional[list[str]] = Field(default=None, max_length=MAX_MODELS)
    tools: list[str] = Field(default_factory=list, max_length=50)


def _org(user: dict) -> Optional[str]:
    return user.get("org_id")


@router.post("/score")
def score_prompt(req: ScoreRequest, user: dict = Depends(get_current_user)):
    """Cost per run (per model) and danger score for one prompt template."""
    if not shared_state.rate_limit_ok(f"prompt-score:{user.get('sub')}",
                                      RATE_LIMIT_SCORE_MAX, RATE_LIMIT_SCORE_WINDOW):
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")
    unknown = sorted(set(req.variables) - set(variables_in(req.body)))
    return {
        "variables": variables_in(req.body),
        "unknown_variables": unknown,
        "cost": score_cost(req.body, req.variables,
                           expected_output_tokens=req.expected_output_tokens,
                           models=req.models, org_id=_org(user)),
        "danger": score_danger(req.body, req.variables, tools=req.tools),
    }
