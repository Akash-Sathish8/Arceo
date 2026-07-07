# Arceo

A trust and control layer for AI agents. Arceo maps every tool an agent can call, scores its blast radius, detects dangerous action chains, and enforces policies at runtime.

> **Brand note:** the product was previously called ActionGate. The code is mid-rename — most user-facing copy says "Arceo," but the SQLite file is still `actiongate.db` and the seed admin email is `admin@actiongate.io`. Don't normalize this in passing.

---

## Strategic positioning (as of 2026-05-29 — see `brain/`)

**The `brain/` directory is the source of truth for strategic state.** Read `brain/Company files/Product explanation.md`, `brain/Company files/Product direction.md`, and `brain/README.md` before any product-direction reasoning.

**Wedge:** Cost + risk governance for AI agents. **Buyer: CIO + CFO together.**

**One-line product:** "Arceo tells you how much your AI agent will cost — and what could go wrong with it — before you put it in production."

**Why this buyer:** The CIO has agents to ship but can't get sign-off because nobody can answer the budget question. The CFO has been burned by surprise SaaS bills and won't approve scaling AI without a defensible cap. The agent-security space is consolidated around CISO buyers — the CIO + CFO buyer is uncrowded.

**What we are:** Predeployment forecast + risk in one CFO-readable report — *"this agent costs $X/month ±Y%, worst case is $Z if this chain fires."*

**What we are NOT:**
- Not an AI eval platform (Galileo, Patronus)
- Not an AI security platform sold to CISOs (Zenity, Noma)
- Not LLM observability (LangSmith, Helicone — they measure *after* deploy; we forecast *before*)
- Not an agent builder — we govern them

**Validation signal:** [[CIO budget forecasting pain]] — Akash's CIO contacts cannot forecast production cost; blocks pilot → production transition. One CIO has validated agent spend-forecasting as a major pain point (2026-05-28).

**Stale wedge — do not pitch this:** Earlier strategic notes (pre-2026-05-29) framed Arceo as an Agentforce-specific security tool sold to the Salesforce CoE lead. The brain explicitly retired that wedge. **The product is platform-agnostic — any agent in (Anthropic SDK, OpenAI, MCP, GitHub scan), one CFO-readable forecast out.** The Salesforce OAuth + `/orgs` work originally shipped under that wedge was rolled back on 2026-06-03 (see commits reverting `447f33a` + `092d651`).

---

## Repo layout

*(Re-verified against `dev` 2026-07-07. Earlier versions of this file described a pre-rename `ActionGate/arceo/production` layout that exists on NO current branch — when in doubt, `git ls-tree origin/dev`.)*

```
Arceo/
├─ backend/                FastAPI Authority Engine (Python 3.11)
│  └─ analysis/ authority/ evals/ ingestion/ jobs/ sandbox/ testing/ tests/
├─ frontend/               Vite + React 19 + TS dashboard
├─ website/                Next.js marketing site
├─ sdk/                    Python SDK
├─ test-agents/            Synthetic + real-code validation fleets (MVP campaign)
├─ .github/
│  ├─ workflows/tests.yml  pytest on push/PR
│  └─ actions/scan/        Agent Security Scan composite action
├─ Dockerfile              Single container: backend + built SPA (added 2026-07-07, PR #27)
└─ README.md
```

The canonical CLAUDE.md lives at the repo root on `dev` (added 2026-07-07). The `~/Arceo` checkout's copy is what local Claude sessions load — when updating one, sync the other.

---

## Codebase size

| Area | Files | LOC (dev, 2026-07-07) |
|---|---|---|
| Backend (Python) | 74 | 21,637 |
| Frontend (TS/TSX) | 50 | 18,877 |
| Website (TSX/TS) | 18 | ~1,850 |

**Largest files (refactor candidates):**
- `backend/main.py` — **monolith, 80+ endpoints, 5,482 lines.** Needs splitting by domain (auth, authority, sandbox, ingestion, proxy).
- `frontend/src/pages/AgentDetail.tsx` — **2,906 lines.** Tabbed monolith.
- `frontend/src/pages/Workflows.tsx` — **1,867 lines.**
- `frontend/src/pages/Authority.tsx` — **1,668 lines.** Dashboard + Connect form combined.
- `frontend/src/pages/CostPortfolio.tsx` — **1,299 lines.** The CFO-facing wedge surface.

---

## Running locally

```bash
# Backend (port 8000)
cd backend
pip install -r requirements.txt
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env       # required for LLM classification + simulation
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env # don't ship default secret
python3 -m uvicorn main:app --reload --port 8000

# Frontend (port 5173)
cd frontend
npm install
npm run dev

# Website (port 3000)
cd website
npm install
npm run dev
```

Or the whole product as one container: `docker build -t arceo . && docker run -p 8000:8000 -v arceo-data:/data -e ANTHROPIC_API_KEY=... -e JWT_SECRET=... arceo` (backend serves the built SPA from `backend/static/`).

The website proxies API calls via `next.config.ts` rewrite: `/api/backend/*` → `${BACKEND_URL ?? "http://localhost:8000"}/api/*`. The frontend talks to the backend directly.

## Demo login

- **Email:** `admin@actiongate.io`
- **Password:** `admin123`
- **Magic demo wipe:** typing `demo` (any case) in the email field on `/login` deletes the demo tables and signs in as admin. ⚠️ Since the D28 fix (2026-07-06) this works **ONLY when the instance runs with `DEMO_MODE=true`** — it used to fire unauthenticated on any instance, which was an all-tenant data wipe. Demo instances must boot with `DEMO_MODE=true`; customer deployments (unset) can never trigger it.

---

## API endpoints (FastAPI, port 8000)

All endpoints under `/api/*` require a Bearer JWT in `Authorization` unless flagged unauthenticated. Multi-tenant: every query scoped by `org_id` from the JWT.

### Auth
- `POST /api/auth/signup` — Create org + admin user
- `POST /api/auth/login` — Returns JWT (24h expiry)
- `GET /api/auth/me`
- `POST /api/auth/change-password`

### Authority engine
- `GET /api/authority/agents` — All agents in org with blast-radius scores
- `GET /api/authority/agent/{id}` — Detail: graph, chains, recommendations, policies, executions
- `POST /api/authority/agents` — Create
- `PUT /api/authority/agent/{id}` — Update
- `DELETE /api/authority/agent/{id}` — Delete
- `POST /api/authority/agents/delete` — Bulk delete
- `GET /api/authority/chains` — All flagged dangerous chains
- `GET /api/services` — Available services (unauth)

### Agent discovery
- `POST /api/authority/agents/register` — Self-register with tool manifest (auto-classifies risk labels)
- `POST /api/authority/agents/import/mcp` — Import from MCP `tools/list` format
- `POST /api/authority/agents/import/openai` — Import from OpenAI function-calling format
- `POST /api/authority/agents/connect/mcp` — Live MCP server connect, auto-pull tools
- `POST /api/authority/agents/extract` — Haiku-powered code extraction from a single file
- `POST /api/authority/agents/extract-github` — Whole-repo scan (walks public GitHub tree, ~5–8s per file)

### Policies + enforcement
- `GET /api/authority/agent/{id}/policies`
- `POST /api/authority/agent/{id}/policies` — Auto-priority: BLOCK=100, REQUIRE_APPROVAL=50, ALLOW=10
- `DELETE /api/authority/policy/{id}`
- `GET /api/authority/agent/{id}/policy-conflicts` — Detect overlapping policies
- `POST /api/enforce` — Runtime check with `params` and `session_context`
- `GET /api/approvals` — Pending approval queue (frontend polls 30s)
- `POST /api/approvals/{execution_id}` — Approve/reject

### Test data fixtures
- `GET|PUT|DELETE /api/authority/agent/{id}/test-data`

### Sandbox simulation
- `GET /api/sandbox/scenarios` — 28 scenarios (normal / edge / adversarial / chain exploit) across 4 archetypes (support, devops, sales, ops)
- `GET /api/sandbox/scenarios/{agent_type}` — Filtered
- `GET /api/sandbox/agent/{agent_id}/scenarios`
- `POST /api/sandbox/simulate` — Single-agent. `dry_run=true` skips LLM
- `POST /api/sandbox/simulate/multi` — Multi-agent with dispatch + depth-3 cap
- `GET /api/sandbox/simulate/stream` — SSE live stream
- `GET /api/sandbox/simulations` — List past
- `GET /api/sandbox/simulation/{id}` — Detail with trace + report
- `POST /api/sandbox/apply-policy` / `apply-all-policies` — Apply recommended policy from a sim
- `POST /api/sandbox/sweep` — Run all scenarios for an agent, aggregate report
- `GET /api/sandbox/sweeps` / `GET /api/sandbox/sweep/{id}`

### Adversarial testing
- `POST /api/boundary-test/{agent_id}` — Enumerate every dangerous action sequence
- `POST /api/red-team/{agent_id}` — Claude-as-attacker vs the agent's own LLM loop
- `POST /api/regression-test/{agent_id}` — Detect policy changes that make agent LESS safe
- `GET /api/regression-test/{agent_id}/history`
- `POST /api/prelaunch/{agent_id}` — Aggregate: boundary + regression + cost + replay → prioritized fix list
- `POST /api/prelaunch/{agent_id}/auto-fix`

### Trace ingestion + replay
- `POST /api/ingest/langsmith` / `POST /api/ingest/langfuse` / `POST /api/ingest/generic`
- `POST /api/replay` — Replay historical trace against current policies
- `POST /api/traces/live` — Live trace ingestion
- `GET /api/traces/live/{agent_id}`
- `WS /ws/traces/{agent_id}` — Live trace WebSocket

### Proxy (transparent enforcement)
- `ANY /proxy/{service}/{path}` — Set `X-Agent-ID` header. Enforces policies then forwards. Supports stripe, zendesk, salesforce, sendgrid, github, slack, pagerduty, hubspot, gmail, calendly
- `ANY /proxy/llm/{provider}/{path}` — `anthropic` / `openai`. Captures full request + response

### LLM capture (unauthenticated)
- `POST /api/agent/{agent_id}/llm-call` — From SDK `wrap_llm()`. Logged under `LLM_CALL`

### Cost model
- `GET /api/agents/{agent_id}/cost-report` — Capabilities → $ exposure ranges from `analysis/cost_defaults.yaml`

### Logs
- `GET /api/audit` (with filters: user, action, resource, date)
- `GET /api/executions` / `GET /api/executions/{agent_id}`

### API keys
- `POST /api/keys` / `GET /api/keys` / `DELETE /api/keys/{id}`

### Notifications + workflows
- `GET|POST /api/notifications/settings`
- `POST /api/workflows/optimize` — Multi-agent workflow optimizer

### SDK + scan
- `POST /api/sdk/analyze-trace`
- `POST /api/report` — Post-hoc reporting (unauthenticated)
- `POST /api/scan` — **GitHub Action endpoint.** Auth: `X-API-Key`. Body: `{files: [{path, content}], threshold?: int}`. Returns: `{summary, agents}`. Verdict: `fail` when any critical chain OR `max_blast_radius > threshold`; `warn` within 20 points; else `pass`. **No DB writes** — pure read-side.

### Mock sandbox
- `POST /mock/session` / `ANY /mock/{tool}/{action}` / `GET /mock/session/{session_id}/trace` / `GET /mock/sessions` / `GET /mock/available`

### Health + meta
- `GET /api/health` — Returns OK
- `GET /api/demo-mode` — Whether DEMO_MODE env var is set

---

## SQLite schema

Single file: `backend/actiongate.db` (or `ARCEO_DB_PATH` — set it to a persistent volume in any real deploy). Schema defined inline in `backend/db.py:init_db()` via `executescript()` + `CREATE TABLE IF NOT EXISTS`. No ORM, raw `sqlite3`. Foreign keys enabled. **17 tables**:

| Table | Purpose |
|---|---|
| `organizations` | Multi-tenant root |
| `users` | Auth — email, bcrypt password, role (admin/viewer), org_id |
| `agents` | Agent defs — name, tools, simulation_model, org_id |
| `agent_tools` | agent_id → tool_id, service, name |
| `tool_actions` | tool_id → action, risk_labels (JSON), reversible |
| `policies` | agent_id, action_pattern, effect, conditions, priority |
| `audit_log` | user_id, email, action, resource, detail, org_id, timestamp |
| `execution_log` | agent_id, tool, action, status (EXECUTED/BLOCKED/PENDING_APPROVAL), policy_id |
| `simulations` | agent_id, scenario_id, status, trace_json, report_json |
| `sweeps` | agent_id, total_scenarios, completed, report_json |
| `api_keys` | key_hash, agent_id, scopes, active, last_used |
| `test_data` | agent_id, data_json |
| `workspace_settings` | org_id, slack_webhook_url, alert_email, notify_on_block |
| `regression_baselines` | agent_id, baseline_json, status |
| `forecast_snapshots` | Periodic forecast snapshots (via `jobs/snapshot_forecasts.py`) → vs-last-time deltas |
| `cost_overrides` | Per-org cost/rate overrides (scope, key, sub_key, value) |
| `agent_budgets` | Per-agent budget caps |

A second file, `backend/llm_cache.db`, persists the LLM risk-classification cache (`llm_classifications`) — deliberately separate from the app DB.

Default org + `admin@actiongate.io` user seeded on first boot if tables empty (`db.py:217`).

---

## Backend architecture (`backend/`)

### Core
- `main.py` — FastAPI app, **all 80+ endpoints in one file (5,482 lines)**, CORS, startup hooks, SPA static serving (traversal-safe). Uses deprecated `@app.on_event("startup")`.
- `db.py` — Schema + multi-tenant helpers
- `auth.py` — JWT + bcrypt + tenant middleware. Warns if `JWT_SECRET` is default

### `authority/` — the risk engine (the IP)
- `parser.py` — `AgentConfig` / `ToolDef` dataclasses + **20 sample configs** (support, devops, sales, 6 HPE GreenLake variants, ops, etc.)
- `action_mapper.py` — **89 actions across 11 tools**, 5 risk labels: `moves_money`, `touches_pii`, `deletes_data`, `sends_external`, `changes_production`
- `risk_classifier.py` — 3-layer: hardcoded catalog → keyword heuristics → Claude Haiku LLM (cached in-memory AND persisted to `llm_cache.db`, survives restarts). Strips known service prefixes (stripe_, netsuite_, aws_ec2_, etc.) before matching
- `graph.py` — NetworkX authority graph + **realistic blast-radius scoring** (per-action labels + reversibility + read/write detection, diminishing returns curve, density bonus, capped at 100)
- `chain_detector.py` — **32 universal risk-label transition rules across 10 labels** (expanded from 14/5 by PR #15, 2026-07-06 — see `brain/Decisions/2026-07-06 Dangerous-chain taxonomy expanded.md`). Calibrated against OWASP LLM Top 10 2025 + OWASP Agentic, MITRE ATLAS/ATT&CK, NIST AI 600-1, EchoLeak/Replit/ShadowLeak incidents
- `enforcement.py` — Policy match + condition eval (`gt`/`gte`/`lt`/`lte`/`eq`/`neq`/`in`/`not_in`/`contains`/`requires_prior`) → BLOCK / REQUIRE_APPROVAL / ALLOW. Fires Slack webhook on block

### `analysis/`
- `spend_forecast.py` — the 3-tier spend forecaster (LOW capability / MEDIUM sandbox ±28% / HIGH live ±15%). Live tier forecasts from ≥5 captured calls with a wide band (D27), HIGH at ≥50; calls/day uses a calendar-day basis — quiet days are priced in (decision 2026-07-07). Accuracy grades: `brain/Live/mvp-campaign/accuracy-tracker.md`
- `cost_model.py` — Capabilities → $ exposure (per-tool breach scenarios)
- `cost_defaults.yaml` — Configurable cost ranges
- `prelaunch.py` — Pre-launch audit: boundary + regression + cost + replay → single prioritized fix list with `FixItem`s

### `jobs/`
- `snapshot_forecasts.py` — periodic forecast snapshots → `forecast_snapshots` table (feeds vs-last-time deltas)

### `ingestion/`
- `base.py` — Shared normalize → register → analyze → store
- `langsmith.py` / `langfuse.py` — Vendor-specific trace import

### `sandbox/` — simulation platform
- `runner.py` — Single-agent LLM loop (model router: `claude-*` → Anthropic, `gpt-*` → OpenAI, `ollama/*` → local Ollama). 20-turn safety cap. 4 archetype system prompts (support, devops, sales, ops)
- `multi_runner.py` — Multi-agent coordinator with `dispatch_agent` tool, depth-3 cap
- `analyzer.py` — Trace → violations + chains + data flows + LLM-generated executive summary
- `models.py` — Dataclasses: `TraceStep`, `SimulationTrace`, `Violation`, `Scenario`, `SimulationReport`
- `boundary_tester.py` — Enumerate every dangerous sequence, check policy coverage
- `red_team.py` — 5 attack types (prompt_injection, social_engineering, authority_escalation, data_exfiltration, chain_exploit). Claude attacker + agent's LLM loop as defender
- `trace_replay.py` — Replay historical traces (LangSmith / LangFuse / simple formats)
- `agents/executor.py` — Tool executor: enforce → mock call → trace capture
- `agents/tool_schemas.py` — LLM parameter schemas per tool.action
- `prompts/scenarios.py` — `ALL_SCENARIOS` + `SUPPORT_SCENARIOS` / `DEVOPS_SCENARIOS` / `SALES_SCENARIOS` / `OPS_SCENARIOS`
- `mocks/registry.py` — Central dispatch + per-simulation state + multi-tenant data (default tenants: `tenant-alpha`, `tenant-beta`)
- `mocks/{stripe,zendesk,salesforce,sendgrid,github,aws,slack,pagerduty,hubspot,gmail,calendly,email}.py` — 12 service mocks

### `testing/`
- `regression.py` — Detects when policy change makes agent LESS safe (baseline vs new run)

### `tests/` (pytest)
- `test_analyzer.py`, `test_api.py`, `test_chain_detector.py`, `test_risk_classifier.py`, `test_sdk.py`
- `test_hpe_features.py`, `test_new_features.py` — vague names, candidates for rename

---

## Frontend architecture (`frontend/`)

Vite v8 + React 19 + TypeScript v6 + Tailwind v4 + React Query (configured but underutilized) + React Router v7 + Zustand + cmdk + framer-motion + lucide-react. **No legacy JSX layer** — `main.tsx` is the only entry. The orphaned `*.jsx` files noted in earlier CLAUDE.md versions have been removed.

### Routes (all `.tsx`, defined in `main.tsx`; per-file LOC churns — check the file)
- `/login` — `Login.tsx`. Email + password signup/login. `demo` magic-email wipe (DEMO_MODE-gated)
- `/` — `Authority.tsx`. Main dashboard. Agent list, fleet stats, risk chains. Connect form
- `/agent/:agentId` — `AgentDetail.tsx`. Tabs: tools / policies / authority graph / chains / executions / recommendations / policy conflicts
- `/spend` + `/agent/:agentId/spend` — `CostPortfolio.tsx`. **The CFO-facing Cost Portfolio — the wedge surface**: fleet + per-agent spend forecast, confidence tiers, bands, CFO PDF export
- `/sandbox` — `Sandbox.tsx`. Scenario picker, batch run, dry-run + LLM modes, Claude-generated scenarios
- `/sandbox/:simulationId` — `SimulationDetail.tsx`. Trace timeline, violations, fix-in-prod links
- `/sweep/:sweepId` — `SweepDetail.tsx`
- `/compare` — `Comparison.tsx`. Animated metric counters, before/after policy comparison
- `/history` — `History.tsx`. Audit + execution log. Aliases: `/executions`, `/audit` → `/history`
- `/approvals` — `Approvals.tsx`. Pending queue, polls 30s
- `/settings` — `Settings.tsx`. JWT display/copy, code snippets w/ real agent ID, team invites
- `/workflows` — `Workflows.tsx`. Multi-agent workflow visualizer
- `*` — `NotFound.tsx`

### Components
- `layout/AppShell.tsx`, `layout/Sidebar.tsx` (Lucide icons, pending-approvals badge polls 30s, org name from email domain), `layout/CommandPalette.tsx` (⌘K via cmdk), `layout/ErrorBoundary.tsx`
- `agents/RiskBadge.tsx`
- `shared/EmptyState.tsx`, `shared/RiskLabel.tsx`, `shared/StatCard.tsx`, `shared/Toast.tsx` (`toast(msg)` / `toast(msg, "error")`)
- `ui/Button.tsx` (primary/secondary/ghost/destructive), `ui/Input.tsx`

### `src/lib/`
- `api.ts` — `apiFetch` with Bearer auto-attach; use `skipLogoutOn401: true` on auth endpoints
- `types.ts` — `RiskLabel`, `Severity`, `User`
- `utils.ts` — `timeAgo`, `scoreToColor`, `scoreToBg`, `agentIcon`, label color maps

### `src/store/` (Zustand)
- `commandPalette.ts`, `sidebar.ts`

### Design tokens (in `src/index.css`)
- CSS vars: `var(--text-primary)`, `var(--text-secondary)`, `var(--text-muted)`, `var(--border)`, `var(--bg)`, `var(--white)`, severity vars (`--severity-critical-bg` etc.)
- Risk colors: `moves_money=#dc2626`, `touches_pii=#7c3aed`, `deletes_data=#ea580c`, `sends_external=#2563eb`, `changes_production=#0d9488`

---

## Website (`website/`)

Next.js 16 (Turbopack), React 19, TypeScript, Tailwind v4. Marketing site.

### Routes (`app/`)
- `page.tsx` — Landing: Navbar + Hero + ProblemStatement + HowItWorks + ProductVisual + FeatureRows + CTABanner + Footer
- `book-demo/page.tsx` — Demo request form (mailto submit to `akakash.sathish@gmail.com`)
- `layout.tsx` — Root layout, DM Sans, OG metadata
- `globals.css` — Tailwind + `.fade-up`, `.btn-black`, `.btn-outline`, `.eyebrow`
- `icon.svg` — Favicon

### Components (all in use)
- `Navbar.tsx`, `Hero.tsx`, `ProblemStatement.tsx`, `HowItWorks.tsx`, `ProductVisual.tsx`, `FeatureRows.tsx`, `CTABanner.tsx`, `Footer.tsx`, `Logo.tsx`

### `next.config.ts`
- `turbopack.root = __dirname` — pinned to avoid workspace-root inference issues
- Rewrites `/api/backend/*` → `${BACKEND_URL ?? "http://localhost:8000"}/api/*`

### Critical behavior
- `Hero.tsx` + `lib/useFadeIn.ts` have a `pageshow` listener that calls `window.location.reload()` on bfcache restore — fixes a Safari/Chrome bug where fade-in elements stuck at `opacity: 0` after browser back-navigation. **Do not undo this.**
- Logo click force-reloads home. Internal links use Next.js `<Link>`. External (`Get Started` to the app) is plain `<a>`.

---

## Key concepts

### 10 universal risk labels (5→10 via PR #15, 2026-07-06)
- `moves_money` — charges, refunds, transfers
- `touches_pii` — customer data, emails, personal info
- `deletes_data` — permanent removal
- `sends_external` — emails, messages, webhooks outside the org
- `changes_production` — deploys, scales, terminates
- `changes_access` — IAM grants, role changes, credential issuance, password resets
- `reads_secrets` — secrets, tokens, API keys, private keys, env vars
- `evades_detection` — disables/tampers with logging, audit trails, monitoring
- `bulk_export` — mass export, full dumps, list-all at volume
- `executes_code` — arbitrary code, shell, SQL

### Blast-radius scoring (`authority/graph.py`)
Per-action scoring: labels (money=12, pii=4, delete=15, external=7, prod=12) × reversibility (2.0x if irreversible) × read/write (0.15x if read-only). Sum with diminishing-returns decay (`1/(1+i*0.12)`). Normalize against 240 (recalibrated 2026-06-08 against agents scored on their declared actions — the path every endpoint uses; was /800, which compressed every score into ~25–35). Realistic fleet lands: scheduler ~0 / CRM ~14 (low), support ~37 (medium), ops ~56 (high), infra agent that can terminate prod + delete DBs + move money ~83 (critical). Add density bonus (up to +20 for an all-dangerous agent). Cap at 100.

### Chain detection (`authority/chain_detector.py`) — 32 transition rules
Risk-label transitions, not hardcoded tool patterns — expanded 14→32 rules over the 10 labels by PR #15 (2026-07-06; rationale + full rule list in `brain/Decisions/2026-07-06 Dangerous-chain taxonomy expanded.md`). The original 7 critical rules (`pii-exfil` — EchoLeak/ShadowLeak, `pii-financial`, `pii-delete`, `money-money`, `money-delete`, `prod-delete` — Replit/PocketOS, `delete-delete` — Ransomware 3.0) still anchor the taxonomy. Works at capability level (static) AND execution level (trace). Cross-agent detection in multi-agent sims.

### Conditional policies
- Param: `{"field": "amount", "op": "gt", "value": 100}`
- Session: `{"op": "requires_prior", "value": "pagerduty.get_incident"}` — supports wildcards
- Priority: BLOCK=100 > REQUIRE_APPROVAL=50 > ALLOW=10

### 3-layer risk classification
1. Hardcoded catalog (81 known actions, instant)
2. Keyword heuristics with service-prefix stripping (instant)
3. Claude Haiku for unknown actions (cached in-memory + persisted to `llm_cache.db`, ~0.1¢/call)

---

## GitHub Action — Agent Security Scan

Customers add `.github/actions/scan` to scan agent code on every push/PR.

- `.github/actions/scan/action.yml` — composite action (inputs: `api-key`, `api-url`, `threshold`, `comment-mode`, `paths`, `max-files`)
- `.github/actions/scan/run.py` — runtime. Detects changed agent files, POSTs to `/api/scan`, posts PR comment + step summary, exits non-zero on `fail`
- `.github/workflows/agent-security.yml` — dogfood workflow

Backend contract — `POST /api/scan` documented above. Verdict logic: `fail` when any critical chain OR `max_blast_radius > threshold`; `warn` within 20 points; else `pass`. **No DB writes** — pure read-side. Helper: `_score_in_memory(file_path, content, anthropic_client)`.

---

## Known limitations & technical debt

### Architecture
- **`main.py` monolith (80+ endpoints).** Split into routers by domain: `routers/auth.py`, `routers/authority.py`, `routers/sandbox.py`, `routers/ingestion.py`, `routers/proxy.py`.
- **SQLite single-file** — no horizontal scale, write contention under load. Plan: PostgreSQL with SQLAlchemy for production, keep SQLite for dev.
- **Deprecated `@app.on_event("startup")`** — migrate to FastAPI lifespan.
- **No background job queue.** Long-running sims block request threads (except SSE stream). Need Celery or Arq + Redis.
- **Rate limiting exists on `/api/enforce` only** (pilot-hardening) — every other endpoint is an open DoS surface.
- **`/api/agent/{id}/llm-call` is unauthenticated.** Intentional but risky in prod. Should accept optional `X-API-Key`. (Same for `/api/authority/agents/register` and `/api/traces/live` — deferred product decision, see brain.)
- **`/api/scan` runs Haiku sequentially per file** — for 50-file PRs that's ~5 minutes. Batch with `anthropic.messages.batches` (24hr async) or parallelize with semaphore.
- **No webhooks/event bus** for async policy notifications to customer SOCs.

### Frontend
- **Massive page files.** AgentDetail (2.6k), Authority (1.9k), Workflows (1.8k), Sandbox (1.4k) — all need decomposition into hooks + sub-components.
- **React Query installed but most pages use raw `useState`/`useEffect`/`fetch`.** Convert systematically, get free caching/refetch.
- **No frontend tests at all.** Add Vitest + Testing Library starter.
- **Tailwind v4 + CSS variables hybrid** — works but inconsistent. Pick one.

### Cost-forecasting state (the CIO+CFO wedge work)
The three gaps formerly listed here (mocked unit-economics $, fixed sensitivity ranking, missing snapshots) **closed during the 2026-07 MVP campaign**: unit economics compute per-agent with no archetype-$ fallback, the `forecast_snapshots` table + `jobs/snapshot_forecasts.py` exist, and the live tier shipped (5-call floor per D27; calendar-day calls/day basis per the 2026-07-07 decision). Canonical accuracy state, grades, and remaining honest limits: `brain/Live/mvp-campaign/accuracy-tracker.md`.


### Tests
- No coverage report. `test_hpe_features.py` and `test_new_features.py` are vaguely named.

### DevOps
- **No hosted deployment exists** (see Deployment below). The root `Dockerfile` is real and pilot-ready (single container, customer-VPC friendly) but blocks horizontal scale — SQLite + one process.
- No staging env.

### Branding / housekeeping
- DB file still `actiongate.db`. Seed user still `admin@actiongate.io`. Don't rename casually.

---

## Roadmap (CIO+CFO wedge — see `brain/Company files/Product direction.md`)

The brain owns the canonical Now/Next/Later. This is a Claude-facing summary; if it conflicts with the brain, the brain wins.

### Now (this week)
1. **Close the 3 forecast accuracy gaps** ([[Forecast accuracy gaps]]) — per-agent unit economics $, per-agent sensitivity ranking, vs-last-month delta via nightly snapshots.
2. **Typography + visual pass** on the Cost Portfolio to kill the AI-generated read.
3. **Wire one real export button** end-to-end — CFO PDF is the highest-impact.
4. **Start 5 CIO discovery calls** using the working demo.

### Next (1–2 weeks)
1. **Live trace ingestion** to unlock the high-confidence tier (`/api/agent/{id}/llm-call` → per-agent rolling averages → forecast tightens ±28% → ±15% after 7 days).
2. **Settings UI for per-org cost overrides** — let customers plug in their negotiated Anthropic rate via the dashboard, not by editing YAML on the server.
3. **Convert the first design partner pilot** ($15K trial → annual contract).
4. **Anomaly detection alerts** — "this agent's spend jumped 3× in 24 hours, here's what changed."
5. **Per-agent sensitivity computed from real perturbation** instead of YAML constants.

### Later (1–3 months)
1. **Multi-agent workflow spend** — orchestrator parent forecast includes dispatched sub-agent cost.
2. **v2 Cost Portfolio breakdown** — per-action distribution (p50 / p95 / p99), save-scenario, forecast-vs-actuals chart.
3. **Risk × Cost in one view** — the wedge's full bet: CFO sees cost AND worst-case dollar exposure side-by-side, in the same export.
4. **Cross-platform agent ingestion** — LangChain, CrewAI, AutoGen, Bedrock Agents, Vertex Agents, MCP-discovery at scale.
5. **SOC2 Type 1** — required for serious enterprise CIO+CFO ICP.
6. **Pricing v2** — from $15K hand-priced pilots to self-service tier with per-agent caps.


---

## Conventions

- API client: `import { apiFetch } from "@/lib/api"` (auto Bearer token)
- Toasts: `import { toast } from "@/components/shared/Toast"` — `toast(msg)` or `toast(msg, "error")`
- All SQL: parameterized (`?` placeholders), never string interpolation
- Multi-tenant: every query scoped by `org_id`
- Tests: `cd backend && pytest` (CI runs via `.github/workflows/tests.yml`; conftest isolates the DB via `ARCEO_DB_PATH` and stubs the LLM)
- Commits on dev: be lean

---

## Deployment

**There is currently NO hosted instance of Arceo anywhere** — no Railway, no staging, nothing (verified 2026-07-07; earlier versions of this file described a Railway setup that never existed on current branches). The only running Arceo is the local dev/campaign server.

- **Container build:** root `Dockerfile` (PR #27, 2026-07-07) — multi-stage: node builds the SPA into `backend/static/` (main.py serves it, traversal-safe), `python:3.11-slim` runs uvicorn on :8000 as a non-root user. `.dockerignore` keeps `.env` and `*.db` out of the image.
- **Run:** `docker run -p 8000:8000 -v arceo-data:/data -e ANTHROPIC_API_KEY=... -e JWT_SECRET=... arceo` — SQLite lives at `ARCEO_DB_PATH=/data/actiongate.db`; skip the volume and all data dies with the container. Suited to running in a customer's VPC (the pilot pitch).
- **Healthcheck:** `GET /api/health`
- **Env vars:** `ANTHROPIC_API_KEY` (required), `JWT_SECRET` (required for prod), `ARCEO_DB_PATH`, `GITHUB_TOKEN` (optional, raises GitHub scan limit from 60/hr to 5000/hr), `BACKEND_URL` (website), `DEMO_MODE` (demo instances must set it — see Demo login), `CORS_ORIGINS`

---

## Branches

- `Prod` — **GitHub default branch**; promote target. dev → Prod merges are deliberate release-ish events (PR #19's accidental early merge to Prod was treated as an incident and undone; the clean promote was PR #26, 2026-07-07).
- `dev` — **all active work lands here** via feature-branch PRs. Never push dev directly (Akash, 2026-06-11).
- `main` — legacy pre-rename layout (`arceo/`, `production/` dirs). Stale; do not base work on it.
- Assorted `feat/`, `fix/`, `sprint-*` branches; GitHub auto-deletes head branches on merge.

Remote: `origin` → `Akash-Sathish8/Arceo` (the only remote). No `gh` CLI on this machine — PRs are created via the GitHub API with the `git credential fill` keychain token.
