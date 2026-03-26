# ActionGate

A trust and control layer for AI-powered workflows that maps what agents can do and scores their blast radius.

## Project Structure

- `backend/` — Python + FastAPI Authority Engine
  - `authority/parser.py` — Agent config parser with sample agent definitions
  - `authority/action_mapper.py` — Maps tool actions to risk labels
  - `authority/graph.py` — NetworkX authority graph + blast radius scoring
  - `authority/chain_detector.py` — Dangerous multi-step chain detection
  - `authority/risk_classifier.py` — Heuristic auto-classification of risk labels
  - `auth.py` — JWT authentication
  - `db.py` — SQLite database (agents, policies, audit log, execution log, users, simulations)
  - `main.py` — FastAPI endpoints
  - `sandbox/` — Simulation platform
    - `models.py` — TraceStep, SimulationTrace, Violation, SimulationReport
    - `mocks/` — Mock API servers for 11 services (Stripe, Zendesk, Salesforce, SendGrid, GitHub, AWS, Slack, PagerDuty, HubSpot, Gmail, Calendly)
    - `mocks/registry.py` — Central mock registry + per-simulation state store
    - `agents/executor.py` — Tool executor: enforce check → mock call → trace capture
    - `prompts/scenarios.py` — 21 scenarios (normal, edge case, adversarial, chain exploit) for 3 agent types
    - `runner.py` — Simulation runner: LLM agent loop via Anthropic SDK + dry-run mode
    - `analyzer.py` — Trace analyzer: violation detection, chain detection, risk scoring, recommendations
- `frontend/` — React dashboard

## Running

```bash
# Backend
cd backend
pip install -r requirements.txt
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
- `GET /api/auth/me` — Current user

### Authority Engine (requires auth)
- `GET /api/authority/agents` — All agents with blast radius scores
- `GET /api/authority/agent/{id}` — Detail: graph, chains, recommendations, policies, executions
- `POST /api/authority/agents` — Create agent
- `PUT /api/authority/agent/{id}` — Update agent
- `DELETE /api/authority/agent/{id}` — Delete agent
- `GET /api/authority/chains` — All flagged dangerous chains

### Enforcement
- `POST /api/enforce` — Runtime enforcement check (agents call this before acting)
- `GET /api/authority/agent/{id}/policies` — List policies
- `POST /api/authority/agent/{id}/policies` — Create policy
- `DELETE /api/authority/policy/{id}` — Delete policy

### Agent Discovery (register is unauthenticated, import requires auth)
- `POST /api/authority/agents/register` — Agents self-register with tool manifests (auto-classifies risk labels)
- `POST /api/authority/agents/import/mcp` — Import from MCP tools/list format
- `POST /api/authority/agents/import/openai` — Import from OpenAI function-calling format

### Sandbox Simulation (requires auth, except scenario listing)
- `GET /api/sandbox/scenarios` — List all 21 simulation scenarios
- `GET /api/sandbox/scenarios/{agent_type}` — Scenarios for support/devops/sales
- `POST /api/sandbox/simulate` — Run simulation (dry_run=true skips LLM, uses all tools)
- `GET /api/sandbox/simulations` — List past simulation runs
- `GET /api/sandbox/simulation/{id}` — Full simulation detail with trace + report

### Logging (requires auth)
- `GET /api/audit` — Audit log
- `GET /api/executions` — Execution log
- `GET /api/executions/{agent_id}` — Agent-specific executions
