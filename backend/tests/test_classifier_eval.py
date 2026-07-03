"""CI gate: classifier accuracy measured against the hand-labeled eval set.

Runs in fixtures mode (recorded LLM responses, keyless, deterministic) and
asserts per-label precision/recall stay above the floors in thresholds.json.
Floors are a ratchet: they encode the last measured level; improvements raise
them, regressions fail here.
"""

from __future__ import annotations

import json
import os

from evals.eval_lib import (
    ALL_LABELS, THRESHOLDS_PATH, check_thresholds, compute_metrics, fixture_key,
    gated, load_cases, load_fixtures, run_cases,
)

from authority.action_mapper import ACTION_CATALOG


def test_eval_set_is_well_formed():
    cases = load_cases()
    assert len(cases) >= 150
    for c in cases:
        assert set(c.expected_labels) <= set(ALL_LABELS), f"{c.id}: bad label"
        assert c.tool and c.action, f"{c.id}: missing tool/action"


def test_fixture_coverage_for_llm_dependent_cases():
    """Every case whose correctness depends on the LLM must have a recorded
    fixture — otherwise the fixtures-mode metrics silently degrade to the
    deterministic path and the gate measures the wrong thing."""
    fixtures = load_fixtures()
    missing = []
    for c in load_cases():
        if not c.requires_llm:
            continue
        if ACTION_CATALOG.get(c.tool, {}).get(c.action) is not None:
            continue  # catalog hit — LLM never consulted
        if fixture_key(c.action, c.description) not in fixtures:
            missing.append(c.id)
    assert not missing, (
        f"{len(missing)} requires_llm cases lack fixtures (run evals/regen_fixtures.py): {missing}"
    )


def test_metrics_meet_thresholds():
    cases = load_cases()
    results = run_cases(cases, mode="fixtures")
    metrics = compute_metrics(gated(results, "fixtures"))
    with open(THRESHOLDS_PATH) as f:
        thresholds = json.load(f)
    failures = check_thresholds(metrics, thresholds)
    assert not failures, "classifier metrics regressed below floors:\n" + "\n".join(failures)


def test_eval_is_deterministic():
    """Two runs over the same fixtures must produce identical results."""
    cases = load_cases()
    a = run_cases(cases, mode="fixtures")
    b = run_cases(cases, mode="fixtures")
    for ra, rb in zip(a, b):
        assert ra["got_labels"] == rb["got_labels"], f"{ra['id']} nondeterministic"
        assert ra["got_reversible"] == rb["got_reversible"], f"{ra['id']} nondeterministic"
