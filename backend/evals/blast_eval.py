"""Blast-radius accuracy eval — the full-pipeline answer-key harness.

Where eval_lib.py grades the CLASSIFIER (labels per action), this grades the
whole blast-radius pipeline per agent: classified labels -> reversibility ->
chain detection -> score -> band -> scan verdict, against a hand-authored
answer key (tests/eval/blast_answer_key.jsonl) plus four incident archetypes
(tests/eval/incident_archetypes.json) whose ground truth is what actually
happened in the wild — the only fully non-circular truth we have.

Ground truth is BAND + ORDERING + MUST-FIRE CHAINS, not exact scores: the
prose score ranges predate the 2026-07-03 recalibration and are report-only
diagnostics. Entries with adjudicated == "pending" are reported, never gated.

Modes (same discipline as eval_lib):
  fixtures      — LLM layer replays tests/eval/llm_fixtures.json (CI default).
  deterministic — LLM layer returns None (keyword/catalog only). The delta
                  fixtures-vs-deterministic measures what the LLM layer adds
                  and what the silent-0 path costs when it's unavailable.
  gold          — labels/reversibility force-overridden by known-correct
                  values (ACTION_CATALOG + classifier_eval.jsonl + optional
                  gold_action_labels.json). Residual error under gold labels
                  is FORMULA error, isolated from classifier error.

Answer-key schema (JSONL, one object per agent):
  id, source (parser|anchor|manifest|archetype), ref, expected_band,
  expected_range ([lo, hi], optional), expected_verdict (pass|warn|fail),
  must_fire_chains ([{id, min_severity}]), must_not_fire_chains ([id]),
  truth_source, adjudicated ("pending" | ISO date), notes.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from evals.eval_lib import load_fixtures, make_llm_stub  # noqa: E402

ANSWER_KEY_PATH = os.path.join(BACKEND_DIR, "tests", "eval", "blast_answer_key.jsonl")
ARCHETYPES_PATH = os.path.join(BACKEND_DIR, "tests", "eval", "incident_archetypes.json")
MANIFESTS_DIR = os.path.join(BACKEND_DIR, "tests", "eval", "extracted_manifests")
GOLD_LABELS_PATH = os.path.join(BACKEND_DIR, "tests", "eval", "gold_action_labels.json")
BLAST_THRESHOLDS_PATH = os.path.join(BACKEND_DIR, "tests", "eval", "blast_thresholds.json")
CLASSIFIER_CASES_PATH = os.path.join(BACKEND_DIR, "tests", "eval", "classifier_eval.jsonl")

BANDS = ("low", "medium", "high", "critical")
BAND_RANK = {b: i for i, b in enumerate(BANDS)}
SEVERITY_RANK = {"medium": 1, "high": 2, "critical": 3}
VERDICTS = ("pass", "warn", "fail")
SCAN_DEFAULT_THRESHOLD = 60  # mirrors ScanRequest's default in main.py


@dataclass
class BlastEvalEntry:
    id: str
    source: str
    ref: str
    expected_band: str
    expected_verdict: str
    expected_range: list | None = None
    must_fire_chains: list = field(default_factory=list)
    must_not_fire_chains: list = field(default_factory=list)
    truth_source: str = ""
    adjudicated: str = "pending"
    notes: str = ""

    @property
    def is_gated(self) -> bool:
        return self.adjudicated != "pending"


# ── Loading + well-formedness ─────────────────────────────────────────────


def valid_chain_ids() -> set[str]:
    from authority.chain_detector import LABEL_TRANSITIONS
    return {t.id for t in LABEL_TRANSITIONS}


def load_answer_key(path: str = ANSWER_KEY_PATH) -> list[BlastEvalEntry]:
    entries = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entries.append(BlastEvalEntry(**json.loads(line)))

    ids = [e.id for e in entries]
    assert len(ids) == len(set(ids)), "duplicate ids in blast answer key"
    known_chains = valid_chain_ids()
    for e in entries:
        assert e.source in ("parser", "anchor", "manifest", "archetype"), f"{e.id}: bad source"
        assert e.expected_band in BANDS, f"{e.id}: bad band {e.expected_band}"
        assert e.expected_verdict in VERDICTS, f"{e.id}: bad verdict {e.expected_verdict}"
        if e.expected_range is not None:
            lo, hi = e.expected_range
            assert 0 <= lo <= hi <= 100, f"{e.id}: bad range {e.expected_range}"
        for mf in e.must_fire_chains:
            assert mf["id"] in known_chains, f"{e.id}: unknown chain {mf['id']}"
            assert mf["min_severity"] in SEVERITY_RANK, f"{e.id}: bad severity {mf['min_severity']}"
        for cid in e.must_not_fire_chains:
            assert cid in known_chains, f"{e.id}: unknown must-not-fire chain {cid}"
    return entries


def load_archetypes(path: str = ARCHETYPES_PATH) -> list[dict]:
    with open(path) as f:
        data = json.load(f)
    archetypes = data["archetypes"]
    known_chains = valid_chain_ids()
    for a in archetypes:
        assert a["expected_band"] == "critical", f"{a['id']}: archetypes are critical by definition"
        for mf in a["must_fire_chains"]:
            assert mf["id"] in known_chains, f"{a['id']}: unknown chain {mf['id']}"
    return archetypes


def load_manifest(ref: str) -> dict | None:
    path = os.path.join(MANIFESTS_DIR, f"{ref}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def load_gold_labels() -> dict:
    """Known-correct labels for GOLD mode: classifier_eval.jsonl expected labels
    (hand-labeled, CI-gated) + optional founder-authored gold_action_labels.json.
    Catalog actions need no entry — the catalog IS gold by construction and
    classify_with_fallback returns it verbatim."""
    gold: dict[str, dict] = {}
    with open(CLASSIFIER_CASES_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            case = json.loads(line)
            key = f"{case['tool']}.{case['action']}"
            gold[key] = {
                "labels": case.get("expected_labels", []),
                "reversible": case.get("expected_reversible", True),
            }
    if os.path.exists(GOLD_LABELS_PATH):
        with open(GOLD_LABELS_PATH) as f:
            gold.update(json.load(f))
    return gold


# ── Building + scoring agents ─────────────────────────────────────────────


def _classify_overrides(config) -> dict:
    """The calibrate_fleet recipe: classify every declared action.
    Caller is responsible for having installed the right LLM layer."""
    from authority.risk_classifier import classify_with_fallback
    return {
        t.name: {a: classify_with_fallback(t.name, a, "") for a in t.actions}
        for t in config.tools
    }


def build_agent(entry: BlastEvalEntry, archetypes_by_id: dict | None = None):
    """Resolve an answer-key entry to (AgentConfig, overrides). Returns None when
    the entry's manifest hasn't been extracted yet (reported as skipped)."""
    from authority.parser import SAMPLE_CONFIGS, parse_agent_config

    if entry.source == "parser":
        raw = next((c for c in SAMPLE_CONFIGS if c["id"] == entry.ref), None)
        assert raw is not None, f"{entry.id}: no SAMPLE_CONFIG with id {entry.ref}"
        config = parse_agent_config(raw)
    elif entry.source == "anchor":
        from evals.calibrate_fleet import NOTE_TAKER_ACTIONS, INFRA_MAX_ACTIONS, _synthetic
        actions = {"note-taker": NOTE_TAKER_ACTIONS, "infra-max": INFRA_MAX_ACTIONS}[entry.ref]
        tool = {"note-taker": "notion", "infra-max": "infra"}[entry.ref]
        config, overrides = _synthetic(entry.ref, entry.id, tool, actions)
        return config, overrides
    elif entry.source == "manifest":
        raw = load_manifest(entry.ref)
        if raw is None:
            return None
        config = parse_agent_config(raw)
    elif entry.source == "archetype":
        raw = (archetypes_by_id or {})[entry.ref]["config"]
        config = parse_agent_config(raw)
    else:  # pragma: no cover — load_answer_key validates sources
        raise ValueError(entry.source)

    return config, _classify_overrides(config)


def apply_gold(overrides: dict, gold: dict) -> dict:
    """Force known-correct labels/reversibility onto classified overrides.
    Actions without gold truth keep their pipeline classification."""
    from dataclasses import replace
    out = {}
    for tool, actions in overrides.items():
        out[tool] = {}
        for name, mapped in actions.items():
            g = gold.get(f"{tool}.{name}")
            if g:
                out[tool][name] = replace(
                    mapped, risk_labels=list(g["labels"]), reversible=bool(g["reversible"])
                )
            else:
                out[tool][name] = mapped
    return out


def simulate_scan_verdict(score: float, critical_chains: int, has_exec_code: bool,
                          unclassified: int, total_actions: int,
                          threshold: int = SCAN_DEFAULT_THRESHOLD) -> str:
    """Mirror of /api/scan's honest-gate verdict (main.py): hard failure modes
    first (critical chain, opaque capability, arbitrary code), then the score
    only separates warn from pass."""
    if critical_chains > 0:
        return "fail"
    if total_actions and unclassified / total_actions > 0.25:
        return "fail"
    if has_exec_code:
        return "fail"
    if score >= max(0, threshold - 20):
        return "warn"
    return "pass"


def score_agent(config, overrides) -> dict:
    """config + classified overrides -> everything the metrics need."""
    from authority.chain_detector import detect_chains
    from authority.graph import calculate_blast_radius

    chains = detect_chains(config, overrides)
    br = calculate_blast_radius(config, overrides, chains=chains.flagged_chains)

    fired: dict[str, str] = {}
    for fc in chains.flagged_chains:
        prev = fired.get(fc.chain.id)
        if prev is None or SEVERITY_RANK.get(fc.chain.severity, 0) > SEVERITY_RANK.get(prev, 0):
            fired[fc.chain.id] = fc.chain.severity

    all_actions = [a for acts in overrides.values() for a in acts.values()]
    from authority.risk_classifier import is_effectively_read
    # Mirrors compute_risk_coverage: "none" = the classifier had NO signal.
    # An affirmatively-benign verdict (LLM vetoed weak labels -> zero labels,
    # source "keyword+llm") is classified-safe, NOT opaque.
    unclassified = sum(
        1 for a in all_actions
        if getattr(a, "classification_source", None) == "none"
        or (getattr(a, "classification_source", None) in (None, "unknown")
            and not a.risk_labels and not is_effectively_read(a.action.lower()))
    )
    has_exec_code = any("executes_code" in a.risk_labels for a in all_actions)
    critical_chains = sum(1 for fc in chains.flagged_chains if fc.chain.severity == "critical")

    return {
        "score": br.score,
        "band": br.band,
        "chain_risk": br.chain_risk,
        "fired_chains": fired,
        "critical_chains": critical_chains,
        "unclassified": unclassified,
        "total_actions": len(all_actions),
        "verdict": simulate_scan_verdict(
            br.score, critical_chains, has_exec_code, unclassified, len(all_actions)
        ),
    }


# ── Running the key ───────────────────────────────────────────────────────


def _llm_layer(mode: str, missing: list | None = None):
    if mode == "deterministic":
        return lambda *a, **k: None
    if mode in ("fixtures", "gold"):
        return make_llm_stub(load_fixtures(), missing)
    raise ValueError(f"unknown mode: {mode}")


def run_key(mode: str = "fixtures") -> list[dict]:
    """Score every answer-key agent under the given mode. Returns per-entry
    result dicts; manifest entries without a frozen manifest are skipped=True."""
    import authority.risk_classifier as rc

    entries = load_answer_key()
    archetypes_by_id = {a["id"]: a for a in load_archetypes()}
    gold = load_gold_labels() if mode == "gold" else None

    original = rc.classify_with_llm
    missing: list[str] = []
    rc.classify_with_llm = _llm_layer(mode, missing)
    results = []
    try:
        rc._llm_cache.clear()
        for entry in entries:
            built = build_agent(entry, archetypes_by_id)
            if built is None:
                results.append({"id": entry.id, "entry": entry, "skipped": True,
                                "skip_reason": f"no frozen manifest at extracted_manifests/{entry.ref}.json"})
                continue
            config, overrides = built
            if gold is not None:
                overrides = apply_gold(overrides, gold)
            outcome = score_agent(config, overrides)
            results.append({"id": entry.id, "entry": entry, "skipped": False, **outcome,
                            **_grade(entry, outcome)})
    finally:
        rc.classify_with_llm = original
        rc._llm_cache.clear()
    return results


def run_archetypes(mode: str = "fixtures") -> list[dict]:
    """Score the four incident archetypes. Separate from run_key so the hard
    all-critical assert has its own artifact with citations attached."""
    import authority.risk_classifier as rc

    archetypes = load_archetypes()
    original = rc.classify_with_llm
    rc.classify_with_llm = _llm_layer(mode)
    results = []
    try:
        rc._llm_cache.clear()
        from authority.parser import parse_agent_config
        for a in archetypes:
            config = parse_agent_config(a["config"])
            outcome = score_agent(config, _classify_overrides(config))
            chain_misses = _chain_misses(a["must_fire_chains"], outcome["fired_chains"])
            results.append({
                "id": a["id"], "name": a["name"], "citation": a["citation"],
                "incident": a["incident"], **outcome,
                "band_ok": outcome["band"] == "critical",
                "chain_misses": chain_misses,
                "known_miss": bool(a.get("known_miss")),
                "known_miss_note": a.get("known_miss_note", ""),
            })
    finally:
        rc.classify_with_llm = original
        rc._llm_cache.clear()
    return results


def _chain_misses(must_fire: list, fired: dict) -> list[str]:
    misses = []
    for mf in must_fire:
        got = fired.get(mf["id"])
        if got is None:
            misses.append(f"{mf['id']} did not fire")
        elif SEVERITY_RANK.get(got, 0) < SEVERITY_RANK[mf["min_severity"]]:
            misses.append(f"{mf['id']} fired at {got}, expected >= {mf['min_severity']}")
    return misses


def _grade(entry: BlastEvalEntry, outcome: dict) -> dict:
    band_delta = abs(BAND_RANK[outcome["band"]] - BAND_RANK[entry.expected_band])
    in_range = None
    if entry.expected_range is not None:
        lo, hi = entry.expected_range
        in_range = lo <= outcome["score"] <= hi
    false_fires = [cid for cid in entry.must_not_fire_chains if cid in outcome["fired_chains"]]
    return {
        "band_exact": band_delta == 0,
        "band_within_one": band_delta <= 1,
        "band_delta": band_delta,
        "in_range": in_range,
        "chain_misses": _chain_misses(entry.must_fire_chains, outcome["fired_chains"]),
        "chain_false_fires": false_fires,
        "verdict_match": outcome["verdict"] == entry.expected_verdict,
    }


# ── Metrics ───────────────────────────────────────────────────────────────


def kendall_tau(xs: list[float], ys: list[float]) -> float:
    """Kendall tau-a over paired rankings; stdlib, fine at n<=100.
    Ties in either list drop the pair (tau on strict pairs)."""
    n = len(xs)
    concordant = discordant = 0
    for i in range(n):
        for j in range(i + 1, n):
            dx, dy = xs[i] - xs[j], ys[i] - ys[j]
            if dx == 0 or dy == 0:
                continue
            if (dx > 0) == (dy > 0):
                concordant += 1
            else:
                discordant += 1
    total = concordant + discordant
    return round((concordant - discordant) / total, 4) if total else 1.0


def _truth_rank(entry: BlastEvalEntry) -> float:
    """Ordering ground truth: band rank, tie-broken by the range midpoint."""
    mid = sum(entry.expected_range) / 2 if entry.expected_range else 50.0
    return BAND_RANK[entry.expected_band] * 1000 + mid


def compute_blast_metrics(results: list[dict], gated_only: bool = False) -> dict:
    scored = [r for r in results if not r["skipped"]]
    if gated_only:
        scored = [r for r in scored if r["entry"].is_gated]
    n = len(scored)
    if n == 0:
        return {"n": 0}

    band_exact = sum(1 for r in scored if r["band_exact"])
    within_one = sum(1 for r in scored if r["band_within_one"])
    verdicts = sum(1 for r in scored if r["verdict_match"])
    must_fire_total = sum(len(r["entry"].must_fire_chains) for r in scored)
    must_fire_hits = must_fire_total - sum(len(r["chain_misses"]) for r in scored)
    false_fires = sum(len(r["chain_false_fires"]) for r in scored)

    ranged = [r for r in scored if r["in_range"] is not None]
    range_hits = sum(1 for r in ranged if r["in_range"])
    range_mae = (
        round(sum(_range_distance(r) for r in ranged) / len(ranged), 2) if ranged else None
    )

    tau = kendall_tau([_truth_rank(r["entry"]) for r in scored],
                      [r["score"] for r in scored])

    boundary = [r for r in scored
                if any(abs(r["score"] - b) <= 5 for b in (40, 60, 80))]
    boundary_flips = sum(1 for r in boundary if not r["band_exact"])

    confusion: dict[str, dict[str, int]] = {b: {b2: 0 for b2 in BANDS} for b in BANDS}
    for r in scored:
        confusion[r["entry"].expected_band][r["band"]] += 1

    return {
        "n": n,
        "skipped": sum(1 for r in results if r["skipped"]),
        "band_exact": round(band_exact / n, 4),
        "band_within_one": round(within_one / n, 4),
        "kendall_tau": tau,
        "chain_recall": round(must_fire_hits / must_fire_total, 4) if must_fire_total else 1.0,
        "chain_false_fires": false_fires,
        "verdict_agreement": round(verdicts / n, 4),
        "range_hit_rate": round(range_hits / len(ranged), 4) if ranged else None,
        "range_mae": range_mae,
        "boundary_n": len(boundary),
        "boundary_flips": boundary_flips,
        "band_confusion": confusion,
    }


def _range_distance(r: dict) -> float:
    lo, hi = r["entry"].expected_range
    s = r["score"]
    return 0.0 if lo <= s <= hi else min(abs(s - lo), abs(s - hi))


def check_blast_thresholds(metrics: dict, thresholds: dict) -> list[str]:
    """Ratchet check, same contract as eval_lib.check_thresholds."""
    failures = []
    for key, floor in thresholds.get("floors", {}).items():
        val = metrics.get(key)
        if val is not None and val < floor:
            failures.append(f"{key}: {val} < floor {floor}")
    for key, cap in thresholds.get("ceilings", {}).items():
        val = metrics.get(key)
        if val is not None and val > cap:
            failures.append(f"{key}: {val} > ceiling {cap}")
    return failures


# ── Pipeline error decomposition ──────────────────────────────────────────


def decompose(results_by_mode: dict[str, list[dict]]) -> list[dict]:
    """Per-agent score deltas across modes. fixtures - deterministic = what the
    LLM layer adds (the silent-0 cost when it's down); gold - fixtures =
    classifier-induced score error; band mismatch under gold = formula error."""
    rows = []
    by_id = {m: {r["id"]: r for r in rs if not r["skipped"]}
             for m, rs in results_by_mode.items()}
    ids = sorted(set.intersection(*(set(d) for d in by_id.values()))) if by_id else []
    for aid in ids:
        fx = by_id.get("fixtures", {}).get(aid)
        det = by_id.get("deterministic", {}).get(aid)
        gd = by_id.get("gold", {}).get(aid)
        rows.append({
            "id": aid,
            "score_fixtures": fx["score"] if fx else None,
            "score_deterministic": det["score"] if det else None,
            "score_gold": gd["score"] if gd else None,
            "llm_layer_delta": (fx["score"] - det["score"]) if fx and det else None,
            "classifier_error": (gd["score"] - fx["score"]) if gd and fx else None,
            "unclassified": fx["unclassified"] if fx else None,
            "band_error_under_gold": (gd["band"] != gd["entry"].expected_band) if gd else None,
        })
    return rows
