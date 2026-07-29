# Critical-Severity Vulnerabilities

| Field | Value |
|---|---|
| Document | Critical-Severity Vulnerabilities |
| Project | Arceo — Backend Security Audit |
| Audit date | 2026-07-28 |
| Auditor | Arceo Engineering — Internal Security Review |
| Scope | `backend/` (FastAPI service, Python 3.11) + operational scripts (`scripts/`) |
| Source | `dev`, verified at commit `076f0b0` |
| Classification | Internal / Confidential |
| Findings (this tier) | 0 |

## Result: no Critical findings

This audit identified **no Critical-severity vulnerabilities** in the backend. An empty Critical tier is a result, not an omission — it reflects that the highest-impact classes the rubric reserves for Critical were specifically checked and not found on the app layer:

- **No SQL injection** — every query is `%s`-parameterized (psycopg3); `ORDER BY` clauses are hardcoded; the one dynamic `DELETE FROM {table}` iterates an allowlisted constant and is `DEMO_MODE`-gated.
- **No unsandboxed code execution / deserialization** — no `pickle` / `yaml.load` / `eval` / `exec` / `subprocess` / `os.system` / `getattr`-dispatch reachable from request input; enforcement operators come from a hardcoded table.
- **No hardcoded secrets in source** — only inert test fixtures and a public documentation key; real secrets live in the vault or environment.
- **No standing cross-tenant read breach** — every id-addressed route verifies org ownership (404 on cross-org), and RLS is `ENABLE`d and `FORCE`d on all org-scoped tables as a structural backstop.
- **No zero/static-IV authenticated encryption** — the vault uses fresh 12-byte nonces and fresh per-value DEKs (AES-256-GCM); nonce reuse is structurally precluded.
- **No `alg=none` / auth-token minting bypass** — HS256 is pinned, the `JWT_SECRET` boot guard is present, and the demo-wipe debug path is double-gated behind `DEMO_MODE`.

## Escalation trigger — read before deploying multi-tenant

Two High findings are held **one notch below Critical by deployment posture, not by impact ceiling**:

- **HIGH-001** (enforcing proxy does not bind the target agent to the API key's org) — impact ceiling is cross-tenant **money movement**, which the rubric classes as Critical. It is held at High only because no shared multi-tenant instance is hosted; the current pilot model is one organization per customer-VPC deployment, where there is no second tenant to cross into.
- **HIGH-002** (policy/execution writes omit `org_id` → enforcement fails open under RLS) — "enforcement fails open" disables the product's core control; held at High only because it requires the non-superuser RLS role that is not today's configuration.

**The moment a shared, multi-tenant Arceo instance exists — a hosted SaaS tier, a self-service signup, or any deployment where more than one organization shares a database and process — HIGH-001 and HIGH-002 escalate to Critical and this document must be updated to carry them.** They are also the first two items in Phase 1 of `Remediation_Roadmap.md` and, per the tenancy-pair analysis in `High_Vulnerabilities.md`, must be remediated together (fixing one by turning RLS on triggers the other).

## Changelog

| Date | Author | Description |
|---|---|---|
| 2026-07-28 | Arceo Engineering — Internal Security Review | No Critical findings; recorded the HIGH-001/HIGH-002 escalation trigger for multi-tenant deployment. |
