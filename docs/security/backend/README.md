# Arceo Backend — Security Audit

A comprehensive security audit of the Arceo backend: the Python 3.11 / FastAPI service in `backend/` (PostgreSQL with Row-Level Security via psycopg3, Alembic, Redis, the enforcing credential-injecting proxy, and the LLM simulation sandbox) plus the operational scripts in `scripts/`. Conducted against `dev` at commit `076f0b0` on 2026-07-28.

## Findings summary

| Severity | Count | Remediation timeline |
|---|---:|---|
| Critical | 0 | — |
| High | 4 | Immediate — within 48 hours; blocks multi-tenant deploy / next key rotation |
| Medium | 18 | Weeks 1–6 (next release cycle) |
| Low | 17 | Continuous (next development cycle) |
| **Total** | **39** | |

The two heaviest surfaces — multi-tenancy and injection — are clean at the top: no SQL injection, no reachable code execution, no cross-tenant read leak at the app layer, and RLS is `ENABLE`d and `FORCE`d on every org-scoped table. Most findings are gaps in fixes already begun in earlier rounds. There are **no Critical findings** — see `Critical_Vulnerabilities.md` for the verified-clean checklist and the one condition under which two High findings escalate.

## Top risk areas

1. **A tenant-isolation pair with no safe RLS setting (HIGH-001, HIGH-002).** The enforcing proxy lets a non-agent-scoped key act as another org's agent and inject that org's vaulted credentials — live today because RLS is dormant under the dev/superuser role. The mirror-image HIGH-002 means switching RLS on (the fix) makes policy creation 500 and enforcement fail open. They must be remediated together.
2. **Denial of wallet across the LLM surface (HIGH-003, MED-004).** Sweep, red-team, simulate, and generate-scenarios fan one request into hundreds of billable server-key calls with no per-org ceiling, and the only budget gate is unwired from them and fails open. On a keyless instance, two endpoints reach the model unauthenticated.
3. **Encryption-at-rest tooling gap (HIGH-004).** The key-rotation and backfill scripts never learned about `audit_log.detail_enc`, so a routine master-key rotation permanently bricks the densest-PII column (full LLM prompts/responses).
4. **Egress and injection into model loops (MED-010, MED-011).** The proxy's outbound egress is well-guarded, but the Slack-webhook path skips the guard (blind SSRF), and the code-extraction LLM step ingests unfenced file content that can under-score blast radius and slip past the `/api/scan` gate.
5. **Session, revocation, and retention hygiene (MED-001, MED-013).** A deleted user's JWT still verifies and the WebSocket path skips `token_version`; LLM prompts/responses accrete in the audit chain with no retention or purge.
6. **`main.py` concentration.** The 6,600-line monolith holds 22 of 39 findings; splitting it into domain routers is the single structural change that most reduces the backend's security surface.

## Critical actions required

1. **Do not enable a shared multi-tenant deployment or the non-superuser RLS role** until HIGH-001 and HIGH-002 are fixed **together** and verified under that role.
2. **Do not run a production master-key rotation** until HIGH-004 adds `audit_log.detail_enc` to both ops scripts and the rotation test covers every encrypted column.
3. **Add a per-organization spend ceiling** to the server-key LLM endpoints and require authentication on `/api/report` and `/api/sdk/analyze-trace` (HIGH-003).
4. **Harden the budget gate** (enforce-by-default, fail closed) so the HIGH-003 ceiling is reliable (MED-004).
5. Work Phases 2–4 of `Remediation_Roadmap.md` in order.

## Document index

| Document | Contents |
|---|---|
| [`Security_Overview.md`](./Security_Overview.md) | Metrics, severity × OWASP and × module cross-tabs, key risk narratives, dependency advisory, full coverage matrix, methodology |
| [`Critical_Vulnerabilities.md`](./Critical_Vulnerabilities.md) | No Critical findings — verified-clean checklist + the HIGH-001/002 escalation trigger |
| [`High_Vulnerabilities.md`](./High_Vulnerabilities.md) | HIGH-001 … HIGH-004, full detail |
| [`Medium_Vulnerabilities.md`](./Medium_Vulnerabilities.md) | MED-001 … MED-018, full detail |
| [`Low_Vulnerabilities.md`](./Low_Vulnerabilities.md) | LOW-001 … LOW-017, full detail |
| [`Dead_Code_Report.md`](./Dead_Code_Report.md) | Security-relevant dead code, with reproduction commands |
| [`Domain_Checklists.md`](./Domain_Checklists.md) | Per-module coverage evidence (open findings + passed controls) |
| [`Remediation_Roadmap.md`](./Remediation_Roadmap.md) | Four-phase plan with per-item validation and phase gates |

## Methodology

**Scope.** The full backend (`backend/`) and operational scripts (`scripts/`) at `dev @ 076f0b0`. The frontend, website, and SDK internals are out of scope except where a packaged artifact (`sdk/`, `.github/actions/scan`) sits on the backend's trust boundary.

**Techniques.** Endpoint-by-endpoint trust-boundary mapping across seven concern areas — authentication, tenant isolation, injection, cryptography, dependencies, logging, and cost/abuse — with targeted deep reads and exhaustive `grep` sweeps of the `main.py` monolith from each angle. Every High finding's cited code was read and confirmed; a representative sample of Medium/Low citations was re-verified against the checked-out commit.

**Severity ratings.**

- **Critical** — system compromise, RCE, auth bypass, credential exposure, full data breach, or cross-tenant data destruction. No production deployment until resolved.
- **High** — significant risk requiring near-term remediation; must be resolved before general availability.
- **Medium** — defense-in-depth weakness that degrades posture but does not independently enable exploitation; next release cycle.
- **Low** — hygiene and code-quality issues with security implications; track and address during regular development.

Severity reflects the **worst realistic** impact given the actual deployment posture (single-tenant, per-customer-VPC pilots today), not the theoretical maximum. "Needs Verification," where noted on a finding, flags exploitability that depends on deployment configuration or runtime state.

## Changelog

| Date | Author | Description |
|---|---|---|
| 2026-07-28 | Arceo Engineering — Internal Security Review | Initial backend security audit deliverable (`dev @ 076f0b0`). |
