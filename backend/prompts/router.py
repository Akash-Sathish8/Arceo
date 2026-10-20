"""HTTP surface for the prompt library.

  /api/prompts/*         signed in: score, fix, CRUD, publish, fork, QA,
                         private compare, use counter, QA budget
  /api/public/prompts/*  unauthenticated, read-only (plus the website's live
                         score box and the public use counter, both IP-limited)
"""

from __future__ import annotations

import os
import statistics
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

import shared_state
from analysis.spend_forecast import load_defaults, price_call
from auth import get_current_user
from db import get_db

from . import ai_check, qa, store
from .cost import default_models, score_cost
from .danger import score_danger
from .fixer import fix_prompt
from .template import VariableSpec, variables_in

router = APIRouter(prefix="/api/prompts", tags=["prompts"])
public_router = APIRouter(prefix="/api/public", tags=["prompts-public"])

# Scoring can make up to one free count_tokens call per Anthropic model, so it
# gets its own budget rather than riding the general API limit.
RATE_LIMIT_SCORE_MAX = int(os.getenv("RATE_LIMIT_PROMPT_SCORE_MAX", "60"))
RATE_LIMIT_SCORE_WINDOW = int(os.getenv("RATE_LIMIT_PROMPT_SCORE_WINDOW", "60"))
RATE_LIMIT_QA_MAX = int(os.getenv("RATE_LIMIT_PROMPT_QA_MAX", "6"))
RATE_LIMIT_QA_WINDOW = int(os.getenv("RATE_LIMIT_PROMPT_QA_WINDOW", "300"))
# The website's anonymous score box: generous for a person, useless for a scraper.
RATE_LIMIT_PUBLIC_SCORE_MAX = int(os.getenv("RATE_LIMIT_PUBLIC_SCORE_MAX", "20"))
RATE_LIMIT_PUBLIC_SCORE_WINDOW = int(os.getenv("RATE_LIMIT_PUBLIC_SCORE_WINDOW", "3600"))
# A prompt that failed most of its own QA cases shouldn't be shared as reliable.
PUBLISH_MIN_RELIABILITY = float(os.getenv("ARCEO_PROMPT_PUBLISH_MIN_RELIABILITY", "0.6"))
MAX_BODY_CHARS = 100_000
PUBLIC_MAX_BODY_CHARS = 8_000
MAX_MODELS = 12
# What the public score box prices: one budget, one mid, one premium model.
PUBLIC_MODELS = ("gpt-5-mini", "claude-haiku-4-5", "claude-sonnet-4-6")
PUBLIC_DEFAULT_OUTPUT = 300
PUBLIC_DEFAULT_RUNS_PER_DAY = 20

Visibility = Literal["private", "org", "public"]


class ScoreRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=MAX_BODY_CHARS)
    variables: dict[str, VariableSpec] = Field(default_factory=dict)
    expected_output_tokens: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    models: Optional[list[str]] = Field(default=None, max_length=MAX_MODELS)
    tools: list[str] = Field(default_factory=list, max_length=50)
    # When scoring a saved prompt's draft: reuse its cached AI check (if the text
    # still matches) and its "not applicable" marks, so the live badge and the
    # saved badge agree.
    prompt_id: Optional[str] = Field(default=None, max_length=64)
    dismissed: list[str] = Field(default_factory=list, max_length=100)


class FixRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=MAX_BODY_CHARS)
    variables: dict[str, VariableSpec] = Field(default_factory=dict)
    tools: list[str] = Field(default_factory=list, max_length=50)


class PromptWrite(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=2_000)
    use_case: str = Field(default="", max_length=80)
    body: str = Field(..., min_length=1, max_length=MAX_BODY_CHARS)
    variables: dict[str, VariableSpec] = Field(default_factory=dict)
    tools: list[str] = Field(default_factory=list, max_length=50)
    expected_output_tokens: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    runs_per_day: Optional[int] = Field(default=None, ge=0, le=10_000_000)
    model: Optional[str] = Field(default=None, max_length=80)
    dismissed: list[str] = Field(default_factory=list, max_length=100)


class PublishRequest(BaseModel):
    visibility: Visibility = "public"
    # A critical-band prompt can still be shared, but only with the author
    # explicitly accepting the risk; secrets/PII in the text never can.
    acknowledge_risk: bool = False


class DismissRequest(BaseModel):
    reason_id: str = Field(..., max_length=200)
    dismissed: bool = True


class CompareVariant(BaseModel):
    label: str = Field(default="", max_length=60)
    body: str = Field(..., min_length=1, max_length=MAX_BODY_CHARS)


class CompareRequest(BaseModel):
    variants: list[CompareVariant] = Field(..., min_length=2, max_length=3)
    model: Optional[str] = Field(default=None, max_length=80)


class PublicScoreRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=PUBLIC_MAX_BODY_CHARS)
    runs_per_day: int = Field(default=PUBLIC_DEFAULT_RUNS_PER_DAY, ge=1, le=1_000_000)


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


def _client_ip(request: Request) -> str:
    from main import client_ip
    return client_ip(request)


def _score(body: str, variables: dict[str, VariableSpec], tools: list[str],
           expected_output_tokens: Optional[int], org_id: Optional[str],
           measured: Optional[dict[str, int]] = None, probe: Optional[dict] = None,
           models: Optional[list[str]] = None, dismissed: Optional[list[str]] = None,
           ai: Optional[dict] = None, preferred: Optional[str] = None) -> tuple[dict, dict]:
    if models is None and preferred:
        # The author's own model is always in the table, first.
        models = list(dict.fromkeys([preferred] + default_models(load_defaults(org_id))))
    cost = score_cost(body, variables, expected_output_tokens=expected_output_tokens,
                      measured_output_tokens=measured, models=models, org_id=org_id)
    danger = score_danger(body, variables, tools=tools, probe=probe, dismissed=dismissed, ai=ai)
    return cost, danger


def _vars_dump(variables: dict[str, VariableSpec]) -> dict:
    return {k: v.model_dump(exclude_none=True) for k, v in variables.items()}


def _vars_load(raw) -> dict[str, VariableSpec]:
    return {k: VariableSpec(**v) for k, v in (raw or {}).items()}


def _owned(prompt_id: str, user: dict) -> dict:
    p = store.get_prompt(prompt_id, _org(user))
    if not p or not p["owned"]:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return p


def _rescore_saved(p: dict, org_id: Optional[str], **overrides) -> tuple[dict, dict]:
    """Score a saved prompt with everything it knows: AI check, dismissals,
    latest QA measurements, the author's model."""
    measured, probe, _ = qa.latest_measurements(p["id"], org_id)
    body, tools = p["body"], p.get("tools") or []
    return _score(body, _vars_load(p.get("variables")), tools, p.get("expected_output_tokens"), org_id,
                  measured=overrides.get("measured", measured), probe=overrides.get("probe", probe),
                  models=overrides.get("models"), dismissed=p.get("dismissed") or [],
                  ai=ai_check.cached_only(p, body, tools), preferred=p.get("model"))


# ── scoring and fixing ───────────────────────────────────────────────────

@router.post("/score")
def score_prompt(req: ScoreRequest, user: dict = Depends(get_current_user)):
    """Cost per run (per model) and danger score for one prompt template."""
    _rate_limit(user)
    ai, preferred = None, None
    if req.prompt_id:
        p = store.get_prompt(req.prompt_id, _org(user))
        if p and p["owned"]:
            ai = ai_check.cached_only(p, req.body, req.tools)
            preferred = p.get("model")
    cost, danger = _score(req.body, req.variables, req.tools, req.expected_output_tokens,
                          _org(user), models=req.models, dismissed=req.dismissed, ai=ai, preferred=preferred)
    return {
        "variables": variables_in(req.body),
        "unknown_variables": sorted(set(req.variables) - set(variables_in(req.body))),
        "cost": cost,
        "danger": danger,
    }


@router.post("/fix")
def fix(req: FixRequest, user: dict = Depends(get_current_user)):
    """'Fix it for me': a deterministic hardening rewrite, plus the score after it."""
    _rate_limit(user)
    return fix_prompt(req.body, req.variables, req.tools)


@router.get("/qa-budget")
def qa_budget(user: dict = Depends(get_current_user)):
    """Free runs left this month on Arceo's key, and which of your own keys are set."""
    return qa.budget(_org(user))


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
    ai = ai_check.run_ai_check(req.body, req.tools, _org(user))
    cost, danger = _score(req.body, req.variables, req.tools, req.expected_output_tokens, _org(user),
                          dismissed=req.dismissed, ai=ai, preferred=req.model)
    pid = store.new_id("pr")
    ts = store.now()
    with get_db() as conn:
        store.insert_prompt(conn, {
            "id": pid, "org_id": _org(user), "author_id": user.get("sub"),
            "author_name": store.display_name(conn, user),
            "title": req.title, "description": req.description, "use_case": req.use_case,
            "body": req.body, "variables": _vars_dump(req.variables), "tools": req.tools,
            "expected_output_tokens": req.expected_output_tokens, "runs_per_day": req.runs_per_day,
            "model": req.model, "dismissed": req.dismissed, "ai_check": ai,
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
    p = _owned(prompt_id, user)
    ai = ai_check.cached_or_run(p, req.body, req.tools, _org(user))
    text_changed = req.body != p["body"] or _vars_dump(req.variables) != (p.get("variables") or {})
    measured, probe, _ = (None, None, None) if text_changed else qa.latest_measurements(prompt_id, _org(user))
    cost, danger = _score(req.body, req.variables, req.tools, req.expected_output_tokens, _org(user),
                          measured=measured, probe=probe, dismissed=req.dismissed, ai=ai, preferred=req.model)
    fields = {
        "title": req.title, "description": req.description, "use_case": req.use_case,
        "body": req.body, "variables": _vars_dump(req.variables), "tools": req.tools,
        "expected_output_tokens": req.expected_output_tokens, "runs_per_day": req.runs_per_day,
        "model": req.model, "dismissed": req.dismissed, "ai_check": ai,
        "cost_summary": cost, "danger_summary": danger, "updated_at": store.now(),
    }
    if text_changed:
        # Edits to the text invalidate the last QA pass: it measured different words.
        fields["reliability"] = None
    with get_db() as conn:
        store.update_prompt(conn, prompt_id, _org(user), fields)
    return store.get_prompt(prompt_id, _org(user))


@router.delete("/{prompt_id}")
def delete_prompt(prompt_id: str, user: dict = Depends(get_current_user)):
    _require_editor(user)
    if not store.delete_prompt(prompt_id, _org(user)):
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"deleted": prompt_id}


@router.post("/{prompt_id}/dismiss")
def dismiss_reason(prompt_id: str, req: DismissRequest, user: dict = Depends(get_current_user)):
    """Mark one danger reason not applicable (or undo it). Only judgement calls
    can be dismissed; leaked secrets, personal data and attack results can't."""
    _require_editor(user)
    p = _owned(prompt_id, user)
    current = (p.get("danger_summary") or {}).get("reasons") or []
    match = next((r for r in current if r.get("id") == req.reason_id), None)
    if req.dismissed and (not match or not match.get("dismissable")):
        raise HTTPException(status_code=400, detail="That risk can't be marked not applicable.")
    dismissed = [d for d in (p.get("dismissed") or []) if d != req.reason_id]
    if req.dismissed:
        dismissed.append(req.reason_id)
    p["dismissed"] = dismissed
    cost, danger = _rescore_saved(p, _org(user))
    with get_db() as conn:
        store.update_prompt(conn, prompt_id, _org(user), {
            "dismissed": dismissed, "danger_summary": danger, "cost_summary": cost, "updated_at": store.now()})
    return store.get_prompt(prompt_id, _org(user))


@router.post("/{prompt_id}/publish")
def publish_prompt(prompt_id: str, req: PublishRequest, user: dict = Depends(get_current_user)):
    """Snapshot the draft as a new immutable version and share it.

    The score is recomputed on the exact text being published, so the badge a
    reader sees always describes that version and never a stale draft score.
    """
    _require_editor(user)
    p = _owned(prompt_id, user)
    _, _, reliability = qa.latest_measurements(prompt_id, _org(user))
    if p.get("reliability") is None:
        reliability = None  # the text changed since that QA run
    if reliability is not None and reliability < PUBLISH_MIN_RELIABILITY:
        raise HTTPException(status_code=409, detail=(
            f"This prompt worked in {round(reliability * 100)}% of its QA tests. "
            f"Get it to {round(PUBLISH_MIN_RELIABILITY * 100)}% or more before publishing."))
    cost, danger = _rescore_saved(p, _org(user))
    if danger["publish_blockers"]:
        raise HTTPException(status_code=409, detail=(
            "Publishing blocked: remove the API key or personal data from the prompt first. "
            "Fix it for me does this."))
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
    _owned(prompt_id, user)
    with get_db() as conn:
        store.update_prompt(conn, prompt_id, _org(user), {"tests": suite.model_dump(), "updated_at": store.now()})
    return {"tests": suite.model_dump()}


def _qa_rate_limit(user: dict) -> None:
    if not shared_state.rate_limit_ok(f"prompt-qa:{_org(user)}", RATE_LIMIT_QA_MAX, RATE_LIMIT_QA_WINDOW):
        raise HTTPException(status_code=429, detail="Too many runs in a few minutes. Try again shortly.")


@router.post("/{prompt_id}/qa")
def run_prompt_qa(prompt_id: str, user: dict = Depends(get_current_user)):
    """Run the saved tests (or generate them) on real models plus canary attacks,
    then rescore: cost becomes MEASURED and danger includes the attack results."""
    _require_editor(user)
    _qa_rate_limit(user)
    p = _owned(prompt_id, user)
    suite = qa.QaSuite(**(p.get("tests") or {}))
    variables = _vars_load(p.get("variables"))
    static = score_danger(p["body"], variables, tools=p.get("tools") or [], dismissed=p.get("dismissed") or [],
                          ai=ai_check.cached_only(p, p["body"], p.get("tools") or []))
    try:
        result = qa.run_qa(p, suite, _org(user), static["untrusted_variables"])
    except qa.QaError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    preferred = [p["model"]] if p.get("model") else []
    models = list(dict.fromkeys(preferred + suite.models + default_models(load_defaults(_org(user)))))
    cost, danger = _rescore_saved(p, _org(user), measured=result["measured_output_tokens"],
                                  probe=result["probe"], models=models)
    fields = {"reliability": result["reliability"], "cost_summary": cost, "danger_summary": danger,
              "updated_at": store.now()}
    if result.get("generated_suite"):
        fields["tests"] = result["generated_suite"]  # reuse the generated tests next time
    with get_db() as conn:
        store.update_prompt(conn, prompt_id, _org(user), fields)
    return {**result, "cost": cost, "danger": danger}


@router.get("/{prompt_id}/qa")
def get_prompt_qa(prompt_id: str, user: dict = Depends(get_current_user)):
    _owned(prompt_id, user)
    return {"runs": qa.run_history(prompt_id, _org(user))}


@router.post("/{prompt_id}/compare")
def compare_versions(prompt_id: str, req: CompareRequest, user: dict = Depends(get_current_user)):
    """Private A/B: 2-3 versions of a prompt on the same inputs and model, side by
    side with measured cost and danger. Nothing is published; it costs one run."""
    _require_editor(user)
    _qa_rate_limit(user)
    p = _owned(prompt_id, user)
    org = _org(user)
    try:
        (model_key, provider), = qa.resolve_models([req.model or p.get("model") or qa.DEFAULT_QA_MODEL], org)
        keys = qa.Keys(org, {provider})
        suite = qa.QaSuite(**(p.get("tests") or {}))
        samples = qa._sample_values(p)
        cases = [c for c in suite.cases][:3] or [qa.QaCase(label="your sample", values=samples)]
        defaults = load_defaults(org)
        est = 0.0
        for v in req.variants:
            row = score_cost(v.body, {}, expected_output_tokens=qa.MAX_OUTPUT_TOKENS, models=[model_key],
                             org_id=org, allow_network=False)["models"][0]
            longest = max((sum(len(x) for x in c.values.values()) for c in cases), default=0)
            est += (row["usd_per_run"] + (price_call(model_key, longest // 3 + 200, 0, defaults=defaults)["usd"] or 0)) \
                * len(cases)
        qa.check_caps(est, keys, org)
        out, total = [], 0.0
        for v in req.variants:
            outputs, ins, outs = [], [], []
            for c in cases:
                r = qa.call_model(model_key, provider, None, qa._fill(v.body, {**samples, **c.values}), org,
                                  api_key=keys.key_for(provider))
                outputs.append(r["text"])
                ins.append(r["input_tokens"])
                outs.append(r["output_tokens"])
                total += price_call(model_key, r["input_tokens"], r["output_tokens"], defaults=defaults)["usd"] or 0.0
            usd = price_call(model_key, int(statistics.median(ins)), int(statistics.median(outs)), defaults=defaults)["usd"]
            danger = score_danger(v.body, _vars_load(p.get("variables")), tools=p.get("tools") or [])
            out.append({"label": v.label, "body": v.body, "outputs": outputs,
                        "cost": {"model_key": model_key, "usd_per_run": round(usd or 0.0, 8),
                                 "output_tokens": int(statistics.median(outs)), "basis": "measured"},
                        "danger": danger})
        keys.record("compare", total)
    except qa.QaError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    return {"model": model_key, "cases": [c.model_dump() for c in cases], "variants": out,
            "usd_total": round(total, 6), "runs_per_day": p.get("runs_per_day")}


@router.post("/{prompt_id}/use")
def use_prompt(prompt_id: str, user: dict = Depends(get_current_user)):
    """Count one use (filled in, then copied or opened in a chat app). The filled
    values never reach the server; only the count does."""
    p = store.get_prompt(prompt_id, _org(user))
    if not p:
        raise HTTPException(status_code=404, detail="Prompt not found")
    if shared_state.should_fire_once(f"prompt-use:{prompt_id}:{user.get('sub')}", 600):
        store.increment_use(prompt_id)
    return {"ok": True}


@router.post("/{prompt_id}/unpublish")
def unpublish_prompt(prompt_id: str, user: dict = Depends(get_current_user)):
    _require_editor(user)
    _owned(prompt_id, user)
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
            "model": src.get("model"), "parent_id": prompt_id, "cost_summary": src.get("cost_summary"),
            "danger_summary": src.get("danger_summary"), "created_at": ts, "updated_at": ts,
        })
    return store.get_prompt(pid, _org(user))


# ── public, unauthenticated ──────────────────────────────────────────────

@public_router.post("/prompts/score")
def public_score(req: PublicScoreRequest, request: Request):
    """The website's live box: paste a prompt, see its danger and monthly cost.

    Rules-only danger and the ~4 chars/token estimate (no outbound calls, so an
    anonymous visitor can't spend anything), IP rate-limited, nothing stored."""
    if not shared_state.rate_limit_ok(f"public-score:{_client_ip(request)}",
                                      RATE_LIMIT_PUBLIC_SCORE_MAX, RATE_LIMIT_PUBLIC_SCORE_WINDOW):
        raise HTTPException(status_code=429, detail="That's a lot of prompts. Sign up free to keep scoring.")
    cost = score_cost(req.body, {}, expected_output_tokens=PUBLIC_DEFAULT_OUTPUT, models=list(PUBLIC_MODELS),
                      allow_network=False)
    for m in cost["models"]:
        if m.get("available"):
            m["usd_per_month"] = round(m["usd_per_run"] * req.runs_per_day * 30, 2)
    danger = score_danger(req.body, {})
    return {"cost": cost, "danger": danger, "runs_per_day": req.runs_per_day,
            "assumed_output_tokens": PUBLIC_DEFAULT_OUTPUT}


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
    p.pop("ai_check", None)
    return p


@public_router.post("/prompts/{prompt_id}/use")
def public_use(prompt_id: str, request: Request):
    if not store.get_prompt(prompt_id, None):
        raise HTTPException(status_code=404, detail="Prompt not found")
    if shared_state.should_fire_once(f"prompt-use:{prompt_id}:ip:{_client_ip(request)}", 600):
        store.increment_use(prompt_id)
    return {"ok": True}


@public_router.get("/creators/{author_id}")
def public_creator(author_id: str):
    return store.creator_profile(author_id)
