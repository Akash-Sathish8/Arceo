"""/api/prompt-workflows: stack prompts into steps; cost and danger as one unit.

(/api/workflows/* is already the multi-agent optimizer, hence the prefix.)
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import get_current_user
from db import get_db

from . import store
from .workflows import WorkflowError, WorkflowSpec, score_workflow

router = APIRouter(prefix="/api/prompt-workflows", tags=["prompt-workflows"])


class WorkflowWrite(WorkflowSpec):
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=2_000)


class WorkflowPublish(BaseModel):
    visibility: Literal["org", "public"] = "public"


def _org(user: dict) -> Optional[str]:
    return user.get("org_id")


def _require_editor(user: dict) -> None:
    from main import require_role
    require_role(user, "editor")


def _score(spec: WorkflowSpec, org_id: Optional[str]) -> dict:
    prompts = [store.get_prompt(s.prompt_id, org_id) for s in spec.steps]
    try:
        return score_workflow(spec, prompts, org_id)
    except WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _spec_of(row: dict) -> WorkflowSpec:
    raw = row.get("steps") or {}
    return WorkflowSpec(**raw) if isinstance(raw, dict) else WorkflowSpec(steps=raw)


def _get(conn, wf_id: str, org_id: Optional[str]) -> Optional[dict]:
    row = conn.execute("SELECT * FROM prompt_workflows WHERE id = %s", (wf_id,)).fetchone()
    if not row:
        return None
    owned = bool(org_id) and row["org_id"] == org_id
    if not owned and not (row["visibility"] == "public" and row["status"] == "published"):
        return None
    out = store.hydrate(row)
    out["owned"] = owned
    out.pop("org_id", None)
    return out


@router.post("/score")
def score(spec: WorkflowSpec, user: dict = Depends(get_current_user)):
    if not spec.steps:
        raise HTTPException(status_code=400, detail="Add at least one step.")
    return _score(spec, _org(user))


@router.get("")
def list_workflows(scope: Literal["all", "mine", "public"] = "all", user: dict = Depends(get_current_user)):
    where = {"mine": "org_id = %s", "public": store.PUBLIC_PRED,
             "all": f"(org_id = %s OR ({store.PUBLIC_PRED}))"}[scope]
    args = () if scope == "public" else (_org(user),)
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT id, org_id, author_name, title, description, visibility, status, cost_summary, danger_summary, "
            f"steps, updated_at FROM prompt_workflows WHERE {where} ORDER BY updated_at DESC LIMIT 100", args,
        ).fetchall()
    out = []
    for r in rows:
        h = store.hydrate(r)
        h["owned"] = h.pop("org_id") == _org(user)
        h["step_count"] = len((h.get("steps") or {}).get("steps", []))
        h.pop("steps", None)
        out.append(h)
    return {"workflows": out}


@router.post("")
def create_workflow(req: WorkflowWrite, user: dict = Depends(get_current_user)):
    _require_editor(user)
    scored = _score(req, _org(user)) if req.steps else {"cost": None, "danger": None}
    wid, ts = store.new_id("wf"), store.now()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO prompt_workflows (id, org_id, author_id, author_name, title, description, steps, "
            "cost_summary, danger_summary, created_at, updated_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (wid, _org(user), user.get("sub"), store.display_name(conn, user), req.title, req.description,
             store.dumps(WorkflowSpec(steps=req.steps, inputs=req.inputs).model_dump(by_alias=True)),
             store.dumps(scored["cost"]), store.dumps(scored["danger"]), ts, ts),
        )
        return _get(conn, wid, _org(user))


@router.get("/{wf_id}")
def get_workflow(wf_id: str, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        wf = _get(conn, wf_id, _org(user))
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return wf


@router.put("/{wf_id}")
def update_workflow(wf_id: str, req: WorkflowWrite, user: dict = Depends(get_current_user)):
    _require_editor(user)
    with get_db() as conn:
        wf = _get(conn, wf_id, _org(user))
    if not wf or not wf["owned"]:
        raise HTTPException(status_code=404, detail="Workflow not found")
    scored = _score(req, _org(user)) if req.steps else {"cost": None, "danger": None}
    with get_db() as conn:
        conn.execute(
            "UPDATE prompt_workflows SET title = %s, description = %s, steps = %s, cost_summary = %s, "
            "danger_summary = %s, updated_at = %s WHERE id = %s AND org_id = %s",
            (req.title, req.description,
             store.dumps(WorkflowSpec(steps=req.steps, inputs=req.inputs).model_dump(by_alias=True)),
             store.dumps(scored["cost"]), store.dumps(scored["danger"]), store.now(), wf_id, _org(user)),
        )
        return _get(conn, wf_id, _org(user))


@router.delete("/{wf_id}")
def delete_workflow(wf_id: str, user: dict = Depends(get_current_user)):
    _require_editor(user)
    with get_db() as conn:
        cur = conn.execute("DELETE FROM prompt_workflows WHERE id = %s AND org_id = %s", (wf_id, _org(user)))
    if not cur.rowcount:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return {"deleted": wf_id}


@router.post("/{wf_id}/publish")
def publish_workflow(wf_id: str, req: WorkflowPublish, user: dict = Depends(get_current_user)):
    """Share a workflow. Community sharing needs every step's prompt to be public
    itself, or readers would see a workflow whose steps they can't open."""
    _require_editor(user)
    with get_db() as conn:
        wf = _get(conn, wf_id, _org(user))
    if not wf or not wf["owned"]:
        raise HTTPException(status_code=404, detail="Workflow not found")
    spec = _spec_of(wf)
    if not spec.steps:
        raise HTTPException(status_code=400, detail="Add at least one step before publishing.")
    if req.visibility == "public":
        for i, s in enumerate(spec.steps):
            p = store.get_prompt(s.prompt_id, None)
            if not p:
                raise HTTPException(status_code=409, detail=(
                    f"Step {i + 1}'s prompt isn't published to the community. Publish it first."))
    scored = _score(spec, _org(user))
    with get_db() as conn:
        conn.execute(
            "UPDATE prompt_workflows SET visibility = %s, status = 'published', cost_summary = %s, "
            "danger_summary = %s, updated_at = %s WHERE id = %s AND org_id = %s",
            (req.visibility, store.dumps(scored["cost"]), store.dumps(scored["danger"]), store.now(),
             wf_id, _org(user)),
        )
        return _get(conn, wf_id, _org(user))
