# Security Overview

## Assessment summary

| Field | Value |
|---|---|
| Project | Arceo — Backend Security Audit |
| Audit date | 2026-07-28 |
| Auditor | Arceo Engineering — Internal Security Review |
| Scope | `backend/` (FastAPI service, Python 3.11) and operational scripts (`scripts/`) |
| Source root | `dev`, verified at commit `076f0b0` |
| Stack | FastAPI · PostgreSQL (Row-Level Security, `FORCE`) via psycopg3 · Alembic · Redis · enforcing credential-injecting proxy · LLM simulation sandbox |
| Files assessed | Full backend surface — the 6,600-line `main.py` monolith plus `db.py`, `auth.py`, `vault.py`, `encryption.py`, `approvals.py`, `shared_state.py`, the `authority/`, `sandbox/`, `jobs/`, and `ingestion/` packages, the `scripts/` ops tooling, and the packaged GitHub scan action |
| Findings | **39 total — 0 Critical · 4 High · 18 Medium · 17 Low** |

The two heaviest areas — multi-tenancy and injection — are clean at the top: no SQL injection, no reachable code-execution/deserialization, no cross-tenant read leak at the app layer, the mock boundary holds, SSRF/path-traversal guards are solid, RLS is `ENABLE`d and `FORCE`d on every org-scoped table, and the envelope cryptography is sound. Most findings are gaps in fixes already begun in prior rounds rather than untouched weaknesses. See `Critical_Vulnerabilities.md` for the verified-clean checklist behind the empty Critical tier.

---

## Severity by OWASP category

| OWASP category | Critical | High | Medium | Low | Total |
|---|---:|---:|---:|---:|---:|
| A01:2021 Broken Access Control | 0 | 2 | 0 | 6 | 8 |
| A02:2021 Cryptographic Failures | 0 | 1 | 2 | 3 | 6 |
| A03:2021 Injection | 0 | 0 | 0 | 0 | 0 |
| A04:2021 Insecure Design | 0 | 0 | 4 | 2 | 6 |
| A05:2021 Security Misconfiguration | 0 | 0 | 3 | 1 | 4 |
| A06:2021 Vulnerable & Outdated Components | 0 | 0 | 0 | 0 | 0 |
| A07:2021 Identification & Authentication Failures | 0 | 0 | 2 | 0 | 2 |
| A08:2021 Software & Data Integrity Failures | 0 | 0 | 1 | 2 | 3 |
| A09:2021 Security Logging & Monitoring Failures | 0 | 0 | 3 | 3 | 6 |
| A10:2021 Server-Side Request Forgery | 0 | 0 | 1 | 0 | 1 |
| LLM01:2025 Prompt Injection | 0 | 0 | 1 | 0 | 1 |
| LLM10:2025 Unbounded Consumption | 0 | 1 | 1 | 0 | 2 |
| **Total** | **0** | **4** | **18** | **17** | **39** |

A03 (Injection) and A06 (Vulnerable & Outdated Components) are empty by result: injection was checked exhaustively (see the coverage matrix and `Critical_Vulnerabilities.md`) and found clean, and no dependency CVE rose to a scored finding — the one dependency observation is advisory (see below).

## Severity by module

| Module | High | Medium | Low | Total |
|---|---:|---:|---:|---:|
| `backend/main.py` (API monolith — proxy, policy, sandbox, ingest) | 3 | 12 | 7 | 22 |
| `scripts/` (master-key rotation & backfill) | 1 | 0 | 0 | 1 |
| `backend/auth.py` (JWT, bcrypt, sessions) | 0 | 2 | 0 | 2 |
| `backend/vault.py` (envelope crypto) | 0 | 0 | 2 | 2 |
| `backend/shared_state.py` (Redis client) | 0 | 1 | 1 | 2 |
| `.github/actions/scan` (customer CI action) | 0 | 1 | 1 | 2 |
| `backend/db.py` (schema & helpers) | 0 | 0 | 1 | 1 |
| `backend/sandbox/runner.py` (LLM loop) | 0 | 1 | 0 | 1 |
| `backend/sandbox/mocks/registry.py` | 0 | 0 | 1 | 1 |
| `backend/authority/risk_classifier.py` | 0 | 1 | 0 | 1 |
| `backend/approvals.py` | 0 | 0 | 1 | 1 |
| `backend/jobs/snapshot_forecasts.py` | 0 | 0 | 1 | 1 |
| `sdk/` (published package) | 0 | 0 | 1 | 1 |
| `docker-compose.yml` | 0 | 0 | 1 | 1 |
| **Total** | **4** | **18** | **17** | **39** |

**`main.py` concentrates 22 of 39 findings (56%).** The 6,600-line monolith mixes the enforcing proxy, policy CRUD, the sandbox/LLM spenders, ingestion, and auth in one module; splitting it into domain routers (`routers/proxy.py`, `routers/authority.py`, `routers/sandbox.py`, …) is the single structural change that would most reduce the backend's security surface and make per-route controls (org-binding, budget gates, rate limits) auditable.

---

## Key risk areas

### 1. A tenant-isolation pair with no safe RLS setting — HIGH-001, HIGH-002, LOW-013

The most important finding is not a single bug but a pair. **HIGH-001** lets a non-agent-scoped API key drive the enforcing proxy as *another org's* agent, injecting that org's vaulted provider credential (including `moves_money`) — live today because RLS is dormant under the dev/superuser role. **HIGH-002** is the mirror image: policy and execution writes omit `org_id` and file under `'default'`, so the moment RLS is switched on (the fix for HIGH-001), policy creation 500s for real tenants and enforcement silently fails open. There is no configuration in which both are safe, so they must be remediated together. **LOW-013** (keyless proxy captures land in the default org) is the same root cause at lower severity. Both Highs are held one notch below Critical only because no shared multi-tenant instance is hosted yet; the escalation trigger is recorded in `Critical_Vulnerabilities.md`.

### 2. Denial-of-wallet across the server-key LLM surface — HIGH-003, MED-004, MED-006, MED-012

Arceo's differentiator is cost governance, yet its own backend exposes an uncapped spend surface. **HIGH-003**: the sweep, red-team, simulate, and generate-scenarios endpoints fan one request into hundreds of billable server-key calls with no per-org ceiling, and the lone budget control (`_budget_gate`) is wired only to the proxy and llm-call paths. **MED-004**: that gate is itself off-by-default, a no-op for budgetless agents, and fails open. **MED-006** (synchronous LLM handlers exhausting the threadpool) and **MED-012** (unbounded GitHub file reads) compound the resource-exhaustion picture. On a keyless instance, `/api/report` and `/api/sdk/analyze-trace` reach the model unauthenticated.

### 3. Encryption-at-rest tooling and retention gaps around a sound vault — HIGH-004, MED-013, MED-014, LOW-007, LOW-008, LOW-012

The AES-256-GCM envelope is well-designed, but the operational envelope around it has gaps. **HIGH-004**: the key-rotation and backfill scripts never learned about `audit_log.detail_enc`, so a routine rotation permanently bricks the densest-PII column. **MED-013**: LLM prompts/responses accrete in the append-only audit chain with no retention/purge. **MED-014**: the Slack webhook URL is the one secret still stored in cleartext. **LOW-007** (no AAD binding), **LOW-008** (env-var master key custody, an acknowledged interim), and **LOW-012** (approval-header secrets stored unencrypted) round out the theme.

### 4. Egress and injection into model loops — MED-010, MED-011

As an agent-governance product, Arceo runs untrusted content through model loops, so injection and egress are in-domain. The proxy's outbound egress is well-guarded (`validate_external_url` pins the resolved IP and blocks metadata/loopback), but **MED-010** shows the Slack-webhook egress path skips that guard entirely (blind SSRF), and **MED-011** shows the code-extraction LLM step interpolates untrusted file content behind only a markdown fence — no data-guard, failing open on parse — so crafted input can under-score blast radius and slip past the `/api/scan` gate. (The risk-classifier hop already carries a data-guard; the live surface is the extraction prompts, owned by the authority-engine track.)

### 5. Session, revocation, and auth-surface hygiene — MED-001, MED-002, MED-003, MED-015

Central RBAC and `token_version` revocation exist, but with gaps: **MED-001** (a deleted user's JWT still verifies; the WebSocket path skips `token_version`; no admin deprovision lever), **MED-002** (full JWT in the `/ws/traces` query string, landing in logs), **MED-003** (a dead but non-constant-time unsalted-SHA-256 verify branch), and **MED-015** (signup returns an account-existence/tenant oracle).

### 6. Logging, retention, and observability — MED-017, LOW-003, LOW-004, LOW-014

**MED-017** (caller-controlled ids reach the application logger without CR/LF stripping — log forgery; the tamper-evident audit chain itself is intact), **LOW-003** (seed-admin password logged at WARNING), **LOW-004** (privileged events mis-logged under `org_id:"system"`), and **LOW-014** (no audit row on authz 403s) together weaken the forensic record the product's integrity claims depend on.

---

## Dependency advisory

No dependency CVE rose to a scored finding — the Docker image and CI install from hash-pinned locks with `--require-hashes`, the Dockerfile is digest-pinned and non-root, and the notable transitive CVEs (starlette CVE-2024-47874, an h11 request-smuggling issue, pyjwt) are already cleared. Two advisory items remain, neither independently exploitable in the current surface:

| Item | Observation | Action |
|---|---|---|
| Starlette 0.41.3 | Predates later multipart-parser hardening; endpoints are JSON so the multipart path is likely unreachable | `pip-audit` already runs in CI as advisory — flip its `continue-on-error` to a hard gate and track the upgrade |
| Git-history secret scan | Not run against `origin` (the audit ran in a worktree) | Run `gitleaks` / `trufflehog` against the origin history as a one-time check |

---

## Coverage matrix

Every finding ID mapped to its category. An empty category is a recorded result.

**OWASP Top 10 (2021)**
- **A01 Broken Access Control** — HIGH-001, HIGH-002, LOW-001, LOW-005, LOW-006, LOW-013, LOW-015, LOW-017
- **A02 Cryptographic Failures** — HIGH-004, MED-003, MED-014, LOW-007, LOW-008, LOW-012
- **A03 Injection** — *(none — verified clean: all queries parameterized, no dynamic SQL from input)*
- **A04 Insecure Design** — MED-005, MED-006, MED-007, MED-008, LOW-002, LOW-016 (LOW-015 also maps here)
- **A05 Security Misconfiguration** — MED-009, MED-012, MED-016, LOW-009
- **A06 Vulnerable & Outdated Components** — *(none scored — see Dependency advisory)*
- **A07 Identification & Authentication Failures** — MED-001, MED-015
- **A08 Software & Data Integrity Failures** — MED-018, LOW-010, LOW-011
- **A09 Security Logging & Monitoring Failures** — MED-002, MED-013, MED-017, LOW-003, LOW-004, LOW-014
- **A10 Server-Side Request Forgery** — MED-010

**OWASP Top 10 for LLM Applications (2025) / Agentic**
- **LLM01 Prompt Injection** — MED-011
- **LLM10 Unbounded Consumption** — HIGH-003, MED-004
- **LLM02 Sensitive Information Disclosure** — *(covered under A09: MED-013 retention, MED-002 token exposure)*
- **LLM06 Excessive Agency** — *(none — verified contained: enforce-first execution, fail-closed dispatch, turn/depth caps; see `Domain_Checklists.md`)*

---

## Methodology

**Scope.** The full backend (`backend/`) and the operational scripts (`scripts/`) at `dev @ 076f0b0`. Frontend, website, and SDK internals are out of scope except where a packaged artifact (`sdk/`, `.github/actions/scan`) is part of the backend's trust boundary.

**Techniques.** Endpoint-by-endpoint trust-boundary mapping across seven concern areas — authentication, tenant isolation, injection, cryptography, dependencies, logging, and cost/abuse — combined with targeted deep reads and exhaustive `grep` sweeps of the `main.py` monolith from each concern angle (appropriate for a single-file, 80-endpoint surface). Every High finding's cited code was read and confirmed; a representative sample of Medium/Low citations was re-verified against the checked-out commit.

**Coverage.** Tenancy 20/20 and injection 32/32 candidate sites read; crypto 13/13; dependencies 9/9; logging 7/7; cost 9/9; authentication 6/9 (the unread three are low-risk read paths). Non-tenancy helper internals (cost math, graph/red-team internals) were reviewed by the concern areas that own them.

**Severity model.** Impact-based (worst *realistic* impact given the actual deployment posture, not the theoretical maximum), per the rubric reproduced in each vulnerability document. "Needs Verification" is a flag applied alongside a severity where exploitability depends on deployment configuration or runtime state.

---

## Remediation priority

- **Immediate (48 hours / before multi-tenant deploy).** Fix HIGH-001 and HIGH-002 **together**; add per-org spend ceilings for HIGH-003; patch the rotation/backfill scripts for HIGH-004 **before the next key rotation**. Full steps in `Remediation_Roadmap.md`, Phase 1.
- **Short-term (weeks 1–2).** Harden `_budget_gate` (MED-004), validate the Slack egress (MED-010), fence the risk classifier (MED-011), add client timeouts (MED-007, MED-008), close the revocation gaps (MED-001), and add audit retention (MED-013). Phase 2/3.
- **Medium-term (next cycle).** The 17 Low findings — defense-in-depth and hygiene: AAD binding, KMS custody, tenant-prefixed Redis keys, Pydantic caps, docker-compose hardening. Phase 3/4.

---

## Document index

- [`README.md`](./README.md) — package index and executive summary
- [`Critical_Vulnerabilities.md`](./Critical_Vulnerabilities.md) — empty tier + the HIGH-001/002 escalation trigger
- [`High_Vulnerabilities.md`](./High_Vulnerabilities.md) — HIGH-001 … HIGH-004
- [`Medium_Vulnerabilities.md`](./Medium_Vulnerabilities.md) — MED-001 … MED-018
- [`Low_Vulnerabilities.md`](./Low_Vulnerabilities.md) — LOW-001 … LOW-017
- [`Dead_Code_Report.md`](./Dead_Code_Report.md) — security-relevant dead code
- [`Domain_Checklists.md`](./Domain_Checklists.md) — per-module coverage evidence
- [`Remediation_Roadmap.md`](./Remediation_Roadmap.md) — phased remediation plan

## Changelog

| Date | Author | Description |
|---|---|---|
| 2026-07-28 | Arceo Engineering — Internal Security Review | Initial overview for the backend security audit (`dev @ 076f0b0`). |
