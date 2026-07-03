"""Opt-in backfill: re-run the classifier over stored tool_actions rows.

Stored labels don't self-heal when the classifier improves — the risk engine
trusts DB labels for tools outside the hardcoded catalog, so an agent
registered before a classifier fix keeps its old (possibly wrong) labels until
it re-registers. Run this once after deploying a classifier change:

  cd backend && ./venv/bin/python evals/reclassify_stored.py            # dry-run diff
  cd backend && ./venv/bin/python evals/reclassify_stored.py --apply    # write changes

Needs ANTHROPIC_API_KEY for LLM adjudication (read from backend/.env if
present). Without it, weak keyword labels are kept (fail toward flagging) and
vague actions stay 'none' — still an improvement over 'unknown', but rerun
with the key for full accuracy. Scores shift after applying: that is the point.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

env_path = os.path.join(BACKEND_DIR, ".env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v)

import db  # noqa: E402
from authority.action_mapper import ACTION_CATALOG  # noqa: E402
from authority.risk_classifier import classify_with_fallback  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run diff)")
    args = ap.parse_args()

    if not os.getenv("ANTHROPIC_API_KEY"):
        print("WARNING: no ANTHROPIC_API_KEY — weak labels will be kept unadjudicated\n")

    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT ta.id, ta.action, ta.description, ta.risk_labels, ta.reversible, "
            "       ta.classification_source, at.name AS tool_name, ag.name AS agent_name "
            "FROM tool_actions ta "
            "JOIN agent_tools at ON ta.tool_id = at.id "
            "JOIN agents ag ON at.agent_id = ag.id "
            "ORDER BY ag.name, at.name, ta.action"
        ).fetchall()

        changed = 0
        for r in rows:
            # Catalog-covered actions are already resolved live at read time.
            if ACTION_CATALOG.get(r["tool_name"], {}).get(r["action"]):
                continue
            mapped = classify_with_fallback(r["tool_name"], r["action"], r["description"] or "")
            old_labels = sorted(json.loads(r["risk_labels"] or "[]"))
            new_labels = sorted(mapped.risk_labels)
            old_rev, new_rev = bool(r["reversible"]), mapped.reversible
            old_src = r["classification_source"] if "classification_source" in r.keys() else "unknown"
            if old_labels == new_labels and old_rev == new_rev and old_src == mapped.classification_source:
                continue
            changed += 1
            print(f"{r['agent_name']} / {r['tool_name']}.{r['action']}")
            if old_labels != new_labels:
                print(f"    labels: {old_labels} -> {new_labels}")
            if old_rev != new_rev:
                print(f"    reversible: {old_rev} -> {new_rev}")
            if old_src != mapped.classification_source:
                print(f"    source: {old_src} -> {mapped.classification_source}")
            if args.apply:
                conn.execute(
                    "UPDATE tool_actions SET risk_labels = ?, reversible = ?, classification_source = ? WHERE id = ?",
                    (json.dumps(mapped.risk_labels), mapped.reversible, mapped.classification_source, r["id"]),
                )

        print(f"\n{changed} of {len(rows)} stored actions {'updated' if args.apply else 'would change (dry-run — pass --apply to write)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
