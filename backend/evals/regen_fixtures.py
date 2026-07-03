"""Regenerate tests/eval/llm_fixtures.json against the CURRENT LLM_SYSTEM_PROMPT.

Run manually whenever eval cases are added or the prompt changes:
  cd backend && ./venv/bin/python evals/regen_fixtures.py

Requires ANTHROPIC_API_KEY (read from backend/.env if not in the environment).
Each case gets majority-of-3 votes at temperature=0 so fixtures are stable.
Catalog-hit cases are skipped — classify_with_fallback returns at layer 1 and
never consults the LLM for them.
"""

from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

# Load .env like main.py does, without overriding real env
env_path = os.path.join(BACKEND_DIR, ".env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v)

from authority.action_mapper import ACTION_CATALOG
from authority.risk_classifier import (
    LLM_SYSTEM_PROMPT, VALID_LABELS, build_llm_user_msg, keyword_candidates,
)
from evals.eval_lib import FIXTURES_PATH, fixture_key, load_cases

MODEL = "claude-haiku-4-5-20251001"
VOTES = 3


def _one_vote(client, action: str, description: str, schema_keys: list) -> tuple[list, bool] | None:
    # Byte-identical to the pipeline's prompt, including keyword candidates.
    schema = {"properties": {k: {} for k in schema_keys}} if schema_keys else None
    user_msg = build_llm_user_msg(
        action, description, schema_keys or None,
        keyword_candidates(action, description, schema),
    )
    try:
        resp = client.messages.create(
            model=MODEL, max_tokens=200, temperature=0,
            system=LLM_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )
        text = resp.content[0].text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        result = json.loads(text)
        labels = [l for l in result.get("risk_labels", []) if l in VALID_LABELS]
        return labels, bool(result.get("reversible", True))
    except Exception as e:
        print(f"  vote failed for {action}: {e}", file=sys.stderr)
        return None


def _majority(votes: list[tuple[list, bool]]) -> tuple[list, bool]:
    need = len(votes) // 2 + 1
    label_counts: dict[str, int] = {}
    irrev = 0
    for labels, reversible in votes:
        for l in labels:
            label_counts[l] = label_counts.get(l, 0) + 1
        if not reversible:
            irrev += 1
    labels = sorted(l for l, c in label_counts.items() if c >= need)
    return labels, irrev < need


def main() -> int:
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY required")
        return 1
    import anthropic
    client = anthropic.Anthropic()

    cases = [
        c for c in load_cases()
        if ACTION_CATALOG.get(c.tool, {}).get(c.action) is None  # skip layer-1 hits
    ]
    print(f"{len(cases)} non-catalog cases x {VOTES} votes = {len(cases) * VOTES} calls to {MODEL}")

    def classify(case):
        votes = []
        for _ in range(VOTES):
            v = _one_vote(client, case.action, case.description, case.input_schema_keys)
            if v is not None:
                votes.append(v)
        if not votes:
            return case, None
        labels, reversible = _majority(votes)
        return case, {"labels": labels, "reversible": reversible, "votes": len(votes)}

    fixtures: dict = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for case, result in pool.map(classify, cases):
            if result is None:
                print(f"  ALL VOTES FAILED: {case.id} {case.action}")
                continue
            fixtures[fixture_key(case.action, case.description)] = result

    fixtures = dict(sorted(fixtures.items()))
    with open(FIXTURES_PATH, "w") as f:
        json.dump(fixtures, f, indent=2)
    print(f"wrote {len(fixtures)} fixtures to {FIXTURES_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
