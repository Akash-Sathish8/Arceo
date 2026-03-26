# ActionGate

A trust and control layer for AI agents. Tell ActionGate what tools your agent has, and it maps every action, scores how dangerous it is, detects risky combinations, and lets you test it in a sandbox before it touches production.

## What it does

1. **Register your agent's tools** — Stripe, Zendesk, Salesforce, GitHub, AWS, or anything else
2. **See the blast radius** — ActionGate scores how dangerous the agent is (0-100) based on what it can do
3. **Detect dangerous chains** — "can read PII" + "can send emails" = PII exfiltration risk
4. **Run sandbox simulations** — test your agent against mock APIs with realistic fake data
5. **See what goes wrong** — full trace of every action, violations flagged, chains detected
6. **Apply policies in one click** — block or require approval for dangerous actions
7. **Re-run and verify** — see the before/after difference with policies active

## Quick Start

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

Open `http://localhost:5173`. Login with `admin@actiongate.io` / `admin123`.

## Test with a real agent

```bash
# Install the SDK
pip install -e sdk/

# Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-...

# Run the example agent
python3 examples/langchain_agent.py
```

This runs a LangChain support agent with Stripe, Zendesk, and Email tools through ActionGate's sandbox. Every tool call is enforced and traced.

## SDK

The ActionGate SDK wraps your agent's tools so every call goes through enforcement and mock APIs instead of real ones.

### Python — LangChain

```python
from actiongate import ActionGateClient, wrap_tools

gate = ActionGateClient(agent_id="my-agent")
wrapped = wrap_tools(my_langchain_tools, gate)
# Now every tool call goes through ActionGate
```

### Python — Anthropic SDK (raw)

```python
from actiongate.frameworks.anthropic_sdk import run_agent_loop

result = run_agent_loop(
    client=anthropic.Anthropic(),
    gate=ActionGateClient(agent_id="my-agent"),
    tools=my_tool_definitions,
    messages=[{"role": "user", "content": "Handle this ticket..."}],
)
```

### Python — OpenAI SDK

```python
from actiongate.frameworks.openai_sdk import execute_tool_calls

response = client.chat.completions.create(model="gpt-4o", tools=tools, messages=messages)
tool_messages = execute_tool_calls(response, gate)
```

### Python — CrewAI

```python
from actiongate.frameworks.crewai import wrap_crewai_tools

wrapped = wrap_crewai_tools(my_tools, gate)
agent = Agent(tools=wrapped, ...)
```

### Python — AutoGen

```python
from actiongate.frameworks.autogen import create_autogen_functions

functions = create_autogen_functions(gate, [
    {"tool": "stripe", "action": "get_customer", "description": "Look up customer"},
])
```

### Python — LlamaIndex

```python
from actiongate.frameworks.llamaindex import create_llamaindex_tools

tools = create_llamaindex_tools(gate, [
    {"tool": "stripe", "action": "create_refund", "description": "Issue refund"},
])
agent = OpenAIAgent.from_tools(tools)
```

### Python — Haystack

```python
from actiongate.frameworks.haystack import create_haystack_tools

tools = create_haystack_tools(gate, tool_definitions)
```

### Python — MCP

```python
from actiongate.frameworks.mcp import ActionGateMCPProxy

proxy = ActionGateMCPProxy(gate=gate, source="my-mcp-server")
result = proxy.call_tool("send_email", {"to": "user@test.com"})
```

### JavaScript — Vercel AI SDK

```javascript
const { ActionGateClient, createVercelTools } = require('actiongate');

const gate = new ActionGateClient({ agentId: 'my-agent' });
const tools = createVercelTools(gate, [
  { tool: 'stripe', action: 'get_customer', description: 'Look up customer' },
]);
```

## Mock HTTP Endpoints

Real agents can call ActionGate's mock APIs over HTTP:

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

81 mock endpoints across 11 services: Stripe, Zendesk, Salesforce, SendGrid, GitHub, AWS, Slack, PagerDuty, HubSpot, Gmail, Calendly.

## API

### Auth
- `POST /api/auth/login` — login, get JWT
- `GET /api/auth/me` — current user

### Authority Engine
- `GET /api/authority/agents` — all agents with blast radius
- `GET /api/authority/agent/{id}` — detail with graph, chains, policies
- `POST /api/authority/agents` — create agent
- `DELETE /api/authority/agent/{id}` — delete agent
- `GET /api/authority/chains` — all dangerous chains

### Agent Discovery
- `POST /api/authority/agents/register` — agents self-register (no auth)
- `POST /api/authority/agents/import/mcp` — import MCP tools
- `POST /api/authority/agents/import/openai` — import OpenAI functions

### Enforcement
- `POST /api/enforce` — runtime check (agents call before acting)
- `POST /api/authority/agent/{id}/policies` — create policy
- `DELETE /api/authority/policy/{id}` — delete policy

### Sandbox
- `GET /api/sandbox/agent/{id}/scenarios` — auto-generated scenarios
- `POST /api/sandbox/simulate` — run simulation
- `GET /api/sandbox/simulations` — list past runs
- `POST /api/sandbox/apply-policy` — apply recommended policy
- `POST /api/sandbox/apply-all-policies` — apply all recommendations

### Mock Endpoints
- `POST /mock/session` — create sandbox session
- `POST /mock/{tool}/{action}` — call mock tool
- `GET /mock/session/{id}/trace` — get session trace
- `GET /mock/available` — list all mock endpoints

## Architecture

```
backend/
  main.py              — FastAPI API (40+ endpoints)
  authority/            — blast radius, chain detection, risk classification
  sandbox/
    mocks/             — 11 mock API servers (81 endpoints)
    agents/            — tool executor, parameter schemas
    prompts/           — scenario library + auto-generation
    runner.py          — simulation engine (dry-run + LLM)
    analyzer.py        — trace analysis, violations, recommendations

sdk/
  actiongate/          — Python SDK (pip install -e sdk/)
    frameworks/        — LangChain, Anthropic, OpenAI, CrewAI, AutoGen, LlamaIndex, Haystack, MCP
  js/                  — JavaScript SDK (Vercel AI, OpenAI JS)

frontend/              — React dashboard
  Sandbox.jsx          — simulation runner + scenario picker
  SimulationDetail.jsx — trace timeline + violation report
  Authority.jsx        — agent dashboard + creation form
  AgentDetail.jsx      — authority graph + policies
```
