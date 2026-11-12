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

_JSON_COLS = ("variables", "tools", "tests", "cost_summary", "danger_summary", "cost", "danger", "ai_check", "dismissed",
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
    """Public byline: the user's name, never their email or any part of it."""
    row = conn.execute("SELECT name FROM users WHERE id = %s", (user.get("sub"),)).fetchone()
    name = (row or {}).get("name") or ""
    return name if name and "@" not in name else "An Arceo member"


# ── prompts ──────────────────────────────────────────────────────────────

# A card shows the viewer's own prompts as they are now and everyone else's as last
# PUBLISHED: an edit another org hasn't published (its title, its warnings, its cost) is
# never listed or searchable. The description isn't versioned, so it is the same for all.
# Each "%s" is the viewer's org id (see _card_args); "" or None means nobody owns anything.
_PUBLISHED_JOIN = "LEFT JOIN prompt_versions v ON v.prompt_id = p.id AND v.version = p.published_version"
_SEEN_TITLE = "CASE WHEN p.org_id = %s THEN p.title ELSE COALESCE(v.title, p.title) END"
# Whether the body has a blank: the same pattern as template.VAR_RE, so a card can tell
# "fill in first" from "send in one click" without the body coming over the wire.
_BLANK_SQL = r"'\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}'"
_PROMPT_LIST_COLS = (
    "p.id, p.org_id, p.author_id, p.author_name, " + _SEEN_TITLE + " AS title, p.description, p.use_case, "
    "p.visibility, p.status, p.published_version, p.parent_id, "
    "CASE WHEN p.org_id = %s THEN p.cost_summary ELSE COALESCE(v.cost, p.cost_summary) END AS cost_summary, "
    "CASE WHEN p.org_id = %s THEN p.danger_summary ELSE COALESCE(v.danger, p.danger_summary) END AS danger_summary, "
    "CASE WHEN p.org_id = %s THEN p.reliability ELSE v.reliability END AS reliability, "
    "COALESCE((CASE WHEN p.org_id = %s THEN p.body ELSE COALESCE(v.body, p.body) END) ~ " + _BLANK_SQL
    + ", FALSE) AS has_blanks, "
    "p.use_count, p.runs_per_day, p.model, p.created_at, p.updated_at")
_CARD_PARAMS = 5                     # "%s" placeholders in _PROMPT_LIST_COLS
_PUBLIC_P = "p.visibility = 'public' AND p.status = 'published'"


# What a library card reads from a cost row: enough for headlineCost / rowBasis
# on the frontend (frontend/src/lib/promptFormat.ts) and nothing else.
_CARD_ROW_KEYS = ("model", "model_key", "provider", "available", "usd_per_run", "is_floor", "basis", "output_basis")


def slim_cost_summary(cost: Optional[dict], preferred: Optional[str] = None) -> Optional[dict]:
    """A cost summary cut down to what a list card shows.

    Same shape as the full summary, but `models` keeps only the rows the card can
    pick (the author's own model when it's priced, the cheapest, else the first
    priced row) with their token counts dropped. The frontend's headlineCost picks
    the same row from this as from the full table. GET /api/prompts/{id} still
    returns the whole table: about 2.4 KB a prompt, most of the library list's size.
    """
    if not isinstance(cost, dict):
        return None
    rows = [m for m in (cost.get("models") or []) if isinstance(m, dict)]
    priced = [m for m in rows if m.get("available") and m.get("usd_per_run") is not None]
    keep: list[dict] = []
    if preferred:
        keep += [m for m in priced if preferred in (m.get("model_key"), m.get("model"))][:1]
    cheapest = cost.get("cheapest_model")
    keep += [m for m in priced if m.get("model_key") == cheapest][:1] if cheapest else []
    if not keep and priced:
        keep.append(priced[0])
    ids = {id(m) for m in keep}
    return {
        "models": [{k: m.get(k) for k in _CARD_ROW_KEYS if k in m} for m in rows if id(m) in ids],
        "cheapest_model": cheapest,
        "unsized_variables": cost.get("unsized_variables") or [],
        "catalog_date": cost.get("catalog_date"),
        "rates": cost.get("rates"),
    }


def _slim(row: dict) -> dict:
    row["cost_summary"] = slim_cost_summary(row.get("cost_summary"), row.get("model"))
    return row


def list_prompts(org_id: str, scope: str, q: Optional[str], use_case: Optional[str],
                 limit: int = 100, ids: Optional[list[str]] = None) -> list[dict]:
    """Rows for a list of cards. cost_summary is the slim card version
    (slim_cost_summary); open one prompt for its full cost table. Rows another org
    owns show their published version (see _PROMPT_LIST_COLS). has_blanks says
    whether the (seen) body has any {{blank}}; the body itself isn't listed."""
    where, args = [], []
    if ids is not None:
        # Rows for a ranked search: the visibility rule below still applies.
        where.append("p.id = ANY(%s)")
        args.append(list(ids))
    if scope == "mine":
        where.append("p.org_id = %s")
        args.append(org_id)
    elif scope == "public":
        where.append(_PUBLIC_P)
    else:  # all: mine + public
        where.append(f"(p.org_id = %s OR ({_PUBLIC_P}))")
        args.append(org_id)
    if q:
        where.append(f"({_SEEN_TITLE} ILIKE %s OR p.description ILIKE %s OR p.use_case ILIKE %s)")
        like = f"%{q}%"
        args += [org_id, like, like, like]
    if use_case:
        where.append("p.use_case = %s")
        args.append(use_case)
    sql = (f"SELECT {_PROMPT_LIST_COLS} FROM prompts p {_PUBLISHED_JOIN} WHERE {' AND '.join(where)} "
           "ORDER BY p.updated_at DESC LIMIT %s")
    with get_db() as conn:
        rows = conn.execute(sql, (*([org_id] * _CARD_PARAMS), *args, limit)).fetchall()
    return [_slim(hydrate(r)) for r in rows]


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


def increment_use(prompt_id: str) -> None:
    with get_db() as conn:
        conn.execute("UPDATE prompts SET use_count = use_count + 1 WHERE id = %s", (prompt_id,))


def creator_profile(author_id: str) -> dict:
    """Public stats for a creator, from PUBLIC published prompts and closed
    comparisons only: published prompts, uses, forks, comparison wins."""
    from . import battles
    with get_db() as conn:
        # Everyone sees a creator's prompts as published (see _PROMPT_LIST_COLS).
        rows = conn.execute(
            "SELECT p.id, COALESCE(v.title, p.title) AS title, p.description, p.use_case, p.author_name, "
            "COALESCE(v.danger, p.danger_summary) AS danger_summary, COALESCE(v.cost, p.cost_summary) AS cost_summary, "
            "v.reliability AS reliability, COALESCE(COALESCE(v.body, p.body) ~ " + _BLANK_SQL + ", FALSE) AS has_blanks, "
            "p.use_count, p.runs_per_day, p.model, p.updated_at "
            f"FROM prompts p {_PUBLISHED_JOIN} WHERE p.author_id = %s AND {_PUBLIC_P} "
            "ORDER BY p.use_count DESC, p.updated_at DESC LIMIT 500",
            (author_id,),
        ).fetchall()
        ids = [r["id"] for r in rows]
        forks = 0
        if ids:
            forks = conn.execute(
                "SELECT COUNT(*) AS n FROM prompts WHERE parent_id = ANY(%s)", (ids,)
            ).fetchone()["n"]
        name_row = conn.execute("SELECT author_name FROM battle_entries WHERE author_id = %s LIMIT 1",
                                (author_id,)).fetchone()
        closed = conn.execute(
            "SELECT DISTINCT b.id FROM battles b JOIN battle_entries e ON e.battle_id = b.id "
            "WHERE e.author_id = %s AND b.status = 'closed'", (author_id,)).fetchall()
        wins = 0
        for b in closed:
            entries = [hydrate(e) for e in conn.execute(
                "SELECT id, author_id, cost, danger FROM battle_entries WHERE battle_id = %s", (b["id"],)).fetchall()]
            votes = conn.execute("SELECT entry_a, entry_b, winner FROM battle_votes WHERE battle_id = %s "
                                 "ORDER BY created_at, id", (b["id"],)).fetchall()
            board = battles.leaderboard(entries, votes, "best")
            if board and board[0].get("author_id") == author_id and board[0]["votes"] > 0:
                wins += 1
    prompts = [_slim(hydrate(r)) for r in rows]
    name = prompts[0]["author_name"] if prompts else (name_row or {}).get("author_name")
    return {"author_id": author_id, "author_name": name, "prompts": prompts,
            "total_forks": forks, "total_uses": sum(p.get("use_count") or 0 for p in prompts),
            "comparison_wins": wins}
