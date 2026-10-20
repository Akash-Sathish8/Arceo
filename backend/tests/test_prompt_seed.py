"""The starter library: big enough, safe by construction, and idempotent to load."""

from __future__ import annotations

from prompts import seed
from prompts.danger import score_danger
from prompts.template import variables_in


def test_library_size_and_coverage():
    items = seed.load()["prompts"]
    assert 40 <= len(items) <= 60
    assert len({i["title"] for i in items}) == len(items)  # titles are the idempotency key
    assert {"agency ops", "sales", "marketing", "founder ops", "support", "product", "finance"} <= {i["use_case"] for i in items}


def test_every_seed_prompt_models_the_safe_pattern():
    for i in seed.load()["prompts"]:
        d = score_danger(i["body"].strip(), seed._vars(i.get("vars")))
        assert d["band"] == "low", (i["title"], d["band"], [r["title"] for r in d["reasons"]])
        assert set(variables_in(i["body"])) == set(i.get("vars") or {}), i["title"]  # every slot has a sample


def test_seed_is_idempotent_and_public(client):
    first = seed.seed()
    assert first["created"] + first["unchanged"] == first["total"]
    again = seed.seed()
    assert again == {**again, "created": 0, "updated": 0, "unchanged": first["total"]}
    rows = client.get("/api/public/prompts?q=Client%20email%20to%203%20bullets").json()["prompts"]
    assert rows and rows[0]["author_name"] == "Arceo Library"
