"""Load the starter community library (seed_library.yaml).

Idempotent by title: re-running updates changed prompts (new published version)
and leaves unchanged ones alone. Published by a dedicated "Arceo Library" org
and user that can't log in (random, discarded password).

    python -m prompts.seed            # from backend/, with DATABASE_URL set
    python -m prompts.seed --qa       # also run QA on each (needs a model key)
"""

from __future__ import annotations

import argparse
import secrets
import uuid
from pathlib import Path

import yaml

from db import get_db

from . import qa, store
from .cost import score_cost
from .danger import score_danger
from .template import VariableSpec

SEED_PATH = Path(__file__).parent / "seed_library.yaml"
LIBRARY_EMAIL = "library@prompts.arceo.internal"
LIBRARY_ORG = "arceo-library"


def load() -> dict:
    return yaml.safe_load(SEED_PATH.read_text())


def _vars(raw: dict) -> dict[str, VariableSpec]:
    return {k: VariableSpec(sample=str(v)) for k, v in (raw or {}).items()}


def ensure_author(conn, name: str) -> str:
    row = conn.execute("SELECT id FROM users WHERE email = %s", (LIBRARY_EMAIL,)).fetchone()
    if row:
        return row["id"]
    from auth import hash_password
    now = store.now()
    conn.execute("INSERT INTO organizations (id, name, created_at, workspace) VALUES (%s,%s,%s,'prompts') "
                 "ON CONFLICT (id) DO NOTHING", (LIBRARY_ORG, name, now))
    uid = str(uuid.uuid4())
    conn.execute("INSERT INTO users (id, email, password_hash, name, role, org_id, created_at) "
                 "VALUES (%s,%s,%s,%s,'admin',%s,%s)",
                 (uid, LIBRARY_EMAIL, hash_password(secrets.token_urlsafe(32)), name, LIBRARY_ORG, now))
    return uid


def seed(run_qa: bool = False) -> dict:
    data = load()
    created = updated = unchanged = 0
    with get_db() as conn:
        author_id = ensure_author(conn, data["author"])
    for item in data["prompts"]:
        body = item["body"].strip()
        variables = _vars(item.get("vars"))
        var_dump = {k: v.model_dump(exclude_none=True) for k, v in variables.items()}
        cost = score_cost(body, variables, expected_output_tokens=item.get("out"), org_id=LIBRARY_ORG,
                          allow_network=False)
        danger = score_danger(body, variables)
        ts = store.now()
        with get_db() as conn:
            row = conn.execute("SELECT id, body, published_version FROM prompts WHERE org_id = %s AND title = %s",
                               (LIBRARY_ORG, item["title"])).fetchone()
            if row and row["body"] == body:
                unchanged += 1
                continue
            pid = row["id"] if row else store.new_id("pr")
            version = (row["published_version"] if row else 0) + 1
            fields = {"title": item["title"], "description": (item.get("description") or "").strip(),
                      "use_case": item.get("use_case", ""), "body": body, "variables": var_dump, "tools": [],
                      "expected_output_tokens": item.get("out"), "runs_per_day": item.get("runs_per_day", 20),
                      "visibility": "public", "status": "published", "published_version": version,
                      "cost_summary": cost, "danger_summary": danger, "updated_at": ts}
            if row:
                store.update_prompt(conn, pid, LIBRARY_ORG, fields)
                updated += 1
            else:
                store.insert_prompt(conn, {"id": pid, "org_id": LIBRARY_ORG, "author_id": author_id,
                                           "author_name": data["author"], "created_at": ts, **fields})
                created += 1
            store.insert_version(conn, {"id": store.new_id("pv"), "org_id": LIBRARY_ORG, "prompt_id": pid,
                                        "version": version, "title": item["title"], "body": body,
                                        "variables": var_dump, "tools": [], "expected_output_tokens": item.get("out"),
                                        "cost": cost, "danger": danger, "created_at": ts})
        if run_qa:
            p = store.get_prompt(pid, LIBRARY_ORG)
            try:
                qa.run_qa(p, qa.QaSuite(), LIBRARY_ORG, danger["untrusted_variables"])
            except qa.QaError as e:
                print(f"QA skipped for {item['title']}: {e}")
    return {"created": created, "updated": updated, "unchanged": unchanged, "total": len(data["prompts"])}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--qa", action="store_true", help="also run QA on each prompt (uses a model key)")
    print(seed(run_qa=ap.parse_args().qa))
