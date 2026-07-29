# Domain Checklists

| Field | Value |
|---|---|
| Document | Domain Checklists — coverage evidence |
| Project | Arceo — Backend Security Audit |
| Audit date | 2026-07-28 |
| Auditor | Arceo Engineering — Internal Security Review |
| Source | `dev`, verified at commit `076f0b0` |
| Classification | Internal / Confidential |

This document is the audit's coverage evidence. Each section is a module (or trust boundary) with the security checks performed against it. An **unchecked box** is an open finding — `- [ ] **ID** (Severity) — action`; a **checked box** is a control that was reviewed and **passed**, recorded so a reader can confirm from this document alone that the area was examined and nothing was skipped. All 39 findings appear exactly once as an unchecked box; the 4 High findings are marked in bold.

---

## Enforcing proxy & credential injection — `main.py` (`/proxy/*`), `vault.py`

- [ ] **HIGH-001** (High) — Bind the target agent's org to the API key's org before enforce and vault injection (ALLOW + REQUIRE_APPROVAL paths)
- [ ] **MED-005** (Med) — Key the `/proxy/llm` rate limiter on client IP, not the caller-supplied `X-Agent-ID`; gate agent auto-create behind a key
- [ ] **MED-010** (Med) — Validate the stored Slack webhook URL through `validate_external_url`; allowlist `hooks.slack.com`; disable redirects
- [ ] **LOW-007** (Low) — Bind AAD (`table:col:org:row`) into the AES-GCM envelope so blobs are not relocatable
- [ ] **LOW-008** (Low) — Implement `KmsMasterKey` behind the existing `MasterKeyProvider` seam; mount the secret rather than `-e`
- [ ] **LOW-013** (Low) — Require a key on the proxy in any multi-tenant deployment; scope keyless captures out of the default-org read path
- [x] `X-API-Key` mandatory on the enforcing proxy — no wide-open egress on a fresh install
- [x] Agent's own `Authorization` / `X-API-Key` stripped before the vaulted secret is injected
- [x] Outbound egress guarded: `validate_external_url` pins the resolved IP (defeats DNS-rebind), blocks loopback/private/link-local/metadata, `follow_redirects=False`
- [x] Vault decrypt failure fails **closed** (call blocked, logged; no agent-header fallback)
- [x] Envelope crypto: fresh 12-byte nonce + fresh DEK per operation; `InvalidTag` propagated, never swallowed

## Tenant isolation & RLS — `db.py`, `main.py` (`_tenant_context`)

- [ ] **HIGH-002** (High) — Set `org_id` explicitly on the four policy INSERTs; context-derive it in `log_execution`; add a BEFORE-INSERT org trigger on `policies`
- [ ] **LOW-005** (Low) — Prefix live-trace Redis keys with `{org_id}:`
- [ ] **LOW-015** (Low) — Snapshot scheduler: set `current_org` per org and use a short transaction per org, not one `'system'`-context batch
- [ ] **LOW-017** (Low) — `deepcopy` on assignment (or delete) the unused `MockState(tenant_id=)` aliasing path — dead code today
- [x] RLS `ENABLE`d **and** `FORCE`d on every org-scoped table (migration `0002`)
- [x] Every id-addressed route verifies org ownership (404 cross-org); `test_cross_org_matrix` covers ~25 endpoints
- [x] `agents.id` is a global PK with collision-retry
- [x] No SQL injection — all queries `%s`-parameterized (psycopg3), `ORDER BY` hardcoded, the one dynamic `DELETE` iterates an allowlisted constant
- [x] Audit hash-chain validated; append-only trigger fires for all roles including superuser (migration `0007`)
- ⚠️ **Caveat:** FORCED RLS is bypassed by a superuser role; the app must run as a non-superuser for RLS to bite. HIGH-001 (live with RLS off) and HIGH-002 (fails under RLS on) form a pair with no safe setting — fix together.

## Authentication, sessions & RBAC — `auth.py`, `main.py` (`_rbac`)

- [ ] **MED-001** (Med) — Fail closed when the user row is missing/deleted; enforce `token_version` on the WebSocket handshake; add an admin deprovision lever
- [ ] **MED-002** (Med) — Replace the JWT-in-`/ws/traces?token=` query param with a short-lived single-use WS ticket
- [ ] **MED-003** (Med) — Use `hmac.compare_digest` and delete the unsalted-SHA-256 fallback branch so verify fails closed
- [ ] **MED-015** (Med) — Return a uniform signup response and equalize timing to close the account/tenant oracle
- [ ] **LOW-006** (Low) — Return a generic 409 (or auto-suffix) on a cross-org name collision
- [x] HS256 pinned (no `alg=none`); `JWT_SECRET` boot guard present
- [x] Central RBAC (`_rbac`), viewer < editor < admin, one middleware with no per-route miss
- [x] Instant session revocation via `users.token_version`, bumped on password change (migration `0006`)
- [x] Login rate-limit fails closed; login is timing-equalized; signup has no mass-assignment

## LLM sandbox, spend & abuse resistance — `main.py` (sandbox), `sandbox/runner.py`, `multi_runner.py`

- [ ] **HIGH-003** (High) — Per-org pre-call spend/call-count ceiling on sweep, red-team, simulate, and generate-scenarios; require auth on the keyless `/api/report` + `/api/sdk/analyze-trace` faucets
- [ ] **MED-004** (Med) — Make `_budget_gate` enforce-by-default outside dev, fail closed, and track a per-org running total in Redis
- [ ] **MED-006** (Med) — Move the synchronous heavy-LLM handlers off the 40-slot threadpool (background queue or `CapacityLimiter`)
- [ ] **MED-008** (Med) — Pass `timeout` + `max_retries` when building the OpenAI-compatible client
- [x] Excessive agency contained: `execute_tool_call` runs enforce-first and fails **closed**; dispatch is dict-lookup (no `getattr`)
- [x] 20-turn and depth-3 caps enforced and **not** request-overridable
- [x] `multi_runner` adds `MAX_TOTAL_LLM_CALLS=60` + cycle detection
- [x] `dispatch_agent` is org-scoped — no cross-org dispatch
- [x] Mock boundary holds — zero real network / filesystem / subprocess I/O across all 12 service mocks

## Risk classification & code extraction — `authority/risk_classifier.py`, `main.py` (extract / scan)

- [ ] **MED-011** (Med) — Data-guard/fence untrusted file content in the extraction prompts (`_extract_and_register`, `_score_in_memory`); treat unclassifiable as not-safe
- [ ] **MED-012** (Med) — Enforce a per-file and aggregate byte cap in `extract-github` before decoding
- [x] The risk-classifier hop already carries a data-guard (delimiters + `VALID_LABELS` output filter)
- [x] Path traversal safe: `_safe_static_path` resolves and containment-checks
- [x] `/api/scan` `path` never touches the filesystem — pure read-side, no DB writes

## Encryption at rest & key operations — `encryption.py`, `scripts/`, `approvals.py`

- [ ] **HIGH-004** (High) — Add `audit_log.detail_enc` to the rotation and backfill scripts; replace the two hardcoded lists with a shared registry + a CI assertion
- [ ] **MED-013** (Med) — Add a retention/purge job for `audit_log.detail`; move captured prompt/response content off the tamper-evident chain
- [ ] **MED-014** (Med) — Encrypt `slack_webhook_url` via `encryption.split`; mask on read
- [ ] **LOW-012** (Low) — Store held-approval headers by allowlist and encrypt `headers_json`
- [x] Encryption-at-rest reuses the vault's reviewed envelope (one crypto path); flag-gated (`ARCEO_ENCRYPT_AT_REST`) and reversible via read-both-ways
- [x] No key material in logs/reprs; `GET /api/credentials` returns metadata only

## Logging, error handling & observability — `main.py` (middleware), `shared_state.py`

- [ ] **MED-007** (Med) — Set a Redis socket timeout; call it via `to_thread` or an async client
- [ ] **MED-009** (Med) — Cap bytes actually read from the stream, not the declared `Content-Length`
- [ ] **MED-016** (Med) — Return a static client message + server-side correlation id; stop reflecting `str(e)`
- [ ] **MED-017** (Med) — Strip CR/LF/control chars before logging; constrain agent-id to `[a-z0-9-]`
- [ ] **LOW-003** (Low) — Do not log the seed-admin bootstrap password; require it via a secret
- [ ] **LOW-004** (Low) — Stash the resolved org on `request.state` so `_access_log` attributes events to the real tenant
- [ ] **LOW-014** (Low) — Emit an `AUTHZ_DENIED` audit row on 403; warn when middleware auth resolution throws
- [ ] **LOW-016** (Low) — Acquire the WebSocket slot inside `try` and release it in `finally`
- [x] Structured privileged-action access log — one JSON line per mutating/privileged call, no bodies/PII
- [x] Security headers set (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, CSP) + HSTS outside dev
- [x] Broad global rate limit across `/api/*` plus tight limits on auth/enforce/scan

## Supply chain & packaging — `.github/actions/scan`, `sdk/`, `docker-compose.yml`, dependencies

- [ ] **MED-018** (Med) — Hash-pin (or replace with stdlib) the scan action's `pip install httpx`
- [ ] **LOW-001** (Low) — Enforce `api_keys.scopes` or drop the unused column
- [ ] **LOW-002** (Low) — Add Pydantic `Field` length/count caps to the named auth/sim/MCP/ingest models
- [ ] **LOW-009** (Low) — docker-compose: bind `127.0.0.1`, set a Postgres password, Redis `--requirepass`
- [ ] **LOW-010** (Low) — Recommend pinning the action to a release tag/SHA, not `@dev`
- [ ] **LOW-011** (Low) — Register/hold the `arceo` PyPI name; consider a namespaced distribution
- [x] `requirements.txt` floats, but the Dockerfile and CI install from hash-pinned locks with `--require-hashes`
- [x] Dockerfile digest-pinned and non-root; CI least-privilege, all actions SHA-pinned, no `pull_request_target`, no script injection
- [x] Notable transitive CVEs (starlette CVE-2024-47874, h11 smuggling, pyjwt) cleared

## Changelog

| Date | Author | Description |
|---|---|---|
| 2026-07-28 | Arceo Engineering — Internal Security Review | Initial per-module coverage checklist for the backend security audit (`dev @ 076f0b0`). |
