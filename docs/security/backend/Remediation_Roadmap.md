# Remediation Roadmap

| Field | Value |
|---|---|
| Document | Remediation Roadmap |
| Project | Arceo — Backend Security Audit |
| Audit date | 2026-07-28 |
| Auditor | Arceo Engineering — Internal Security Review |
| Source | `dev`, verified at commit `076f0b0` |
| Classification | Internal / Confidential |

This roadmap sequences all 39 findings into four phases by urgency and dependency. Because the audit found **no Critical findings**, Phase 1 is anchored by the four High findings — but two of them (HIGH-001/HIGH-002) gate any multi-tenant deployment and one (HIGH-004) gates the next key rotation, so Phase 1 carries genuine 48-hour urgency. Each item lists the target file, the finding ID, concrete steps, and a **validation** criterion stated as a command or a test. Each phase ends with **gate criteria** that must hold before the next phase begins.

---

## Phase 1 — Immediate (within 48 hours; blocks multi-tenant deploy and the next key rotation)

### The tenancy pair — fix HIGH-001 and HIGH-002 together

- [x] **HIGH-001** — `backend/main.py` (`proxy_request`, lines 850–911). After resolving the agent, compare its org to the key's org and reject on mismatch on both the ALLOW and REQUIRE_APPROVAL paths: `if agent_row and key_info.get("org_id") and agent_row["org_id"] != key_info["org_id"]: raise HTTPException(403)`. Resolve the agent's org once and reuse it. Return an identical response for "not found" and "other org." *(shipped 2026-07-29, PR #124)*
  - **Validation:** add a cross-org proxy case to `backend/tests/test_cross_org_matrix.py` (org-A non-agent-scoped key + org-B `X-Agent-ID` → 403, no upstream forward); run the suite under the non-superuser role.
- [x] **HIGH-002** — `backend/main.py` (policy INSERTs 3312/4836/6279/6316) + `backend/db.py` (`log_execution`, 299). Add the `org_id` column to all four policy INSERTs with the authenticated tenant; give `log_execution` the same `current_org` derivation `log_audit` uses; add a BEFORE-INSERT `org_id` trigger on `policies`. *(shipped 2026-07-29, PR #124)*
  - **Validation:** under the non-superuser role, `test_rls_enforcement.py` asserts (a) policy creation succeeds for a non-`default` tenant and (b) a BLOCK policy still blocks after `FORCE ROW LEVEL SECURITY` is active.
- **Coupling:** these two must ship in the same change set — turning RLS on to close HIGH-001 activates HIGH-002, and vice versa. Do not enable the non-superuser RLS role in any shared environment until both land.

### Denial of wallet

- [x] **HIGH-003** — `backend/main.py` (spenders 4041/4149/4233/6039/6106). Thread a per-org pre-call spend/call-count ceiling through `run_simulation`/`run_sweep`/`run_red_team` (mirror `multi_runner.MAX_TOTAL_LLM_CALLS`); call the budget gate at each spender's entry; require a key unconditionally on `/api/report` (1046) and `/api/sdk/analyze-trace` (961); pin `generate-scenarios` off the premium model by default. *(shipped 2026-07-29, PR #126)*
  - **Validation:** a test drives a sweep past a per-org call budget and asserts it aborts; `/api/report` returns 401 on a keyless instance.

### Encryption-at-rest key operations

- [x] **HIGH-004** — `scripts/rotate_vault_master_key.py` (`_BLOB_COLUMNS`, 39–43) + `scripts/backfill_encryption.py` (`_COLUMNS`, 35–39). Add `audit_log.detail_enc` to both; replace the two hardcoded lists with a single shared registry in `backend/encryption.py`; add a CI assertion that every `*_enc` column in the schema appears in the registry. *(shipped 2026-07-29, PR #125)*
  - **Validation:** extend `backend/tests/test_encrypt_at_rest.py` to rotate-then-read and backfill-then-read **every** encrypted column, including `audit_log.detail_enc`, asserting each decrypts under the new key. **Do not run a production key rotation until this lands.**

**Phase 1 gate:** all four Highs merged; the cross-org proxy test and the RLS-on policy/enforce tests pass under the non-superuser role; the rotation test covers every `_enc` column; the per-org spend ceiling is enforced on all server-key spenders. No shared multi-tenant deployment and no master-key rotation before this gate is met.

---

## Phase 2 — Short-term (weeks 1–2): high-impact hardening

- [x] **MED-004** — `backend/main.py` (`_budget_gate`, 2947). Make it enforce-by-default outside dev, fail **closed** on error, resolve the wallet from the authenticated org, and keep a per-org running total in Redis. (Prerequisite for HIGH-003's ceiling to be reliable.) *(shipped 2026-07-29, PR #127)*
  - **Validation:** a test asserts the gate blocks once a per-org total is exceeded and blocks (not allows) when the store is unreachable.
- [x] **MED-010** — `backend/main.py` (3550) + `backend/authority/enforcement.py` (299). Run the stored Slack webhook URL through `validate_external_url`; allowlist `hooks.slack.com`; disable redirects. *(shipped 2026-07-29, PR #128 — host allowlist defaults to Slack, extensible via `ARCEO_WEBHOOK_ALLOWED_HOSTS`; validated at save AND at fire time)*
  - **Validation:** a test that a webhook pointing at `169.254.169.254`/loopback is rejected at save and at fire time.
- [ ] **MED-011** — `backend/main.py` (`_extract_and_register` 2268, `_score_in_memory` 2548). Wrap untrusted file content in a data-guard with delimiter escaping; treat an unparseable/empty classifier result as not-safe (fail toward higher risk), not as "no tools."
  - **Validation:** an injection regression case (file content attempting to close the fence and null the tool list) still yields a non-empty, correctly-scored inventory.
- [ ] **MED-001** — `backend/auth.py` (146–151) + `backend/main.py` (WS auth 4916). Fail closed when the user row is missing/deleted; enforce `token_version` on the WebSocket handshake; add an admin deprovision endpoint.
  - **Validation:** `test_rbac.py` asserts a deleted user's token is rejected and a `token_version` bump closes an open WS.
- [ ] **MED-013** — `backend/main.py` (679–689, 2869–2884). Add a retention/purge job for `audit_log.detail`; move captured prompt/response content off the tamper-evident chain into a separately-retained store.
  - **Validation:** a job test purges detail older than the retention window while leaving the hash chain verifiable via `GET /api/audit/verify`.
- [ ] **MED-006** — `backend/main.py` (sync LLM handlers 4773/5953/6075 et al.). Move heavy LLM jobs to a background queue or wrap them in an `anyio.CapacityLimiter`.
  - **Validation:** a concurrency test shows sync routes stay responsive while N sweeps run.
- [ ] **MED-007** — `backend/shared_state.py` (25, 110). Set `socket_timeout`/`socket_connect_timeout`; call Redis via `anyio.to_thread` or an async client. **Half done:** both clients now carry `socket_timeout`/`socket_connect_timeout` (`REDIS_TIMEOUT`, default 2s), pulled forward with PR #127 because the budget gate blocks on a Redis round-trip. Still open: the sync client is called from async middleware — move those calls to `anyio.to_thread` or an async client.
  - **Validation:** a test with a stalled Redis asserts the request path times out rather than hanging.
- [ ] **MED-008** — `backend/sandbox/runner.py` (190, 229). Pass `timeout` + `max_retries` when constructing the OpenAI-compatible client; centralize construction.
  - **Validation:** a test asserts a hung upstream fails fast rather than at ~600s.

- [ ] **MED-004-b (follow-up, surfaced while fixing MED-004)** — **sandbox spend is not metered, so the gate cannot see it.** `sandbox/runner.py`, `sandbox/multi_runner.py` and `sandbox/red_team.py` write no `LLM_CALL`/`LLM_CALL_PROXY` audit row, and month-to-date spend is computed exclusively from those rows. The budget gate therefore runs at `/api/sandbox/simulate`, `/api/sandbox/sweep` and `/api/red-team/*` against a counter their own spend never advances: a sweep is blocked only once *proxy/SDK-captured* spend has already exhausted the cap, and sweeps alone can never trip it. Those endpoints remain bounded per-request by `_SimBudget` / `ARCEO_SIM_MAX_LLM_CALLS` (HIGH-003), so this is a metering gap rather than an uncapped path — but it means the monthly cap under-counts real server-key spend. **Fix:** record each server-key model call to the audit log the same way the capture paths do (or charge the counter directly from `_SimBudget`), so one accounting covers both.
  - **Validation:** a test asserts that a completed dry-run-off sweep advances the org's month-to-date counter, and that a sweep is refused once the cap is reached on sandbox spend alone.

**Phase 2 gate:** the budget gate is enforce-by-default and fail-closed; the Slack egress is validated; the extraction prompts are fenced and fail toward higher risk; revocation closes on deleted users and the WS path; an audit-retention job is scheduled; heavy LLM handlers no longer hold the sync threadpool.

---

## Phase 3 — Medium-term (weeks 4–6): remaining Medium findings

- [ ] **MED-002** — `backend/main.py` (4911/4916). Replace the JWT-in-URL WS auth with a short-lived single-use ticket. **Validation:** access logs no longer contain a usable bearer token.
- [ ] **MED-003** — `backend/auth.py` (68–80). Use `hmac.compare_digest`, then delete the SHA-256 fallback so verify fails closed. **Validation:** `test_auth_hardening.py` asserts `verify_password("x", sha256("x"))` is `False`. **Pre-check:** run `SELECT count(*) FROM users WHERE password_hash NOT LIKE '$2%'`; if > 0, escalate to High and migrate those rows first.
- [ ] **MED-005** — `backend/main.py` (616–648). Key the `/proxy/llm` rate limit on client IP (or authenticated org); gate agent auto-create behind a key. **Validation:** rotating `X-Agent-ID` no longer resets the bucket.
- [ ] **MED-009** — `backend/main.py` (185–198). Cap bytes actually read from the stream; add an ingress body limit. **Validation:** a chunked over-cap body is rejected.
- [ ] **MED-012** — `backend/main.py` (2444–2460). Enforce per-file and aggregate byte caps before decoding; validate the branch/ref. **Validation:** a large-file repo does not grow worker RSS past the cap.
- [ ] **MED-014** — `backend/main.py` (3536/3550). Encrypt `slack_webhook_url` via `encryption.split`; mask on read. **Validation:** `test_encrypt_at_rest.py` covers the webhook column; the read path returns a masked value.
- [ ] **MED-015** — `backend/main.py` (1366–1368). Uniform signup response and timing parity. **Validation:** a test shows identical status/body/timing for existing vs new account.
- [ ] **MED-016** — `backend/main.py` (791/3102/2282/4106) + `runner.py` (396). Return a static message + server-side correlation id; log detail server-side only. **Validation:** error responses no longer contain upstream URLs or `str(e)`.
- [ ] **MED-017** — `backend/main.py` (616/5456), `registry.py` (525), `risk_classifier.py` (756). Strip CR/LF/control chars before logging; constrain agent-id to `[a-z0-9-]`. **Validation:** a forged newline in `X-Agent-ID` cannot inject a log line.
- [ ] **MED-018** — `.github/actions/scan/action.yml` (45–47). Hash-pin the `httpx` install or use the stdlib. **Validation:** `pip install --require-hashes` succeeds in the action.

**Phase 3 gate:** every Medium is closed or explicitly risk-accepted with sign-off recorded.

---

## Phase 4 — Continuous (next development cycle): Low findings

Defense-in-depth and hygiene; none blocks release. Track in the backlog and fix opportunistically; several remove a "safe only by invariant" caveat.

- [ ] **LOW-001** — `backend/main.py` (6546–6557): enforce `api_keys.scopes` or drop the column. **Validation:** a scoped key is denied an out-of-scope action.
- [ ] **LOW-002** — `backend/main.py` (auth/sim/MCP/ingest models): add `Field` length/count caps. **Validation:** oversized payloads are rejected with 422.
- [ ] **LOW-003** — `backend/db.py` (143–148): stop logging the seed-admin password; require via secret. **Validation:** boot logs contain no credential.
- [ ] **LOW-004** — `backend/main.py` (`_access_log`, 303; `_tenant_context`, 78–106): stash org on `request.state`. **Validation:** access-log rows carry the real `org_id`, not `system`.
- [ ] **LOW-005** — `backend/shared_state.py` (67–72/88/134/148): prefix live-trace keys with `{org_id}:`. **Validation:** a cross-org key-collision test passes.
- [ ] **LOW-006** — `backend/main.py` (2087–2095): savepoint + generic 409 on cross-org name collision. **Validation:** the response no longer reveals other-org existence.
- [ ] **LOW-007** — `backend/vault.py` (88–151): bind AAD = `table:col:org:row`. **Validation:** a relocated ciphertext fails to decrypt.
- [ ] **LOW-008** — `backend/vault.py` (55–93): implement `KmsMasterKey`; mount the secret. **Validation:** the vault operates against a KMS provider in a staging test.
- [ ] **LOW-009** — `docker-compose.yml` (13–37): bind `127.0.0.1`; Postgres password; Redis `--requirepass`. **Validation:** default compose exposes no open Postgres/Redis on `0.0.0.0`.
- [ ] **LOW-010** — `.github/actions/scan/README.md` (28): recommend a tag/SHA, not `@dev`. **Validation:** docs show a pinned reference.
- [ ] **LOW-011** — `sdk/pyproject.toml` (6): hold/verify the `arceo` PyPI name; consider a namespaced dist. **Validation:** the name is confirmed owned.
- [ ] **LOW-012** — `backend/approvals.py` (27–55): header allowlist + encrypt `headers_json`. **Validation:** stored headers contain no raw `Cookie`/secret.
- [ ] **LOW-013** — `backend/main.py` (616–648/688): require a key on the proxy in multi-tenant; scope keyless captures. **Validation:** default-org admin cannot read another tenant's keyless capture. *(Overlaps HIGH-001.)*
- [ ] **LOW-014** — `backend/main.py` (99–100/323–326): emit `AUTHZ_DENIED` on 403; warn on middleware auth throw. **Validation:** a 403 produces an audit row.
- [ ] **LOW-015** — `backend/jobs/snapshot_forecasts.py` (64–125): per-org `current_org` + short txn per org. **Validation:** snapshot job holds no long `system`-context transaction.
- [ ] **LOW-016** — `backend/main.py` (4925–4966): acquire the WS slot inside `try`, release in `finally`. **Validation:** a failed handshake leaks no slot.
- [ ] **LOW-017** — `backend/sandbox/mocks/registry.py` (57–68): `deepcopy` on assign or delete the dead `tenant_id` path. **Validation:** no shared-reference aliasing if the path is enabled. *(Dead code — see `Dead_Code_Report.md`.)*

**Phase 4 gate:** all Low items are tracked in the backlog with an owner; CI guards are added where a fix is testable (Pydantic caps, Redis key prefixing, AAD binding) so none regresses silently.

## Changelog

| Date | Author | Description |
|---|---|---|
| 2026-07-28 | Arceo Engineering — Internal Security Review | Initial four-phase remediation plan for the backend security audit (`dev @ 076f0b0`). |
