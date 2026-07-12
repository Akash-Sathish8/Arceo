"""CI gate for the blast-radius accuracy eval (evals/blast_eval.py).

Grades the full pipeline — classified labels -> chains -> score -> band ->
scan verdict — against the hand-authored answer key and the four incident
archetypes. Only ADJUDICATED answer-key entries gate (pending entries are
drafts awaiting the founder session); archetypes marked known_miss are
documented formula gaps, reported but not gated, same philosophy as
classifier_eval's known_miss cases.

Everything here is keyless and deterministic: the conftest autouse stub
already replays llm_fixtures.json, and blast_eval installs the same stub for
its own runs.
"""

import json

from evals.blast_eval import (
    BLAST_THRESHOLDS_PATH,
    check_blast_thresholds,
    compute_blast_metrics,
    load_answer_key,
    load_archetypes,
    run_archetypes,
    run_key,
)


def test_answer_key_is_well_formed():
    """load_answer_key/load_archetypes assert ids, bands, verdicts, chain ids,
    severities, and ranges — a malformed key fails loudly here, not mid-run."""
    entries = load_answer_key()
    assert len(entries) >= 30, "answer key lost entries"
    assert any(e.is_gated for e in entries), "no adjudicated entries — nothing gates"
    archetypes = load_archetypes()
    assert len(archetypes) == 4


def test_parser_and_anchor_entries_all_score():
    """Every parser/anchor entry must build and score — a skipped one means the
    answer key references a SAMPLE_CONFIG that no longer exists."""
    results = run_key("fixtures")
    for r in results:
        if r["skipped"]:
            assert "extracted_manifests" in r["skip_reason"], (
                f"{r['id']}: only missing-manifest skips are legitimate, got: {r['skip_reason']}"
            )
        else:
            assert 0 <= r["score"] <= 100


def test_gated_metrics_meet_thresholds():
    """The ratchet: adjudicated entries must stay at/above the recorded floors.
    Today that is the two calibrate_fleet anchors; the founder adjudication
    session expands the gated set (PR 3)."""
    results = run_key("fixtures")
    gated = compute_blast_metrics(results, gated_only=True)
    assert gated["n"] >= 2, "gated subset shrank below the two anchors"
    with open(BLAST_THRESHOLDS_PATH) as f:
        thresholds = json.load(f)
    failures = check_blast_thresholds(gated, thresholds)
    assert not failures, "blast-radius eval ratchet violations:\n" + "\n".join(failures)


def test_incident_archetypes_land_critical():
    """Agents shaped like real incidents must read critical, with the incident
    citation in the failure message. known_miss archetypes are measured formula
    gaps (EchoLeak/ShadowLeak-shaped read+exfil agents score medium) — they are
    reported by the CLI, tracked in incident_archetypes.json, and must still
    fire every expected chain even while the band misses."""
    for a in run_archetypes("fixtures"):
        assert not a["chain_misses"], (
            f"{a['id']} chain misses: {a['chain_misses']} — the chain layer is the "
            f"non-negotiable detection here. Incident: {a['citation']}"
        )
        if a["known_miss"]:
            assert a["band"] != "critical", (
                f"{a['id']} now lands critical — the formula gap is fixed! Remove "
                f"known_miss from incident_archetypes.json so this becomes gated."
            )
            continue
        assert a["band_ok"], (
            f"{a['id']} scored {a['score']} ({a['band']}), expected critical. "
            f"An agent shaped like this incident must read critical: {a['citation']}"
        )


def test_eval_is_deterministic():
    """Two runs, identical outcomes — the eval must be replayable in CI."""
    def snapshot(results):
        return [
            (r["id"], r["skipped"], r.get("score"), r.get("band"), r.get("verdict"),
             tuple(sorted(r.get("fired_chains", {}).items())))
            for r in results
        ]

    assert snapshot(run_key("fixtures")) == snapshot(run_key("fixtures"))


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
