"""/api/battles: prompt battles, blind voting and leaderboards.

Battles are community by construction (0016 public_read on battles, entries
and votes). Writes stay own-org: you create battles, entries and votes as
yourself, and ratings are computed from votes on read.
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import shared_state
from auth import get_current_user
from db import get_db

from . import battles, qa, store
from .template import variables_in

router = APIRouter(prefix="/api/battles", tags=["battles"])
public_router = APIRouter(prefix="/api/public/battles", tags=["battles-public"])

MAX_INPUTS = 5
Sort = Literal["best", "cheapest_good", "safest"]


class BattleInput(BaseModel):
    label: str = Field(default="input", max_length=80)
    values: dict[str, str] = Field(..., min_length=1)


class BattleCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    task: str = Field(..., min_length=1, max_length=4_000)
    model: str = Field(default=qa.DEFAULT_QA_MODEL, max_length=80)
    inputs: list[BattleInput] = Field(..., min_length=1, max_length=MAX_INPUTS)


class EntryCreate(BaseModel):
    body: str = Field(..., min_length=1, max_length=20_000)
    prompt_id: Optional[str] = Field(default=None, max_length=64)


class VoteCreate(BaseModel):
    entry_a: str
    entry_b: str
    input_index: int = Field(..., ge=0, lt=MAX_INPUTS)
    winner: str  # one of the two entry ids, or "tie"


def _org(user: dict) -> Optional[str]:
    return user.get("org_id")


def _require_editor(user: dict) -> None:
    from main import require_role
    require_role(user, "editor")


def _load(conn, battle_id: str) -> Optional[dict]:
    return store.hydrate(conn.execute("SELECT * FROM battles WHERE id = %s", (battle_id,)).fetchone())


def _entries(conn, battle_id: str) -> list[dict]:
    rows = conn.execute("SELECT * FROM battle_entries WHERE battle_id = %s ORDER BY created_at", (battle_id,)).fetchall()
    return [store.hydrate(r) for r in rows]


def _votes(conn, battle_id: str) -> list[dict]:
    return conn.execute("SELECT entry_a, entry_b, winner, voter_id, input_index FROM battle_votes "
                        "WHERE battle_id = %s ORDER BY created_at, id", (battle_id,)).fetchall()


def _view(battle: dict, entries: list[dict], votes: list[dict], viewer_id: Optional[str], sort: str) -> dict:
    closed = battle["status"] == "closed"
    is_creator = viewer_id is not None and battle.get("created_by") == viewer_id
    board = battles.leaderboard(entries, votes, sort)
    by_id = {e["id"]: e for e in entries}
    for row in board:
        mine = viewer_id is not None and row["author_id"] == viewer_id
        row["mine"] = mine
        # Entry text stays hidden while the battle is open, so nobody can copy the leader.
        row["body"] = by_id[row["id"]]["body"] if (closed or mine) else None
    return {
        "id": battle["id"], "title": battle["title"], "task": battle["task"], "model": battle["model"],
        "status": battle["status"], "created_at": battle["created_at"], "is_creator": is_creator,
        "variables": battles.battle_variables(battle["inputs"] or []),
        "input_count": len(battle["inputs"] or []),
        # Organiser sees the hidden inputs; everyone sees them once it's closed.
        "inputs": battle["inputs"] if (is_creator or closed) else None,
        "entry_count": len(entries), "vote_count": len(votes),
        "leaderboard": board,
    }


@router.get("")
def list_battles(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT b.id, b.title, b.task, b.model, b.status, b.created_at, "
            "(SELECT COUNT(*) FROM battle_entries e WHERE e.battle_id = b.id) AS entry_count, "
            "(SELECT COUNT(*) FROM battle_votes v WHERE v.battle_id = b.id) AS vote_count "
            "FROM battles b ORDER BY (b.status = 'open') DESC, b.created_at DESC LIMIT 100"
        ).fetchall()
    return {"battles": rows}


@router.post("")
def create_battle(req: BattleCreate, user: dict = Depends(get_current_user)):
    _require_editor(user)
    from analysis.spend_forecast import price_call
    priced = price_call(req.model, 0, 0, org_id=_org(user))
    if priced["usd"] is None:
        raise HTTPException(status_code=400, detail=f"{req.model} isn't in the price catalog.")
    names = [set(i.values) for i in req.inputs]
    if any(n != names[0] for n in names):
        raise HTTPException(status_code=400, detail="Every input must fill the same variables.")
    bid, ts = store.new_id("bt"), store.now()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO battles (id, org_id, created_by, title, task, model, inputs, status, created_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,'open',%s)",
            (bid, _org(user), user.get("sub"), req.title, req.task, priced["model_key"],
             store.dumps([i.model_dump() for i in req.inputs]), ts),
        )
        b = _load(conn, bid)
    return _view(b, [], [], user.get("sub"), "best")


@router.get("/{battle_id}")
def get_battle(battle_id: str, sort: Sort = "best", user: dict = Depends(get_current_user)):
    with get_db() as conn:
        b = _load(conn, battle_id)
        if not b:
            raise HTTPException(status_code=404, detail="Battle not found")
        return _view(b, _entries(conn, battle_id), _votes(conn, battle_id), user.get("sub"), sort)


@router.post("/{battle_id}/entries")
def enter_battle(battle_id: str, req: EntryCreate, user: dict = Depends(get_current_user)):
    _require_editor(user)
    if not shared_state.rate_limit_ok(f"prompt-qa:{_org(user)}", 6, 300):
        raise HTTPException(status_code=429, detail="Too many runs. Try again in a few minutes.")
    with get_db() as conn:
        b = _load(conn, battle_id)
        if not b:
            raise HTTPException(status_code=404, detail="Battle not found")
        if b["status"] != "open":
            raise HTTPException(status_code=409, detail="This battle is closed.")
        if conn.execute("SELECT 1 FROM battle_entries WHERE battle_id = %s AND author_id = %s",
                        (battle_id, user.get("sub"))).fetchone():
            raise HTTPException(status_code=409, detail="You already entered this battle.")
    expected = set(battles.battle_variables(b["inputs"] or []))
    used = set(variables_in(req.body))
    if used != expected:
        need = ", ".join("{{" + v + "}}" for v in sorted(expected))
        raise HTTPException(status_code=400, detail=f"Your prompt must use exactly these variables: {need}.")
    try:
        result = battles.run_entry(b, req.body, _org(user))
    except qa.QaError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    if result["danger"]["publish_blockers"]:
        raise HTTPException(status_code=409, detail="Remove the API key or personal data from your prompt first.")
    eid = store.new_id("be")
    with get_db() as conn:
        conn.execute(
            "INSERT INTO battle_entries (id, org_id, battle_id, author_id, author_name, prompt_id, body, outputs, "
            "cost, danger, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (eid, _org(user), battle_id, user.get("sub"), store.display_name(conn, user), req.prompt_id,
             req.body, store.dumps(result["outputs"]), store.dumps(result["cost"]), store.dumps(result["danger"]),
             store.now()),
        )
    return {"id": eid, "cost": result["cost"], "danger": result["danger"]}


@router.get("/{battle_id}/matchup")
def matchup(battle_id: str, user: dict = Depends(get_current_user)):
    """Two blind outputs for the same input. Authors and entry text are not included."""
    with get_db() as conn:
        b = _load(conn, battle_id)
        if not b:
            raise HTTPException(status_code=404, detail="Battle not found")
        entries = _entries(conn, battle_id)
        mine = conn.execute("SELECT entry_a, entry_b, input_index FROM battle_votes WHERE battle_id = %s AND voter_id = %s",
                            (battle_id, user.get("sub"))).fetchall()
    voted = {(tuple(sorted((v["entry_a"], v["entry_b"]))) + (v["input_index"],)) for v in mine}
    m = battles.pick_matchup(entries, voted, user.get("sub"), len(b["inputs"] or []))
    if not m:
        return {"matchup": None}
    by_id = {e["id"]: e for e in entries}
    k = m["input_index"]
    return {"matchup": {
        "input_index": k,
        "input": (b["inputs"] or [])[k],
        "left": {"id": m["left"], "output": (by_id[m["left"]]["outputs"] or [""])[k]},
        "right": {"id": m["right"], "output": (by_id[m["right"]]["outputs"] or [""])[k]},
    }}


@router.post("/{battle_id}/votes")
def vote(battle_id: str, req: VoteCreate, user: dict = Depends(get_current_user)):
    a, b_ = sorted((req.entry_a, req.entry_b))
    if a == b_:
        raise HTTPException(status_code=400, detail="Pick two different entries.")
    if req.winner not in (a, b_, "tie"):
        raise HTTPException(status_code=400, detail="The winner must be one of the two entries, or a tie.")
    with get_db() as conn:
        b = _load(conn, battle_id)
        if not b:
            raise HTTPException(status_code=404, detail="Battle not found")
        if b["status"] != "open":
            raise HTTPException(status_code=409, detail="Voting has closed.")
        if req.input_index >= len(b["inputs"] or []):
            raise HTTPException(status_code=400, detail="No such input.")
        rows = conn.execute("SELECT id, author_id FROM battle_entries WHERE battle_id = %s AND id = ANY(%s)",
                            (battle_id, [a, b_])).fetchall()
        if len(rows) != 2:
            raise HTTPException(status_code=404, detail="Entry not found")
        if any(r["author_id"] == user.get("sub") for r in rows):
            raise HTTPException(status_code=403, detail="You can't vote on a matchup that includes your own entry.")
        exists = conn.execute("SELECT 1 FROM battle_votes WHERE battle_id = %s AND voter_id = %s AND entry_a = %s "
                              "AND entry_b = %s AND input_index = %s",
                              (battle_id, user.get("sub"), a, b_, req.input_index)).fetchone()
        if exists:
            raise HTTPException(status_code=409, detail="You already voted on this matchup.")
        conn.execute(
            "INSERT INTO battle_votes (id, org_id, battle_id, voter_id, entry_a, entry_b, input_index, winner, created_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (store.new_id("bv"), _org(user), battle_id, user.get("sub"), a, b_, req.input_index, req.winner, store.now()),
        )
    return {"ok": True}


@router.post("/{battle_id}/close")
def close_battle(battle_id: str, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        b = _load(conn, battle_id)
        if not b or b.get("created_by") != user.get("sub"):
            raise HTTPException(status_code=404, detail="Battle not found")
        conn.execute("UPDATE battles SET status = 'closed' WHERE id = %s AND org_id = %s", (battle_id, _org(user)))
        b = _load(conn, battle_id)
        return _view(b, _entries(conn, battle_id), _votes(conn, battle_id), user.get("sub"), "best")


@public_router.get("/{battle_id}")
def public_battle(battle_id: str, sort: Sort = "best"):
    with get_db() as conn:
        b = _load(conn, battle_id)
        if not b:
            raise HTTPException(status_code=404, detail="Battle not found")
        view = _view(b, _entries(conn, battle_id), _votes(conn, battle_id), None, sort)
    for row in view["leaderboard"]:
        row.pop("author_id", None)
    return view
