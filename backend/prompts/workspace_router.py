"""/api/workspace: which product this org's app opens on.

'prompts' = a founder or agency who came for the prompt library: the app
lands on /prompts and the sidebar leads with Prompts. 'agents' = the agent
governance product. Either can switch; it's a view preference, not a gate.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from auth import get_current_user
from db import get_db

router = APIRouter(prefix="/api/workspace", tags=["workspace"])


class WorkspaceUpdate(BaseModel):
    workspace: Literal["agents", "prompts"]


@router.get("")
def get_workspace(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute("SELECT workspace FROM organizations WHERE id = %s", (user.get("org_id"),)).fetchone()
    return {"workspace": (row or {}).get("workspace") or "agents"}


@router.put("")
def set_workspace(req: WorkspaceUpdate, user: dict = Depends(get_current_user)):
    from main import require_role
    require_role(user, "admin")
    with get_db() as conn:
        conn.execute("UPDATE organizations SET workspace = %s WHERE id = %s", (req.workspace, user.get("org_id")))
    return {"workspace": req.workspace}
