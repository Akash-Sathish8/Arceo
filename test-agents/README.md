# Arceo spend-forecast accuracy harness

## Purpose

Measure how **accurately** Arceo's spend forecaster predicts an AI agent's real
monthly cost — and how much a sandbox sweep (and, later, live trace ingestion)
improves that accuracy.

**The one rule that makes this an honest test:** a forecast is only "accurate"
when measured against an **independently-known true cost**. Every test agent
carries an `expected_truth` block whose `monthly_point_usd` was computed **by
hand** from the model pricing + the agent's declared behavior — never read back
from Arceo. **Never grade Arceo with Arceo's own numbers.** The forecaster's
output is the thing under test; the hand math is the answer key.

## Folder layout

```
spend-test-agents/
├─ README.md                  this guide
├─ register_and_forecast.py   runnable harness (stdlib only)
├─ synthetic/                 controlled manifests; expected_truth computed by hand
│   └─ NN_*.json              each: register_payload + behavior + expected_truth
└─ real-github/               real public repos scanned in place (no hand truth;
                              used for qualitative sanity, not relative-error scoring)
```

`synthetic/` is the scoreable fleet: behavior is fully specified, so the true
cost is knowable to the dollar. `real-github/` repos have no hand-computed
truth — they exercise the extractor/scanner end-to-end but are not graded on
relative error.

## The 3-tier convergence test

Arceo reports a confidence tier based on how much real data it has. As data
arrives, the forecast should **tighten** (narrower band) and **converge** toward
`expected_truth`:

| Tier | Trigger | What it has | Expected behavior |
|---|---|---|---|
| **LOW** | just connected, no traces | capability tree + archetype defaults | widest band; point often off by 10–40x on agents whose real volume/tokens differ from defaults |
| **MEDIUM** | after a sandbox sweep | sandbox traces | band narrows; tier flips to medium |
| **HIGH** | ≥ 50 live captured LLM calls in 7 days | per-agent rolling token/volume averages | tightest band (±15%); point converges to truth |

**Known gap to watch (do not mistake for a bug):** sandbox traces feed
**unit-economics + tier detection** but **NOT** the point estimate's per-call
token basis — only **live** captured LLM calls move the per-call token math.
So at MEDIUM the **band may narrow without the point moving**. The point only
converges to truth once live ingestion (`POST /api/agent/{id}/llm-call`) supplies
≥ 50 real calls and the rolling averages kick in (HIGH tier). Treat a MEDIUM
run that narrows the band but leaves the point near its LOW value as **expected**,
not a regression.

## The synthetic fleet

| file | role | danger | model | expected $/mo | what it tests |
|---|---|---|---|---:|---|
| `synthetic/01_cheap_scheduler.json` | cheap | low | claude-haiku-4-5 | $0.40 | cost floor — sub-dollar, not 0 or balloon; LOW overstates ~10x (defaults assume 100 calls/day, 60% cache) |
| `synthetic/02_support_agent.json` | normal | medium | claude-sonnet-4-6 | $15.73 | common case; LLM tokens dominate, cheap email + zero-cost refund negligible |
| `synthetic/03_sales_crm.json` | normal | medium | claude-sonnet-4-6 | $187.01 | 5x volume + a real per-action tool line (stripe.create_charge + template email ~45% of LLM cost) |
| `synthetic/04_rag_research.json` | token-heavy | low | claude-sonnet-4-6 | $713.86 | huge 80k-token context; LOW underestimates ~1 order of magnitude on token basis |
| `synthetic/05_budget_buster_infra.json` | expensive | critical | claude-opus-4-7 | $16,715.78 | ceiling: Opus 1.35x inflation, 2000 calls/day, expensive tools; LOW under-forecasts ~20–40x |
| `synthetic/06_skewed_distribution.json` | adversarial | high | claude-sonnet-4-6 | $124.48 | 95/5 skew to one paid action vs uniform-distribution assumption (~9.5x under on tool cost) |
| `synthetic/07_long_loop.json` | adversarial | medium | claude-sonnet-4-6 | $70.70 | long agentic loop, ~15 tool results / call (~8500 in tok) vs 1-result static estimate |
| `synthetic/08_model_switcher.json` | adversarial | medium | claude-haiku-4-5 | $50.26 | silent 20% Opus escalation vs single-model assumption; expected_truth uses 80/20 blend |

Columns: file | role | danger | model | expected $/mo | what it tests. Each
JSON's `expected_truth.how_computed` shows the full arithmetic so the answer key
is auditable.

> Note on `simulation_model`: it is **not settable through any API** (the
> register/PUT bodies accept only name/description/tools). The harness surfaces
> the declared model for reference but cannot set it. To make a **real** sweep
> run on the declared model, `UPDATE agents SET simulation_model=? WHERE id=?`
> in `actiongate.db` directly.

## Known forecaster gaps this fleet exposes

Building the fleet already surfaced real product gaps before a single run. The
`expected_truth` blocks deliberately use **real-world API prices** (e.g. a
SendGrid send ≈ $0.0004, an RDS snapshot ≈ $0.02), so the gap between truth and
Arceo's output is itself a finding, not a test error:

1. **Tool cost is keyed by tool *name*, and only `stripe` overlaps the sandbox.**
   `_estimate_tool_cost_per_call` (`spend_forecast.py:697`) looks up
   `tool_action_costs[tool_name][action]`. The pricing table is keyed
   `sendgrid, twilio, stripe, aws_rds, aws_lambda, aws_s3, pinecone,
   openai_embeddings, browserbase`; the registerable/sandbox tools are named
   `aws, calendly, email, github, gmail, hubspot, pagerduty, salesforce, slack,
   stripe, zendesk`. **`stripe` is the only name in both.** So Arceo forecasts
   **$0 tool cost for every non-Stripe tool** — agents 02/03/05/06 will show a
   tool-cost line below their `expected_truth`. Two consequences: tool-cost
   forecasting is effectively Stripe-only, and you **cannot validate non-Stripe
   tool cost via a sandbox sweep** (the only priced tool that is also a mock is
   `stripe`). *Fix:* align the pricing-table keys with the tool/mock names, or add
   a service-alias map (`email→sendgrid`, `aws→aws_rds`, …).

2. **Sandbox traces don't move the point estimate** — only the band + unit
   economics (see the 3-tier note above). The point converges only at HIGH tier
   via live capture.

3. **`simulation_model` is not settable through any API** (see the fleet note
   above) — a real per-model sweep needs a direct DB patch.

`08_model_switcher.json` is intentionally **unreachable by the live system**: its
`expected_truth` is a real 80/20 Haiku/Opus blend, but Arceo prices 100% of calls
at one model, so its forecast will sit ~44% below truth even with perfect volume
data. That permanent gap *is* the test of the single-model assumption.

## How to run

Start the backend (port 8000), then:

```bash
# LOW tier — register the fleet and score forecasts vs truth
python3 register_and_forecast.py

# point at a different backend
python3 register_and_forecast.py --base-url http://localhost:8000

# reuse agents already registered (skip the register POST)
python3 register_and_forecast.py --no-register

# MEDIUM tier — run a sandbox sweep per agent, then re-forecast and re-score
python3 register_and_forecast.py --sweep            # dry_run=true (no LLM, free)
python3 register_and_forecast.py --sweep --real-sweep  # real LLM loop

# full help (explains tiers + the token-cost warning on --real-sweep)
python3 register_and_forecast.py --help
```

`--real-sweep` runs the agent's real LLM loop: it **spends LLM tokens** and
requires `ANTHROPIC_API_KEY` set **on the server**. Plain `--sweep` uses
`dry_run=true` (no LLM) and produces thinner traces.

`BASE_URL` env var sets the default backend URL (falls back to
`http://localhost:8000`). The harness logs in as `admin@actiongate.io` /
`admin123` and sends the returned JWT as a Bearer token on authed calls.

## Scoring

The harness prints, per tier:

- **Per-agent relative error** = `(forecast_point − expected_truth_point) /
  expected_truth_point` (signed; positive = over-forecast).
- **Band coverage** — does the independent truth land **inside** Arceo's stated
  `[low, high]` band? An honest forecaster should bracket the truth even when the
  point is off.
- **LOW → MEDIUM convergence** — for each agent, did `|relative error|` shrink
  after the sweep? (Per the known gap above, expect the band to tighten more
  reliably than the point.)

A good result, fleet-wide: relative error shrinks LOW → MEDIUM → HIGH and the
true cost lands inside the stated band at every tier — converging on the
hand-computed `expected_truth`, which Arceo never sees.
