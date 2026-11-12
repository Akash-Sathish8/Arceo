"""Fit and evaluate the prompt matcher against the labeled eval set (plan section 1, Stage 5).

    python -m prompts.similarity_fit            # fit on the fit split, print metrics, write similarity_weights.json
    python -m prompts.similarity_fit --eval     # score the committed weights only (writes nothing)
    python -m prompts.similarity_fit --sealed   # also score the sealed held-out files (verify agent)
    python -m prompts.similarity_fit --judge    # committed weights, then the AI second opinion on Save
                                                # (Stage 6) on the holdout; see "The AI second opinion" below
    python -m prompts.similarity_fit --conflicts               # hand-labeled cases a newer prompt may
                                                               # have made stale (see "Label conflicts")
    python -m prompts.similarity_fit --eval --cases-glob 'prompt_similarity_sealed2_*.yaml'
                                                # also score extra case files as their own set; works
                                                # with fitting, --eval and --judge alike

Corpus: every prompt in prompts/seed/*.yaml, used as the public library (its
own IDF background, exactly as production uses public published prompts).

Cases:
  - tests/eval/prompt_similarity_cases_{1..4}.yaml, labeled by hand
    (paraphrase -> same, extended / trimmed -> close, hard_negative / novel -> none);
  - "filled" cases GENERATED here, one per corpus prompt: the prompt rendered
    with its own samples (template.render), with a varied lead-in and the pasted
    content placed inline after a colon, kept fenced, or pasted at the end.
    Expected: same.

  - "reworded" extended / trimmed cases GENERATED here (reworded_cases): a
    target's own paraphrase plus the sentences its extended case added, or minus
    the sentence its trimmed case dropped. Expected: close. They are kept in
    their own splits (fit_rw, holdout_rw), reported apart, and used only to fit
    the reword gate and hold it to REWORDED_FALSE_SAME; the plan's holdout
    targets are measured on the same cases as before.

Split: 70/30 BY TARGET PROMPT (a stable hash of its title), so no target sits
in both halves; novel cases split by their own id.

Fit: pair features from similarity.pair_features for the rescored candidates of
every fit case; L2 logistic regression by Newton's method in pure Python
(deterministic, no numpy); thresholds picked on the fit split only:
T_same at >= 0.97 precision of "same" decisions (with the same-gate), T_close
at >= 0.85 and T_related at >= 0.6 precision of target pairs; the same-gate's
own parameters are chosen on the fit split too. The reword gate (a reworded
prompt with a requirement added or dropped is not "same") is fitted on the
paraphrase + filled target pairs against the reworded fit cases.

Metrics, per split and per kind: same precision / recall, any-match recall,
close-or-better recall, hard-negative false close/same rate, novel false
positive rate, top-1 accuracy and MRR (reciprocal rank of the target, within 10).

The AI second opinion (--judge, plan Stage 6): scores the committed weights
(never fits or writes them), prints the table without the judge, then runs
similarity_judge.review on every case exactly as match_draft(mode="save") does
and prints the same table with it, plus judge calls, tokens, estimated cost,
latency (and how many calls would have missed the live 4 s budget) and what
changed (promotions / demotions, right or wrong). Default split: the holdout
(--judge-split fit|holdout|both; --sealed and --cases-glob add more). It needs
a real key: ANTHROPIC_API_KEY from the environment, else from backend/.env or
~/ActionGate/backend/.env (read, never printed). Answers are cached in a JSON
file (--judge-cache) so reruns cost nothing; the file also keeps every call's
usage so the cost of a cold run can still be reported. The eval runs with a
generous budget (--judge-budget, default 30 s) so it measures the judge's
answers, and reports the live-budget misses separately.

Label conflicts (--conflicts): the hand-labeled cases were written against the
library as it was then. A prompt added later can do a "novel" case's job, be
the real answer to a hard negative, or give a paraphrase a second right answer.
--conflicts scores the committed weights (it never fits or writes) and lists,
deterministically, every hand-labeled case where a prompt no hand-labeled case
targets (one added after the cases were written; --conflicts-all: any prompt
other than the case's own target) matches at close or same, or, for
paraphrase / extended / trimmed cases, outranks the target. --conflicts-min-score
also lists "related" matches scoring at least that much, to screen wider. Each
listed pair is then read by a person: a real conflict is relabeled in its case
file (with a one-line reason); a false collision goes in REVIEWED_FALSE_COLLISIONS.
Exits 1 while any listed conflict (close or same, or a target outranked) is
unreviewed; wider "related" listings never fail.

Extra case files (--cases-glob, repeatable): a glob that is absolute, relative
to the working directory, or relative to tests/eval. The files are scored as
one more set, never fitted on; their targets must be library prompts (cases
that point elsewhere are counted, not shown).
"""

from __future__ import annotations

import argparse
import glob as globlib
import hashlib
import json
import math
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

import yaml

from . import similarity as S
from .danger import _DATA_RULE
from .template import VAR_RE, VariableSpec, render

BACKEND = Path(__file__).resolve().parent.parent
EVAL_DIR = BACKEND / "tests" / "eval"
CASE_FILES = tuple(EVAL_DIR / f"prompt_similarity_cases_{i}.yaml" for i in range(1, 5))
SEALED_FILES = tuple(EVAL_DIR / f"prompt_similarity_sealed_{i}.yaml" for i in range(1, 5))

POSITIVE = ("paraphrase", "filled", "extended", "trimmed")
SAME_KINDS = ("paraphrase", "filled")
CLOSE_KINDS = ("extended", "trimmed")
NEGATIVE = ("hard_negative", "novel")
KIND_ORDER = ("paraphrase", "filled", "extended", "trimmed", "hard_negative", "novel")
TOP_K = 5          # matches returned, as the API default
MRR_DEPTH = 10

TARGETS = {        # holdout targets (plan section 1, enforced by test_prompt_similarity_eval.py)
    "same_precision": 0.95,
    "same_recall": 0.85,
    "any_recall": 0.90,          # paraphrase + filled + extended
    "hard_negative_false": 0.05,
    "mrr": 0.90,
}
# Fit-split precision each level must reach (plan: same >= 0.97, close >= 0.85, related >= 0.6).
# "same" aims a little above 0.97: out-of-fold precision runs about a point below fit precision
# (5-fold CV inside the fit split), and the plan's rule is "never wrongly say it already exists".
PRECISION_FOR = {"same": 0.975, "close": 0.85, "related": 0.60}
# Generated "filled" cases are easy and always right, so they can carry overall "same" precision
# while hand-written rewordings and extended/trimmed copies are still confused. "same" must
# therefore also hold this precision on the hand-labeled fit cases alone (the stricter wins).
SAME_PRECISION_LABELED = 0.96
# "close" interrupts the person, so on the fit split it must also wrongly fire on
# at most this share of hard negatives (and novel prompts); the holdout target is 5%.
FALSE_CLOSE_BUDGET = 0.03
# "Same" while typing claims the draft is already in the library, so it must hold up when someone
# rewords a prompt AND adds or drops a requirement: on the generated reworded extended / trimmed fit
# cases (reworded_cases), at most this share may come back "same" (the rest are "close", which still
# shows the card; Save's AI second opinion checks every "same" anyway). The strictest budget whose
# 5-fold CV "same" recall inside the fit split stays >= 0.865 (the plan's 0.85 plus a margin for
# split-to-split variation), decided before looking at the holdout. CV inside the fit split, 2026-11:
#   budget   CV same recall   CV reworded called "same"
#    0.10        0.840              12 / 96
#    0.15        0.868              18 / 96     <- chosen
#    0.20        0.876              20 / 96
#    none        0.897              43 / 96     (no reword gate: what shipped before)
REWORDED_FALSE_SAME = 0.15
L2 = 1.0
HARD_NEGATIVE_WEIGHT = 1.0


# ── corpus and cases ─────────────────────────────────────────────────────

def corpus_items() -> list[dict]:
    from . import seed
    return seed.load()["prompts"]


def corpus_pool(items: Optional[list] = None) -> "S.Pool":
    return S.build_pool(S.seed_docs(items if items is not None else corpus_items()))


def load_cases(paths: Iterable[Path] = CASE_FILES) -> list[dict]:
    cases: list[dict] = []
    for p in paths:
        data = yaml.safe_load(Path(p).read_text()) or {}
        for c in data.get("cases") or []:
            q = c.get("query") or {}
            cases.append({"id": str(c["id"]), "target": c.get("target"), "kind": str(c["kind"]),
                          "expect": str(c.get("expect") or ""), "file": Path(p).name,
                          "query": {"body": str(q.get("body") or ""), "title": str(q.get("title") or ""),
                                    "description": str(q.get("description") or ""),
                                    "use_case": str(q.get("use_case") or "")}})
    return cases


def _h(text: str) -> int:
    return int(hashlib.sha256(text.encode()).hexdigest(), 16)


def split_of(case: dict) -> str:
    """70/30 by target prompt; novel cases by their own id."""
    key = case["target"] or f"novel:{case['id']}"
    return "fit" if _h("arceo-similarity-split:" + str(key)) % 1000 < 700 else "holdout"


# ── generated "filled" cases ─────────────────────────────────────────────

_LEAD_INS = (
    "", "Can you help me with this?", "Quick one.", "I need a hand with something for my business.",
    "Hi! Here's what I need.", "Could you do this for me?", "Need help with this one.", "Okay, next thing.",
    "Hoping you can help.", "Here's my task for today.",
)
_POINTERS = ("Here's the {x}:", "This is the {x}:", "The {x}:", "Pasting the {x} below:", "My {x}:",
             "{X} below:")


def _noun(name: str) -> str:
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name).replace("_", " ").replace("-", " ").lower().split()
    return " ".join(words) or "text"


def _fence_re(name: str) -> re.Pattern:
    ph = r"\{\{\s*" + re.escape(name) + r"\s*\}\}"
    return re.compile(r"<([A-Za-z_][\w-]*)[^>]*>\s*" + ph + r"\s*</\1>|```[\w-]*\s*" + ph + r"\s*```|"
                      r'"""\s*' + ph + r'\s*"""')


def _drop_data_rule(body: str) -> str:
    parts = re.split(r"(?<=[.!?])\s+|\n", body)
    return "\n".join(p for p in parts if p.strip() and not _DATA_RULE.search(p))


def filled_case(item: dict) -> Optional[dict]:
    """The prompt as someone would paste it with real content in it. Deterministic per title."""
    title = str(item.get("title") or "")
    body = str(item.get("body") or "").strip()
    if not title or not body:
        return None
    h = _h("arceo-filled:" + title)
    pick = lambda i, n: (h >> (12 * i)) % n  # noqa: E731
    samples = {k: str(v) for k, v in (item.get("vars") or {}).items()}
    names = list(dict.fromkeys(m.group(1) for m in VAR_RE.finditer(body)))
    fenced = [n for n in names if _fence_re(n).search(body)]
    placement = ("inline", "fenced", "end")[pick(0, 3)] if fenced else "inline"
    text = body
    tail = ""
    if fenced and placement != "fenced":
        if pick(1, 2) == 0:
            text = _drop_data_rule(text)
        for j, n in enumerate(fenced):
            noun = _noun(n)
            ptr = _POINTERS[pick(2 + j, len(_POINTERS))].replace("{x}", noun).replace("{X}", noun.capitalize())
            if placement == "inline":
                text = _fence_re(n).sub(lambda m, ptr=ptr, n=n: f"{ptr} {{{{{n}}}}}", text, count=1)
            else:
                text = _fence_re(n).sub("", text, count=1)
                tail += f"\n\n{ptr}\n{{{{{n}}}}}"
    elif fenced and pick(1, 3) == 0:
        # keep it fenced, but the way people paste: a code fence instead of tags
        for n in fenced:
            text = _fence_re(n).sub(lambda m, n=n: f"```\n{{{{{n}}}}}\n```", text, count=1)
    text = re.sub(r"\n{3,}", "\n\n", (text.strip() + tail)).strip()
    filled, _, _ = render(text, {k: VariableSpec(sample=v) for k, v in samples.items()})
    lead = _LEAD_INS[pick(5, len(_LEAD_INS))]
    query = f"{lead}\n{filled}".strip() if lead else filled
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return {"id": f"gen-filled-{slug}", "target": title, "kind": "filled", "expect": "same", "file": "generated",
            "placement": placement, "query": {"body": query, "title": "", "description": "", "use_case": ""}}


def generated_cases(items: list) -> list[dict]:
    out = []
    for it in sorted(items, key=lambda x: str(x.get("title") or "").casefold()):
        c = filled_case(it)
        if c:
            out.append(c)
    return out


# ── generated "reworded" extended / trimmed cases ────────────────────────
#
# The hand-written extended and trimmed cases are mostly the library prompt copied with a
# sentence added or cut, while the paraphrases are reworded from scratch. Fitted on that
# alone, "how copied is it" separates them, and a REWORDED prompt with a requirement added
# or dropped then reads as "same". These cases put the two together, from the same split
# only: each target's own paraphrase, plus the sentences its extended case added (that the
# library prompt doesn't cover), or minus the paraphrase's sentence that says what its
# trimmed case left out. Expected: close. Built deterministically per target.

_RW_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'(])|\n+")
_RW_SALIENT = 2.5        # IDF of a term that says something (as the same-gate's sentence check)
_RW_UNCOVERED = 0.5      # a sentence the other prompt covers less than this much is new to it


def _rw_sentences(body: str) -> list[str]:
    return [s.strip() for s in _RW_SPLIT.split(body.strip()) if s.strip()]


def _rw_salient(text: str, corpus: "S.Corpus") -> set:
    return {t for t in S.canonical(text).tokens if not t.startswith("§") and corpus.word(t) >= _RW_SALIENT}


def _rw_cover(terms: set, other: set, corpus: "S.Corpus") -> float:
    tot = sum(corpus.word(t) for t in sorted(terms))
    return sum(corpus.word(t) for t in sorted(terms) if t in other) / tot if tot else 1.0


def _rw_join(sents: list[str], adds: list[str], h: int) -> str:
    """The paraphrase with the added sentences: at the end, before its last sentence, or the first
    one folded into the sentence before it ("..., and also ...")."""
    body = list(sents)
    where = h % 3
    if where == 2 and adds[0][:5].lower() == "also " and body and "{{" not in body[-1]:
        last = body[-1].rstrip(" .!")
        rest = adds[0][5:]
        body[-1] = f"{last}, and also {rest[:1].lower()}{rest[1:]}"
        return "\n".join(body + adds[1:])
    pos = len(body) - 1 if where == 1 and len(body) >= 3 else len(body)
    body[pos:pos] = adds
    return "\n".join(body)


def reworded_cases(cases: list, pool: "S.Pool") -> list[dict]:
    corpus = pool.corpus
    by: dict = {}
    for c in cases:
        if c["target"] and c["file"] not in ("generated", "generated-reworded"):
            by.setdefault(c["target"], {}).setdefault(c["kind"], c)
    out = []
    for t in sorted(by):
        kinds = by[t]
        para, e = kinds.get("paraphrase"), pool.by_id.get(t)
        if not para or e is None:
            continue
        c_terms = set(e.terms) | set(e.canon.meta_tokens)
        p_sents = _rw_sentences(para["query"]["body"])
        h = _h("arceo-reworded:" + t)
        ext = kinds.get("extended")
        if ext:
            adds = [s for s in _rw_sentences(ext["query"]["body"]) if "{{" not in s
                    and len(st := _rw_salient(s, corpus)) >= 2 and _rw_cover(st, c_terms, corpus) < _RW_UNCOVERED]
            if adds:
                out.append({"id": f"gen-rx-{ext['id']}", "target": t, "kind": "extended", "expect": "close",
                            "file": "generated-reworded",
                            "query": {**para["query"], "body": _rw_join(p_sents, adds, h)}})
        trim = kinds.get("trimmed")
        if trim:
            tq = trim["query"]
            tc = S.canonical(tq["body"], tq["title"], tq["description"])
            t_terms = set(tc.tokens) | set(tc.meta_tokens)
            dropped = [st for s in _rw_sentences(e.body) if "{{" not in s
                       and len(st := _rw_salient(s, corpus)) >= 2 and _rw_cover(st, t_terms, corpus) < _RW_UNCOVERED]
            cut: set = set()
            for st in dropped:
                best, at = 0.0, None
                for i, ps in enumerate(p_sents):
                    if i == 0 or "{{" in ps:          # the opening says the job; a blank's line holds content
                        continue
                    pt = _rw_salient(ps, corpus)
                    j = sum(corpus.word(x) for x in sorted(pt & st)) / (sum(corpus.word(x) for x in sorted(pt | st)) or 1)
                    if j > best:
                        best, at = j, i
                if at is not None and best >= 0.15:
                    cut.add(at)
            if cut and len(p_sents) - len(cut) >= 2:
                out.append({"id": f"gen-rt-{trim['id']}", "target": t, "kind": "trimmed", "expect": "close",
                            "file": "generated-reworded",
                            "query": {**para["query"],
                                      "body": "\n".join(s for i, s in enumerate(p_sents) if i not in cut)}})
    return out


# ── featurize ────────────────────────────────────────────────────────────

@dataclass
class CaseResult:
    case: dict
    pairs: list          # similarity.Pair, rescored candidates


def featurize(cases: list, pool: "S.Pool") -> list[CaseResult]:
    out = []
    for c in cases:
        q = c["query"]
        canon = S.canonical(q["body"], q["title"], q["description"], q["use_case"])
        pairs = []
        if canon.content_len >= S.MIN_CONTENT_TOKENS:
            pairs = S.score_query(S.make_query(canon, pool.corpus), [pool])
        out.append(CaseResult(c, pairs))
    return out


def apply_model(results: list, m: "S.Model") -> None:
    for r in results:
        for p in r.pairs:
            p.score = m.score(p.feats)
            p.verify = m.verify_prob(p.feats)
            p.level = S.level_for(p.score, p.feats, p.gate, m, p.verify)
        r.pairs.sort(key=lambda p: (-p.score, p.entry.id))


def is_target(r: CaseResult, p) -> bool:
    return bool(r.case["target"]) and p.entry.id == r.case["target"]


# ── logistic regression (pure Python, deterministic) ─────────────────────

def _solve(a: list, b: list) -> list:
    """Gaussian elimination with partial pivoting: a x = b."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: (abs(m[r][col]), -r))
        if abs(m[piv][col]) < 1e-12:
            continue
        m[col], m[piv] = m[piv], m[col]
        pv = m[col][col]
        for j in range(col, n + 1):
            m[col][j] /= pv
        for r in range(n):
            if r != col and m[r][col]:
                f = m[r][col]
                row_r, row_c = m[r], m[col]
                for j in range(col, n + 1):
                    row_r[j] -= f * row_c[j]
    return [m[i][n] for i in range(n)]


def fit_logistic(rows: list, labels: list, l2: float = L2, iters: int = 60,
                 sample_weights: Optional[list] = None) -> tuple[list, float, list, list]:
    """Standardized L2 logistic regression by Newton's method. Returns (weights, bias, mean, std)."""
    d = len(rows[0])
    n = len(rows)
    sw = sample_weights or [1.0] * n
    mean = [sum(r[j] for r in rows) / n for j in range(d)]
    std = []
    for j in range(d):
        var = sum((r[j] - mean[j]) ** 2 for r in rows) / n
        std.append(math.sqrt(var) if var > 1e-12 else 1.0)
    X = [[1.0] + [(r[j] - mean[j]) / std[j] for j in range(d)] for r in rows]
    beta = [0.0] * (d + 1)
    for _ in range(iters):
        grad = [0.0] * (d + 1)
        hess = [[0.0] * (d + 1) for _ in range(d + 1)]
        for x, y, s_w in zip(X, labels, sw):
            z = sum(b * v for b, v in zip(beta, x))
            z = max(-35.0, min(35.0, z))
            p = 1.0 / (1.0 + math.exp(-z))
            w = s_w * p * (1.0 - p)
            e = s_w * (y - p)
            for i in range(d + 1):
                xi = x[i]
                grad[i] += e * xi
                if xi:
                    wxi = w * xi
                    hrow = hess[i]
                    for j in range(i, d + 1):
                        hrow[j] += wxi * x[j]
        for i in range(d + 1):
            for j in range(i):
                hess[i][j] = hess[j][i]
        for i in range(1, d + 1):           # no penalty on the bias
            grad[i] -= l2 * beta[i]
            hess[i][i] += l2
        step = _solve(hess, grad)
        beta = [b + s for b, s in zip(beta, step)]
        if max(abs(s) for s in step) < 1e-9:
            break
    return [round(b, 6) for b in beta[1:]], round(beta[0], 6), [round(x, 6) for x in mean], \
        [round(x, 6) for x in std]


# ── thresholds ───────────────────────────────────────────────────────────

def lowest_threshold(scored: list, precision: float, fixed_tp: int = 0, fixed_n: int = 0) -> float:
    """Lowest score t with precision(score >= t) >= `precision` (pairs tied at t all count)."""
    scored = sorted(scored, key=lambda x: -x[0])
    best = 1.0 + 1e-9
    tp, n = fixed_tp, fixed_n
    i = 0
    while i < len(scored):
        s = scored[i][0]
        while i < len(scored) and scored[i][0] == s:
            tp += 1 if scored[i][1] else 0
            n += 1
            i += 1
        if n and tp / n >= precision:
            best = s
    return best


def false_close_rate(results: list, t: float, t_related: float, kinds: tuple = NEGATIVE) -> float:
    """Share of `kinds` cases where any returned match would reach "close" at verifier threshold t."""
    cases = [r for r in results if r.case["kind"] in kinds]
    if not cases:
        return 0.0
    bad = sum(1 for r in cases if any(p.feats.get("exact") or (p.score >= t_related and p.verify >= t)
                                      for p in r.pairs[:TOP_K]))
    return bad / len(cases)


def pick_close(results: list, t_related: float) -> float:
    """Lowest verifier threshold with close-pair precision >= 0.85 AND at most FALSE_CLOSE_BUDGET of hard
    negatives (and of novel prompts) wrongly reaching close."""
    pairs = sorted(((p.verify, r.case["kind"] in POSITIVE and is_target(r, p)) for r in results for p in r.pairs
                    if p.score >= t_related), key=lambda x: -x[0])
    floor = lowest_threshold(pairs, PRECISION_FOR["close"])
    for t in sorted({v for v, _ in pairs if v >= floor}):
        if false_close_rate(results, t, t_related, ("hard_negative",)) <= FALSE_CLOSE_BUDGET and \
                false_close_rate(results, t, t_related, ("novel",)) <= FALSE_CLOSE_BUDGET:
            return t
    return 1.0


def pick_same(results: list, m: "S.Model", t_close: float, t_related: float) -> tuple[float, float]:
    """(verifier threshold for same, gate threshold): the most right "same" calls with fit precision
    >= PRECISION_FOR["same"] overall AND >= SAME_PRECISION_LABELED on the hand-labeled cases.
    Generated reworded cases are left out here; pick_reword holds them to their own budget."""
    exact = {"all": [0, 0], "labeled": [0, 0]}
    cand = []
    for r in results:
        if is_reworded(r):
            continue
        labeled = r.case["kind"] != "filled"
        for p in r.pairs:
            right = r.case["kind"] in SAME_KINDS and is_target(r, p)
            if p.feats.get("exact"):
                for key in ("all", "labeled") if labeled else ("all",):
                    exact[key][0] += right
                    exact[key][1] += 1
            elif p.score >= t_related:
                cand.append((p.verify, m.gate_prob(S.gate_features(p.feats, p.gate)), right, labeled))
    target_scores = sorted(v for v, _, right, _ in cand if right)
    options = {t_close} | {target_scores[int(len(target_scores) * q)] for q in (0.02, 0.05, 0.1, 0.15, 0.2, 0.3)
                           if target_scores}
    best = (-1, 1.0, 1.0)
    for t_same in sorted(x for x in options if x >= t_close):
        pool = [(g, right, labeled) for v, g, right, labeled in cand if v >= t_same]
        g_all = lowest_threshold([(g, r_) for g, r_, _ in pool], PRECISION_FOR["same"], *exact["all"])
        g_lab = lowest_threshold([(g, r_) for g, r_, lab in pool if lab], SAME_PRECISION_LABELED,
                                 *exact["labeled"])
        g_t = max(g_all, g_lab)
        tp = sum(1 for g, right, _ in pool if g >= g_t and right)
        if tp > best[0] or (tp == best[0] and t_same < best[1]):
            best = (tp, t_same, g_t)
    return round(best[1], 6), round(best[2], 6)


def pick_reword(results: list, m: "S.Model", budget: float = None) -> float:
    """The reword gate's threshold: the lowest at which at most `budget` (REWORDED_FALSE_SAME) of the
    generated reworded extended / trimmed cases would still be called "same" by everything else."""
    budget = REWORDED_FALSE_SAME if budget is None else budget
    t = m.thresholds
    g_t = float(m.same_gate.get("threshold", 0.5))
    best = []
    for r in results:
        if not is_reworded(r):
            continue
        top = 0.0
        for p in r.pairs:
            if p.feats.get("exact") or p.feats.get("op_conflict") or p.feats.get("neg_flip") \
                    or p.score < t["related"] or p.verify < t["same"]:
                continue
            gf = S.gate_features(p.feats, p.gate)
            if m.gate_prob(gf) >= g_t:
                top = max(top, m.reword_prob(gf))
        best.append(top)
    if not best:
        return 0.0
    allowed = int(math.floor(budget * len(best) + 1e-9))
    ranked = sorted(best, reverse=True)
    return 0.0 if allowed >= len(ranked) else round(ranked[allowed] + 1e-6, 6)


# ── metrics ──────────────────────────────────────────────────────────────

def evaluate(results: list) -> dict:
    """Metrics per kind and overall, from results that already carry scores and levels."""
    per: dict = {k: {"n": 0, "same_pred": 0, "same_right": 0, "same_hit": 0, "any_hit": 0, "close_hit": 0,
                     "level_ok": 0, "false_cs": 0, "false_cs_target": 0, "any_related": 0, "rr": 0.0,
                     "top1": 0} for k in KIND_ORDER}
    for r in results:
        kind = r.case["kind"]
        st = per.setdefault(kind, {key: 0 for key in per["paraphrase"]})
        st["n"] += 1
        ranked = r.pairs
        matches = S.order([p for p in ranked if p.level])[:TOP_K]
        for p in matches:
            if p.level == "same":
                st["same_pred"] += 1
                st["same_right"] += 1 if (kind in SAME_KINDS and is_target(r, p)) else 0
        tgt = next((p for p in matches if is_target(r, p)), None)
        if kind in SAME_KINDS and matches and is_target(r, matches[0]) and matches[0].level == "same":
            st["same_hit"] += 1
        if tgt is not None:
            st["any_hit"] += 1
            if tgt.level in ("same", "close"):
                st["close_hit"] += 1
            if (kind in CLOSE_KINDS and tgt.level == "close") or (kind in SAME_KINDS and tgt.level == "same"):
                st["level_ok"] += 1
        if any(p.level in ("same", "close") for p in matches):
            st["false_cs"] += 1 if kind in NEGATIVE else 0
        if tgt is not None and tgt.level in ("same", "close") and kind in NEGATIVE:
            st["false_cs_target"] += 1
        if matches:
            st["any_related"] += 1
        if kind in POSITIVE:
            rank_ = next((i + 1 for i, p in enumerate(ranked[:MRR_DEPTH]) if is_target(r, p)), None)
            st["rr"] += 1.0 / rank_ if rank_ else 0.0
            st["top1"] += 1 if rank_ == 1 else 0
    return per


def _ratio(a: float, b: float) -> Optional[float]:
    return a / b if b else None


def summary(per: dict) -> dict:
    tot = lambda key, kinds: sum(per[k][key] for k in kinds if k in per)  # noqa: E731
    all_kinds = [k for k in per]
    same_pred = tot("same_pred", all_kinds)
    return {
        "same_precision": _ratio(tot("same_right", all_kinds), same_pred),
        "same_predictions": same_pred,
        "same_recall": _ratio(tot("same_hit", SAME_KINDS), tot("n", SAME_KINDS)),
        "any_recall": _ratio(tot("any_hit", ("paraphrase", "filled", "extended")),
                             tot("n", ("paraphrase", "filled", "extended"))),
        "any_recall_with_trimmed": _ratio(tot("any_hit", POSITIVE), tot("n", POSITIVE)),
        "close_or_better_recall": _ratio(tot("close_hit", CLOSE_KINDS), tot("n", CLOSE_KINDS)),
        "close_level_accuracy": _ratio(tot("level_ok", CLOSE_KINDS), tot("n", CLOSE_KINDS)),
        "hard_negative_false": _ratio(per["hard_negative"]["false_cs"], per["hard_negative"]["n"]),
        "hard_negative_false_target": _ratio(per["hard_negative"]["false_cs_target"], per["hard_negative"]["n"]),
        "novel_false": _ratio(per["novel"]["false_cs"], per["novel"]["n"]),
        "novel_any_related": _ratio(per["novel"]["any_related"], per["novel"]["n"]),
        "mrr": _ratio(tot("rr", POSITIVE), tot("n", POSITIVE)),
        "top1": _ratio(tot("top1", POSITIVE), tot("n", POSITIVE)),
        "cases": tot("n", all_kinds),
    }


def targets_failed(s: dict) -> list[str]:
    fails = []
    for key, bound in TARGETS.items():
        v = s.get(key)
        if v is None:
            continue
        if key == "hard_negative_false":
            if v > bound:
                fails.append(f"{key} {v:.3f} > {bound}")
        elif v < bound:
            fails.append(f"{key} {v:.3f} < {bound}")
    return fails


def _f(v: Optional[float]) -> str:
    return "  -  " if v is None else f"{v:5.3f}"


def table(split: str, per: dict) -> str:
    lines = [f"{split:<8} {'kind':<14} {'n':>4}  {'sameP':>5}  {'sameR':>5}  {'anyR':>5}  {'close+':>6}  "
             f"{'lvlOK':>5}  {'falseCS':>7}  {'MRR':>5}  {'top1':>5}"]
    for k in KIND_ORDER:
        st = per.get(k)
        if not st or not st["n"]:
            continue
        n = st["n"]
        pos = k in POSITIVE
        lines.append(
            f"{split:<8} {k:<14} {n:>4}  {_f(_ratio(st['same_right'], st['same_pred'])):>5}  "
            f"{_f(_ratio(st['same_hit'], n) if k in SAME_KINDS else None):>5}  "
            f"{_f(_ratio(st['any_hit'], n) if pos else None):>5}  "
            f"{_f(_ratio(st['close_hit'], n) if pos else None):>6}  "
            f"{_f(_ratio(st['level_ok'], n) if pos else None):>5}  "
            f"{_f(_ratio(st['false_cs'], n) if not pos else None):>7}  "
            f"{_f(st['rr'] / n if pos else None):>5}  {_f(st['top1'] / n if pos else None):>5}")
    s = summary(per)
    lines.append(f"{split:<8} {'TOTAL':<14} {s['cases']:>4}  same P {_f(s['same_precision'])} "
                 f"({s['same_predictions']} said)  same R {_f(s['same_recall'])}  any R (para+filled+ext) "
                 f"{_f(s['any_recall'])}  hard-neg close/same {_f(s['hard_negative_false'])} "
                 f"(target only {_f(s['hard_negative_false_target'])})  novel close/same {_f(s['novel_false'])} "
                 f"(any related {_f(s['novel_any_related'])})  MRR {_f(s['mrr'])}  top1 {_f(s['top1'])}")
    return "\n".join(lines)


# ── the pipeline ─────────────────────────────────────────────────────────

@dataclass
class Prepared:
    pool: "S.Pool"
    results: dict        # split -> [CaseResult]


SPLITS = ("fit", "holdout", "fit_rw", "holdout_rw")
SPLIT_NAMES = {"fit": "fit", "holdout": "holdout", "fit_rw": "fit-rw", "holdout_rw": "hold-rw"}


def prepare(case_files: Iterable[Path] = CASE_FILES, items: Optional[list] = None,
            splits: Iterable[str] = SPLITS) -> Prepared:
    """Corpus pool + featurized cases for the requested splits (the eval test only needs the holdout).

    "fit" / "holdout": the hand-labeled cases and the generated filled ones. "fit_rw" / "holdout_rw":
    the generated reworded extended / trimmed cases (reworded_cases) of the same targets, kept apart
    so the plan's holdout targets are measured on the same cases as before."""
    items = items if items is not None else corpus_items()
    pool = corpus_pool(items)
    titles = {e.id for e in pool.entries}
    cases = load_cases(case_files) + generated_cases(items)
    missing = sorted({c["target"] for c in cases if c["target"] and c["target"] not in titles})
    if missing:
        raise ValueError(f"eval cases point at prompts that aren't in the seed library: {missing[:5]}")
    wanted = set(splits)
    by_split: dict = {k: [] for k in SPLITS}
    for c in cases:
        by_split[split_of(c)].append(c)
    if wanted & {"fit_rw", "holdout_rw"}:
        for c in reworded_cases(cases, pool):
            by_split[split_of(c) + "_rw"].append(c)
    return Prepared(pool, {k: featurize(v, pool) if k in wanted else [] for k, v in by_split.items()})


GATE_FEATURES = ("one_sided", "noise", "q_more", "c_more", "q_novel_mass", "c_novel_mass", "q_gap", "c_gap",
                 "q_novel", "c_novel", "role_q_all", "role_c_all", "contain_c", "contain_q")
# The reword gate reads only what survives rewording: clauses left over after lining the two prompts'
# clauses up, clauses the other side doesn't cover, requirement words and numbers only one side has,
# length, and coverage. Nothing about how much text was copied (the same-gate has that).
REWORD_FEATURES = ("al_q", "al_c", "al_qm", "al_cm", "al_asym", "al_masym", "al_ndiff",
                   "req_q_only", "req_c_only", "req_asym", "len_signed", "len_abs", "num_q_only", "num_c_only",
                   "one_sided", "noise", "q_more", "c_more", "q_gap", "c_gap", "q_novel_mass", "c_novel_mass",
                   "q_unc", "c_unc", "q_unc_req", "c_unc_req", "q_unc_mass", "c_unc_mass", "unc_asym",
                   "unc_req_asym", "unc_mass_asym")


def is_reworded(r: "CaseResult") -> bool:
    return r.case["file"] == "generated-reworded"


def fit_on(fit_res: list, features: Iterable[str] = S.FEATURES, l2: float = L2,
           hn_weight: float = HARD_NEGATIVE_WEIGHT, verbose: bool = False) -> "S.Model":
    """Fit the match model, the same-gate, the reword gate and the thresholds on these case results only.

    Everything but the reword gate is fitted on the hand-labeled and filled cases alone, exactly as
    before the reworded cases existed; the reword gate is fitted on the target pairs of the paraphrase
    and filled cases (1) against the generated reworded extended / trimmed ones (0), and its threshold
    lets at most REWORDED_FALSE_SAME of those through as "same"."""
    features = list(features)
    rw_res = [r for r in fit_res if is_reworded(r)]
    fit_res = [r for r in fit_res if not is_reworded(r)]
    rows, labels, weights_ = [], [], []
    for r in fit_res:
        for p in r.pairs:
            rows.append([p.feats[f] for f in features])
            pos = r.case["kind"] in POSITIVE and is_target(r, p)
            labels.append(1.0 if pos else 0.0)
            weights_.append(hn_weight if (r.case["kind"] == "hard_negative" and is_target(r, p)) else 1.0)
    t0 = time.time()
    weights, bias, mean, std = fit_logistic(rows, labels, l2, sample_weights=weights_)
    # the same-gate: on target pairs, same job reworded or filled (1) vs extended / trimmed (0)
    g_rows, g_labels = [], []
    for r in fit_res:
        if r.case["kind"] not in POSITIVE:
            continue
        tp = next((p for p in r.pairs if is_target(r, p)), None)
        if tp is not None and not tp.feats.get("exact"):
            gf = S.gate_features(tp.feats, tp.gate)
            g_rows.append([gf[f] for f in GATE_FEATURES])
            g_labels.append(1.0 if r.case["kind"] in SAME_KINDS else 0.0)
    g_w, g_b, g_mean, g_std = fit_logistic(g_rows, g_labels, l2)
    # the verifier: same job (target pairs of positive kinds) vs another job on the same topic (the top pair
    # of hard negatives and novel prompts, and each positive case's best other library prompt)
    m0 = S.Model(features, mean, std, weights, bias, {"same": 1.0, "close": 1.0, "related": 0.0}, {})
    apply_model(fit_res, m0)
    v_rows, v_labels = [], []
    for r in fit_res:
        if r.case["kind"] in POSITIVE:
            tp = next((p for p in r.pairs if is_target(r, p)), None)
            if tp is not None:
                v_rows.append([tp.feats[f] for f in S.VERIFY_FEATURES])
                v_labels.append(1.0)
            other = next((p for p in r.pairs if not is_target(r, p)), None)
            if other is not None:
                v_rows.append([other.feats[f] for f in S.VERIFY_FEATURES])
                v_labels.append(0.0)
        elif r.pairs:
            v_rows.append([r.pairs[0].feats[f] for f in S.VERIFY_FEATURES])
            v_labels.append(0.0)
    v_w, v_b, v_mean, v_std = fit_logistic(v_rows, v_labels, l2)
    if verbose:
        print(f"fit: {len(rows)} pairs ({int(sum(labels))} positive) from {len(fit_res)} cases; "
              f"same-gate on {len(g_rows)} target pairs; {time.time() - t0:.1f}s")
    gate = {"salient_idf": 3.0, "features": list(GATE_FEATURES), "mean": g_mean, "std": g_std,
            "weights": g_w, "bias": g_b, "threshold": 0.5}
    verify = {"features": list(S.VERIFY_FEATURES), "mean": v_mean, "std": v_std, "weights": v_w, "bias": v_b}
    m = S.Model(features, mean, std, weights, bias, {"same": 1.0, "close": 1.0, "related": 1.0}, gate, verify)
    apply_model(fit_res, m)
    pairs = [(p.score, r.case["kind"] in POSITIVE and is_target(r, p)) for r in fit_res for p in r.pairs]
    t_related = lowest_threshold(pairs, PRECISION_FOR["related"])
    t_close = pick_close(fit_res, t_related)
    t_same, g_t = pick_same(fit_res, m, t_close, t_related)
    m.thresholds = {"same": t_same, "close": round(t_close, 6), "related": round(t_related, 6)}
    m.same_gate["threshold"] = g_t
    if rw_res:
        r_rows, r_labels = [], []
        for r in fit_res + rw_res:
            if r.case["kind"] not in POSITIVE or (not is_reworded(r) and r.case["kind"] not in SAME_KINDS):
                continue
            tp = next((p for p in r.pairs if is_target(r, p)), None)
            if tp is not None and not tp.feats.get("exact"):
                gf = S.gate_features(tp.feats, tp.gate)
                r_rows.append([gf[f] for f in REWORD_FEATURES])
                r_labels.append(0.0 if is_reworded(r) else 1.0)
        r_w, r_b, r_mean, r_std = fit_logistic(r_rows, r_labels, l2)
        m.reword_gate = {"features": list(REWORD_FEATURES), "mean": r_mean, "std": r_std, "weights": r_w,
                         "bias": r_b, "threshold": 0.0}
        apply_model(rw_res, m)
        m.reword_gate["threshold"] = pick_reword(rw_res, m)
    m.meta = {"fit": {"l2": l2, "hard_negative_weight": hn_weight, "pairs": len(rows), "positives": int(sum(labels)),
                      "gate_pairs": len(g_rows), "verify_pairs": len(v_rows), "fit_cases": len(fit_res),
                      "reworded_cases": len(rw_res), "lexicon_groups": len(S.lexicon().labels),
                      "precision_targets": PRECISION_FOR, "same_precision_labeled": SAME_PRECISION_LABELED,
                      "false_close_budget": FALSE_CLOSE_BUDGET, "reworded_false_same": REWORDED_FALSE_SAME}}
    apply_model(fit_res + rw_res, m)
    return m


def fit(prep: Prepared, l2: float = L2, verbose: bool = True, hn_weight: float = HARD_NEGATIVE_WEIGHT,
        features: Iterable[str] = S.FEATURES) -> "S.Model":
    m = fit_on(prep.results["fit"] + prep.results["fit_rw"], features, l2, hn_weight, verbose)
    m.meta["fit"].update({"holdout_cases": len(prep.results["holdout"]), "corpus_prompts": len(prep.pool.entries),
                          "reworded_fit_cases": len(prep.results["fit_rw"])})
    return m


def merge(pers: list) -> dict:
    out: dict = {}
    for per in pers:
        for k, st in per.items():
            acc = out.setdefault(k, {key: 0 for key in st})
            for key, v in st.items():
                acc[key] += v
    return out


def cross_validate(prep: Prepared, folds: int = 5, **fit_kwargs) -> dict:
    """K-fold CV inside the fit split, folds grouped by target prompt: model selection without the holdout.
    Returns {"cv": the hand-labeled + filled cases, "cv_rw": the reworded extended / trimmed ones}."""
    res = prep.results["fit"] + prep.results["fit_rw"]
    fold_of = lambda r: _h("arceo-cv:" + str(r.case["target"] or r.case["id"])) % folds  # noqa: E731
    pers: dict = {"cv": [], "cv_rw": []}
    for f in range(folds):
        train = [r for r in res if fold_of(r) != f]
        test = [r for r in res if fold_of(r) == f]
        m = fit_on(train, **fit_kwargs)
        apply_model(test, m)
        pers["cv"].append(evaluate([r for r in test if r.case["file"] != "generated-reworded"]))
        pers["cv_rw"].append(evaluate([r for r in test if r.case["file"] == "generated-reworded"]))
    return {k: merge(v) for k, v in pers.items()}


def write_weights(m: "S.Model", path: Path = S.WEIGHTS_PATH) -> None:
    path.write_text(json.dumps(m.to_dict(), indent=2, sort_keys=False) + "\n")


def run_eval(prep: Prepared, m: "S.Model", splits: Iterable[str] = SPLITS) -> dict:
    out = {}
    for sp in splits:
        apply_model(prep.results[sp], m)
        out[sp] = evaluate(prep.results[sp])
    return out


# ── extra case files (--cases-glob) ──────────────────────────────────────

def resolve_case_globs(patterns: Iterable[str]) -> list[Path]:
    """Case files for --cases-glob patterns: absolute, else relative to the working directory, else to
    tests/eval (and, for a path like backend/tests/eval/x_*.yaml given from elsewhere, its file name
    inside tests/eval). Sorted and de-duplicated; never reads a file."""
    files: set = set()
    for pat in patterns:
        tries = [pat] if os.path.isabs(pat) else [pat, str(EVAL_DIR / pat), str(EVAL_DIR / Path(pat).name)]
        for t in tries:
            hits = [Path(h) for h in globlib.glob(t) if Path(h).is_file()]
            if hits:
                files.update(h.resolve() for h in hits)
                break
    return sorted(files)


def extra_results(paths: list, pool: "S.Pool") -> tuple[list, int]:
    """(featurized cases from these files, how many point at a prompt that isn't in the library)."""
    cases = load_cases(paths)
    titles = {e.id for e in pool.entries}
    unknown = sum(1 for c in cases if c["target"] and c["target"] not in titles)
    return featurize(cases, pool), unknown


def _extra_header(paths: list, n: int, unknown: int) -> str:
    names = ", ".join(p.name for p in paths)
    return f"extra set: {n} cases from {len(paths)} file(s) ({names})" + \
        (f"; {unknown} point at a prompt that isn't in the library (always counted as misses)" if unknown else "")


# ── label conflicts (--conflicts) ────────────────────────────────────────
#
# The hand-labeled cases were written against the library as it was then. A prompt added later can
# do a "novel" case's job, be the real answer to a hard negative, or give a paraphrase a second right
# answer. label_conflicts lists every such suspect; a person reads both texts and either relabels the
# case in its file (one-line reason) or records the pair here as a reviewed false collision.

# (case id, prompt title) -> why the two are NOT the same job, after reading both. A reviewed pair
# is still listed, marked as reviewed, but no longer fails --conflicts. Reviewed 2026-11 after the
# library grew from 240 to 319 prompts; the first entry is a ranking slip between two original prompts
# (--conflicts-all), the rest are the "related" pairs scoring >= 0.05 (--conflicts-min-score 0.05).
REVIEWED_FALSE_COLLISIONS: dict = {
    ("q3-macro-trim", "Replies to comments on my post"):
        "a reusable canned support answer is the macro's job, not replies to public post comments",
    ("q1-chat-helper-hn", "Short question for a team chat"):
        "adds a live chat box to a website; the prompt rewrites a question for a team chat",
    ("q3-investor-update-hardneg-deck", "Speaker notes for my slides"):
        "outlines a new pitch deck from notes; the prompt writes what to say over existing slides",
    ("q3-novel-performance-review", "Goals for the next three months"):
        "reviews one employee's past six months; the prompt sets a team's goals for the next quarter",
    ("q3-onboarding-emails-hardneg-cancel", "Cancel a service in writing"):
        "a business asks its own cancelled users why they left; the prompt cancels a service you buy",
    ("q3-privacy-terms-hardneg-noshow", "Cancel a service in writing"):
        "writes a business's cancellation and no-show policy; the prompt cancels a service you buy",
    ("q4-review-testimonial-hn-permission", "Ask for the details I need"):
        "asks a happy reviewer's permission to quote them; the prompt asks a stuck customer for details",
}

CONFLICT_LEVELS = ("same", "close")


def unlabeled_titles(items: list, cases: Iterable[dict]) -> set:
    """Library prompts no hand-labeled case targets: the ones added after the cases were written."""
    targeted = {c["target"] for c in cases if c["target"] and c["file"] != "generated"}
    return {str(i.get("title")) for i in items if i.get("title") and str(i["title"]) not in targeted}


def label_conflicts(results: list, suspects: Optional[set] = None, levels: tuple = CONFLICT_LEVELS,
                    min_score: Optional[float] = None) -> list[dict]:
    """Hand-labeled cases (results already carry levels) whose label a library prompt may have made stale.

    A pair (case, prompt) is listed when the prompt is not the case's own target, is in `suspects`
    (None = any prompt), and
      - matches at one of `levels`, or
      - with `min_score`: matches at "related" scoring at least that much, or
      - the case is paraphrase / extended / trimmed and the prompt outranks the target (or the target
        isn't among the candidates at all) while matching at "related" or better.
    Generated "filled" cases are skipped: their prompts' own overlap is the seed near-duplicate check.
    """
    rows = []
    for r in results:
        c = r.case
        if c["file"] == "generated":
            continue
        positive = c["kind"] in POSITIVE
        t_idx = next((i for i, p in enumerate(r.pairs) if is_target(r, p)), None)
        for i, p in enumerate(r.pairs):
            if is_target(r, p) or not p.level or (suspects is not None and p.entry.id not in suspects):
                continue
            outranks = positive and (t_idx is None or i < t_idx)
            why = []
            if p.level in levels:
                why.append(f"matches at {p.level}")
            elif min_score is not None and p.score >= min_score:
                why.append(f"related, score >= {min_score}")
            if outranks:
                why.append("outranks the target" if t_idx is not None else "target not found")
            if not why:
                continue
            reviewed = REVIEWED_FALSE_COLLISIONS.get((c["id"], p.entry.id))
            rows.append({"case": c["id"], "kind": c["kind"], "file": c["file"], "split": split_of(c),
                         "target": c["target"], "prompt": p.entry.id, "level": p.level,
                         "score": round(p.score, 4), "verify": round(p.verify, 4), "target_rank": t_idx,
                         "why": "; ".join(why), "blocking": p.level in levels or outranks,
                         "reviewed": reviewed})
    return sorted(rows, key=lambda d: (d["file"], d["case"], -d["score"], d["prompt"]))


def find_conflicts(items: Optional[list] = None, m: Optional["S.Model"] = None,
                   case_files: Iterable[Path] = CASE_FILES, only_unlabeled: bool = True,
                   levels: tuple = CONFLICT_LEVELS, min_score: Optional[float] = None) -> list[dict]:
    """label_conflicts over every hand-labeled case (both splits) with model `m` (default: committed)."""
    items = items if items is not None else corpus_items()
    pool = corpus_pool(items)
    cases = load_cases(case_files)
    results = featurize(cases, pool)
    apply_model(results, m or S.model())
    suspects = unlabeled_titles(items, cases) if only_unlabeled else None
    return label_conflicts(results, suspects, levels, min_score)


def conflicts_report(rows: list, suspects_note: str) -> str:
    if not rows:
        return f"label conflicts ({suspects_note}): none"
    lines = [f"label conflicts ({suspects_note}): {len(rows)}"]
    for d in rows:
        lines.append(f"  {d['kind']:<13} {d['split']:<7} {d['case']}  (target {d['target']!r})")
        lines.append(f"      -> {d['prompt']!r}: {d['level']}, score {d['score']:.3f}, same-job {d['verify']:.3f}"
                     f", target rank {d['target_rank']}; {d['why']}"
                     + (f"  [reviewed: {d['reviewed']}]" if d["reviewed"] else ""))
    return "\n".join(lines)


def main_conflicts(args) -> int:
    t0 = time.time()
    S.set_model(None)
    items = corpus_items()
    rows = find_conflicts(items, S.model(), only_unlabeled=not args.conflicts_all,
                          min_score=args.conflicts_min_score)
    note = "any prompt other than the case's target" if args.conflicts_all else \
        "prompts no hand-labeled case targets"
    print(f"corpus {len(items)} prompts; committed weights; {time.time() - t0:.1f}s")
    print(conflicts_report(rows, note))
    open_ = [d for d in rows if d["blocking"] and not d["reviewed"]]
    if open_:
        print(f"\n{len(open_)} unreviewed: read both texts, then relabel the case or add it to "
              "REVIEWED_FALSE_COLLISIONS")
    return 1 if open_ else 0


# ── the AI second opinion (Stage 6) ──────────────────────────────────────

def _default_judge_cache() -> Path:
    """$ARCEO_SIMILARITY_JUDGE_CACHE, else the build session's scratchpad file, else the temp dir."""
    import tempfile

    env = os.getenv("ARCEO_SIMILARITY_JUDGE_CACHE")
    if env:
        return Path(env)
    scratch = Path("/private/tmp/claude-501/-Users-akashsathish/076b0285-d4cd-4658-9d76-76f328ddefd2/scratchpad")
    return (scratch if scratch.is_dir() else Path(tempfile.gettempdir())) / "judge_cache.json"


DEFAULT_JUDGE_CACHE = _default_judge_cache()
LIVE_BUDGET_S = 4.0
RELATED_CUTS = (0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7)


def load_api_key() -> bool:
    """Make ANTHROPIC_API_KEY available from a local .env if the environment lacks it. Never prints it."""
    if os.getenv("ANTHROPIC_API_KEY"):
        return True
    for env in (BACKEND / ".env", Path.home() / "ActionGate" / "backend" / ".env"):
        try:
            lines = env.read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            m = re.match(r"\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.*)$", line)
            if m:
                val = m.group(1).strip().strip('"\'')
                if val:
                    os.environ["ANTHROPIC_API_KEY"] = val
                    return True
    return False


def related_ask_table(results: list) -> str:
    """Where the best "related" candidate lands when nothing is close or same: is it the right prompt?

    This is the data behind similarity_judge.RELATED_ASK (which "related" candidate gets asked about)."""
    rows = []
    for r in results:
        matches = S.order([p for p in r.pairs if p.level])
        if not matches or matches[0].level != "related":
            continue
        top = max((p for p in matches if p.level == "related"), key=lambda p: (p.score, p.entry.id))
        rows.append((top.score, r.case["kind"] in POSITIVE and is_target(r, top)))
    lines = ["best candidate only 'related': is it the right prompt?   cut   right  wrong   (below: right  wrong)"]
    for cut in RELATED_CUTS:
        a = sum(1 for s, ok in rows if s >= cut and ok)
        b = sum(1 for s, ok in rows if s >= cut and not ok)
        c = sum(1 for s, ok in rows if s < cut and ok)
        d = sum(1 for s, ok in rows if s < cut and not ok)
        lines.append(f"{'':<56}{cut:5.2f}  {a:>5}  {b:>5}   {'':<7}{c:>5}  {d:>5}")
    return "\n".join(lines)


def _levels(results: list) -> dict:
    return {(r.case["id"], p.entry.id): p.level for r in results for p in r.pairs}


def judge_changes(results: list, before: dict) -> str:
    """What the second opinion changed, split by whether the pair is the case's real target."""
    from collections import Counter
    c: Counter = Counter()
    for r in results:
        kind = r.case["kind"]
        for p in r.pairs:
            old = before.get((r.case["id"], p.entry.id))
            if old == p.level:
                if p.judged:
                    c[f"kept {old} ({'target' if is_target(r, p) else 'other'}, said {p.judged})"] += 1
                continue
            who = "target" if is_target(r, p) else "other"
            c[f"{old} -> {p.level}: {kind} {who}"] += 1
    return "\n".join(f"  {n:>4}  {k}" for k, n in sorted(c.items(), key=lambda x: (-x[1], x[0]))) or "  (none)"


def run_judge(results: list, *, budget_s: float, cache, min_verify: Optional[float], workers: int = 4) -> dict:
    """similarity_judge.review on every case, as match_draft(mode="save") would; returns merged call stats."""
    from . import similarity_judge as J

    def one(r: CaseResult) -> dict:
        q = r.case["query"]
        canon = S.canonical(q["body"], q["title"], q["description"], q["use_case"])
        stats: dict = {}
        if canon.content_len >= S.MIN_CONTENT_TOKENS:
            pairs = S.order([p for p in r.pairs if p.level])
            # meter=False: an offline eval on a developer key is not product COGS
            J.review(pairs, canon, q, None, None, budget_s=budget_s, cache=cache, stats=stats,
                     min_verify=min_verify, meter=False)
        return stats

    merged: dict = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        for st in ex.map(one, results):
            for k, v in st.items():
                if isinstance(v, list):
                    merged.setdefault(k, []).extend(v)
                else:
                    merged[k] = merged.get(k, 0) + v
    return merged


def _cost(input_tokens: int, output_tokens: int) -> float:
    try:
        import cogs
        from llm_models import FAST_MODEL
        usd = cogs.price(FAST_MODEL, {"input_tokens": input_tokens, "output_tokens": output_tokens})
        if usd > 0 or not (input_tokens or output_tokens):
            return usd
    except Exception:  # noqa: BLE001 - fall back to Haiku 4.5 list prices
        pass
    return input_tokens / 1e6 * 1.0 + output_tokens / 1e6 * 5.0


def _pct(xs: list, q: float) -> int:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * q))] if xs else 0


def judge_report(stats: dict, log: list) -> str:
    lat = stats.get("latency_ms") or []
    tin, tout = int(stats.get("input_tokens", 0)), int(stats.get("output_tokens", 0))
    lines = [f"judge calls {int(stats.get('calls', 0))} this run (drafts asked {int(stats.get('drafts_asked', 0))}, "
             f"candidates asked {int(stats.get('candidates_asked', 0))}, answered from cache "
             f"{int(stats.get('cached', 0))}; timeouts {int(stats.get('timeouts', 0))}, errors "
             f"{int(stats.get('errors', 0))}, no key {int(stats.get('no_key', 0))}, unusable answers "
             f"{int(stats.get('unparsed', 0))})",
             f"this run: {tin} input + {tout} output tokens, estimated cost ${_cost(tin, tout):.4f}"]
    if lat:
        over = sum(1 for x in lat if x > LIVE_BUDGET_S * 1000)
        lines.append(f"latency this run: p50 {_pct(lat, 0.5)} ms, p90 {_pct(lat, 0.9)} ms, max {max(lat)} ms; "
                     f"{over} of {len(lat)} calls over the live {LIVE_BUDGET_S:.0f} s budget")
    if log:
        ain = sum(c.get("input_tokens", 0) for c in log)
        aout = sum(c.get("output_tokens", 0) for c in log)
        alat = [c.get("latency_ms", 0) for c in log]
        over = sum(1 for x in alat if x > LIVE_BUDGET_S * 1000)
        lines.append(f"cache file holds answers from {len(log)} calls: {ain} input + {aout} output tokens, "
                     f"estimated cost ${_cost(ain, aout):.4f} (${_cost(ain, aout) / len(log):.5f} per call); "
                     f"latency p50 {_pct(alat, 0.5)} ms, p90 {_pct(alat, 0.9)} ms, {over} over "
                     f"{LIVE_BUDGET_S:.0f} s")
    return "\n".join(lines)


def main_judge(args) -> int:
    from . import similarity_judge as J

    have_key = load_api_key()
    splits = ("fit", "holdout") if args.judge_split == "both" else (args.judge_split,)
    t0 = time.time()
    prep = prepare(splits=splits)
    S.set_model(None)
    m = S.model()
    extra: dict = {}
    if args.sealed:
        extra["sealed"] = featurize(load_cases([p for p in SEALED_FILES if p.exists()]), prep.pool)
    if args.cases_glob:
        files = resolve_case_globs(args.cases_glob)
        if not files:
            print(f"--cases-glob matched no files: {args.cases_glob}", file=sys.stderr)
            return 2
        extra["extra"], unknown = extra_results(files, prep.pool)
        print(_extra_header(files, len(extra["extra"]), unknown))
    print(f"corpus {len(prep.pool.entries)} prompts; judging {', '.join([*splits, *extra])}; "
          f"featurized in {time.time() - t0:.1f}s")
    print(f"thresholds {m.thresholds}  gate threshold {m.same_gate.get('threshold')}")
    min_verify = J.PROMOTE_MIN_VERIFY if args.judge_min_verify is None else (
        None if args.judge_min_verify < 0 else args.judge_min_verify)
    print(f"second opinion: every 'same' that isn't an exact copy, then close candidates, up to {J.MAX_ASK} in "
          f"all, else the best related one scoring >= {J.RELATED_ASK}; 'yes' promotes to same "
          + ("always" if min_verify is None else f"only when the same-job probability >= {min_verify}"))
    if not have_key:
        print("no ANTHROPIC_API_KEY found: only cached answers can be used")
    cache = J.VerdictCache(size=1_000_000)
    meta = cache.load(args.judge_cache) if args.judge_cache else {}
    log = list(meta.get("calls") or [])
    status = 0
    sets = {**{sp: prep.results[sp] for sp in splits}, **extra}
    for name, results in sets.items():
        apply_model(results, m)
        print()
        print(related_ask_table(results))
        before_per = evaluate(results)
        before = _levels(results)
        print()
        print(table(name, before_per))
        stats = run_judge(results, budget_s=args.judge_budget, cache=cache, min_verify=min_verify,
                          workers=args.judge_workers)
        new_calls = [{"input_tokens": 0, "output_tokens": 0, "latency_ms": x} for x in stats.get("latency_ms", [])]
        if new_calls:   # spread the run's tokens over its calls (the per-call split isn't kept)
            n = len(new_calls)
            for c in new_calls:
                c["input_tokens"] = int(stats.get("input_tokens", 0)) // n
                c["output_tokens"] = int(stats.get("output_tokens", 0)) // n
            log.extend(new_calls)
        if args.judge_cache:
            cache.dump(args.judge_cache, {"calls": log})
        after_per = evaluate(results)
        print()
        print(table(name + "+AI", after_per))
        print(judge_report(stats, log))
        print("what the second opinion changed:")
        print(judge_changes(results, before))
        if name == "holdout":
            fails = targets_failed(summary(after_per))
            print("\nholdout targets with the second opinion: " + ("all met" if not fails else
                                                                   "MISSED: " + "; ".join(fails)))
            status = 1 if fails else status
        elif name in ("sealed", "extra"):
            for label, per_ in (("without", before_per), ("with", after_per)):
                fails = targets_failed(summary(per_))
                print(f"{name} set against the holdout targets, {label} the second opinion: "
                      + ("all met" if not fails else "MISSED: " + "; ".join(fails)))
    return status


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--eval", action="store_true", help="score the committed weights; write nothing")
    ap.add_argument("--sealed", action="store_true", help="also score the sealed held-out case files")
    ap.add_argument("--no-write", action="store_true", help="fit but don't write similarity_weights.json")
    ap.add_argument("--l2", type=float, default=L2)
    ap.add_argument("--hn-weight", type=float, default=HARD_NEGATIVE_WEIGHT)
    ap.add_argument("--cv", action="store_true", help="also print 5-fold cross-validation inside the fit split")
    ap.add_argument("--judge", action="store_true",
                    help="committed weights + the AI second opinion on Save (calls Claude Haiku; writes no weights)")
    ap.add_argument("--judge-split", choices=("fit", "holdout", "both"), default="holdout")
    ap.add_argument("--judge-cache", type=Path, default=DEFAULT_JUDGE_CACHE,
                    help="JSON file of cached answers, so reruns are free")
    ap.add_argument("--judge-budget", type=float, default=30.0,
                    help="seconds per draft in the eval (live Saves use 4 s; misses are reported)")
    ap.add_argument("--judge-min-verify", type=float, default=None,
                    help="'yes' promotes only at this same-job probability (negative = always); "
                         "default: similarity_judge.PROMOTE_MIN_VERIFY")
    ap.add_argument("--judge-workers", type=int, default=4)
    ap.add_argument("--cases-glob", action="append", default=[],
                    help="extra case files scored as their own set, never fitted on (glob: absolute, "
                         "relative to the working directory, or to tests/eval); repeatable; works with "
                         "fitting, --eval and --judge")
    ap.add_argument("--conflicts", action="store_true",
                    help="list hand-labeled cases a newer library prompt may have made stale (committed "
                         "weights; writes nothing; exits 1 while any close/same match or outranked target is unreviewed)")
    ap.add_argument("--conflicts-all", action="store_true",
                    help="with --conflicts: consider every prompt other than the case's target, not only "
                         "prompts no hand-labeled case targets")
    ap.add_argument("--conflicts-min-score", type=float, default=None,
                    help="with --conflicts: also list 'related' matches scoring at least this much")
    args = ap.parse_args(argv)
    if args.conflicts:
        return main_conflicts(args)
    if args.judge:
        return main_judge(args)
    extra_files = resolve_case_globs(args.cases_glob) if args.cases_glob else []
    if args.cases_glob and not extra_files:
        print(f"--cases-glob matched no files: {args.cases_glob}", file=sys.stderr)
        return 2
    t0 = time.time()
    prep = prepare()
    print(f"corpus {len(prep.pool.entries)} prompts; cases fit {len(prep.results['fit'])}, "
          f"holdout {len(prep.results['holdout'])}; reworded extended/trimmed fit {len(prep.results['fit_rw'])}, "
          f"holdout {len(prep.results['holdout_rw'])}; featurized in {time.time() - t0:.1f}s")
    if args.eval:
        S.set_model(None)
        m = S.model()
    else:
        m = fit(prep, args.l2, hn_weight=args.hn_weight)
        if not args.no_write:
            write_weights(m)
            print(f"wrote {S.WEIGHTS_PATH.name}")
        S.set_model(m)
    print(f"thresholds {m.thresholds}  gate threshold {m.same_gate.get('threshold')}")
    if args.cv:
        cv = cross_validate(prep, l2=args.l2, hn_weight=args.hn_weight)
        print()
        print(table("cv", cv["cv"]))
        print(table("cv-rw", cv["cv_rw"]))
    per = run_eval(prep, m)
    for sp in SPLITS:
        print()
        print(table(SPLIT_NAMES[sp], per[sp]))
    status = 0
    fails = targets_failed(summary(per["holdout"]))
    print("\nholdout targets: " + ("all met" if not fails else "MISSED: " + "; ".join(fails)))
    if fails:
        status = 1
    if args.sealed:
        existing = [p for p in SEALED_FILES if p.exists()]
        if existing:
            sealed = featurize(load_cases(existing), prep.pool)
            apply_model(sealed, m)
            print()
            print(table("sealed", evaluate(sealed)))
    if extra_files:
        extra, unknown = extra_results(extra_files, prep.pool)
        apply_model(extra, m)
        per_x = evaluate(extra)
        print()
        print(_extra_header(extra_files, len(extra), unknown))
        print(table("extra", per_x))
        fails = targets_failed(summary(per_x))
        print("extra set against the holdout targets: " + ("all met" if not fails else "MISSED: " + "; ".join(fails)))
    return status


if __name__ == "__main__":
    sys.exit(main())
