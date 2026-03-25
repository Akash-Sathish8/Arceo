# ActionGate

A trust and control layer for AI-powered workflows that maps what agents can do and scores their blast radius.

## Project Structure

- `backend/` — Python + FastAPI Authority Engine
  - `authority/parser.py` — Agent config parser with sample agent definitions
  - `authority/action_mapper.py` — Maps tool actions to risk labels
  - `authority/graph.py` — NetworkX authority graph + blast radius scoring
  - `authority/chain_detector.py` — Dangerous multi-step chain detection
  - `auth.py` — JWT authentication
  - `db.py` — SQLite database (agents, policies, audit log, execution log, users)
  - `main.py` — FastAPI endpoints
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

### Logging (requires auth)
- `GET /api/audit` — Audit log
- `GET /api/executions` — Execution log
- `GET /api/executions/{agent_id}` — Agent-specific executions
