# Data retention and deletion

**What Arceo stores about a customer, how long it keeps it, and how it goes
away.** Written to be handed to a CIO or a security reviewer without an engineer
attached, so it states the limits as plainly as the guarantees.

Scope: a customer's data in an Arceo instance. Companion documents:
`SECURITY_DESIGN.md` (how it is protected), `DEPLOYMENT_CONTRACT.md` (what the
deployment must provide).

---

## What is stored

| | Contains | Where |
|---|---|---|
| **Agent definitions** | names, tool/action inventories, policies, test fixtures | `agents`, `agent_tools`, `tool_actions`, `policies`, `test_data` |
| **Captured LLM bodies** | ⚠️ **the actual prompt and response text** of the agent's calls | `llm_captures` |
| **Audit trail** | who did what, when; per-call metadata and a content digest | `audit_log` (append-only) |
| **Execution log** | tool calls, decisions, parameters | `execution_log` |
| **Simulations & sweeps** | sandbox traces and reports | `simulations`, `sweeps` |
| **Credentials** | provider secrets, envelope-encrypted | `provider_credentials` |

⚠️ **`llm_captures` is the sensitive one.** It holds verbatim prompt and response
content — whatever the customer's agent sent to a model. Everything else is
metadata about that traffic. Where this document says "the densest PII in the
product", it means this table.

**Extraction also persists derived content.** A repo scan stores the tool
inventory it inferred and up to 8000 characters of verbatim extracted
system-prompt text on the agent record. Derived, not a source dump — but it is
customer code-adjacent content and it lives with the agent.

## How long it is kept

**Captured LLM bodies: `ARCEO_CAPTURE_RETENTION_DAYS`, default 90 days.**

A daily sweep deletes bodies past the window. The audit rows survive with their
metadata and content digest, so the trail still shows that a call happened and
what its content hashed to — and `GET /api/audit/verify` still passes.

Set it to `0` to retain indefinitely. That is an explicit choice, and it should
be a deliberate one: it was the *only* possible behaviour before the sweep
existed.

⚠️ **On Cloud Run the sweep does not run by itself.** CPU is throttled between
requests, so the in-process scheduler essentially never ticks. Drive
`python -m jobs.purge_llm_captures` from Cloud Scheduler —
`DEPLOYMENT_CONTRACT.md` §4. **A retention policy that depends on a loop that
never runs is not a retention policy**, and it fails silently.

**Everything else is kept for the life of the agent or the workspace**, with the
exceptions below.

## How it is deleted

**Deleting an agent** (`DELETE /api/authority/agent/{id}`, or the bulk endpoint)
removes its definition, tools, actions, policies, test data, simulations,
sweeps, executions — **and erases its captured LLM bodies**. The response reports
how many were erased.

⚠️ **This changed in Tier 3.2.** Before it, deleting an agent orphaned the
captured bodies: `llm_captures.agent_id` is a plain column with no foreign key
and no cascade, so nothing referenced them and only the age sweep would ever
have removed them. If you deleted an agent before that change, its bodies may
still be present until they age out — `jobs/purge_llm_captures.py` exposes
`erase_captures_for_agent(conn, org_id, agent_id)` to remove them on request.

**Per-subject erasure** is `erase_captures_for_agent`, the same path the sweep
and agent-deletion use. It is org-scoped: two tenants can hold the same
caller-supplied agent id, and erasure never crosses that boundary.

**Content written before the capture table existed** sits inside `audit_log`,
which is append-only by trigger and cannot be deleted in place.
`scripts/scrub_historical_audit_content.py` is the break-glass; it rewrites the
hash chain and is deliberately not a routine operation.

**Revoking a teammate** (`POST /api/team/{id}/revoke`) signs them out everywhere
and blocks sign-in. Their history stays in the audit trail — that is the point of
an audit trail.

## Export

Available today, all client-side from the UI:

- **Audit and execution logs** — CSV, from History
- **Spend** — CSV and the CFO PDF, from the Spend Dashboard and Cost Portfolio

⚠️ **The audit export was truncated at 100 rows and did not say so** until Tier
3.2. It now reports the true total alongside the page, so a truncated export is
visible as truncated. If you exported an audit trail before that change, treat
it as the most recent 100 entries rather than a complete record.

## Limits, stated plainly

- **There is no self-service "delete my organisation".** Nothing removes the
  `organizations` row. Workspace closure is a manual operation today. On a
  self-hosted deployment against a customer-owned Postgres, deletion is
  `DROP DATABASE` and export is `pg_dump`.
- **There is no whole-org export endpoint**, for the same reason.
- **Backups are the deployment's responsibility**, so erasure guarantees here
  cover the live database only. If the deployment takes backups, deleted content
  persists in them for the backup retention period. Reconcile the two windows
  before quoting one to a customer.
- **Arceo's own operational spend counters** (`cogs:{org}:{month}`) hold dollar
  totals per org in Redis, with a ~40-day TTL. No customer content.

## Answering the question a CIO actually asks

> *"If we stop using you, what happens to our prompts?"*

Delete the agents: their captured bodies are erased in the same transaction, and
the response tells you how many. What remains is the audit trail — metadata and
digests, no content — which is append-only by design because its value is that
it cannot be quietly edited. If the workspace itself must go, that is a manual
operation today; ask, and it is done against the database directly.
