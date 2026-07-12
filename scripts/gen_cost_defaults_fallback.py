#!/usr/bin/env python3
"""Regenerate the no-pyyaml fallback for the operational cost defaults.

backend/analysis/cost_defaults_operational.fallback.json is a byte-for-byte
JSON rendering of cost_defaults_operational.yaml, loaded by load_defaults()
when pyyaml is not installed. It is GENERATED — never edit it by hand. The old
hand-maintained _MINIMAL_DEFAULTS dict drifted badly (11 of ~35 models, stale
calibration date, wrong cache discounts); tests/test_price_hygiene.py fails CI
whenever the YAML changes without rerunning this script.

Usage:  python3 scripts/gen_cost_defaults_fallback.py
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

ANALYSIS = Path(__file__).resolve().parent.parent / "backend" / "analysis"
SRC = ANALYSIS / "cost_defaults_operational.yaml"
DST = ANALYSIS / "cost_defaults_operational.fallback.json"


def main() -> None:
    data = yaml.safe_load(SRC.read_text())
    DST.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n")
    print(f"wrote {DST.relative_to(ANALYSIS.parent.parent)} "
          f"({len(data.get('models', {}))} models)")


if __name__ == "__main__":
    main()
