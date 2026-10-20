"""Prompt library phase 5: battles, blind matchups, votes, Elo, leaderboards."""

from __future__ import annotations

import random
import uuid

import pytest

from prompts import battles, qa

BATTLE = {
    "title": "Best cold-email opener",
    "task": "Write a 2-sentence cold email opener for the product described.",
    "model": "claude-haiku-4-5",
    "inputs": [{"label": "saas", "values": {"product": "A CRM for dentists"}},
               {"label": "hardware", "values": {"product": "A solar backpack"}}],
}


def fake_call(model_key, provider, system, user_text, org_id, max_tokens=1024):
    # Longer prompts produce longer outputs, so entries get different measured costs.
    return {"text": f"Opener for: {user_text[:40]}", "input_tokens": len(user_text) // 4,
            "output_tokens": 10 + len(user_text) // 10, "latency_ms": 3}


@pytest.fixture(autouse=True)
def _fake_model(monkeypatch):
    monkeypatch.setattr(qa, "call_model", fake_call)


@pytest.fixture()
def players(client):
    from tests.conftest import _signup_org
    tag = uuid.uuid4().hex[:6]
    return [_signup_org(client, f"bt-{i}-{tag}@example.com") for i in range(4)]


def _battle(client, host):
    r = client.post("/api/battles", headers=host["headers"], json=BATTLE)
    assert r.status_code == 200, r.text
    return r.json()


def _enter(client, p, bid, body):
    r = client.post(f"/api/battles/{bid}/entries", headers=p["headers"], json={"body": body})
    assert r.status_code == 200, r.text
    return r.json()


# ── pure logic ───────────────────────────────────────────────────────────

def test_elo_winner_gains_loser_loses_and_ties_balance():
    t = battles.elo(["a", "b"], [{"entry_a": "a", "entry_b": "b", "winner": "a"}])
    assert t["a"]["elo"] == 1016 and t["b"]["elo"] == 984 and t["a"]["wins"] == 1
    t = battles.elo(["a", "b"], [{"entry_a": "a", "entry_b": "b", "winner": "tie"}])
    assert t["a"]["elo"] == t["b"]["elo"] == 1000 and t["a"]["ties"] == 1


def test_leaderboard_sorts():
    entries = [
        {"id": "pricey", "cost": {"usd_per_run": 0.01}, "danger": {"score": 10}},
        {"id": "cheap", "cost": {"usd_per_run": 0.001}, "danger": {"score": 70}},
        {"id": "weak", "cost": {"usd_per_run": 0.0001}, "danger": {"score": 0}},
    ]
    votes = [{"entry_a": "pricey", "entry_b": "weak", "winner": "pricey"},
             {"entry_a": "cheap", "entry_b": "weak", "winner": "cheap"}]
    assert [r["id"] for r in battles.leaderboard(entries, votes, "best")][-1] == "weak"
    assert [r["id"] for r in battles.leaderboard(entries, votes, "cheapest_good")][:2] == ["cheap", "pricey"]
    assert [r["id"] for r in battles.leaderboard(entries, votes, "safest")][0] == "weak"


def test_matchup_excludes_own_entry_and_voted_pairs():
    entries = [{"id": "x", "author_id": "me"}, {"id": "y", "author_id": "u1"}, {"id": "z", "author_id": "u2"}]
    m = battles.pick_matchup(entries, set(), "me", 1, random.Random(1))
    assert {m["left"], m["right"]} == {"y", "z"}
    assert battles.pick_matchup(entries, {("y", "z", 0)}, "me", 1) is None


# ── HTTP ─────────────────────────────────────────────────────────────────

def test_full_battle_flow(client, players):
    host, p1, p2, voter = players
    b = _battle(client, host)
    assert b["variables"] == ["product"] and b["inputs"] is not None  # organiser sees inputs
    assert client.get(f"/api/battles/{b['id']}", headers=p1["headers"]).json()["inputs"] is None  # entrants don't

    short = _enter(client, p1, b["id"], "Opener for {{product}}.")
    long_ = _enter(client, p2, b["id"], "You are a world-class SDR. Write a punchy two-sentence opener for "
                                         "{{product}}. Lead with the pain, end with a question.")
    assert short["cost"]["basis"] == "measured"
    assert short["cost"]["usd_per_run"] < long_["cost"]["usd_per_run"]
    # Pasted product text is scored as untrusted, so even a contest prompt gets an injection read.
    assert short["danger"]["untrusted_variables"] == ["product"]

    # Entry bodies are hidden from others while open.
    view = client.get(f"/api/battles/{b['id']}", headers=voter["headers"]).json()
    assert all(r["body"] is None for r in view["leaderboard"])
    mine = client.get(f"/api/battles/{b['id']}", headers=p1["headers"]).json()
    assert [r["body"] is not None for r in mine["leaderboard"] if r["mine"]] == [True]

    # Voter judges both inputs; matchup never names authors.
    for _ in range(2):
        m = client.get(f"/api/battles/{b['id']}/matchup", headers=voter["headers"]).json()["matchup"]
        assert set(m) == {"input_index", "input", "left", "right"} and set(m["left"]) == {"id", "output"}
        r = client.post(f"/api/battles/{b['id']}/votes", headers=voter["headers"], json={
            "entry_a": m["left"]["id"], "entry_b": m["right"]["id"], "input_index": m["input_index"],
            "winner": long_["id"]})
        assert r.status_code == 200, r.text
    assert client.get(f"/api/battles/{b['id']}/matchup", headers=voter["headers"]).json()["matchup"] is None

    board = client.get(f"/api/battles/{b['id']}", headers=voter["headers"]).json()["leaderboard"]
    assert board[0]["id"] == long_["id"] and board[0]["wins"] == 2
    cheap = client.get(f"/api/battles/{b['id']}?sort=cheapest_good", headers=voter["headers"]).json()["leaderboard"]
    # With two entries only the winner sits at or above the median rating, so it leads despite costing more.
    assert cheap[0]["id"] == long_["id"]

    # Close reveals bodies and inputs; public page needs no auth and hides author ids.
    closed = client.post(f"/api/battles/{b['id']}/close", headers=host["headers"]).json()
    assert closed["status"] == "closed" and all(r["body"] for r in closed["leaderboard"])
    pub = client.get(f"/api/public/battles/{b['id']}").json()
    assert pub["inputs"] and all("author_id" not in r for r in pub["leaderboard"])
    assert client.post(f"/api/battles/{b['id']}/votes", headers=voter["headers"], json={
        "entry_a": short["id"], "entry_b": long_["id"], "input_index": 0, "winner": "tie"}).status_code == 409


def test_vote_rules(client, players):
    host, p1, p2, voter = players
    b = _battle(client, host)
    e1 = _enter(client, p1, b["id"], "A {{product}}")
    e2 = _enter(client, p2, b["id"], "B {{product}}")
    url = f"/api/battles/{b['id']}/votes"
    body = {"entry_a": e1["id"], "entry_b": e2["id"], "input_index": 0, "winner": e1["id"]}
    assert client.post(url, headers=p1["headers"], json=body).status_code == 403   # own entry
    assert client.post(url, headers=voter["headers"], json={**body, "winner": "someone"}).status_code == 400
    assert client.post(url, headers=voter["headers"], json={**body, "input_index": 4}).status_code == 400
    assert client.post(url, headers=voter["headers"], json=body).status_code == 200
    # Swapping sides is the same matchup.
    swapped = {**body, "entry_a": e2["id"], "entry_b": e1["id"]}
    assert client.post(url, headers=voter["headers"], json=swapped).status_code == 409


def test_entry_rules(client, players):
    host, p1, *_ = players
    b = _battle(client, host)
    r = client.post(f"/api/battles/{b['id']}/entries", headers=p1["headers"], json={"body": "No variables here"})
    assert r.status_code == 400 and "{{product}}" in r.json()["detail"]
    _enter(client, p1, b["id"], "Go {{product}}")
    assert client.post(f"/api/battles/{b['id']}/entries", headers=p1["headers"],
                       json={"body": "Again {{product}}"}).status_code == 409
    r = client.post(f"/api/battles/{b['id']}/entries", headers=host["headers"],
                    json={"body": "sk-ant-api03-" + "q" * 30 + " {{product}}"})
    assert r.status_code == 409


def test_create_validation_and_close_permissions(client, players):
    host, p1, *_ = players
    assert client.post("/api/battles", headers=host["headers"], json={**BATTLE, "model": "mystery"}).status_code == 400
    mixed = {**BATTLE, "inputs": [{"values": {"a": "1"}}, {"values": {"b": "2"}}]}
    assert client.post("/api/battles", headers=host["headers"], json=mixed).status_code == 400
    b = _battle(client, host)
    assert client.post(f"/api/battles/{b['id']}/close", headers=p1["headers"]).status_code == 404
    assert b["id"] in [x["id"] for x in client.get("/api/battles", headers=p1["headers"]).json()["battles"]]
