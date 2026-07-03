"""CLI: run the classifier eval and print per-label precision/recall.

Usage (from backend/):
  ./venv/bin/python evals/run_eval.py --mode fixtures
  ./venv/bin/python evals/run_eval.py --mode deterministic --baseline evals/baseline_report.json
  ./venv/bin/python evals/run_eval.py --mode fixtures --check   # exit 1 on threshold violation
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from evals.eval_lib import (
    THRESHOLDS_PATH, check_thresholds, compute_metrics, gated, load_cases, run_cases,
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["deterministic", "fixtures", "live"], default="fixtures")
    ap.add_argument("--baseline", help="write full metrics + failures to this JSON path")
    ap.add_argument("--check", action="store_true", help="compare against thresholds.json, exit 1 on violation")
    ap.add_argument("--verbose", action="store_true", help="print every mismatching case")
    args = ap.parse_args()

    cases = load_cases()
    results = run_cases(cases, mode=args.mode)
    gated_results = gated(results, args.mode)
    metrics = compute_metrics(gated_results)
    all_metrics = compute_metrics(results)

    print(f"mode={args.mode}  cases={len(results)}  gated={len(gated_results)}")
    print(f"exact-match (gated): {metrics['exact_match']:.1%}   reversibility: {metrics['reversibility_accuracy']:.1%}")
    print(f"{'label':22} {'prec':>6} {'recall':>6} {'f1':>6}   (tp/fp/fn)")
    for label, m in metrics["per_label"].items():
        print(f"{label:22} {m['precision']:>6.2f} {m['recall']:>6.2f} {m['f1']:>6.2f}   ({m['tp']}/{m['fp']}/{m['fn']})")

    mism = [r for r in results if not r["labels_match"] or not r["reversible_match"]]
    known = [r for r in mism if r["known_miss"]]
    ungated = [r for r in mism if r["requires_llm"] and args.mode == "deterministic" and not r["known_miss"]]
    real = [r for r in mism if r not in known and r not in ungated]
    print(f"\nmismatches: {len(real)} gated, {len(ungated)} llm-dependent (ungated in this mode), {len(known)} known-miss")
    if args.verbose or len(real) <= 40:
        for r in real:
            rev = "" if r["reversible_match"] else f"  rev exp={r['expected_reversible']} got={r['got_reversible']}"
            print(f"  {r['id']:10} {r['action']:28} exp={r['expected_labels']} got={r['got_labels']}{rev}")
    if known:
        print("known-miss (reported, never gated):")
        for r in known:
            print(f"  {r['id']:10} {r['action']:28} exp={r['expected_labels']} got={r['got_labels']}")

    missing = [r["id"] for r in results if r.get("_missing_fixture")]
    if missing:
        print(f"\nWARNING: {len(missing)} cases had no LLM fixture (stub returned None): {missing[:10]}")

    if args.baseline:
        with open(args.baseline, "w") as f:
            json.dump({
                "mode": args.mode,
                "gated_metrics": metrics,
                "all_metrics": all_metrics,
                "mismatch_ids": [r["id"] for r in mism],
            }, f, indent=2)
        print(f"\nwrote {args.baseline}")

    if args.check:
        if not os.path.exists(THRESHOLDS_PATH):
            print("no thresholds.json — nothing to check")
            return 0
        with open(THRESHOLDS_PATH) as f:
            thresholds = json.load(f)
        failures = check_thresholds(metrics, thresholds)
        if failures:
            print("\nTHRESHOLD VIOLATIONS:")
            for x in failures:
                print(f"  {x}")
            return 1
        print("\nthresholds: all pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
