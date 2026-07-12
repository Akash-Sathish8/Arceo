"""CLI for the blast-radius accuracy eval (see blast_eval.py).

  cd backend && python evals/run_blast_eval.py                     # fixtures mode, summary
  cd backend && python evals/run_blast_eval.py --verbose           # + per-agent rows
  cd backend && python evals/run_blast_eval.py --mode deterministic
  cd backend && python evals/run_blast_eval.py --decompose         # fixtures vs deterministic vs gold
  cd backend && python evals/run_blast_eval.py --check             # exit 1 on ratchet violation (CI semantics)
  cd backend && python evals/run_blast_eval.py --baseline evals/blast_baseline_report.json
  cd backend && python evals/run_blast_eval.py --propose           # founder adjudication worksheet

All modes are keyless and deterministic. Gated metrics cover only adjudicated
answer-key entries; pending entries and skipped manifests are report-only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from evals.blast_eval import (  # noqa: E402
    BLAST_THRESHOLDS_PATH,
    check_blast_thresholds,
    compute_blast_metrics,
    decompose,
    run_archetypes,
    run_key,
)


def _print_metrics(title: str, m: dict) -> None:
    print(f"\n== {title} ==")
    for k, v in m.items():
        if k == "band_confusion":
            continue
        print(f"  {k:20s} {v}")


def _print_rows(results: list[dict]) -> None:
    for r in results:
        if r["skipped"]:
            print(f"  {r['id']:32s} SKIPPED — {r['skip_reason']}")
            continue
        e = r["entry"]
        marks = []
        if not r["band_exact"]:
            marks.append("BAND")
        if r["chain_misses"]:
            marks.append("CHAINS(" + "; ".join(r["chain_misses"]) + ")")
        if r["chain_false_fires"]:
            marks.append("FALSE-FIRE(" + ",".join(r["chain_false_fires"]) + ")")
        if not r["verdict_match"]:
            marks.append("VERDICT")
        gate = "gated" if e.is_gated else "pending"
        print(f"  {r['id']:32s} score={r['score']:3d} band={r['band']:8s} exp={e.expected_band:8s} "
              f"verdict={r['verdict']:4s}/{e.expected_verdict:4s} uncl={r['unclassified']}/{r['total_actions']} "
              f"[{gate}] {' '.join(marks)}")


def _print_archetypes(archetypes: list[dict]) -> None:
    print("\n== incident archetypes ==")
    for a in archetypes:
        status = "OK" if (a["band_ok"] and not a["chain_misses"]) else "MISS"
        if status == "MISS" and a.get("known_miss"):
            status = "KNOWN-MISS"
        print(f"  {a['id']:20s} score={a['score']:3d} band={a['band']:8s} {status} "
              f"fired={sorted(a['fired_chains'])}")
        if status != "OK":
            print(f"      incident: {a['citation']}")
            for miss in a["chain_misses"]:
                print(f"      chain miss: {miss}")


def _propose(results: list[dict]) -> None:
    """The founder adjudication worksheet: current pipeline output next to the
    draft truth, one block per pending entry, ready to confirm or edit."""
    pending = [r for r in results if not r["skipped"] and not r["entry"].is_gated]
    print(f"\n== ADJUDICATION WORKSHEET — {len(pending)} pending entries ==")
    print("For each: confirm or edit expected_band / must_fire_chains in "
          "tests/eval/blast_answer_key.jsonl, then set adjudicated to today's date.\n")
    for r in pending:
        e = r["entry"]
        print(f"--- {e.id}  (source={e.source}, truth={e.truth_source})")
        print(f"    draft truth : band={e.expected_band} range={e.expected_range} verdict={e.expected_verdict}")
        print(f"    pipeline now: band={r['band']} score={r['score']} verdict={r['verdict']} "
              f"unclassified={r['unclassified']}/{r['total_actions']}")
        print(f"    chains fired: {sorted(r['fired_chains'].items())}")
        if e.notes:
            print(f"    notes       : {e.notes}")
        print()
    skipped = [r for r in results if r["skipped"]]
    if skipped:
        print(f"({len(skipped)} manifest entries skipped — run evals/snapshot_manifests.py "
              f"with ANTHROPIC_API_KEY to freeze their tool manifests first.)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mode", choices=["fixtures", "deterministic", "gold"], default="fixtures")
    ap.add_argument("--check", action="store_true", help="exit 1 on ratchet violation")
    ap.add_argument("--baseline", metavar="PATH", help="write full JSON report to PATH")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--decompose", action="store_true",
                    help="run fixtures+deterministic+gold and print per-agent error decomposition")
    ap.add_argument("--propose", action="store_true", help="print the adjudication worksheet")
    args = ap.parse_args()

    results = run_key(args.mode)
    archetypes = run_archetypes(args.mode)

    if args.propose:
        _propose(results)
        return 0

    metrics = compute_blast_metrics(results)
    gated = compute_blast_metrics(results, gated_only=True)
    _print_metrics(f"all entries (mode={args.mode})", metrics)
    _print_metrics("gated (adjudicated) entries only", gated)
    if args.verbose:
        print()
        _print_rows(results)
    _print_archetypes(archetypes)

    decomposition = None
    if args.decompose:
        by_mode = {m: run_key(m) for m in ("fixtures", "deterministic", "gold")}
        decomposition = decompose(by_mode)
        print("\n== pipeline error decomposition (score deltas) ==")
        print(f"  {'agent':32s} {'fix':>4s} {'det':>4s} {'gold':>4s} {'llm+':>5s} {'clserr':>6s} {'uncl':>4s}")
        for row in decomposition:
            print(f"  {row['id']:32s} {row['score_fixtures']:>4} {row['score_deterministic']:>4} "
                  f"{row['score_gold']:>4} {row['llm_layer_delta']:>5} {row['classifier_error']:>6} "
                  f"{row['unclassified']:>4}")

    failures: list[str] = []
    if os.path.exists(BLAST_THRESHOLDS_PATH):
        with open(BLAST_THRESHOLDS_PATH) as f:
            thresholds = json.load(f)
        failures = check_blast_thresholds(gated, thresholds)
    arch_hard_misses = [a for a in archetypes
                        if not a.get("known_miss") and (not a["band_ok"] or a["chain_misses"])]
    for a in arch_hard_misses:
        failures.append(f"archetype {a['id']} missed (band={a['band']}, "
                        f"chain misses={a['chain_misses']}) — {a['citation']}")
    if failures:
        print("\nRATCHET VIOLATIONS:")
        for f_ in failures:
            print(f"  {f_}")

    if args.baseline:
        report = {
            "mode": args.mode,
            "metrics": metrics,
            "gated_metrics": gated,
            "per_agent": [
                {k: v for k, v in r.items() if k != "entry"}
                | ({"expected_band": r["entry"].expected_band,
                    "adjudicated": r["entry"].adjudicated} if not r["skipped"] else {})
                for r in results
            ],
            "archetypes": archetypes,
            "decomposition": decomposition,
            "ratchet_violations": failures,
        }
        with open(args.baseline, "w") as f:
            json.dump(report, f, indent=2)
        print(f"\nbaseline written to {args.baseline}")

    if args.check and failures:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
