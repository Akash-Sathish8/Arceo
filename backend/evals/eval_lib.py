"""Shared eval logic: load labeled cases, classify them, compute per-label metrics.

Three modes:
  deterministic — LLM layer stubbed to None (keyword/catalog/primitive layers only).
                  Cases marked requires_llm are reported but not gated.
  fixtures      — LLM layer replays recorded responses from llm_fixtures.json.
                  Deterministic and keyless; this is what CI gates on.
  live          — real Anthropic API (manual runs only).

Fixture keys are human-readable "action||description" so diffs are reviewable.
Cases marked known_miss are always excluded from gating but always reported —
they document taxonomy-hard cases we refuse to relabel just to stay green.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

EVAL_CASES_PATH = os.path.join(BACKEND_DIR, "tests", "eval", "classifier_eval.jsonl")
FIXTURES_PATH = os.path.join(BACKEND_DIR, "tests", "eval", "llm_fixtures.json")
THRESHOLDS_PATH = os.path.join(BACKEND_DIR, "tests", "eval", "thresholds.json")

ALL_LABELS = ["moves_money", "touches_pii", "deletes_data", "sends_external", "changes_production"]


@dataclass
class EvalCase:
    id: str
    tool: str
    action: str
    description: str
    input_schema_keys: list = field(default_factory=list)
    expected_labels: list = field(default_factory=list)
    expected_reversible: bool = True
    requires_llm: bool = False
    known_miss: bool = False
    notes: str = ""


def fixture_key(action: str, description: str = "") -> str:
    return f"{action}||{description}"


def load_cases(path: str = EVAL_CASES_PATH) -> list[EvalCase]:
    cases = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            raw = json.loads(line)
            cases.append(EvalCase(**raw))
    ids = [c.id for c in cases]
    assert len(ids) == len(set(ids)), "duplicate case ids in eval set"
    return cases


def load_fixtures(path: str = FIXTURES_PATH) -> dict:
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def make_llm_stub(fixtures: dict, missing: list | None = None):
    """A drop-in replacement for classify_with_llm. Fixture miss returns None —
    the 'LLM unavailable' path — NOT [] (which would read as affirmative-benign
    and veto weak labels). See plan: None != []."""

    def stub(action_name: str, description: str = "", schema_props=None, candidates=None):
        key = fixture_key(action_name, description)
        hit = fixtures.get(key)
        if hit is None:
            if missing is not None:
                missing.append(key)
            return None
        return list(hit["labels"]), bool(hit["reversible"])

    return stub


def _schema_from_keys(keys: list) -> dict | None:
    if not keys:
        return None
    return {"properties": {k: {"type": "string"} for k in keys}}


def run_cases(cases: list[EvalCase], mode: str = "fixtures", fixtures: dict | None = None) -> list[dict]:
    """Classify every case under the given mode; returns per-case result dicts."""
    import authority.risk_classifier as rc

    original = rc.classify_with_llm
    missing: list[str] = []
    if mode == "deterministic":
        rc.classify_with_llm = lambda *a, **k: None
    elif mode == "fixtures":
        rc.classify_with_llm = make_llm_stub(fixtures if fixtures is not None else load_fixtures(), missing)
    elif mode == "live":
        pass
    else:
        raise ValueError(f"unknown mode: {mode}")

    results = []
    try:
        rc._llm_cache.clear()
        for c in cases:
            mapped = rc.classify_with_fallback(
                c.tool, c.action, c.description, _schema_from_keys(c.input_schema_keys)
            )
            got = sorted(mapped.risk_labels)
            exp = sorted(c.expected_labels)
            results.append({
                "id": c.id,
                "tool": c.tool,
                "action": c.action,
                "expected_labels": exp,
                "got_labels": got,
                "expected_reversible": c.expected_reversible,
                "got_reversible": mapped.reversible,
                "labels_match": got == exp,
                "reversible_match": mapped.reversible == c.expected_reversible,
                "requires_llm": c.requires_llm,
                "known_miss": c.known_miss,
                "classification_source": getattr(mapped, "classification_source", None),
            })
    finally:
        rc.classify_with_llm = original
        rc._llm_cache.clear()

    if mode == "fixtures":
        for r in results:
            r["_missing_fixture"] = False
        missing_set = set(missing)
        for r, c in zip(results, cases):
            if fixture_key(c.action, c.description) in missing_set:
                r["_missing_fixture"] = True
    return results


def gated(results: list[dict], mode: str) -> list[dict]:
    """The subset of results that count toward the CI gate for this mode."""
    out = [r for r in results if not r["known_miss"]]
    if mode == "deterministic":
        out = [r for r in out if not r["requires_llm"]]
    return out


def compute_metrics(results: list[dict]) -> dict:
    per_label = {l: {"tp": 0, "fp": 0, "fn": 0} for l in ALL_LABELS}
    exact = 0
    rev_ok = 0
    for r in results:
        exp, got = set(r["expected_labels"]), set(r["got_labels"])
        for l in ALL_LABELS:
            if l in got and l in exp:
                per_label[l]["tp"] += 1
            elif l in got:
                per_label[l]["fp"] += 1
            elif l in exp:
                per_label[l]["fn"] += 1
        if r["labels_match"]:
            exact += 1
        if r["reversible_match"]:
            rev_ok += 1

    for l, m in per_label.items():
        tp, fp, fn = m["tp"], m["fp"], m["fn"]
        m["precision"] = round(tp / (tp + fp), 4) if tp + fp else 1.0
        m["recall"] = round(tp / (tp + fn), 4) if tp + fn else 1.0
        p, rcl = m["precision"], m["recall"]
        m["f1"] = round(2 * p * rcl / (p + rcl), 4) if p + rcl else 0.0

    n = len(results)
    return {
        "n": n,
        "exact_match": round(exact / n, 4) if n else 0.0,
        "reversibility_accuracy": round(rev_ok / n, 4) if n else 0.0,
        "per_label": per_label,
    }


def check_thresholds(metrics: dict, thresholds: dict) -> list[str]:
    """Return a list of violations ('' means pass)."""
    failures = []
    for label, floors in thresholds.get("per_label", {}).items():
        got = metrics["per_label"].get(label, {})
        for metric_name, floor in floors.items():
            val = got.get(metric_name)
            if val is not None and val < floor:
                failures.append(f"{label}.{metric_name}: {val} < floor {floor}")
    for k in ("exact_match", "reversibility_accuracy"):
        if k in thresholds and metrics.get(k, 0) < thresholds[k]:
            failures.append(f"{k}: {metrics[k]} < floor {thresholds[k]}")
    return failures
