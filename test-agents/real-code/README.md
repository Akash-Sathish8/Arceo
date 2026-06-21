# Real-code test agents

Hand-written, production-shaped agents an enterprise would actually ship — real
agent loops, **real vendor SDK calls** (not mocks), and `DRY_RUN`-gated writes.
They span the full danger spectrum with distinct toolsets, so Arceo's blast-radius
scoring and chain detection get exercised across every risk label.

Unlike `../real-github/` (public repos scanned in place) and `../synthetic/`
(JSON manifests), these are local `.py` files: a complete agent per file.

## The fleet

| File | Danger | Tools | Risk labels → chain | Guardrails |
|---|---|---|---|---|
| `calendar_scheduler.py` | low | Google Calendar, Slack | read-heavy, `sends_external` | code: no double-booking |
| `support_agent.py` | medium | Zendesk, Stripe, SendGrid | `touches_pii → moves_money`, `sends_external` | code: $50 refund cap |
| `sales_outreach.py` | medium | Salesforce, Gmail, Slack | `touches_pii → sends_external` | code: respects opt-out / DoNotContact |
| `churn_agent.py` | high | Zendesk, Stripe, HubSpot, SendGrid, Slack | `touches_pii → moves_money → sends_external` | **prompt-only by design** (policy-gap bait) |
| `offboarding_agent.py` | high | Google Workspace, GitHub, AWS, Slack, SendGrid | `touches_pii → deletes_data` | code: verify-before-act, suspend-not-delete, target allow-list |
| `sre_incident_agent.py` | critical | AWS (terminate/delete), GitHub, PagerDuty, Slack | `changes_production → deletes_data` (prod-delete) | code: no destructive op without an open incident |
| `payments_ap_agent.py` | critical | Stripe payouts, NetSuite, bank wire, SendGrid | `moves_money → moves_money` (chained financial) | code: $25k cap + PO match required |

`churn_agent.py` is the deliberate outlier: its safety rules live only in the system
prompt, so Arceo should surface a real **policy gap**, not just a high score. Every
other agent enforces its guardrails in code.

## Safety

`DRY_RUN` defaults to **true** — read tools hit the live API, but every mutating
tool (refunds, payouts, account suspension, instance termination, emails) **previews
instead of executing**. Set `DRY_RUN=false` only against throwaway sandbox orgs.
Each agent's required env vars (API keys / tokens) are listed in its module docstring.

## Shared runtime

`_runtime.py` is the one agent loop the whole fleet imports — `run_agent()`
(bounded by `MAX_TURNS`, terminates on any non-tool stop reason, plumbs
`tool_result` blocks back), `execute_tool()` (errors + guardrail rejections returned
to the model, never crashes), `GuardrailError`, and `DRY_RUN`. Each agent file owns
only its `SYSTEM_PROMPT`, `TOOLS` manifest, and tool implementations.

## Ingesting into Arceo

These are single files, so use the single-file extractor (not `extract-github`):

```
POST /api/authority/agents/extract
{ "path": "offboarding_agent.py", "content": "<file contents>" }
```

Tools whose services overlap Arceo's sandbox mocks (slack, stripe, github, gmail,
hubspot, aws, calendly, zendesk, sendgrid→email) can additionally be **swept**
(`POST /api/sandbox/sweep`) for MEDIUM-tier traces.

> Note: the extractor reads each file's **declared tools** (names, descriptions,
> schemas) — it classifies capabilities, not control flow. So a code-enforced
> guardrail (e.g. the $50 refund cap) is invisible to static scoring; the
> `touches_pii → moves_money` chain still fires on `support_agent.py` even though
> the code bounds the refund. That gap between declared capability and enforced
> behavior is exactly what a sandbox sweep / live trace is for.
