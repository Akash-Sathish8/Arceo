"""Freeze extracted tool manifests for the file-based answer-key agents.

The 11 file-based agents (test-agents/backend-test-agents/*.py|ts and
test-agents/real-code/*.py) need Haiku extraction before they can be scored,
which costs tokens and is nondeterministic. This script runs extraction ONCE
and commits the result as JSON under tests/eval/extracted_manifests/, so the
blast eval stays keyless and deterministic in CI.

Run manually, with a key, from backend/:

  ANTHROPIC_API_KEY=sk-ant-... python evals/snapshot_manifests.py

Cost: 11 files x 1 Haiku call ≈ well under $1 total. Re-run only when an
agent file changes materially; review the diff — a wrong extraction poisons
the answer key (the founder eyeballs tool lists during adjudication).
"""

from __future__ import annotations

import json
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(BACKEND_DIR)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

OUT_DIR = os.path.join(BACKEND_DIR, "tests", "eval", "extracted_manifests")

# ref (matches blast_answer_key.jsonl) -> source file, repo-relative
SOURCES = {
    "bta_support_agent": "test-agents/backend-test-agents/support_agent.py",
    "bta_devops_agent": "test-agents/backend-test-agents/devops_agent.py",
    "bta_sales_agent": "test-agents/backend-test-agents/sales_agent.ts",
    "bta_web_to_lead_agent": "test-agents/backend-test-agents/web_to_lead_agent.py",
    "rc_calendar_scheduler": "test-agents/real-code/calendar_scheduler.py",
    "rc_support_agent": "test-agents/real-code/support_agent.py",
    "rc_sales_outreach": "test-agents/real-code/sales_outreach.py",
    "rc_churn_agent": "test-agents/real-code/churn_agent.py",
    "rc_offboarding_agent": "test-agents/real-code/offboarding_agent.py",
    "rc_sre_incident_agent": "test-agents/real-code/sre_incident_agent.py",
    "rc_payments_ap_agent": "test-agents/real-code/payments_ap_agent.py",
}


def extract_manifest(content: str, filename: str) -> dict:
    """The same Haiku extraction /api/authority/agents/extract uses, minus the
    DB registration — we only want the tool manifest."""
    import anthropic
    from llm_models import FAST_MODEL
    from main import _EXTRACTION_PROMPT  # single source of truth for the prompt

    client = anthropic.Anthropic()
    response = client.messages.create(
        model=FAST_MODEL,
        max_tokens=8000,
        temperature=0,
        system=_EXTRACTION_PROMPT,
        messages=[{"role": "user", "content": f"File: {filename}\n\n```\n{content[:200_000]}\n```"}],
    )
    if getattr(response, "stop_reason", None) == "max_tokens":
        raise RuntimeError(f"{filename}: extraction overflowed the token budget")
    text = response.content[0].text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(text)


def main() -> int:
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY not set — this script spends real (tiny) tokens "
              "and is run manually. Aborting.")
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    for ref, rel_path in SOURCES.items():
        src = os.path.join(REPO_ROOT, rel_path)
        if not os.path.exists(src):
            print(f"  {ref}: MISSING source {rel_path} — skipped")
            continue
        with open(src, encoding="utf-8") as f:
            content = f.read()
        parsed = extract_manifest(content, os.path.basename(rel_path))
        manifest = {
            "id": ref.replace("_", "-"),
            "name": parsed.get("name") or ref,
            "description": parsed.get("description", ""),
            "tools": [
                {
                    "name": t["name"],
                    "service": t.get("service", t["name"]),
                    "description": t.get("description", ""),
                    "actions": t.get("actions", []) or [],
                }
                for t in (parsed.get("tools") or [])
                if isinstance(t, dict) and t.get("name")
            ],
            "_source": rel_path,
        }
        out = os.path.join(OUT_DIR, f"{ref}.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        n_actions = sum(len(t["actions"]) for t in manifest["tools"])
        print(f"  {ref}: {len(manifest['tools'])} tools / {n_actions} actions -> {out}")
    print("\nReview the diffs, then re-run the eval: python evals/run_blast_eval.py --verbose")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
