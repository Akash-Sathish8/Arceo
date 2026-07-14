# Arceo

**Cost + risk governance for AI agents.** Arceo tells you how much your AI agent
will cost — and what could go wrong with it — before you put it in production.

[![CI](https://github.com/Akash-Sathish8/Arceo/actions/workflows/ci.yml/badge.svg)](https://github.com/Akash-Sathish8/Arceo/actions/workflows/ci.yml)
![Python 3.11](https://img.shields.io/badge/python-3.11-blue.svg)
![React 19](https://img.shields.io/badge/React-19-149ECA.svg)
![License: Proprietary](https://img.shields.io/badge/license-Proprietary-red.svg)

<!-- Add a product screenshot here for the strongest first impression, e.g. docs/screenshot.png -->

Point Arceo at an agent (Anthropic SDK, OpenAI, an MCP server, or a GitHub repo)
and it produces a readable report: a monthly spend forecast with a confidence band,
the agent's blast radius (how dangerous it is), the dangerous action chains it can
perform, and the worst-case dollar exposure if one of those chains fires.

## The problem

When a company ships an AI agent — one that sends emails, processes refunds, or
deploys code — it asks two questions:

1. **How much will it cost in production?** Token bills, tool fees, retries, and
   model swaps compound unpredictably.
2. **What's the worst case if it misbehaves?** Data leaks, runaway spend,
   irreversible actions, dangerous chains of tool calls.

Arceo answers both before deployment, in one report.

## What it does

1. **Forecast cost** — estimate an agent's monthly LLM + tool spend with a 3-tier
   confidence band that tightens as real usage data flows in. If there's no signal
   yet, it says so instead of printing a fake number.
2. **Map the blast radius** — score how dangerous an agent is, from the actions it
   can take, weighted by reversibility and read vs. write.
3. **Detect dangerous chains** — risk-label transition rules: "reads PII → sends
   external" = exfiltration; two money-moving actions = chained fraud. Works at the
   capability level (what it *could* do) and the execution level (what it did in
   simulation).
4. **Price the worst case** — translate a fired chain into a dollar-exposure range.
5. **Test in a sandbox** — run the agent against 12 mock services with realistic
   fake data; every tool call is policy-enforced.
6. **Enforce policies** — block or require approval for dangerous actions at
   runtime, with conditional rules.

## Quickstart

Run the whole product as one container:

```bash
docker build -t arceo .
docker run -p 8000:8000 -v arceo-data:/data \
  -e ANTHROPIC_API_KEY=... -e JWT_SECRET=... arceo
```

Then open http://localhost:8000. For running the backend, frontend, and website
separately in development, see [CONTRIBUTING.md](CONTRIBUTING.md).

