 # Arceo

  **Cost + risk governance for AI agents.** Arceo tells you how much your AI agent will cost, and what could go wrong with it before you put it in production.

  Point Arceo at an agent (Anthropic SDK, OpenAI, an MCP server, or a GitHub repo) and it produces a readable report: a monthly spend forecast with a confidence band, the agent's blast radius (how dangerous it is), the
  dangerous action chains it can perform, and the worst-case dollar exposure if one of those chains fires.

  ## The problem

  When a company ships an AI agent, one that sends emails, processes refunds, deploys code, they ask two questions. 

  1. **How much will it cost in production?** Token bills, tool fees, retries, and model swaps compound unpredictably.
  2. **What's the worst case if it misbehaves?** Data leaks, runaway spend, irreversible actions, dangerous chains of tool calls.

  Arceo answers both before deployment, in one report.

  ## What it does

  1. **Forecast cost** — estimate an agent's monthly LLM + tool spend with a 3-tier confidence band that tightens as real usage data flows in. If there's no signal yet, it says so instead of printing a fake
  number.
  2. **Map the blast radius** — score how dangerous an agent is, from the actions it can take, weighted by reversibility and read vs. write.
  3. **Detect dangerous chains** — risk-label transition rules: "reads PII" → "sends external" = exfiltration; two money-moving actions = chained fraud. Works at the capability level (what it *could* do) and
  the execution level (what it did when we simulate it)
  4. **Price the worst case** — translate a fired chain into a dollar exposure range.
  5. **Test in a sandbox** — run the agent against 12 mock services with realistic fake data; every tool call is policy-enforced.
  6. **Enforce policies** — block or require approval for dangerous actions at runtime, with conditional rules.


  ## Repository structure

  ```
  frontend/      React 19 + Vite + TypeScript dashboard (the product UI)
  backend/       FastAPI "Authority Engine" — risk scoring, forecasting, sandbox (Python 3.11)
  website/       Next.js 16 marketing site
  sdk/           Installable Python SDK (pip install -e sdk, package `arceo`)
  test-agents/   Sample + synthetic agents used to exercise the forecaster and scanner
  .github/       Agent-security scan workflow + composite scan action
  ```
  ## Bring an agent in

  - **Upload code** — paste a file or scan a public GitHub repo; Arceo extracts the tools.
  - **Connect MCP** — point Arceo at a running MCP server and auto-pull its tools.
  - **SDK** — wire a deployed agent with one line (below).

  
  ## CI scanning (GitHub Action)

  Arceo can score agent code on every push/PR. The composite action in `.github/actions/scan` sends changed files to `/api/scan`, which returns a verdict — **fail** on any critical chain or a blast radius over
  your threshold, **warn** within 20 points, else **pass** — and comments on the PR. See `.github/workflows/agent-security.yml`.

  ## Run it

  Arceo needs Postgres and Redis (both hard dependencies). The blessed pilot deploy boots all three — app + Postgres + Redis — with one command:

  ```bash
  ANTHROPIC_API_KEY=sk-ant-...  JWT_SECRET=$(openssl rand -hex 32) \
    docker compose -f docker-compose.pilot.yml up -d --build
  # → app on http://localhost:8000  (readiness: GET /api/health)
  ```

  For local development, run Postgres + Redis via `docker compose up -d` (the dev `docker-compose.yml`) and start the backend from a venv and the frontend with `npm run dev` — see `CLAUDE.md` for the full contributor flow.

  ## Tech stack

  - **Backend:** FastAPI · PostgreSQL (SQLAlchemy/Alembic migrations, RLS multi-tenancy) · Redis (cross-worker rate limiting + live-trace fan-out) · NetworkX · Anthropic SDK · PyJWT · bcrypt
  - **Frontend:** React 19 · Vite · TypeScript · Tailwind v4 · React Router · Zustand · @react-pdf/renderer
  - **Website:** Next.js 16 · React 19 · Tailwind v4
