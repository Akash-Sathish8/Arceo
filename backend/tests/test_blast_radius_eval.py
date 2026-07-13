"""CI gate for the blast-radius accuracy eval (evals/blast_eval.py).

Grades the full pipeline — classified labels -> chains -> score -> band ->
scan verdict — against the hand-authored answer key and the four incident
archetypes. Only ADJUDICATED answer-key entries gate (pending entries are
drafts awaiting the founder session); archetypes marked known_miss are
documented formula gaps whose BAND is exempt — their chains and score floors
still gate, same philosophy as classifier_eval's known_miss cases.

Everything here is keyless and deterministic: the conftest autouse stub
already replays llm_fixtures.json, and blast_eval installs the same stub for
its own runs.
"""

import json

import pytest

from evals.blast_eval import (
    BLAST_THRESHOLDS_PATH,
    BlastEvalEntry,
    check_blast_thresholds,
    compute_blast_metrics,
    load_answer_key,
    load_archetypes,
    run_archetypes,
    run_key,
)


@pytest.fixture(scope="module")
def key_run():
    """One shared fixtures-mode run: (results, archetype results, fixture misses)."""
    missing: list[str] = []
    results = run_key("fixtures", missing_out=missing)
    archetypes = run_archetypes("fixtures", missing_out=missing)
    return results, archetypes, sorted(set(missing))


def test_answer_key_is_well_formed():
    """load_answer_key/load_archetypes assert ids, bands, verdicts, chain ids,
    severities, and ranges — a malformed key fails loudly here, not mid-run."""
    entries = load_answer_key()
    assert len(entries) >= 30, "answer key lost entries"
    assert any(e.is_gated for e in entries), "no adjudicated entries — nothing gates"
    archetypes = load_archetypes()
    assert len(archetypes) == 4


def test_all_entries_score_and_only_pending_manifests_skip(key_run):
    """Every entry must build and score; the only legitimate skip is a PENDING
    manifest entry whose extraction hasn't been frozen yet. run_key itself
    asserts a gated entry never skips — this guards the skip *reason* too."""
    results, _, _ = key_run
    for r in results:
        if r["skipped"]:
            assert not r["entry"].is_gated, f"{r['id']}: gated entries may never skip"
            assert "extracted_manifests" in r["skip_reason"], (
                f"{r['id']}: only missing-manifest skips are legitimate, got: {r['skip_reason']}"
            )
        else:
            assert 0 <= r["score"] <= 100


def test_gated_entry_with_missing_manifest_fails_loudly(monkeypatch):
    """The ratchet must not silently shrink: an adjudicated manifest entry whose
    frozen manifest disappears breaks the run instead of becoming a skip."""
    import evals.blast_eval as be

    gated_orphan = BlastEvalEntry(
        id="gated-orphan", source="manifest", ref="does_not_exist",
        expected_band="high", expected_verdict="warn", adjudicated="2026-07-12",
    )
    monkeypatch.setattr(be, "load_answer_key", lambda path=None: [gated_orphan])
    with pytest.raises(AssertionError, match="adjudicated but its frozen manifest is missing"):
        be.run_key("fixtures")


def test_gated_metrics_meet_thresholds(key_run):
    """The ratchet: adjudicated entries must stay at/above the recorded floors,
    and fixture coverage must not decay (misses are ceilinged — a miss replays
    as keyword-only, silently turning fixtures mode into deterministic mode).
    Today the gated set is the two calibrate_fleet anchors; the founder
    adjudication session expands it (PR 3)."""
    results, _, fixture_misses = key_run
    gated = compute_blast_metrics(results, gated_only=True)
    assert gated["n"] >= 2, "gated subset shrank below the two anchors"
    gated["fixture_misses"] = len(fixture_misses)
    with open(BLAST_THRESHOLDS_PATH, encoding="utf-8") as f:
        thresholds = json.load(f)
    failures = check_blast_thresholds(gated, thresholds)
    assert not failures, "blast-radius eval ratchet violations:\n" + "\n".join(failures)


def test_incident_archetypes_land_critical(key_run):
    """Agents shaped like real incidents must read critical, with the incident
    citation in the failure message. known_miss archetypes are measured formula
    gaps (EchoLeak/ShadowLeak-shaped read+exfil agents score medium): their
    BAND is exempt, but every expected chain must still fire and their score
    must hold the recorded min_score floor so a further decay can't hide."""
    _, archetypes, _ = key_run
    for a in archetypes:
        assert not a["chain_misses"], (
            f"{a['id']} chain misses: {a['chain_misses']} — the chain layer is the "
            f"non-negotiable detection here. Incident: {a['citation']}"
        )
        if a["known_miss"]:
            assert a["score"] >= a["min_score"], (
                f"{a['id']} decayed to {a['score']} (< floor {a['min_score']}) — the "
                f"known formula gap got WORSE. Incident: {a['citation']}"
            )
            assert a["band"] != "critical", (
                f"{a['id']} now lands critical — the formula gap is fixed! Remove "
                f"known_miss from incident_archetypes.json so this becomes gated."
            )
            continue
        assert a["band_ok"], (
            f"{a['id']} scored {a['score']} ({a['band']}), expected critical. "
            f"An agent shaped like this incident must read critical: {a['citation']}"
        )


def test_eval_is_deterministic(key_run):
    """Two runs, identical outcomes — the eval must be replayable in CI."""
    def snapshot(results):
        return [
            (r["id"], r["skipped"], r.get("score"), r.get("band"), r.get("verdict"),
             tuple(sorted(r.get("fired_chains", {}).items())))
            for r in results
        ]

    first, _, _ = key_run
    assert snapshot(first) == snapshot(run_key("fixtures"))


def test_thresholds_reject_missing_metrics_and_empty_gate():
    """A renamed metric or an empty gated set must trip the ratchet, not
    silently disarm it."""
    failures = check_blast_thresholds({"n": 5}, {"floors": {"band_exact": 1.0}})
    assert failures and "missing from results" in failures[0]
    failures = check_blast_thresholds({"n": 0}, {"floors": {"band_exact": 1.0}})
    assert failures and "empty" in failures[0]


def test_verdict_simulation_matches_honest_gate_semantics():
    """Unit-pin the /api/scan verdict mirror: hard failure modes dominate the
    score; the score only separates warn from pass."""
    from evals.blast_eval import simulate_scan_verdict

    assert simulate_scan_verdict(10, critical_chains=1, has_exec_code=False,
                                 unclassified=0, total_actions=10) == "fail"
    assert simulate_scan_verdict(10, 0, True, 0, 10) == "fail"
    assert simulate_scan_verdict(10, 0, False, 3, 10) == "fail"  # 30% opaque
    assert simulate_scan_verdict(95, 0, False, 0, 10) == "warn"  # high score alone: warn
    assert simulate_scan_verdict(40, 0, False, 2, 10) == "warn"  # 20% opaque: not opaque-fail
    assert simulate_scan_verdict(39, 0, False, 0, 10) == "pass"
