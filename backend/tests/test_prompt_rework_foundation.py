"""Foundation for the prompts rework: route order, the similar endpoints'
contract shape, the search stub, the MCP hooks, and migration 0018."""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi.routing import APIRoute
from starlette.routing import Match

from prompts import agent_router, similar_router, similarity
from tests.prompt_helpers import signup

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"


def _email(tag: str) -> str:
    return f"{tag}-{uuid.uuid4().hex[:8]}@example.com"


def _first_match(app, method: str, path: str):
    """The route Starlette would dispatch to: the first FULL match, in order."""
    scope = {"type": "http", "method": method, "path": path, "root_path": "", "query_string": b"", "headers": []}
    for route in app.router.routes:
        match, _ = route.matches(scope)
        if match == Match.FULL:
            return route
    return None


def _sample_path(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "pr_sample", path)


def _create(client, headers, title="Thank-you note", body="Write a short thank-you note to {{name}} for {{gift}}."):
    r = client.post("/api/prompts", headers=headers, json={
        "title": title, "description": "A warm thank-you note.", "use_case": "Personal", "body": body,
        "variables": {"name": {"sample": "Aunt May"}, "gift": {"sample": "the scarf"}}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ── route order ──────────────────────────────────────────────────────────

def test_new_prompt_routers_are_registered_before_the_prompt_id_routes():
    """GET /api/prompts/{prompt_id} would read /api/prompts/agent-tokens or
    /api/prompts/sends as a prompt id if the new routers came after it."""
    src = MAIN_PY.read_text()
    prompts_router_at = src.index("app.include_router(_prompts_router)")
    for name in ("_prompts_similar_router", "_prompts_similar_public_router", "_prompts_agent_router"):
        assert src.index(f"app.include_router({name})") < prompts_router_at, name


def test_every_new_route_wins_dispatch_over_the_catch_alls():
    """Each route on the new routers is the first full match for its own path,
    so nothing earlier (like GET /api/prompts/{prompt_id}) handles it. Covers
    routes added to agent_router/similar_router later automatically."""
    import main

    routes = [r for rt in (similar_router.router, similar_router.public_router, agent_router.router)
              for r in rt.routes if isinstance(r, APIRoute)]
    assert len(routes) >= 3
    for r in routes:
        for method in r.methods:
            hit = _first_match(main.app, method, _sample_path(r.path))
            assert hit is not None and hit.endpoint is r.endpoint, (method, r.path, getattr(hit, "path", None))


def test_mcp_is_mounted_before_the_spa_catch_all():
    src = MAIN_PY.read_text()
    assert src.index("_mount_prompts_mcp(app)") < src.index("def serve_frontend(")
    assert "async with mcp_lifespan():" in src


def test_lifespan_can_run_more_than_once(client):
    """The MCP session manager runs inside the app lifespan; the suite enters it
    once per TestClient, so a second entry must work."""
    from fastapi.testclient import TestClient

    import main
    with TestClient(main.app) as again:
        assert again.get("/api/health").status_code == 200


# ── similar endpoints (stub contract) ────────────────────────────────────

def test_similar_draft_contract(client):
    a = signup(client, _email("sim-a"))
    r = client.post("/api/prompts/similar", headers=a["headers"],
                    json={"body": "Summarize this email in 3 bullets", "mode": "live", "k": 5})
    assert r.status_code == 200, r.text
    assert isinstance(r.json()["matches"], list)
    assert client.post("/api/prompts/similar", json={"body": "x"}).status_code == 401
    assert client.post("/api/prompts/similar", headers=a["headers"], json={"body": ""}).status_code == 422
    assert client.post("/api/prompts/similar", headers=a["headers"],
                       json={"body": "x", "mode": "later"}).status_code == 422
    assert client.post("/api/prompts/similar", headers=a["headers"], json={"body": "x", "k": 99}).status_code == 422


def test_similar_to_prompt_respects_visibility(client):
    a, b = signup(client, _email("sim-own")), signup(client, _email("sim-other"))
    pid = _create(client, a["headers"])
    r = client.get(f"/api/prompts/{pid}/similar?k=6", headers=a["headers"])
    assert r.status_code == 200 and isinstance(r.json()["matches"], list)
    # Another org's private prompt, and an unknown id: not found, same as GET /api/prompts/{id}.
    assert client.get(f"/api/prompts/{pid}/similar", headers=b["headers"]).status_code == 404
    assert client.get("/api/prompts/pr_nope/similar", headers=a["headers"]).status_code == 404
    # Public endpoint: private prompts don't exist there until published.
    assert client.get(f"/api/public/prompts/{pid}/similar").status_code == 404
    pub = client.post(f"/api/prompts/{pid}/publish", headers=a["headers"], json={"visibility": "public"})
    assert pub.status_code == 200, pub.text
    r = client.get(f"/api/public/prompts/{pid}/similar?k=3")
    assert r.status_code == 200 and isinstance(r.json()["matches"], list)
    assert client.get(f"/api/prompts/{pid}/similar", headers=b["headers"]).status_code == 200


def test_search_stub_returns_ids_the_viewer_may_see(client):
    a, b = signup(client, _email("search-a")), signup(client, _email("search-b"))
    word = f"zebra{uuid.uuid4().hex[:6]}"
    mine = _create(client, a["headers"], title=f"{word} private note")
    theirs = _create(client, b["headers"], title=f"{word} other org note")
    assert similarity.search(word, a["org_id"]) == [mine]
    assert similarity.search(word, a["org_id"], scope="public") == []
    assert similarity.search(word, None) == []
    assert similarity.search("", a["org_id"]) == []
    client.post(f"/api/prompts/{theirs}/publish", headers=b["headers"], json={"visibility": "public"})
    assert set(similarity.search(word, a["org_id"])) == {mine, theirs}
    assert similarity.search(word, None) == [theirs]
    assert similarity.search(word, a["org_id"], scope="mine") == [mine]


def test_similarity_stub_signatures():
    assert similarity.match_draft({"body": "hi"}, None) == []
    assert similarity.match_draft({"body": "hi"}, "org", exclude_id="x", k=3, mode="save", public_only=True) == []
    assert similarity.similar_to_prompt("x", None, k=6, public_only=True) == []
    assert similarity.invalidate() is None


# ── migration 0018 ───────────────────────────────────────────────────────

def test_agent_tables_exist_with_forced_org_rls():
    from db import get_db
    with get_db() as conn:
        rows = conn.execute(
            "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class "
            "WHERE relname IN ('prompt_agent_tokens', 'prompt_sends')").fetchall()
        assert {r["relname"]: (r["relrowsecurity"], r["relforcerowsecurity"]) for r in rows} == {
            "prompt_agent_tokens": (True, True), "prompt_sends": (True, True)}
        pols = conn.execute("SELECT tablename, policyname, cmd FROM pg_policies "
                            "WHERE tablename IN ('prompt_agent_tokens', 'prompt_sends')").fetchall()
        assert {(p["tablename"], p["policyname"], p["cmd"]) for p in pols} == {
            ("prompt_agent_tokens", "org_isolation", "ALL"), ("prompt_sends", "org_isolation", "ALL")}
        uniq = conn.execute("SELECT indexdef FROM pg_indexes WHERE tablename = 'prompt_agent_tokens' "
                            "AND indexdef ILIKE '%UNIQUE%token_hash%'").fetchall()
        assert uniq
        idx = conn.execute("SELECT indexdef FROM pg_indexes WHERE tablename = 'prompt_sends' "
                           "AND indexname = 'ix_prompt_sends_user_delivered_created'").fetchone()
        assert idx and "(user_id, delivered_at, created_at)" in idx["indexdef"]


def test_send_text_is_registered_for_encryption():
    import encryption
    assert ("prompt_sends", "id", "text", "text_enc") in encryption.ENCRYPTED_COLUMNS
