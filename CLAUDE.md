# ActionGate

A trust and control layer for AI-powered workflows that maps what agents can do and scores their blast radius.

## Project Structure

- `backend/` — Python + FastAPI Authority Engine
  - `authority/parser.py` — Agent config parser with sample agent definitions
  - `authority/action_mapper.py` — Maps tool actions to risk labels
  - `authority/graph.py` — NetworkX authority graph + blast radius scoring (per-action weighting by reversibility)
  - `authority/chain_detector.py` — Risk-label transition detection (14 universal rules, not tool-specific)
  - `authority/risk_classifier.py` — 3-layer classification: catalog → keywords → LLM (Haiku)
  - `auth.py` — JWT authentication (warns if default secret used in production)
  - `db.py` — SQLite database (agents, policies, audit log, execution log, users, simulations)
  - `main.py` — FastAPI endpoints
  - `sandbox/` — Simulation platform
    - `models.py` — TraceStep, SimulationTrace, MultiAgentTrace, Violation, DataFlow, VolumeViolation, SimulationReport
    - `mocks/` — Mock API servers for 11 services with multi-tenant isolation
    - `mocks/registry.py` — Central mock registry + per-simulation state store + tenant data
    - `agents/executor.py` — Tool executor: enforce check → mock call → trace capture
    - `prompts/scenarios.py` — 28 scenarios (normal, edge case, adversarial, chain exploit) for 4 agent types (support, devops, sales, ops)
    - `runner.py` — Single-agent simulation runner: LLM agent loop via Anthropic SDK + dry-run mode
    - `multi_runner.py` — Multi-agent simulation runner: agent dispatch, depth-limited recursion
    - `analyzer.py` — Trace analyzer: violation detection, chain detection, data flow tracking, volume detection, cross-agent analysis, executive summary
- `frontend/` — React dashboard
- `sdk/` — Python + JavaScript SDKs for 9 frameworks

## Running

```bash
# Backend
cd backend
pip install -r requirements.txt
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env  # for LLM classification + simulation
python3 -m uvicorn main:app --reload --port 8000

# Frontend
cd frontend
npm install
npm run dev
```

## Demo Login

- Email: admin@actiongate.io
- Password: admin123

## API

### Auth
- `POST /api/auth/login` — Login, get JWT token
- `POST /api/auth/signup` — Create account
- `GET /api/auth/me` — Current user

### Authority Engine (requires auth)
- `GET /api/authority/agents` — All agents with blast radius scores
- `GET /api/authority/agent/{id}` — Detail: graph, chains, recommendations, policies, executions
- `POST /api/authority/agents` — Create agent
- `PUT /api/authority/agent/{id}` — Update agent
- `DELETE /api/authority/agent/{id}` — Delete agent
- `GET /api/authority/chains` — All flagged dangerous chains
- `GET /api/services` — Available services for the service picker (unauthenticated)

### Enforcement
- `POST /api/enforce` — Runtime enforcement check with conditional policies and session context
  - Supports `params` for condition evaluation (amount > 100)
  - Supports `session_context` for requires_prior conditions
- `GET /api/authority/agent/{id}/policies` — List policies (includes conditions, priority)
- `POST /api/authority/agent/{id}/policies` — Create policy (auto-assigns priority: BLOCK=100, REQUIRE_APPROVAL=50, ALLOW=10)
- `DELETE /api/authority/policy/{id}` — Delete policy
- `GET /api/authority/agent/{id}/policy-conflicts` — Detect overlapping policies and show which wins

### Agent Discovery (register is unauthenticated, import requires auth)
- `POST /api/authority/agents/register` — Agents self-register with tool manifests (auto-classifies risk labels via 3-layer classifier)
- `POST /api/authority/agents/import/mcp` — Import from MCP tools/list format
- `POST /api/authority/agents/import/openai` — Import from OpenAI function-calling format
- `POST /api/authority/agents/connect/mcp` — Connect to live MCP server, auto-pull tools

### Proxy (transparent enforcement)
- `ANY /proxy/{service}/{path}` — Transparent API proxy. Set `X-Agent-ID` header. Enforces policies then forwards to real API. Supports: stripe, zendesk, salesforce, sendgrid, github, slack, pagerduty, hubspot, gmail, calendly.

### Post-Hoc Reporting (unauthenticated)
- `POST /api/report` — Agent reports actions after execution. Full analysis (chains, data flows, volume, executive summary) without enforcement.

### Sandbox Simulation (requires auth, except scenario listing)
- `GET /api/sandbox/scenarios` — List all 28 simulation scenarios
- `GET /api/sandbox/scenarios/{agent_type}` — Scenarios for support/devops/sales/ops
- `POST /api/sandbox/simulate` — Run single-agent simulation (dry_run=true skips LLM)
- `POST /api/sandbox/simulate/multi` — Run multi-agent simulation with dispatch (agent_ids, coordinator_id, scenario_id, dry_run)
- `GET /api/sandbox/simulate/stream` — SSE stream for live simulation
- `GET /api/sandbox/simulations` — List past simulation runs
- `GET /api/sandbox/simulation/{id}` — Full simulation detail with trace + report

### Sweep (Full Agent Scan)
- `POST /api/sandbox/sweep` — Run all scenarios for an agent, get aggregate report (agent_id, dry_run, categories)
- `GET /api/sandbox/sweeps` — List past sweep runs
- `GET /api/sandbox/sweep/{id}` — Full sweep detail with per-scenario breakdown

### Logging (requires auth)
- `GET /api/audit` — Audit log
- `GET /api/executions` — Execution log
- `GET /api/executions/{agent_id}` — Agent-specific executions

## Frontend Status (update this section after every session)

**YC Demo Readiness: ~76/100** — Last updated: 2026-03-30

### Component Status

| Component | Polish | What's real | What's fake / missing |
|-----------|--------|-------------|----------------------|
| `Authority.jsx` | ✅ High | Empty state w/ templates, setup checklist, today stats + 7-day chart, fleet stats, recent activity feed, critical chains banner, agent grid, Sort/filter/search | — |
| `AgentDetail.jsx` | ✅ High | Authority map graph, policy condition builder (ConditionBuilder component), inline agent edit (PUT endpoint), execution history tab, chain display, risk stats, recommendations | Policy conflict detection (endpoint exists: GET /api/authority/agent/{id}/policy-conflicts) |
| `Sandbox.jsx` | ✅ High | Scenario selection, batch run with progress bar, dry-run + LLM modes, before/after comparison banner on re-run, custom prompt queue, past sims list | No "Full Sweep" button (backend: POST /api/sandbox/sweep runs all 28 scenarios) |
| `SimulationDetail.jsx` | ✅ High | Timeline trace with expandable steps, risk breakdown bars, violations list, chains triggered, data flows, simple+raw toggle | Violations have no "Block this in production →" CTA to AgentDetail |
| `History.jsx` | ✅ High | Stats row (total/executed/blocked/pending), filter chips, time filter, search, risk legend, table with tool color chips, CSV export, audit log tab | — |
| `Approvals.jsx` | ✅ High | Queue auto-refreshes 10s, params display, approve/reject with note field | — |
| `Settings.jsx` | ✅ Med | Real JWT token display/copy, code snippets (Python/curl/Node.js), real team invite creates accounts via signup API | Code snippets say `"your-agent-id"` (should load real agent ID from API); notifications are localStorage-only (no real delivery) |
| `Login.jsx` | ✅ High | 3-step onboarding flow, real signup on "Get started", demo login shortcut | Step 2 agent type selection is ignored — should auto-create agent from template |
| `Comparison.jsx` | ✅ High | Animated metric counters, different-agents warning banner | No default to last two sims when accessed directly |
| `main.jsx` (sidebar) | ✅ High | Pending approvals badge (polls /api/approvals 15s), org name from email domain, sign out | — |

### Remaining Gaps (ordered by demo impact)

1. **Login step 2**: Selected agent types are thrown away — should auto-create agent from template after login
2. **Settings**: Code snippets hardcode `"your-agent-id"` — load `GET /api/authority/agents` and use `agents[0].id`
3. **SimulationDetail**: No "Block this in production →" link on violations — should link to `/agent/{agent_id}`
4. **Sandbox**: No "Full Sweep" button — `POST /api/sandbox/sweep` runs all 28 scenarios, great demo feature
5. **AgentDetail**: No policy conflict UI — `GET /api/authority/agent/{id}/policy-conflicts` endpoint unused
6. **Comparison**: No smart default — should auto-load last two simulations when accessed without query params

### Design System Notes
- CSS custom properties: `var(--text-primary)`, `var(--text-secondary)`, `var(--text-muted)`, `var(--border)`, `var(--bg)`, `var(--white)`
- Risk colors (defined per-file, not shared): moves_money=#dc2626, touches_pii=#7c3aed, deletes_data=#ea580c, sends_external=#2563eb, changes_production=#0d9488
- Severity colors: critical={bg:#fef2f2, color:#dc2626}, high={bg:#fff7ed, color:#ea580c}, medium={bg:#fefce8, color:#ca8a04}
- Status styles: EXECUTED={bg:#d4edda, color:#155724}, BLOCKED={bg:#f8d7da, color:#721c24}, PENDING={bg:#fff3cd, color:#856404}
- Brand name: **Arceo** (not ActionGate — the product was rebranded)
- All toast notifications via `import { toast } from "./Toast.jsx"` — `toast(msg)` or `toast(msg, "error")`
- API calls via `import { apiFetch } from "./api.js"` — auto-adds Bearer token; use `skipLogoutOn401: true` on auth endpoints

## Key Concepts

### Risk Labels (5 universal labels)
- `moves_money` — charges, refunds, transfers
- `touches_pii` — customer data, emails, personal info
- `deletes_data` — permanent removal of records
- `sends_external` — emails, messages, webhooks outside the org
- `changes_production` — deploys, scales, terminates infrastructure

### Chain Detection (risk-label transitions)
14 universal transition rules detect dangerous sequences across any tool/domain.
Example: `touches_pii → sends_external` = PII Exfiltration (critical).
Works at both capability level (static analysis) and execution level (trace analysis).
Cross-agent chains detected when actions span different agents in multi-agent simulations.

### Conditional Policies
Policies support conditions: `{"field": "amount", "op": "gt", "value": 100}`.
Session-aware conditions: `{"op": "requires_prior", "value": "pagerduty.get_incident"}`.
Policies have priority (BLOCK=100 > REQUIRE_APPROVAL=50 > ALLOW=10).

### Multi-Agent Simulation
Coordinator agent can dispatch sub-tasks to specialist agents via `dispatch_agent` tool.
Max depth of 3 to prevent infinite loops. Each agent enforced independently.
Cross-agent chain detection and authority escalation analysis.

### Multi-Tenant Mock Isolation
MockState accepts `tenant_id` to scope data. Default tenants: tenant-alpha, tenant-beta.
Cross-tenant access violations detected in analysis.

### 3-Layer Risk Classification
1. Hardcoded catalog (89 known actions, instant)
2. Keyword heuristics (~50 keywords, instant)
3. LLM via Haiku (unknown actions, cached, ~0.1¢ per call)
