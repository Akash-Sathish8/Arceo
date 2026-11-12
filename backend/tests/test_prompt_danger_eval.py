"""Guard rail for the rules-only danger scorer: 140+ realistic prompts, including
coding-agent instructions and ordinary coding requests, must land in their
expected band range (tests/eval/prompt_danger_cases.yaml)."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from prompts.danger import score_danger

ORDER = ["low", "medium", "high", "critical"]
CASES = yaml.safe_load((Path(__file__).parent / "eval" / "prompt_danger_cases.yaml").read_text())["cases"]


def test_the_set_is_big_enough():
    assert len(CASES) >= 140


@pytest.mark.parametrize("case", CASES, ids=[c["p"][:50] for c in CASES])
def test_band_in_expected_range(case):
    band = score_danger(case["p"], {})["band"]
    assert ORDER.index(case["lo"]) <= ORDER.index(band) <= ORDER.index(case["hi"]), \
        f"{band} not in [{case['lo']}, {case['hi']}]: {case['p']}"


def test_no_expected_critical_reads_below_high():
    """The failure that matters most: a critical prompt shown as safe-ish."""
    misses = [c["p"] for c in CASES if c["lo"] == "critical"
              and ORDER.index(score_danger(c["p"], {})["band"]) < ORDER.index("high")]
    assert not misses, misses
