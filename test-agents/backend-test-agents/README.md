# Test agents

Four agent files for testing Arceo's extraction, blast-radius scoring, and chain detection. Each is realistic, minimal (~80-130 lines), and produces a different risk profile.

## How to use

**Via the Arceo UI (`http://localhost:5173`):**
1. Log in → click "+ New agent" (or land on the empty-state Connect form)
2. Connect tab → **Upload file** → drag any of the `.py` / `.ts` files here
3. Arceo's Haiku extractor reads the file, identifies the tools/actions, classifies risk
4. The new agent appears with a blast-radius score + detected chains

**Via the API directly:**
```bash
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@actiongate.io","password":"admin123"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

curl -X POST http://localhost:8000/api/authority/agents/extract \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json
with open('support_agent.py') as f:
    print(json.dumps({'filename': 'support_agent.py', 'content': f.read()}))
")"
```

## What each agent tests

| File | Stack | Expected blast radius | Expected chains |
|---|---|---|---|
| `support_agent.py` | Python, Anthropic SDK | Medium-high (~60-70) | `touches_pii → sends_external`, `touches_pii → moves_money` |
| `devops_agent.py` | Python, Anthropic SDK | High (~75-85) | `changes_production → deletes_data`, `prod-prod`, `delete-delete` |
| `sales_agent.ts` | TypeScript, OpenAI Assistants | Medium (~50-60) | `touches_pii → sends_external` |
| `web_to_lead_agent.py` | Python, Anthropic SDK | Critical (~85-95) | `touches_pii → sends_external` (PII Exfiltration) — canonical ForcedLeak pattern |

## What this tests in Arceo

- **Multi-framework extraction** — Anthropic SDK + OpenAI Assistants API, Python + TypeScript
- **3-layer risk classifier** — catalog (known actions like `stripe_create_refund`) + keyword (e.g. `aws_rds_delete_snapshot` → `deletes_data`) + LLM fallback (unusual names)
- **Blast-radius weighting** — `devops_agent` should outscore `sales_agent` despite similar action counts, because of irreversible production changes
- **Chain detection** — all 4 should trigger at least one chain; `web_to_lead_agent` should be the most severe
- **Tool inventory** — UI displays each tool + action with the right risk label chips
