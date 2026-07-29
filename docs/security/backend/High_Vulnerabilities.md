# High-Severity Vulnerabilities

| Field | Value |
|---|---|
| Document | High-Severity Vulnerabilities |
| Project | Arceo — Backend Security Audit |
| Audit date | 2026-07-28 |
| Auditor | Arceo Engineering — Internal Security Review |
| Scope | `backend/` (FastAPI service, Python 3.11) + operational scripts (`scripts/`) |
| Source | `dev`, verified at commit `076f0b0` |
| Classification | Internal / Confidential |
| Findings (this tier) | 4 |

High-severity findings are significant security risks that must be resolved before general availability. None enables system compromise or a standing cross-tenant breach on its own (those would be Critical), but each either bypasses a core access-control guarantee under a realistic configuration, disables the enforcement layer, exposes an unbounded cost/denial-of-wallet surface, or destroys data during routine operations. **HIGH-001 and HIGH-002 form a tenancy pair with no safe RLS setting** — one is live when Row-Level Security is off (today's posture), the other detonates when it is on — so they must be remediated together. Both are held at High rather than Critical only because no shared multi-tenant instance is hosted yet; see `Critical_Vulnerabilities.md` for the explicit escalation trigger.

---

## HIGH-001: Enforcing Proxy Does Not Bind the Target Agent to the API Key's Organization

**File**: `backend/main.py`
**Lines**: 850–853, 889–892, 904–911
**OWASP Category**: A01:2021 - Broken Access Control
**CWE**: CWE-639: Authorization Bypass Through User-Controlled Key

### Description

The enforcing proxy (`proxy_request`, `@app.api_route("/proxy/{service}/{path:path}")`) authenticates the caller with a mandatory `X-API-Key` (`verify_api_key`, lines 842–844) and reads the target agent from the caller-supplied `X-Agent-ID` header (lines 846–848). The only code that ties those two together is the agent-scope check at lines 850–853:

```python
if key_info and (key_info.get("agent_id") or "") and key_info["agent_id"] != agent_id:
    raise HTTPException(status_code=403, detail="API key is scoped to a different agent")
```

This 403 fires only when the key is *agent-scoped* — that is, when `key_info["agent_id"]` is non-empty. A key minted without an agent scope (the default) carries an empty `agent_id`, so the condition short-circuits and the check is skipped entirely. The handler then resolves the agent's organization directly from the database by the caller-controlled id — on the ALLOW path at lines 904–906 (`SELECT org_id FROM agents WHERE id = %s`) and again on the REQUIRE_APPROVAL path at lines 889–892 — and passes that `agent_org` straight into `_vault_prepare(service, path, headers, agent_org)` (lines 908–911), which injects **that organization's** vaulted provider secret. At no point is `agent_org` compared against the organization that owns the presenting API key.

The result is a cross-tenant confused-deputy. An attacker holding a valid, non-agent-scoped key for organization A sets `X-Agent-ID` to an agent id belonging to organization B. Policy enforcement (`safe_enforce_check`, line 874) evaluates B's policies for B's agent, and on ALLOW the proxy forwards the request upstream using **B's real Stripe / Zendesk / SendGrid credential** — including `moves_money` operations such as refunds and charges billed to B, and logged under B's organization. The sibling paths get this right: `/api/enforce` and `/api/agent/{id}/llm-call` both verify the agent's org against the key's org before acting; the proxy is the one inconsistent path. This contradicts the guarantee stated in `docs/SECURITY_DESIGN.md` — *"the proxy resolves the org from the agent's DB row, never from a caller-supplied header … Another org's admin → Nothing cross-tenant."* The org is indeed read from the agent row, but the agent id that selects that row is caller-supplied and unbound to the key.

The exposure is contained only while PostgreSQL Row-Level Security is active: under a non-superuser role the cross-org `SELECT org_id FROM agents` returns no row, `agent_org` falls back to `DEFAULT_ORG_ID`, and the wrong-tenant credential is not reached. But RLS is dormant in the current dev/superuser configuration (`docs/SECURITY_DESIGN.md`: *"a superuser bypasses even FORCED RLS"*), so the bypass is live as the system runs today — and switching RLS on to close it triggers HIGH-002.

### Impact

- **Cross-Tenant Access**: A key scoped to one organization can drive the enforcing proxy as any agent in any other organization, defeating the product's central tenant-isolation guarantee.
- **Financial Loss**: The injected credential includes `moves_money` providers, so an attacker can issue refunds, charges, or transfers billed to a victim tenant's real payment account.
- **Credential Misuse**: A victim organization's vaulted secrets are used to make live upstream calls it never authorized, while the calling agent itself never sees the secret.
- **Repudiation / Audit Corruption**: Forwarded calls are enforced against the victim's policies and recorded under the victim's organization, misattributing the activity to the wrong tenant.
- **Compliance Violation**: Cross-tenant use of stored payment and customer-data credentials breaches the isolation representations a SOC 2 report or customer DPA depends on.

### Remediation Guidance

- After resolving the agent, compare its org to the key's org and reject on mismatch: `if agent_row and key_info.get("org_id") and agent_row["org_id"] != key_info["org_id"]: raise HTTPException(403)`. Enforce this on both the ALLOW path (before `_vault_prepare`, lines 904–911) and the REQUIRE_APPROVAL path (before `create_pending_proxy`, lines 889–897).
- Resolve the agent's org exactly once near the top of `proxy_request` and reuse it, so no downstream branch can act on an unbound `agent_org`.
- Keep this as an explicit application-layer check rather than relying on RLS, so the proxy is safe whether or not RLS is active; RLS remains the structural backstop.
- Return an identical generic response for "agent not found" and "agent belongs to another org" so the proxy cannot be used as a cross-org agent-id oracle.
- Add a cross-org proxy case to `backend/tests/test_cross_org_matrix.py`: mint a non-agent-scoped key for org A, call `/proxy/{service}/…` with an org-B `X-Agent-ID`, and assert a 403 with no upstream forward — run under the non-superuser role so it holds with RLS both on and off.

### Affected Locations

| # | File | Line(s) | Notes |
|---|---|---|---|
| 1 | `backend/main.py` | 850–853 | Agent/key bind check fires only for agent-scoped keys |
| 2 | `backend/main.py` | 904–906 | ALLOW path resolves `agent_org` from caller-named agent id, no key-org check |
| 3 | `backend/main.py` | 889–892 | REQUIRE_APPROVAL path repeats the unchecked org resolution |
| 4 | `backend/main.py` | 908–911 | `_vault_prepare` injects the resolved org's vaulted secret |

---

## HIGH-002: Policy and Execution Writes Omit `org_id` — Under Production RLS, Policy Creation Fails and Enforcement Falls Open

**File**: `backend/main.py`, `backend/db.py`
**Lines**: `main.py` 3312, 4836, 6279, 6316; `db.py` 299
**OWASP Category**: A01:2021 - Broken Access Control
**CWE**: CWE-284: Improper Access Control

### Description

The tamper-evident audit writer was fixed to derive the tenant from the request context — `log_audit` (`db.py:274–276`) sets `org_id = current_org.get()` when the caller omits it, keeping each written row in lockstep with the org that RLS enforces. That fix was not propagated to two other write paths.

First, all four `INSERT INTO policies` statements omit the `org_id` column entirely: `main.py:3312` (create policy), `4836` (apply-all recommended policies), `6279` (apply recommendation), and `6316` (bulk apply). Each lists `(agent_id, action_pattern, effect, reason, [conditions,] priority, created_by, created_at)` and relies on the column's server-default of `'default'`. Second, `log_execution` (`db.py:299`) declares `org_id: str = DEFAULT_ORG_ID` and — unlike `log_audit` — never derives it from `current_org`, so any caller that does not pass an explicit org (for example the mock-execution endpoint) writes an execution row filed under `'default'`.

Under the intended production posture — the application running as a non-superuser role so FORCED RLS actually bites — this produces two failure modes that mirror HIGH-001's containment:

1. A policy `INSERT` executed inside a real tenant's transaction context writes `org_id='default'` while `app.current_org` is the tenant, so the RLS `WITH CHECK` clause rejects the row and **policy creation returns 500 for every non-`'default'` tenant**.
2. For any policy written while RLS was dormant (filed `'default'`), the enforcement read (`enforce_check`'s policy `SELECT`, running under the tenant's RLS context) matches zero rows, so every action falls through to the default ALLOW — **enforcement silently fails open**, disabling the product's core control for that tenant.

Both modes are hidden today because CI and dev run as a superuser, where FORCED RLS does not apply and `'default'` rows are readable by everyone. The defect surfaces precisely when RLS is switched on to remediate HIGH-001 — which is why the two must be fixed together.

### Impact

- **Security Control Bypass**: Policies filed under `'default'` are invisible to a tenant's RLS-scoped enforcement read, so BLOCK / REQUIRE_APPROVAL rules stop matching and dangerous actions are allowed through.
- **Denial of Service**: Under production RLS, every policy-creation call from a real tenant returns 500, blocking customers from configuring enforcement at all.
- **Cross-Tenant Data Integrity**: Execution and policy rows mis-filed to `'default'` corrupt per-tenant history and can surface one tenant's configuration under the shared default org.
- **False Assurance**: The dashboard reports policies as "created" while they never take effect for the tenant, so operators believe an agent is governed when it is not.
- **Compliance Violation**: Silent fail-open of the enforcement layer invalidates the access-control representations (SOC 2 CC6.1 / CC6.3) the product makes to customers.

### Remediation Guidance

- Set `org_id` explicitly in all four policy `INSERT`s (`main.py:3312/4836/6279/6316`): add the column and pass the authenticated tenant (`_org(user)`) rather than relying on the `'default'` server-default.
- Give `log_execution` (`db.py:299`) the same context-derivation `log_audit` uses — when `org_id` is not supplied, read `current_org.get()` and fall back to `DEFAULT_ORG_ID` only for genuine system contexts.
- Add a `BEFORE INSERT` trigger on `policies` that stamps `org_id` from `app.current_org`, so an omitted org can never silently become `'default'`.
- Audit every remaining `INSERT` and `log_execution` call site for an implicit `'default'` and remove reliance on the server-default.
- Run policy-create and enforce tests under the non-superuser role (`test_cross_org_matrix.py` / `test_rls_enforcement.py`): assert policy creation succeeds for a non-default tenant and that a BLOCK policy still blocks after RLS is forced, so a regression re-opens as a test failure rather than a silent fail-open.

### Affected Locations

| # | File | Line(s) | Notes |
|---|---|---|---|
| 1 | `backend/main.py` | 3312 | Create-policy INSERT omits `org_id` |
| 2 | `backend/main.py` | 4836 | Apply-all-policies INSERT omits `org_id` |
| 3 | `backend/main.py` | 6279 | Apply-recommendation INSERT omits `org_id` |
| 4 | `backend/main.py` | 6316 | Bulk-apply INSERT omits `org_id` |
| 5 | `backend/db.py` | 299 | `log_execution` hard-defaults `org_id` to `DEFAULT_ORG_ID`, no context derivation |

---

## HIGH-003: Server-Key LLM Endpoints Run Unbounded With No Per-Organization Spend Ceiling (Denial of Wallet)

**File**: `backend/main.py`
**Lines**: 4041, 4149, 4233, 6039, 6106 (spenders); 636, 2858, 2947 (the gate); 971, 1054 (keyless faucets)
**OWASP Category**: LLM10:2025 - Unbounded Consumption
**CWE**: CWE-770: Allocation of Resources Without Limits or Throttling

### Description

Several endpoints fan a single HTTP request into many billable, server-key model calls with no per-request or per-organization ceiling: `/api/sandbox/sweep` (`run_sweep`, line 6106) runs every scenario across up to 20 turns each; `/api/red-team/{agent_id}` (`run_red_team_endpoint`, line 6039) drives a multi-turn attacker/defender loop of roughly a hundred-plus calls; `/api/sandbox/simulate` (4149) and `/api/sandbox/simulate/multi` (4233) run agent loops; and `/api/sandbox/agent/{agent_id}/generate-scenarios` (4041) calls a premium model. The only spend control in the codebase, `_budget_gate` (defined at `main.py:2947`), is wired to exactly two call sites — the LLM proxy (`main.py:636`) and `/api/agent/{id}/llm-call` (`main.py:2858`) — and is absent from every server-key spender above. A grep for `_budget_gate` returns only lines 636, 2858, and the definition at 2947, confirming the spenders are ungated.

The exposure widens on a freshly deployed instance with no API keys minted. `/api/report` (`main.py:1046`, auth gate at lines 1053–1054) and `/api/sdk/analyze-trace` (`main.py:961`, gate at 970–971) both resolve auth as `if key_count > 0 and not key_info:` → 401. When `key_count == 0`, that condition is false and the request is accepted **unauthenticated**, giving an anonymous caller a direct path to the model. The one control that does exist, `_budget_gate`, is additionally off-by-default, a no-op for budgetless/auto-created agents, and fails open on error (tracked separately as MED-004), so even where it is wired it is not a reliable ceiling.

### Impact

- **Cost Abuse / Denial of Wallet**: A single authenticated user — or, on a keyless instance, an anonymous caller — can drive unbounded server-key model spend, turning the product's own model bill into the attack surface.
- **Financial Loss**: `generate-scenarios` invokes a premium model with no cap, making each request disproportionately expensive.
- **Denial of Service**: Sustained fan-out exhausts the upstream provider's rate/quota, degrading the service for every tenant.
- **Product-Promise Contradiction**: Arceo sells cost governance; an uncapped spend path in its own backend directly undercuts that value proposition.
- **Unauthenticated Reach**: On a keyless deployment, `/api/report` and `/api/sdk/analyze-trace` reach the model with no credential at all.

### Remediation Guidance

- Thread a per-organization, pre-call spend and call-count ceiling through `run_simulation` / `run_sweep` / `run_red_team` (mirroring `multi_runner.MAX_TOTAL_LLM_CALLS`), checked and decremented before each model call, aborting when exceeded.
- Call `_budget_gate` (hardened per MED-004) at the entry of every server-key spender — `sweep`, `red-team`, `simulate`, `simulate/multi`, `generate-scenarios` — not only the proxy and llm-call paths.
- Rate-limit these endpoints by estimated model-call count rather than request count, so one request that expands to hundreds of calls is throttled accordingly.
- Require an API key unconditionally on `/api/report` and `/api/sdk/analyze-trace` (drop the `key_count > 0` conditional), or skip the LLM summary entirely when unauthenticated.
- Pin `generate-scenarios` to an explicit, non-premium model tier by default and require a key.
- Verify with a test that a sweep or red-team run aborts once a per-org call budget is exceeded, and that `/api/report` returns 401 on a keyless instance.

### Affected Locations

| # | File | Line(s) | Notes |
|---|---|---|---|
| 1 | `backend/main.py` | 6106 | `/api/sandbox/sweep` — scenarios × 20 turns, no gate |
| 2 | `backend/main.py` | 6039 | `/api/red-team/{agent_id}` — multi-turn loop, no gate |
| 3 | `backend/main.py` | 4149, 4233 | `simulate` / `simulate/multi` — no gate |
| 4 | `backend/main.py` | 4041 | `generate-scenarios` — premium model, no gate/key |
| 5 | `backend/main.py` | 636, 2858, 2947 | `_budget_gate` wired only to proxy + llm-call |
| 6 | `backend/main.py` | 971, 1054 | Keyless faucets: unauthenticated when `key_count == 0` |

---

## HIGH-004: Master-Key Rotation and Backfill Scripts Omit `audit_log.detail_enc`, Bricking the Densest-PII Column on Rotation

**File**: `scripts/rotate_vault_master_key.py`, `scripts/backfill_encryption.py`, `backend/db.py`
**Lines**: `rotate_vault_master_key.py` 39–43; `backfill_encryption.py` 35–39; `db.py` 290–296
**OWASP Category**: A02:2021 - Cryptographic Failures
**CWE**: CWE-311: Missing Encryption of Sensitive Data

### Description

Migration `0011_audit_detail_enc` added the `audit_log.detail_enc` column, and `log_audit` writes it on every audit row (`db.py:290–296`: `detail_pt, detail_enc = encryption.split(detail)` → `INSERT INTO audit_log (…, detail, detail_enc, …)`). `audit_log.detail` carries the densest PII in the system — full LLM system prompts and responses captured on `LLM_CALL` rows.

Both master-key operational scripts hardcode the set of encrypted columns, and neither lists `audit_log.detail_enc`. In `rotate_vault_master_key.py`, `_BLOB_COLUMNS` (lines 39–43) enumerates only `pending_requests.body_enc`, `pending_requests.params_json_enc`, and `execution_log.params_enc`. In `backfill_encryption.py`, `_COLUMNS` (lines 35–39) enumerates the same three. The rotation script's own module docstring (lines 16–18) restates the list in prose — *"Covers: … pending_requests.body_enc / params_json_enc, execution_log.params_enc. Add new `_enc` columns to `_BLOB_COLUMNS` below"* — and `audit_log.detail_enc`, introduced by the later `0011` migration, was never added to either.

The failure is unrecoverable. A master-key rotation rewraps every DEK in the three listed columns under the new key but leaves `audit_log.detail_enc`'s DEKs wrapped under the *old* key. Once the old key is retired (the documented final step), every historical audit row's detail becomes permanently undecryptable — `/api/audit` returns 500 on those rows and the data is lost. Separately, `backfill_encryption.py` never encrypts pre-existing plaintext `audit_log.detail`, so adopting encryption-at-rest silently leaves the most sensitive column in cleartext. This is a direct consequence of remediating the prior round's audit-detail finding: the column was added, but the operational tooling that must track every `_enc` column was not updated with it.

### Impact

- **Permanent Data Loss**: After a routine key rotation retires the old key, all historical `audit_log.detail` (LLM prompts and responses) is unrecoverable.
- **Denial of Service**: `/api/audit` returns 500 on historical rows whose DEKs no longer unwrap, breaking the audit-trail view the product's integrity claims depend on.
- **Data Breach (residual plaintext)**: `backfill_encryption.py` leaves pre-existing audit-detail PII in cleartext, so "encryption-at-rest is on" is false for the densest-PII column.
- **Compliance Violation**: An audit trail that becomes unreadable after a security-hygiene operation fails the retention and integrity expectations of SOC 2 and data-protection regimes.
- **Silent Failure**: Neither script errors on the missing column — the desync is invisible until data has already been destroyed.

### Remediation Guidance

- Add `("audit_log", "id", "detail_enc")` to `_BLOB_COLUMNS` in `rotate_vault_master_key.py` and `("audit_log", "id", "detail", "detail_enc")` to `_COLUMNS` in `backfill_encryption.py`.
- Replace both hardcoded lists with a single shared registry of encrypted columns defined once (for example in `backend/encryption.py`) and imported by both scripts, so a new `_enc` migration cannot desync from the tooling.
- Add a CI assertion that every `*_enc` column present in the schema appears in that shared registry, failing the build when a migration adds a column the scripts do not cover.
- Extend `backend/tests/test_encrypt_at_rest.py` to drive rotate-then-read and backfill-then-read across **every** encrypted column, asserting each decrypts under the new key.
- Derive the rotation script's docstring column list from the shared registry rather than restating it in prose.

### Affected Locations

| # | File | Line(s) | Notes |
|---|---|---|---|
| 1 | `scripts/rotate_vault_master_key.py` | 39–43 | `_BLOB_COLUMNS` omits `audit_log.detail_enc` |
| 2 | `scripts/backfill_encryption.py` | 35–39 | `_COLUMNS` omits `audit_log.detail_enc` |
| 3 | `backend/db.py` | 290–296 | `log_audit` writes `detail_enc` live via `encryption.split` |

---

## References

- OWASP Top 10 (2021): [A01 Broken Access Control](https://owasp.org/Top10/A01_2021-Broken_Access_Control/), [A02 Cryptographic Failures](https://owasp.org/Top10/A02_2021-Cryptographic_Failures/)
- OWASP Top 10 for LLM Applications (2025): [LLM10 Unbounded Consumption](https://genai.owasp.org/llmrisk/llm10-unbounded-consumption/)
- CWE: [CWE-639 Authorization Bypass Through User-Controlled Key](https://cwe.mitre.org/data/definitions/639.html), [CWE-284 Improper Access Control](https://cwe.mitre.org/data/definitions/284.html), [CWE-770 Allocation of Resources Without Limits or Throttling](https://cwe.mitre.org/data/definitions/770.html), [CWE-311 Missing Encryption of Sensitive Data](https://cwe.mitre.org/data/definitions/311.html)

## Changelog

| Date | Author | Description |
|---|---|---|
| 2026-07-28 | Arceo Engineering — Internal Security Review | Initial High-severity findings from the backend security audit (`dev @ 076f0b0`). |
