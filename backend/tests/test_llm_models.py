"""llm_models is the single source of truth for our Anthropic model IDs.

These tests don't hit the network — they pin the contract: call sites import
from llm_models (no stray hardcoded IDs), and the startup verifier never
raises no matter what state the key is in.
"""

import glob
import os
import re

import llm_models


BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_verify_never_raises_without_key():
    llm_models.verify_models_at_startup(None)
    llm_models.verify_models_at_startup("")


def test_verify_never_raises_on_bad_key():
    # A garbage key fails auth inside the SDK; the verifier must swallow it.
    llm_models.verify_models_at_startup("sk-ant-not-a-real-key")


def test_no_hardcoded_model_ids_outside_llm_models():
    """Every messages.create call site must use the shared constants.

    The pricing tables (analysis/) keep their own model keys on purpose —
    they price customer-declared models, not our own calls.
    """
    pattern = re.compile(r'model="claude-[^"]+"')
    offenders = []
    for path in glob.glob(os.path.join(BACKEND, "**", "*.py"), recursive=True):
        rel = os.path.relpath(path, BACKEND).replace(os.sep, "/")
        # venv/ holds the vendored Anthropic SDK — third-party code, not call sites.
        if rel.startswith(("tests/", "analysis/", "venv/")) or rel == "llm_models.py":
            continue
        if "node_modules" in rel or rel.startswith("."):
            continue
        with open(path) as f:
            for i, line in enumerate(f, 1):
                if pattern.search(line):
                    offenders.append(f"{rel}:{i}: {line.strip()}")
    assert not offenders, (
        "Hardcoded Anthropic model IDs found — import from llm_models instead:\n"
        + "\n".join(offenders)
    )
