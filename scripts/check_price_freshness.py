#!/usr/bin/env python3
"""Warn when the model price table has gone stale.

Vendor LLM pricing changes often enough that the YAML header says "verify
quarterly" — but nothing enforced it, and the file once carried a header date
that contradicted its own last_calibrated field. This check makes staleness
visible in CI instead of silently biasing every forecast.

Each model row in cost_defaults_operational.yaml carries:
    verified_on: "YYYY-MM-DD"   # when a human last checked the rate
    source_url:  "https://..."  # the official vendor page it came from

Rows older than --max-age-days (default 90) or missing metadata produce
GitHub Actions ::warning:: annotations. Exit code stays 0 by default so the
passage of time never breaks CI on an unrelated PR; pass --strict to hard-fail
(e.g. for a scheduled audit job).

Usage:  python3 scripts/check_price_freshness.py [--max-age-days 90] [--strict]
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, datetime
from pathlib import Path

import yaml

YAML_PATH = (Path(__file__).resolve().parent.parent
             / "backend" / "analysis" / "cost_defaults_operational.yaml")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-age-days", type=int, default=90)
    ap.add_argument("--strict", action="store_true",
                    help="exit 1 on any warning instead of just annotating")
    args = ap.parse_args()

    data = yaml.safe_load(YAML_PATH.read_text())
    today = date.today()
    warnings: list[str] = []

    for key, row in (data.get("models") or {}).items():
        verified_on = row.get("verified_on")
        if not verified_on:
            warnings.append(f"model '{key}' has no verified_on date — rate is unaudited")
            continue
        try:
            checked = datetime.strptime(str(verified_on), "%Y-%m-%d").date()
        except ValueError:
            warnings.append(f"model '{key}' has unparseable verified_on '{verified_on}'")
            continue
        age = (today - checked).days
        if age > args.max_age_days:
            warnings.append(
                f"model '{key}' price last verified {verified_on} ({age}d ago, "
                f"limit {args.max_age_days}d) — re-check {row.get('source_url', 'the vendor page')}"
            )
        if not row.get("source_url"):
            warnings.append(f"model '{key}' has no source_url — rate can't be re-audited")

    for msg in warnings:
        print(f"::warning file=backend/analysis/cost_defaults_operational.yaml::{msg}")

    if warnings:
        print(f"{len(warnings)} price-freshness warning(s)", file=sys.stderr)
        return 1 if args.strict else 0
    print(f"price table fresh: all {len(data.get('models') or {})} model rows "
          f"verified within {args.max_age_days} days")
    return 0


if __name__ == "__main__":
    sys.exit(main())
