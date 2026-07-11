"""Score the reference fleet against current weights — the calibration harness.

Scores the 20 SAMPLE_CONFIGS plus two synthetic anchors (a harmless wiki
note-taker that must land LOW, and a max-danger infra agent that must land
CRITICAL), prints the distribution, each agent's band, and the /api/scan
verdict at the default threshold (60).

  cd backend && ./venv/bin/python evals/calibrate_fleet.py             # fixtures (mirrors prod-with-LLM)
  cd backend && ./venv/bin/python evals/calibrate_fleet.py --mode none # LLM unavailable (fail-open)

Use it when touching LABEL_WEIGHTS, CHAIN_WEIGHT, the normalizer, or the
density bonus in authority/graph.py.
"""

from __future__ import annotations

import argparse
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

import authority.risk_classifier as rc  # noqa: E402
from authority.chain_detector import detect_chains  # noqa: E402
from authority.graph import calculate_blast_radius  # noqa: E402
from authority.parser import AgentConfig, ToolDef, load_all_agents  # noqa: E402
from authority.risk_classifier import classify_with_fallback  # noqa: E402
from evals.eval_lib import load_fixtures, make_llm_stub  # noqa: E402

NOTE_TAKER_ACTIONS = [
    ("create_page", "Create a new page in a workspace"),
    ("update_page", "Update properties of an existing page"),
    ("move_page", "Move a page to a different parent page"),
    ("append_block", "Append a paragraph block to a page"),
    ("get_page", "Fetch a page's content"),
    ("search_pages", "Search pages by title"),
]

INFRA_MAX_ACTIONS = [
    ("terminate_instance", "Terminate a production EC2 instance"),
    ("drop_database", "Drop an entire production database"),
    ("delete_all_backups", "Delete every stored backup"),
    ("execute_sql", "Execute an arbitrary SQL statement"),
    ("create_payout", "Create a payout to an external bank account"),
    ("send_email", "Send an email to any recipient"),
    ("get_customer", "Retrieve customer profile and payment data"),
    ("rotate_api_keys", "Rotate all API keys, invalidating the old ones"),
]


def _synthetic(agent_id: str, name: str, tool: str, actions: list) -> tuple:
    config = AgentConfig(id=agent_id, name=name, description=name,
                         tools=[ToolDef(name=tool, service=tool.capitalize(), description=name)])
    overrides = {tool: {a: classify_with_fallback(tool, a, d) for a, d in actions}}
    return config, overrides


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["fixtures", "none"], default="fixtures")
    args = ap.parse_args()

    if args.mode == "fixtures":
        rc.classify_with_llm = make_llm_stub(load_fixtures())
    else:
        rc.classify_with_llm = lambda *a, **k: None
    rc._llm_cache.clear()

    rows = []
    agents = [(a, None) for a in load_all_agents()]
    agents.append(_synthetic("note-taker", "Wiki Note Taker (anchor: LOW)", "notion", NOTE_TAKER_ACTIONS))
    agents.append(_synthetic("infra-max", "Max-Danger Infra (anchor: CRITICAL)", "infra", INFRA_MAX_ACTIONS))

    for config, overrides in agents:
        if overrides is None:
            overrides = {
                t.name: {a: classify_with_fallback(t.name, a, "") for a in t.actions}
                for t in config.tools
            }
        chains = detect_chains(config, overrides)
        br = calculate_blast_radius(config, overrides, chains=chains.flagged_chains)
        crit = sum(1 for fc in chains.flagged_chains if fc.chain.severity == "critical")
        # Mirror the /api/scan honest gate: it fails on distrust signals, not raw
        # power. executes_code is one such signal (opaque >25% is another, but the
        # reference fixtures are fully classified so it never trips here).
        exec_code = any(
            "executes_code" in getattr(mapped, "risk_labels", [])
            for amap in overrides.values() for mapped in amap.values()
        )
        rows.append((br.score, config.name, len(chains.flagged_chains), crit,
                     getattr(br, "band", "-"), exec_code))

    rows.sort(reverse=True)
    print(f"mode={args.mode}\n")
    print(f"{'score':>6}  {'band':10} {'chains':>6} {'crit':>4}  agent")
    for score, name, chain_count, crit, band, exec_code in rows:
        # FAIL only on distrust (critical chain or code execution); a high but
        # fully-classified score WARNs, matching the shipped /api/scan verdict.
        verdict = "FAIL" if (crit > 0 or exec_code) else ("warn" if score >= 40 else "pass")
        print(f"{score:>6.1f}  {band:10} {chain_count:>6} {crit:>4}  {name}  [scan@60: {verdict}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
