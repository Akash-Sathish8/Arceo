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

Arceo needs **Postgres and Redis**. Both are hard dependencies — Redis has no
in-memory fallback, and rate limiting fails closed, so an unreachable Redis
returns 429 on every login and enforcement check rather than degrading quietly.

```bash
docker compose up -d postgres redis        # the two backing services
docker build -t arceo .
docker run -p 8000:8000 \
  -e DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/arceo \
  -e REDIS_URL=redis://host.docker.internal:6379/0 \
  -e ANTHROPIC_API_KEY=... -e JWT_SECRET=... arceo
```

Then open http://localhost:8000. The container refuses to start without
`DATABASE_URL` and `REDIS_URL` — deliberately, since booting without them
produces an instance that passes its health check and fails every real request.
For running the backend, frontend, and website separately in development, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Repository structure

```
backend/       FastAPI "Authority Engine" — risk scoring, forecasting, sandbox (Python 3.11)
frontend/      React 19 + Vite + TypeScript dashboard (the product UI)
website/       Next.js 16 marketing site
sdk/           Installable Python SDK (pip install -e sdk, package `arceo`)
test-agents/   Sample + synthetic agents used to exercise the forecaster and scanner
scripts/       Operational scripts (SQLite → Postgres migration, key rotation)
docs/          Engineering docs — architecture, security design, runbooks
.github/       CI + the Agent Security Scan composite action
```

## Bring an agent in

- **Upload code** — paste a file or scan a public GitHub repo; Arceo extracts the tools.
- **Connect MCP** — point Arceo at a running MCP server and auto-pull its tools.
- **SDK** — wire a deployed agent with one line (`pip install -e sdk`).

## CI scanning (GitHub Action)

Arceo can score agent code on every push/PR. The composite action in
`.github/actions/scan` sends changed files to `/api/scan`, which returns a
verdict — **fail** on any critical chain or a blast radius over your threshold,
**warn** within 20 points, else **pass** — and comments on the PR. See
`.github/workflows/agent-security.yml`.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design, components, request flow, data model
- [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md) — security posture and design
- [CONTRIBUTING.md](CONTRIBUTING.md) — local setup, branch model, tests
- [SECURITY.md](SECURITY.md) — how to report a vulnerability
- [CHANGELOG.md](CHANGELOG.md) — release history

## Tech stack

- **Backend:** FastAPI · Postgres (psycopg3 + Alembic) · Redis · NetworkX · Anthropic SDK · PyJWT · bcrypt
- **Frontend:** React 19 · Vite · TypeScript · Tailwind v4 · React Router · Zustand · @react-pdf/renderer
- **Website:** Next.js 16 · React 19 · Tailwind v4

## License

Proprietary — all rights reserved. See [LICENSE](LICENSE).
