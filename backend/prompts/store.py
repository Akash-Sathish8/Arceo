"""Raw-SQL persistence for the prompt library (db.py pattern: get_db, dict rows).

Every read that a signed-in user makes is scoped in SQL to "my org OR public
and published", with RLS (0016) as the structural backstop. Unauthenticated
reads run as the 'system' context, which RLS treats as full access, so the
public helpers here filter on visibility/status explicitly and must keep doing so.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, Optional

from db import get_db

_JSON_COLS = ("variables", "tools", "tests", "cost_summary", "danger_summary", "cost", "danger",
              "steps", "inputs", "outputs", "checks")

PUBLIC_PRED = "visibility = 'public' AND status = 'published'"


def now() -> str:
    return datetime.utcnow().isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def dumps(v: Any) -> Optional[str]:
    return None if v is None else json.dumps(v)


def hydrate(row: Optional[dict]) -> Optional[dict]:
    if row is None:
        return None
    out = dict(row)
    for c in _JSON_COLS:
        if c in out and isinstance(out[c], str):
            try:
                out[c] = json.loads(out[c])
            except ValueError:
                out[c] = None
    return out


def display_name(conn, user: dict) -> str:
    """Public byline: the user's name, never their email."""
    row = conn.execute("SELECT name FROM users WHERE id = %s", (user.get("sub"),)).fetchone()
    name = (row or {}).get("name") or ""
    return name if name and "@" not in name else (user.get("email") or "creator").split("@")[0]


# ── prompts ──────────────────────────────────────────────────────────────

_PROMPT_LIST_COLS = ("id, org_id, author_id, author_name, title, description, use_case, visibility, status, "
                     "published_version, parent_id, cost_summary, danger_summary, reliability, created_at, updated_at")


def list_prompts(org_id: str, scope: str, q: Optional[str], use_case: Optional[str],
                 limit: int = 100) -> list[dict]:
    where, args = [], []
    if scope == "mine":
        where.append("org_id = %s")
        args.append(org_id)
    elif scope == "public":
        where.append(PUBLIC_PRED)
    else:  # all: mine + public
        where.append(f"(org_id = %s OR ({PUBLIC_PRED}))")
        args.append(org_id)
    if q:
        where.append("(title ILIKE %s OR description ILIKE %s OR use_case ILIKE %s)")
        like = f"%{q}%"
        args += [like, like, like]
    if use_case:
        where.append("use_case = %s")
        args.append(use_case)
    sql = (f"SELECT {_PROMPT_LIST_COLS} FROM prompts WHERE {' AND '.join(where)} "
           "ORDER BY updated_at DESC LIMIT %s")
    with get_db() as conn:
        rows = conn.execute(sql, (*args, limit)).fetchall()
    return [hydrate(r) for r in rows]


def get_prompt(prompt_id: str, org_id: Optional[str]) -> Optional[dict]:
    """The full row if the caller's org owns it; the PUBLISHED version if it's public.

    A non-owner never sees the working draft, only what was published.
    """
    with get_db() as conn:
        row = conn.execute("SELECT * FROM prompts WHERE id = %s", (prompt_id,)).fetchone()
        if row is None:
            return None
        if org_id and row["org_id"] == org_id:
            out = hydrate(row)
            out["owned"] = True
            return out
        if row["visibility"] != "public" or row["status"] != "published":
            return None
        ver = conn.execute("SELECT * FROM prompt_versions WHERE prompt_id = %s AND version = %s",
                           (prompt_id, row["published_version"])).fetchone()
    out = hydrate(row)
    v = hydrate(ver) or {}
    for k in ("title", "body", "variables", "tools", "expected_output_tokens"):
        out[k] = v.get(k, out.get(k))
    out["cost_summary"], out["danger_summary"] = v.get("cost"), v.get("danger")
    out["reliability"] = v.get("reliability")
    out["tests"] = None   # QA inputs are the author's; never shown to other orgs
    out["owned"] = False
    return out


def insert_prompt(conn, row: dict) -> None:
    cols = list(row)
    conn.execute(
        f"INSERT INTO prompts ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})",
        tuple(dumps(row[c]) if c in _JSON_COLS else row[c] for c in cols),
    )


def update_prompt(conn, prompt_id: str, org_id: str, fields: dict) -> None:
    sets = ", ".join(f"{c} = %s" for c in fields)
    conn.execute(f"UPDATE prompts SET {sets} WHERE id = %s AND org_id = %s",
                 (*[dumps(v) if c in _JSON_COLS else v for c, v in fields.items()], prompt_id, org_id))


def insert_version(conn, row: dict) -> None:
    cols = list(row)
    conn.execute(
        f"INSERT INTO prompt_versions ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})",
        tuple(dumps(row[c]) if c in _JSON_COLS else row[c] for c in cols),
    )


def list_versions(prompt_id: str, org_id: Optional[str], owned: bool) -> list[dict]:
    sql = ("SELECT id, version, title, cost, danger, reliability, created_at FROM prompt_versions "
           "WHERE prompt_id = %s")
    args: list = [prompt_id]
    if owned:
        sql += " AND org_id = %s"
        args.append(org_id)
    else:
        sql += (" AND version <= (SELECT published_version FROM prompts WHERE id = %s AND "
                f"{PUBLIC_PRED})")
        args.append(prompt_id)
    with get_db() as conn:
        rows = conn.execute(sql + " ORDER BY version DESC", tuple(args)).fetchall()
    return [hydrate(r) for r in rows]


def delete_prompt(prompt_id: str, org_id: str) -> bool:
    with get_db() as conn:
        cur = conn.execute("DELETE FROM prompts WHERE id = %s AND org_id = %s", (prompt_id, org_id))
        if cur.rowcount:
            conn.execute("DELETE FROM prompt_versions WHERE prompt_id = %s AND org_id = %s", (prompt_id, org_id))
            conn.execute("DELETE FROM qa_runs WHERE prompt_id = %s AND org_id = %s", (prompt_id, org_id))
        return bool(cur.rowcount)


def creator_profile(author_id: str) -> dict:
    """Public stats for a creator, from PUBLIC published prompts only."""
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT id, title, use_case, author_name, danger_summary, cost_summary, reliability, updated_at "
            f"FROM prompts WHERE author_id = %s AND {PUBLIC_PRED} ORDER BY updated_at DESC LIMIT 200",
            (author_id,),
        ).fetchall()
        ids = [r["id"] for r in rows]
        forks = 0
        if ids:
            forks = conn.execute(
                f"SELECT COUNT(*) AS n FROM prompts WHERE parent_id = ANY(%s)", (ids,)
            ).fetchone()["n"]
    prompts = [hydrate(r) for r in rows]
    return {"author_id": author_id,
            "author_name": prompts[0]["author_name"] if prompts else None,
            "prompts": prompts, "total_forks": forks}
