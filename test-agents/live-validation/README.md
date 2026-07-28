# Live-validation oracle — real-token ground truth (HIGH tier)

`ledger.jsonl` is the **independent** ground truth for the cost engine's HIGH tier:
829 real Anthropic `usage` records captured **client-side** (in the agent process,
*not* by Arceo's own capture) while three real-code agents were driven through the
LLM proxy over 21 distinct days (2026-07-03 → 2026-07-26).

Because the usage is measured independently of Arceo, re-pricing it with the engine's
own catalog and comparing to the measured spend is a true backtest — "never grade
Arceo with Arceo's numbers."

## Schema (one JSON object per line)

```
{"day","agent","model","input_tokens","output_tokens",
 "cache_creation_input_tokens","cache_read_input_tokens","ts"}
```

All cache fields are `0` in this ledger, so pricing is unambiguous
(`cost = in·in_price + out·out_price`).

## Agents and hand-computed monthly truth

Priced with `backend/analysis/cost_defaults_operational.yaml`, monthly =
`(Σ per-call $ / distinct_days) × 30`:

| agent | rows | days | model | monthly truth |
|---|---|---|---|---|
| live-support-agent | 327 | 21 | claude-sonnet-4-6 | $3.92 |
| live-payments-ap | 339 | 20 | claude-sonnet-4-6 | $4.47 |
| live-calendar-scheduler | 163 | 19 | claude-haiku-4-5 | $0.59 |

## Consumers

- `backend/tests/test_spend_backtest.py` — asserts the engine reproduces the three
  monthly truths (CI gate).
- `test-agents/run_backtest_report.py` — prints the proof table for the demo.

Source of record: `brain/Live/mvp-campaign/live-validation/` (the harness `drive_day.py`
still imports agent modules from `/tmp`; relocating those into the repo is a
post-demo backlog item — the committed `ledger.jsonl` here is self-contained).
