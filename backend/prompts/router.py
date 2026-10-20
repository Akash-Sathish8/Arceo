"""HTTP surface for the prompt library.

Arceo's first APIRouters: main.py stays a single `include_router` per router.
  /api/prompts/*         signed-in: score, CRUD, publish, fork
  /api/public/prompts/*  unauthenticated, read-only: published public prompts
                         (share links and SEO for founders and agencies)
"""

from __future__ import annotations

import os
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

import shared_state
from auth import get_current_user
from analysis.spend_forecast import load_defaults
from db import get_db

from . import qa, store
from .cost import default_models, score_cost
from .danger import score_danger
from .template import VariableSpec, variables_in

router = APIRouter(prefix="/api/prompts", tags=["prompts"])
public_router = APIRouter(prefix="/api/public", tags=["prompts-public"])

# Scoring can make up to one free count_tokens call per Anthropic model, so it
# gets its own budget rather than riding the general API limit.
RATE_LIMIT_SCORE_MAX = int(os.getenv("RATE_LIMIT_PROMPT_SCORE_MAX", "60"))
RATE_LIMIT_SCORE_WINDOW = int(os.getenv("RATE_LIMIT_PROMPT_SCORE_WINDOW", "60"))
RATE_LIMIT_QA_MAX = int(os.getenv("RATE_LIMIT_PROMPT_QA_MAX", "6"))
RATE_LIMIT_QA_WINDOW = int(os.getenv("RATE_LIMIT_PROMPT_QA_WINDOW", "300"))
# A prompt that failed most of its own QA cases shouldn't be shared as reliable.
PUBLISH_MIN_RELIABILITY = float(os.getenv("ARCEO_PROMPT_PUBLISH_MIN_RELIABILITY", "0.6"))
MAX_BODY_CHARS = 100_000
MAX_MODELS = 12

Visibility = Literal["private", "org", "public"]


class ScoreRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=MAX_BODY_CHARS)
    variables: dict[str, VariableSpec] = Field(default_factory=dict)
    expected_output_tokens: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    models: Optional[list[str]] = Field(default=None, max_length=MAX_MODELS)
    tools: list[str] = Field(default_factory=list, max_length=50)


class PromptWrite(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=2_000)
    use_case: str = Field(default="", max_length=80)
    body: str = Field(..., min_length=1, max_length=MAX_BODY_CHARS)
    variables: dict[str, VariableSpec] = Field(default_factory=dict)
    tools: list[str] = Field(default_factory=list, max_length=50)
    expected_output_tokens: Optional[int] = Field(default=None, ge=0, le=1_000_000)


class PublishRequest(BaseModel):
    visibility: Visibility = "public"
    # A critical-band prompt can still be shared, but only with the author
    # explicitly accepting the risk; secrets/PII in the text never can.
    acknowledge_risk: bool = False


def _org(user: dict) -> Optional[str]:
    return user.get("org_id")


def _require_editor(user: dict) -> None:
    # Same RBAC as every other write in the product (viewer < editor < admin).
    from main import require_role
    require_role(user, "editor")


def _rate_limit(user: dict) -> None:
    if not shared_state.rate_limit_ok(f"prompt-score:{user.get('sub')}",
                                      RATE_LIMIT_SCORE_MAX, RATE_LIMIT_SCORE_WINDOW):
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")


def _score(body: str, variables: dict[str, VariableSpec], tools: list[str],
           expected_output_tokens: Optional[int], org_id: Optional[str],
           measured: Optional[dict[str, int]] = None, probe: Optional[dict] = None,
           models: Optional[list[str]] = None) -> tuple[dict, dict]:
    cost = score_cost(body, variables, expected_output_tokens=expected_output_tokens,
                      measured_output_tokens=measured, models=models, org_id=org_id)
    danger = score_danger(body, variables, tools=tools, probe=probe)
    return cost, danger


def _vars_dump(variables: dict[str, VariableSpec]) -> dict:
    return {k: v.model_dump(exclude_none=True) for k, v in variables.items()}


def _vars_load(raw) -> dict[str, VariableSpec]:
    return {k: VariableSpec(**v) for k, v in (raw or {}).items()}


# ── scoring ──────────────────────────────────────────────────────────────

@router.post("/score")
def score_prompt(req: ScoreRequest, user: dict = Depends(get_current_user)):
    """Cost per run (per model) and danger score for one prompt template."""
    _rate_limit(user)
    cost, danger = _score(req.body, req.variables, req.tools, req.expected_output_tokens,
                          _org(user), models=req.models)
    return {
        "variables": variables_in(req.body),
        "unknown_variables": sorted(set(req.variables) - set(variables_in(req.body))),
        "cost": cost,
        "danger": danger,
    }


# ── library CRUD ─────────────────────────────────────────────────────────

@router.get("")
def list_prompts(scope: Literal["all", "mine", "public"] = "all",
                 q: Optional[str] = Query(default=None, max_length=200),
                 use_case: Optional[str] = Query(default=None, max_length=80),
                 user: dict = Depends(get_current_user)):
    rows = store.list_prompts(_org(user), scope, q, use_case)
    for r in rows:
        r["owned"] = r.pop("org_id") == _org(user)
    return {"prompts": rows}


@router.post("")
def create_prompt(req: PromptWrite, user: dict = Depends(get_current_user)):
    _require_editor(user)
    _rate_limit(user)
    cost, danger = _score(req.body, req.variables, req.tools, req.expected_output_tokens, _org(user))
    pid = store.new_id("pr")
    ts = store.now()
    with get_db() as conn:
        store.insert_prompt(conn, {
            "id": pid, "org_id": _org(user), "author_id": user.get("sub"),
            "author_name": store.display_name(conn, user),
            "title": req.title, "description": req.description, "use_case": req.use_case,
            "body": req.body, "variables": _vars_dump(req.variables), "tools": req.tools,
            "expected_output_tokens": req.expected_output_tokens,
            "cost_summary": cost, "danger_summary": danger,
            "created_at": ts, "updated_at": ts,
        })
    return store.get_prompt(pid, _org(user))


@router.get("/{prompt_id}")
def get_prompt(prompt_id: str, user: dict = Depends(get_current_user)):
    p = store.get_prompt(prompt_id, _org(user))
    if not p:
        raise HTTPException(status_code=404, detail="Prompt not found")
    p["versions"] = store.list_versions(prompt_id, _org(user), p["owned"])
    return p


@router.put("/{prompt_id}")
def update_prompt(prompt_id: str, req: PromptWrite, user: dict = Depends(get_current_user)):
    _require_editor(user)
    _rate_limit(user)
    p = store.get_prompt(prompt_id, _org(user))
    if not p or not p["owned"]:
        raise HTTPException(status_code=404, detail="Prompt not found")
    cost, danger = _score(req.body, req.variables, req.tools, req.expected_output_tokens, _org(user))
    with get_db() as conn:
        store.update_prompt(conn, prompt_id, _org(user), {
            "title": req.title, "description": req.description, "use_case": req.use_case,
            "body": req.body, "variables": _vars_dump(req.variables), "tools": req.tools,
            "expected_output_tokens": req.expected_output_tokens,
            "cost_summary": cost, "danger_summary": danger,
            # Edits invalidate the last QA pass: it measured different text.
            "reliability": None, "updated_at": store.now(),
        })
    return store.get_prompt(prompt_id, _org(user))


@router.delete("/{prompt_id}")
def delete_prompt(prompt_id: str, user: dict = Depends(get_current_user)):
    _require_editor(user)
    if not store.delete_prompt(prompt_id, _org(user)):
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"deleted": prompt_id}


@router.post("/{prompt_id}/publish")
def publish_prompt(prompt_id: str, req: PublishRequest, user: dict = Depends(get_current_user)):
    """Snapshot the draft as a new immutable version and share it.

    The score is recomputed on the exact text being published, so the badge a
    reader sees always describes that version and never a stale draft score.
    """
    _require_editor(user)
    p = store.get_prompt(prompt_id, _org(user))
    if not p or not p["owned"]:
        raise HTTPException(status_code=404, detail="Prompt not found")
    variables = _vars_load(p.get("variables"))
    measured, probe, reliability = qa.latest_measurements(prompt_id, _org(user))
    if reliability is not None and reliability < PUBLISH_MIN_RELIABILITY:
        raise HTTPException(status_code=409, detail=(
            f"This prompt passed {round(reliability * 100)}% of its QA cases. "
            f"Get it to {round(PUBLISH_MIN_RELIABILITY * 100)}% or more before publishing."))
    cost, danger = _score(p["body"], variables, p.get("tools") or [], p.get("expected_output_tokens"),
                          _org(user), measured=measured, probe=probe)
    if danger["publish_blockers"]:
        raise HTTPException(status_code=409, detail=(
            "Publishing blocked: remove the API key or personal data from the prompt first."))
    if danger["band"] == "critical" and not req.acknowledge_risk:
        raise HTTPException(status_code=409, detail=(
            "This prompt scores critical. Confirm you accept the risk to publish it."))
    version = int(p.get("published_version") or 0) + 1
    ts = store.now()
    with get_db() as conn:
        store.insert_version(conn, {
            "id": store.new_id("pv"), "org_id": _org(user), "prompt_id": prompt_id, "version": version,
            "title": p["title"], "body": p["body"], "variables": p.get("variables"),
            "tools": p.get("tools"), "expected_output_tokens": p.get("expected_output_tokens"),
            "cost": cost, "danger": danger, "reliability": reliability, "created_at": ts,
        })
        store.update_prompt(conn, prompt_id, _org(user), {
            "visibility": req.visibility, "status": "published", "published_version": version,
            "cost_summary": cost, "danger_summary": danger, "updated_at": ts,
        })
    return store.get_prompt(prompt_id, _org(user))


# ── QA ───────────────────────────────────────────────────────────────────

@router.put("/{prompt_id}/tests")
def save_tests(prompt_id: str, suite: qa.QaSuite, user: dict = Depends(get_current_user)):
    _require_editor(user)
    p = store.get_prompt(prompt_id, _org(user))
    if not p or not p["owned"]:
        raise HTTPException(status_code=404, detail="Prompt not found")
    with get_db() as conn:
        store.update_prompt(conn, prompt_id, _org(user), {"tests": suite.model_dump(), "updated_at": store.now()})
    return {"tests": suite.model_dump()}


@router.post("/{prompt_id}/qa")
def run_prompt_qa(prompt_id: str, user: dict = Depends(get_current_user)):
    """Run the saved suite on real models plus canary probes, then rescore.

    Afterwards the draft's cost is MEASURED (median output tokens per model)
    and its danger score includes the probe results (status 'probed')."""
    _require_editor(user)
    if not shared_state.rate_limit_ok(f"prompt-qa:{_org(user)}", RATE_LIMIT_QA_MAX, RATE_LIMIT_QA_WINDOW):
        raise HTTPException(status_code=429, detail="Too many QA runs. Try again in a few minutes.")
    p = store.get_prompt(prompt_id, _org(user))
    if not p or not p["owned"]:
        raise HTTPException(status_code=404, detail="Prompt not found")
    suite = qa.QaSuite(**(p.get("tests") or {}))
    variables = _vars_load(p.get("variables"))
    static = score_danger(p["body"], variables, tools=p.get("tools") or [])
    try:
        result = qa.run_qa(p, suite, _org(user), static["untrusted_variables"])
    except qa.QaError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    cost, danger = _score(p["body"], variables, p.get("tools") or [], p.get("expected_output_tokens"),
                          _org(user), measured=result["measured_output_tokens"], probe=result["probe"],
                          # QA'd models first (now measured), then the usual comparison set.
                          models=list(dict.fromkeys(suite.models + default_models(load_defaults(_org(user))))))
    with get_db() as conn:
        store.update_prompt(conn, prompt_id, _org(user), {
            "reliability": result["reliability"], "cost_summary": cost, "danger_summary": danger,
            "updated_at": store.now(),
        })
    return {**result, "cost": cost, "danger": danger}


@router.get("/{prompt_id}/qa")
def get_prompt_qa(prompt_id: str, user: dict = Depends(get_current_user)):
    p = store.get_prompt(prompt_id, _org(user))
    if not p or not p["owned"]:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"runs": qa.run_history(prompt_id, _org(user))}


@router.post("/{prompt_id}/unpublish")
def unpublish_prompt(prompt_id: str, user: dict = Depends(get_current_user)):
    _require_editor(user)
    p = store.get_prompt(prompt_id, _org(user))
    if not p or not p["owned"]:
        raise HTTPException(status_code=404, detail="Prompt not found")
    with get_db() as conn:
        store.update_prompt(conn, prompt_id, _org(user),
                            {"status": "draft", "visibility": "private", "updated_at": store.now()})
    return store.get_prompt(prompt_id, _org(user))


@router.post("/{prompt_id}/fork")
def fork_prompt(prompt_id: str, user: dict = Depends(get_current_user)):
    """Copy a prompt you can read into your own org as a private draft."""
    _require_editor(user)
    src = store.get_prompt(prompt_id, _org(user))
    if not src:
        raise HTTPException(status_code=404, detail="Prompt not found")
    pid = store.new_id("pr")
    ts = store.now()
    with get_db() as conn:
        store.insert_prompt(conn, {
            "id": pid, "org_id": _org(user), "author_id": user.get("sub"),
            "author_name": store.display_name(conn, user),
            "title": f"{src['title']} (fork)", "description": src.get("description"),
            "use_case": src.get("use_case"), "body": src["body"], "variables": src.get("variables"),
            "tools": src.get("tools"), "expected_output_tokens": src.get("expected_output_tokens"),
            "parent_id": prompt_id, "cost_summary": src.get("cost_summary"),
            "danger_summary": src.get("danger_summary"), "created_at": ts, "updated_at": ts,
        })
    return store.get_prompt(pid, _org(user))


# ── public, unauthenticated ──────────────────────────────────────────────

@public_router.get("/prompts")
def public_list(q: Optional[str] = Query(default=None, max_length=200),
                use_case: Optional[str] = Query(default=None, max_length=80)):
    rows = store.list_prompts("", "public", q, use_case, limit=60)
    for r in rows:
        r.pop("org_id", None)
    return {"prompts": rows}


@public_router.get("/prompts/{prompt_id}")
def public_get(prompt_id: str):
    p = store.get_prompt(prompt_id, None)
    if not p:
        raise HTTPException(status_code=404, detail="Prompt not found")
    p.pop("org_id", None)
    return p


@public_router.get("/creators/{author_id}")
def public_creator(author_id: str):
    return store.creator_profile(author_id)
