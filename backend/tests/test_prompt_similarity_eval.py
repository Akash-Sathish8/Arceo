"""The prompt matcher meets its holdout targets (plan section 1, Stage 5).

Scores the COMMITTED weights (prompts/similarity_weights.json) on the holdout
split: the hand-labeled cases in tests/eval/prompt_similarity_cases_{1..4}.yaml
plus the "filled" cases generated from every library prompt. It is the same
evaluation `python -m prompts.similarity_fit` prints, run offline and
deterministically. After changing the lexicon, the engine or the seed files,
refit and commit the new weights:

    cd backend && .venv/bin/python -m prompts.similarity_fit
"""

from __future__ import annotations

import json
import time
from collections import Counter

import pytest

from prompts import seed, similarity as S, similarity_fit as F


@pytest.fixture(scope="module")
def holdout() -> dict:
    S.set_model(None)                     # the committed JSON, not a model a test swapped in
    started = time.perf_counter()
    prep = F.prepare(splits=("holdout",))
    results = prep.results["holdout"]
    F.apply_model(results, S.model())
    per = F.evaluate(results)
    return {"prep": prep, "results": results, "per": per, "summary": F.summary(per),
            "seconds": time.perf_counter() - started}


def _why(h: dict) -> str:
    return "\n" + F.table("holdout", h["per"])


# ── the plan's holdout targets ───────────────────────────────────────────

def test_same_is_precise(holdout):
    """Never tell someone wrongly that theirs is already in the library."""
    assert holdout["summary"]["same_precision"] >= 0.95, _why(holdout)


def test_same_recall(holdout):
    assert holdout["summary"]["same_recall"] >= 0.85, _why(holdout)


def test_any_match_recall_on_paraphrased_filled_and_extended(holdout):
    assert holdout["summary"]["any_recall"] >= 0.90, _why(holdout)


def test_hard_negatives_are_rarely_close_or_same(holdout):
    assert holdout["summary"]["hard_negative_false"] <= 0.05, _why(holdout)


def test_top1_mrr(holdout):
    assert holdout["summary"]["mrr"] >= 0.90, _why(holdout)


def test_new_jobs_are_rarely_close_or_same(holdout):
    per = holdout["per"]
    negatives = per["hard_negative"]["n"] + per["novel"]["n"]
    wrong = per["hard_negative"]["false_cs"] + per["novel"]["false_cs"]
    assert wrong / negatives <= 0.05, _why(holdout)


def test_every_case_kind_is_in_the_holdout(holdout):
    assert {k for k, st in holdout["per"].items() if st["n"]} == set(F.KIND_ORDER)
    assert holdout["summary"]["cases"] >= 200


# ── the harness itself ───────────────────────────────────────────────────

def test_runs_fast_and_gives_the_same_answer_every_time(holdout):
    assert holdout["seconds"] < 60, f"holdout evaluation took {holdout['seconds']:.1f}s"
    sample = [r.case for r in holdout["results"][::6]]
    again = F.featurize(sample, holdout["prep"].pool)
    F.apply_model(again, S.model())
    first = {r.case["id"]: [(p.entry.id, p.level, p.score) for p in r.pairs] for r in holdout["results"][::6]}
    assert {r.case["id"]: [(p.entry.id, p.level, p.score) for p in r.pairs] for r in again} == first


def test_split_is_by_target_prompt():
    cases = F.load_cases() + F.generated_cases(seed.load()["prompts"])
    targets = {"fit": set(), "holdout": set()}
    for c in cases:
        if c["target"]:
            targets[F.split_of(c)].add(c["target"])
    assert targets["fit"] and targets["holdout"] and not targets["fit"] & targets["holdout"]
    share = len(targets["holdout"]) / (len(targets["fit"]) + len(targets["holdout"]))
    assert 0.2 < share < 0.4
    assert [F.split_of(c) for c in cases] == [F.split_of(c) for c in cases]   # stable


def test_generated_filled_cases_cover_the_library():
    items = seed.load()["prompts"]
    gen = F.generated_cases(items)
    assert len(gen) == len(items) and gen == F.generated_cases(items)
    assert {c["target"] for c in gen} == {i["title"] for i in items}
    for c in gen:
        assert c["kind"] == "filled" and c["expect"] == "same"
        assert "{{" not in c["query"]["body"], c["id"]
    assert set(Counter(c["placement"] for c in gen)) == {"inline", "fenced", "end"}


def test_eval_cases_point_at_library_prompts():
    titles = {i["title"] for i in seed.load()["prompts"]}
    cases = F.load_cases()
    assert len(cases) >= 500
    assert all(c["target"] in titles for c in cases if c["target"])
    assert {c["kind"] for c in cases} == {"paraphrase", "extended", "trimmed", "hard_negative", "novel"}


def test_eval_never_reads_the_sealed_files():
    assert F.CASE_FILES and all("sealed" not in p.name for p in F.CASE_FILES)


def test_committed_weights_match_the_engine():
    d = json.loads(S.WEIGHTS_PATH.read_text())
    assert d["features"] == list(S.FEATURES)
    assert len(d["weights"]) == len(d["mean"]) == len(d["std"]) == len(S.FEATURES)
    assert d["verify"]["features"] == list(S.VERIFY_FEATURES)
    assert len(d["verify"]["weights"]) == len(S.VERIFY_FEATURES)
    pool = S.build_pool([{"id": "a", "body": "Summarize the email below in 3 bullets. <email>{{email}}</email>"},
                         {"id": "b", "body": "Write a friendly reply to the email below. <email>{{email}}</email>"}])
    pair = S.score_query(S.make_query(pool.entries[0].canon, pool.corpus), [pool])[0]
    assert set(d["same_gate"]["features"]) <= set(S.gate_features(pair.feats, pair.gate))
    t = d["thresholds"]
    assert 0.0 < t["related"] <= t["close"] <= t["same"] <= 1.0
    assert 0.0 < d["same_gate"]["threshold"] < 1.0
    rg = d["reword_gate"]
    assert rg["features"] == list(F.REWORD_FEATURES) and len(rg["weights"]) == len(F.REWORD_FEATURES)
    assert set(rg["features"]) <= set(S.gate_features(pair.feats, pair.gate))
    assert 0.0 < rg["threshold"] < 1.0


def test_fitting_twice_gives_identical_weights(holdout):
    """Fits are deterministic (pure-Python Newton, sorted tie-breaks): the same cases give the same JSON."""
    import copy

    def fresh():  # fit_on rescores pairs in place, so give it copies and leave the fixture untouched
        return [F.CaseResult(r.case, [copy.copy(p) for p in r.pairs]) for r in holdout["results"]]

    assert F.fit_on(fresh()).to_dict() == F.fit_on(fresh()).to_dict()


# ── reworded copies with a requirement added or dropped ─────────────────

@pytest.fixture(scope="module")
def reworded() -> list:
    S.set_model(None)
    prep = F.prepare(splits=("holdout_rw",))
    F.apply_model(prep.results["holdout_rw"], S.model())
    return prep.results["holdout_rw"]


def test_reworded_extended_and_trimmed_are_rarely_called_the_same(reworded):
    """A reworded prompt that also adds or drops a requirement is a variant ("close"), not the same prompt.
    The fit holds the generated fit cases to REWORDED_FALSE_SAME; this guards the holdout ones."""
    per = F.evaluate(reworded)
    n = per["extended"]["n"] + per["trimmed"]["n"]
    said_same = per["extended"]["same_pred"] + per["trimmed"]["same_pred"]
    assert n >= 40, n
    assert said_same / n <= 0.25, "\n" + F.table("hold-rw", per)
    assert per["extended"]["any_hit"] + per["trimmed"]["any_hit"] >= 0.95 * n     # still found


def test_reworded_cases_are_generated_from_the_same_split():
    items = seed.load()["prompts"]
    pool = F.corpus_pool(items)
    cases = F.load_cases() + F.generated_cases(items)
    rw = F.reworded_cases(cases, pool)
    assert rw == F.reworded_cases(cases, pool)                              # deterministic
    by_id = {c["id"]: c for c in cases}
    assert {c["kind"] for c in rw} == {"extended", "trimmed"} and all(c["expect"] == "close" for c in rw)
    for c in rw:
        source = by_id[c["id"].split("-", 2)[2]]                             # gen-rx-<id> / gen-rt-<id>
        assert source["target"] == c["target"] and F.split_of(source) == F.split_of(c)
        para = next(x for x in cases if x["target"] == c["target"] and x["kind"] == "paraphrase")
        assert c["query"]["body"] != para["query"]["body"]


# ── label conflicts: a newer prompt never silently takes a labeled case's job ──

def test_no_newer_prompt_takes_a_labeled_job():
    """Every hand-labeled case a prompt added after the cases were written matches at close or same (or
    outranks a paraphrase's target) has been read and relabeled, or recorded as a false collision.

    On failure: `python -m prompts.similarity_fit --conflicts`, read both texts, then relabel the case in
    its file with a one-line reason, or add the pair to F.REVIEWED_FALSE_COLLISIONS with why."""
    S.set_model(None)
    rows = F.find_conflicts(m=S.model())
    open_ = [d for d in rows if d["blocking"] and not d["reviewed"]]
    assert open_ == [], F.conflicts_report(open_, "unreviewed")


def test_conflict_check_flags_a_prompt_that_does_a_cases_job():
    old = {"title": "Client email to 3 bullets", "use_case": "Sales", "description": "Sum up an email.",
           "body": "Summarize the client email below in 3 bullets.\n<email>{{email}}</email>"}
    reply = {"title": "Friendly reply to a client", "use_case": "Sales", "description": "Reply to an email.",
             "body": "Write a friendly reply to the client email below and say what happens next.\n"
                     "<email>{{email}}</email>"}
    items = [old, reply]
    pool = F.corpus_pool(items)
    q = lambda body: {"body": body, "title": "", "description": "", "use_case": ""}  # noqa: E731
    cases = [
        # the "novel" job and the hard negative's real job are now exactly the new prompt
        {"id": "x-novel", "target": None, "kind": "novel", "expect": "none", "file": "x.yaml",
         "query": q(reply["body"])},
        {"id": "x-hn", "target": old["title"], "kind": "hard_negative", "expect": "none", "file": "x.yaml",
         "query": q(reply["body"])},
        {"id": "x-para", "target": old["title"], "kind": "paraphrase", "expect": "same", "file": "x.yaml",
         "query": q(old["body"])},
    ]
    results = F.featurize(cases, pool)
    F.apply_model(results, S.model())
    suspects = F.unlabeled_titles(items, cases)
    assert suspects == {reply["title"]}
    rows = F.label_conflicts(results, suspects)
    assert {(d["case"], d["prompt"], d["level"]) for d in rows} == {("x-hn", reply["title"], "same"),
                                                                    ("x-novel", reply["title"], "same")}
    assert all(d["blocking"] and not d["reviewed"] for d in rows)
    # generated "filled" cases are the seed near-duplicate check's business, not this one
    assert F.label_conflicts([F.CaseResult({**results[0].case, "file": "generated"}, results[0].pairs)],
                             suspects) == []


def test_reviewed_false_collisions_name_real_cases_and_prompts():
    titles = {i["title"] for i in seed.load()["prompts"]}
    ids = {c["id"] for c in F.load_cases()}
    for (case_id, title), why in F.REVIEWED_FALSE_COLLISIONS.items():
        assert case_id in ids and title in titles and why.strip(), (case_id, title)


# ── extra case files (--cases-glob) ──────────────────────────────────────

def test_cases_glob_resolves_and_scores_extra_files(tmp_path, monkeypatch, holdout):
    pool = holdout["prep"].pool
    title = sorted(e.id for e in pool.entries)[0]
    body = next(i["body"] for i in seed.load()["prompts"] if i["title"] == title)
    f1, f2 = tmp_path / "extra_cases_1.yaml", tmp_path / "extra_cases_2.yaml"
    f1.write_text(json.dumps({"cases": [{"id": "e1", "target": title, "kind": "paraphrase", "expect": "same",
                                         "query": {"body": body}}]}))
    f2.write_text(json.dumps({"cases": [{"id": "e2", "target": "No such prompt", "kind": "paraphrase",
                                         "expect": "same", "query": {"body": body}}]}))
    (tmp_path / "extra_cases_3.txt").write_text("not a case file")
    want = [f1.resolve(), f2.resolve()]
    assert F.resolve_case_globs([str(tmp_path / "extra_cases_*.yaml")]) == want          # absolute
    monkeypatch.chdir(tmp_path)
    assert F.resolve_case_globs(["extra_cases_*.yaml", "extra_cases_1.yaml"]) == want    # cwd, de-duplicated
    assert F.resolve_case_globs(["nothing_here_*.yaml"]) == []
    # relative to tests/eval, also when given as a path from the repo root (never opened here)
    assert F.resolve_case_globs(["prompt_similarity_cases_1.yaml"]) == [F.CASE_FILES[0].resolve()]
    assert F.resolve_case_globs(["backend/tests/eval/prompt_similarity_cases_2.yaml"]) == [F.CASE_FILES[1].resolve()]

    results, unknown = F.extra_results(want, pool)
    assert unknown == 1 and [r.case["id"] for r in results] == ["e1", "e2"]
    F.apply_model(results, S.model())
    per = F.evaluate(results)
    assert per["paraphrase"]["n"] == 2 and per["paraphrase"]["same_hit"] == 1   # the copy is found; the
    assert F.summary(per)["same_recall"] == 0.5                                  # unknown target is a miss
