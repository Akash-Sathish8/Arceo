# Arceo

Cost + risk governance for AI agents. Arceo tells you **how much your AI agent will cost** — and **what could go wrong with it** — before you put it in production.

Point Arceo at an agent (Anthropic SDK, OpenAI, an MCP server, or a GitHub repo) and it produces one CFO-readable report: a monthly spend forecast with a confidence band, the agent's blast radius (0–100), the dangerous action chains it can perform, and the worst-case dollar exposure if one of those chains fires.

> The product was previously called ActionGate. The SQLite file is still `actiongate.db` and the seed admin is `admin@actiongate.io`.

## What it does

1. **Forecast cost** — estimate an agent's monthly LLM + tool spend with a confidence band that tightens as real usage flows in.
2. **Map the blast radius** — score how dangerous an agent is (0–100) from the actions it can take.
3. **Detect dangerous chains** — "can read PII" + "can send email" = exfiltration risk; two money-moving actions = chained-fraud risk. Risk-label transitions, not hardcoded patterns.
4. **Price the worst case** — what a fired chain could cost in dollars.
5. **Test in a sandbox** — run the agent against mock APIs with realistic fake data; every tool call is policy-enforced.
6. **Enforce policies** — block or require approval for dangerous actions, at runtime.

Buyer: CIO + CFO together. Platform-agnostic — any agent in, one report out.

## Quick start

```bash
# Backend (port 8000)
cd arceo/backend
pip install -r requirements.txt
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env        # for LLM classification + simulation
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env # don't ship the default secret
python3 -m uvicorn main:app --reload --port 8000

# Frontend (port 5173)
cd arceo/frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Log in with `admin@actiongate.io` / `admin123`.

## Test with a real agent

```bash
pip install -e sdk        # installs the `arceo` package (stdlib-only)
```

```python
from anthropic import Anthropic
from arceo import wrap_llm

# Capture every completion so Arceo can forecast this agent's cost
client = wrap_llm(Anthropic(), "your-agent-id", base_url="http://localhost:8000")
client.messages.create(
    model="claude-sonnet-4-6", max_tokens=256,
    messages=[{"role": "user", "content": "Handle this ticket..."}],
)
```

Token usage is reported to Arceo automatically; after ~50 calls in 7 days the forecast moves to its high-confidence tier. See `sdk/README.md` for OpenAI, `enforce()`, and configuration.

## SDK

The `arceo` SDK (in `sdk/`, stdlib-only) does two things:

- **`wrap_llm(client, agent_id)`** — capture each LLM completion's token usage so Arceo can forecast cost and tighten it with real usage (Anthropic + OpenAI).
- **`enforce(agent_id, tool, action, params)`** — check a tool call against your policies before running it (ALLOW / BLOCK / REQUIRE_APPROVAL).

```python
from anthropic import Anthropic
from arceo import wrap_llm, enforce

client = wrap_llm(Anthropic(), "my-agent")          # cost capture, automatic

if enforce("my-agent", "stripe", "create_refund", {"amount": 500},
           token="<arceo-jwt>")["decision"] == "ALLOW":
    stripe.refunds.create(...)
```

Full usage (OpenAI, `report_llm_call`, `on_error` fail-open/closed, env vars): **`sdk/README.md`**.

## GitHub Action — agent security scan

Scan agent code on every push/PR. Add `.github/actions/scan` to your workflow; it detects changed agent files and calls `POST /api/scan` with `{files: [{path, content}], threshold}`. The build fails when an agent introduces a critical chain or its blast radius crosses your threshold, and a summary is posted to the PR. No data is stored — pure read-side analysis.

## Mock HTTP endpoints

Real agents can call Arceo's mock APIs over HTTP to drive a sandbox session:

```bash
# Create a session
curl -X POST http://localhost:8000/mock/session \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "my-agent"}'

# Call a tool (returns fake data, checks enforcement)
curl -X POST http://localhost:8000/mock/stripe/get_customer \
  -H "X-Session-ID: <session_id>" \
  -H "X-Agent-ID: my-agent" \
  -H "Content-Type: application/json" \
  -d '{"customer_id": "cust_1042"}'

# Get the trace
curl http://localhost:8000/mock/session/<session_id>/trace
```

81 mock actions across 12 services: Stripe, Zendesk, Salesforce, SendGrid, GitHub, AWS, Slack, PagerDuty, HubSpot, Gmail, Calendly, Email.

## API

All `/api/*` endpoints require a Bearer JWT unless noted; every query is scoped by `org_id` (multi-tenant).

### Auth
- `POST /api/auth/login` — login, get JWT
- `GET /api/auth/me` — current user

### Authority engine
- `GET /api/authority/agents` — all agents with blast radius
- `GET /api/authority/agent/{id}` — detail with graph, chains, policies
- `POST /api/authority/agents` — create agent
- `DELETE /api/authority/agent/{id}` — delete agent
- `GET /api/authority/chains` — all dangerous chains

### Agent discovery
- `POST /api/authority/agents/register` — agents self-register
- `POST /api/authority/agents/import/mcp` — import MCP tools
- `POST /api/authority/agents/import/openai` — import OpenAI functions
- `POST /api/authority/agents/extract-github` — scan a public GitHub repo

### Cost + enforcement
- `GET /api/agents/{id}/spend-forecast` — monthly cost forecast + confidence band
- `GET /api/agents/{id}/cost-report` — capability → dollar exposure ranges
- `POST /api/enforce` — runtime policy check (agents call before acting)
- `POST /api/authority/agent/{id}/policies` — create policy
- `DELETE /api/authority/policy/{id}` — delete policy

### Sandbox
- `GET /api/sandbox/agent/{id}/scenarios` — auto-generated scenarios
- `POST /api/sandbox/simulate` — run a simulation (`dry_run` skips the LLM)
- `GET /api/sandbox/simulations` — list past runs
- `POST /api/sandbox/apply-policy` / `apply-all-policies` — apply recommended policies

### Scan (GitHub Action)
- `POST /api/scan` — score agent files (auth: `X-API-Key`). No DB writes.

## Architecture

```
arceo/
  backend/                FastAPI Authority Engine (Python 3.11)
    main.py               API — 80+ endpoints
    authority/            blast radius, chain detection, risk classification, enforcement
    analysis/             cost model + spend forecaster
    sandbox/              simulation engine, 12 service mocks, red-team, boundary tester
    ingestion/            LangSmith / LangFuse trace import
    tests/                pytest suite (CI: .github/workflows/tests.yml)
  frontend/               Vite + React 19 + TypeScript dashboard
production/
  website/                Next.js marketing site
sdk/
  arceo/                  Python SDK — wrap_llm + enforce (stdlib-only)
```
