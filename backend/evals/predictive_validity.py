"""Static blast-radius score vs dry-run sandbox behavior — internal consistency.

For every scoreable answer-key agent: run seeded DRY sandbox scenarios plus a
boundary test, then correlate the STATIC score against the DYNAMIC outcomes
(max dry-run risk score, violation counts, boundary gaps).

CAVEAT — read before quoting these numbers to anyone: dry-run outcomes derive
from the SAME risk labels and weights as the static score (the analyzer shares
graph.py's LABEL_WEIGHTS and SCORE_NORMALIZER). High correlation here means
the pipeline is INTERNALLY CONSISTENT — it is NOT independent evidence that
the score predicts real-world outcomes. Independent validity needs the live
tier (LLM-driven sweeps + red-team bypass rates, ~$5-25 for 6-8 agents) —
parked by founder decision 2026-07-12 — or, better, real customer incident
data. This harness's permanent value: it is the regression net that would
have caught the /240-vs-/265 normalizer drift.

Requires docker compose services (Postgres + Redis). Uses its OWN scratch
database (dropped + recreated each run) so dev data is never touched:

  cd backend && python evals/predictive_validity.py [--json evals/predictive_validity_report.json]

Deterministic: seeded dry-runs (seed=42), no LLM, no network beyond localhost.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

# Scratch DB + env BEFORE any app import (db.py resolves DATABASE_URL at import).
_SCRATCH_URL = os.environ.get(
    "ARCEO_EVAL_DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/arceo_blast_eval",
)
os.environ["DATABASE_URL"] = _SCRATCH_URL
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/14")
os.environ.setdefault("JWT_SECRET", "eval-scratch-not-for-prod")
os.environ["ANTHROPIC_API_KEY"] = ""  # this harness must never spend
os.environ.setdefault(
    "ARCEO_LLM_CACHE_PATH", os.path.join(BACKEND_DIR, "evals", ".eval_llm_cache.db")
)

SEED = 42
MAX_LIBRARY_SCENARIOS = 8

CAVEAT = (
    "INTERNAL CONSISTENCY, NOT INDEPENDENT VALIDITY: dry-run outcomes share the\n"
    "static score's labels and weights. Use for regression + coherence checks;\n"
    "do not quote as proof the score predicts real-world incidents."
)


def _recreate_scratch_db() -> None:
    import psycopg
    from urllib.parse import urlsplit

    dbname = urlsplit(_SCRATCH_URL).path.lstrip("/")
    admin_url = _SCRATCH_URL.rsplit("/", 1)[0] + "/postgres"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')
        admin.execute(f'CREATE DATABASE "{dbname}"')

    from alembic import command
    from alembic.config import Config
    command.upgrade(Config(os.path.join(BACKEND_DIR, "alembic.ini")), "head")


def _agent_dict(config, overrides) -> dict:
    """The DB-shaped agent dict the sandbox runner/boundary tester expect,
    carrying the eval pipeline's classified labels so both sides see the same
    capability picture."""
    return {
        "id": config.id,
        "name": config.name,
        "description": config.description,
        "tools": [
            {
                "name": t.name,
                "service": t.service,
                "description": t.description,
                "actions": [
                    {
                        "action": m.action,
                        "description": m.description,
                        "risk_labels": m.risk_labels,
                        "reversible": m.reversible,
                    }
                    for m in overrides.get(t.name, {}).values()
                ],
            }
            for t in config.tools
        ],
    }


def _scenarios_for(agent_dict: dict) -> list:
    """Mirror the sweep flow: per-agent generated scenarios + matching library
    scenarios, deterministically ordered and capped."""
    from sandbox.prompts.scenarios import (
        ALL_SCENARIOS,
        generate_scenarios_for_agent,
        scenario_matches_tools,
    )

    tool_names = {t["name"] for t in agent_dict["tools"]}
    library = sorted(
        (s for s in ALL_SCENARIOS if scenario_matches_tools(s, tool_names)),
        key=lambda s: s.id,
    )[:MAX_LIBRARY_SCENARIOS]
    return generate_scenarios_for_agent(agent_dict) + library


def _spearman(xs: list[float], ys: list[float]) -> float:
    """Spearman rho via average ranks + Pearson on ranks. Stdlib, n<=100."""
    def ranks(vals: list[float]) -> list[float]:
        order = sorted(range(len(vals)), key=lambda i: vals[i])
        out = [0.0] * len(vals)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                out[order[k]] = avg
            i = j + 1
        return out

    rx, ry = ranks(xs), ranks(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = sum((a - mx) ** 2 for a in rx) ** 0.5
    vy = sum((b - my) ** 2 for b in ry) ** 0.5
    return round(cov / (vx * vy), 4) if vx and vy else 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", metavar="PATH", help="write the full artifact to PATH")
    args = ap.parse_args()

    print("=" * 74)
    print(CAVEAT)
    print("=" * 74)
    print("\nRecreating scratch database...")
    _recreate_scratch_db()

    import authority.risk_classifier as rc
    from evals.blast_eval import (
        _llm_layer,
        build_agent,
        kendall_tau,
        load_answer_key,
        load_archetypes,
        score_agent,
    )
    from sandbox.analyzer import analyze_trace
    from sandbox.boundary_tester import run_boundary_test
    from sandbox.runner import run_simulation_dry

    entries = load_answer_key()
    arch_by_id = {a["id"]: a for a in load_archetypes()}

    original = rc.classify_with_llm
    rc.classify_with_llm = _llm_layer("fixtures")
    rows: list[dict] = []
    try:
        rc._llm_cache.clear()
        for entry in entries:
            built = build_agent(entry, arch_by_id)
            if built is None:
                continue
            config, overrides = built
            static = score_agent(config, overrides)
            agent = _agent_dict(config, overrides)

            max_risk = 0.0
            crit = high = chains_triggered = 0
            scenarios = _scenarios_for(agent)
            for sc in scenarios:
                trace = run_simulation_dry(agent, sc, seed=SEED)
                report = analyze_trace(trace, sc)
                max_risk = max(max_risk, report.risk_score)
                for v in report.violations:
                    if v.severity == "critical":
                        crit += 1
                    elif v.severity == "high":
                        high += 1
                chains_triggered += len(report.chains_triggered)

            boundary = run_boundary_test(agent)
            rows.append({
                "id": entry.id,
                "static_score": static["score"],
                "band": static["band"],
                "scenarios_run": len(scenarios),
                "max_dry_risk": max_risk,
                "critical_violations": crit,
                "high_violations": high,
                "chains_triggered": chains_triggered,
                "boundary_gaps": getattr(boundary, "total_gaps", 0),
                "boundary_sequences": getattr(boundary, "total_sequences_tested", 0),
            })
            print(f"  {entry.id:32s} static={static['score']:3d} dry-max={max_risk:5.1f} "
                  f"viol(c/h)={crit}/{high} chains={chains_triggered} gaps={rows[-1]['boundary_gaps']}")
    finally:
        rc.classify_with_llm = original
        rc._llm_cache.clear()

    xs = [float(r["static_score"]) for r in rows]
    correlations = {
        "static_vs_max_dry_risk": {
            "spearman": _spearman(xs, [r["max_dry_risk"] for r in rows]),
            "kendall": kendall_tau(xs, [r["max_dry_risk"] for r in rows]),
        },
        "static_vs_severe_violations": {
            "spearman": _spearman(xs, [float(r["critical_violations"] + r["high_violations"]) for r in rows]),
            "kendall": kendall_tau(xs, [float(r["critical_violations"] + r["high_violations"]) for r in rows]),
        },
        "static_vs_boundary_gaps": {
            "spearman": _spearman(xs, [float(r["boundary_gaps"]) for r in rows]),
            "kendall": kendall_tau(xs, [float(r["boundary_gaps"]) for r in rows]),
        },
    }

    bands = ("low", "medium", "high", "critical")
    contingency = {b: {"agents": 0, "with_critical_violation": 0} for b in bands}
    for r in rows:
        contingency[r["band"]]["agents"] += 1
        if r["critical_violations"] > 0:
            contingency[r["band"]]["with_critical_violation"] += 1

    print(f"\n== correlations (n={len(rows)}) ==")
    for name, c in correlations.items():
        print(f"  {name:32s} spearman={c['spearman']:+.4f} kendall={c['kendall']:+.4f}")
    print("\n== band x any-critical-violation ==")
    for b in bands:
        c = contingency[b]
        print(f"  {b:8s} {c['with_critical_violation']}/{c['agents']} agents")
    print("\n" + CAVEAT)

    if args.json:
        with open(args.json, "w") as f:
            json.dump({
                "caveat": CAVEAT,
                "seed": SEED,
                "per_agent": rows,
                "correlations": correlations,
                "band_contingency": contingency,
            }, f, indent=2)
        print(f"\nartifact written to {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
