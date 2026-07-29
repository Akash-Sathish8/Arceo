# Low-Severity Vulnerabilities

| Field | Value |
|---|---|
| Document | Low-Severity Vulnerabilities |
| Project | Arceo — Backend Security Audit |
| Audit date | 2026-07-28 |
| Auditor | Arceo Engineering — Internal Security Review |
| Scope | `backend/` (FastAPI service, Python 3.11) + operational scripts (`scripts/`) + `docker-compose.yml`, `sdk/` |
| Source | `dev`, verified at commit `076f0b0` |
| Classification | Internal / Confidential |
| Findings (this tier) | 17 |

Low-severity findings are hygiene and defense-in-depth items that do not independently enable exploitation but mark places where a control is missing, conditional on an invariant, or stored/logged more permissively than necessary. Several are safe today only because of a structural invariant — globally-unique ids, single-tenant deployment, or a dead code path — that a future change could invalidate; they are cheap to fix now and expensive to rediscover later. Address them during regular development. None blocks release.

## LOW-001: API-key `scopes` are stored but never enforced — every key is full-access

**File**: `backend/main.py`
**Lines**: 6546-6557
**OWASP Category**: A01:2021 - Broken Access Control
**CWE**: CWE-1220: Insufficient Granularity of Access Control

### Description
`verify_api_key` (`backend/main.py:6546-6557`) authenticates an `X-API-Key` by SHA-256-hashing it and selecting the matching row with `active = 1`. It returns the full row — which includes the `scopes` column — but never inspects `scopes`. Every call site that authenticates a key treats a valid key as fully authorized: `verify_api_key` is consumed at `main.py:286, 345, 623, 842, 968, 1051, 2675, …` and none of them reads `row["scopes"]` or gates behavior on it.

The `scopes` column is real — `alembic/versions/0001_baseline.py:188` defines `sa.Column("scopes", sa.Text, server_default='["enforce","register","report"]')` — and it is populated with a full default on every insert. But `CreateApiKeyRequest` (`main.py:6560`) accepts only `name` and `agent_id`, so there is no field through which an operator could mint a narrower key in the first place. The result is that a key intended to be least-privilege (for example, a scan-only key handed to a CI runner) cannot be expressed, and even the default scope set that *is* stored is never checked at authentication time.

Risk is Low because possession of any valid key already implies the org issued it to a trusted holder; the weakness is that the product presents a capability — scoped, least-privilege keys — that does not actually exist, so a key leaked from a low-trust context is as powerful as an admin-minted one.

### Impact
- **Privilege Escalation**: a key leaked from a low-trust integration (a CI runner meant only to call `/api/scan`) can invoke every key-authenticated endpoint — enforce, self-register agents, post reports — because no per-endpoint scope check exists.
- **Defense-in-Depth Gap**: the `scopes` column and its default advertise a least-privilege control that the authentication path never applies, so operators may rely on a boundary that is inert.
- **Information Disclosure**: a scan-only integration key can reach the full key-authenticated surface of its org, beyond the read-only CI role it was issued for.
- **Compliance Violation**: SOC2 CC6.1/CC6.3 least-privilege expectations are undermined by an authorization attribute that is persisted but never evaluated.

### Remediation Guidance
- In `verify_api_key`, parse `row["scopes"]` (JSON) onto the returned dict and add a `require_scope(key_row, needed)` helper that 403s on a missing scope.
- Gate each key-authenticated endpoint on the scope it needs (`/api/scan` → `scan`, `/api/enforce` → `enforce`, the register path → `register`, reporting → `report`).
- Add a validated `scopes: list[str]` field to `CreateApiKeyRequest` (`main.py:6560`) with an allow-list and persist it in the `INSERT` inside `create_api_key`.
- If scoped keys will not ship this cycle, drop the `scopes` column in a follow-up migration rather than leave a false capability in the schema.
- Verification: extend `test_rate_limit_and_scoping.py` with a key minted for `["scan"]` and assert it receives 403 on `/api/enforce` while an `["enforce"]` key succeeds.

---

## LOW-002: Auth, sim, MCP, and ingest request models lack `Field` length/count constraints

**File**: `backend/main.py`
**Lines**: 1339-1347, 3003-3007, 3990-3994, 4225-4230, 4693-4695, 6560-6562
**OWASP Category**: A04:2021 - Insecure Design
**CWE**: CWE-20: Improper Input Validation

### Description
Several request models that accept externally controlled input declare bare `str` and `list` fields with no Pydantic `Field(max_length=...)` bound. `LoginRequest`/`SignupRequest` (`main.py:1339-1347`) take unbounded `email`/`password`/`name`; `MCPConnectInput` (`3003`) takes unbounded `url`/`agent_name`/`auth_token`; `SimulateRequest` (`3990`) and `MultiSimulateRequest` (`4225`) take an unbounded `custom_prompt`, and `MultiSimulateRequest.agent_ids` is an uncapped `list[str]`; `LangSmithIngest` (`4693`) takes an uncapped `runs: list[dict]` (its neighbor `LangFuseIngest` mirrors this with `traces`); and `CreateApiKeyRequest` (`6560`) takes an unbounded `name`.

The invariant that keeps this safe today is coarse: a global `_body_size_guard` middleware (`main.py:185-198`) rejects any request whose `Content-Length` exceeds `MAX_BODY_BYTES` (12 MiB by default, `main.py:178`), and one model — `MCPImportInput.mcp_tools` (`main.py:3000`) — already carries `Field(max_length=1000)`. That 12 MiB whole-body ceiling is a backstop, not a per-field or per-item bound. Within it, a caller can still send a multi-megabyte `custom_prompt` that flows straight into LLM token cost, or a list with tens of thousands of small items where each item drives downstream work — one risk classification per tool, one dispatched sub-agent per `agent_ids` entry.

Risk is Low because the body ceiling caps absolute size and most of these endpoints are authenticated; the gap is amplification and cost *within* that ceiling, compounded by the inconsistency that the same list-cap pattern was applied to one model and not to its neighbors. `Field` is already imported (`main.py:22`), so this is a tightening, not a new dependency.

### Impact
- **Denial of Service**: an oversized `custom_prompt` that fits under the 12 MiB cap is forwarded to the LLM runner, inflating latency, token spend, and per-request memory.
- **Denial of Service**: an uncapped `runs`/`agent_ids` list amplifies a single request into many downstream units of work (per-item classification, per-agent dispatch) disproportionate to the request's byte size.
- **Defense-in-Depth Gap**: per-field bounds are the natural early-rejection layer; their absence leaves the 12 MiB body ceiling as the only guard, even though `MCPImportInput` already demonstrates the intended pattern.
- **Information Disclosure**: unbounded free-text fields widen the surface for oversized values to land in logs, error responses, or storage at unexpected sizes.

### Remediation Guidance
- Add `Field(max_length=...)` to the string fields on the named models (email/name/url tight, e.g. 320/1024; `custom_prompt` sized to the LLM token budget), reusing the already-imported `Field`.
- Add item-count caps to the list fields — `agent_ids`, `runs`, `traces` — mirroring the existing `MCPImportInput.mcp_tools = Field(max_length=1000)`.
- Size any field that feeds an LLM (`custom_prompt`) to a token budget rather than a byte count.
- Keep `_body_size_guard` as the coarse backstop; the field bounds are the per-semantics layer beneath it.
- Verification: add a test that POSTs an over-limit `custom_prompt` and an over-count `runs` list and asserts a 422 from model validation (a rejects-oversized test).

### Affected Locations

| # | File | Line(s) | Notes |
|---|---|---|---|
| 1 | `backend/main.py` | 1339-1347 | `LoginRequest` / `SignupRequest` — unbounded `email`/`password`/`name` |
| 2 | `backend/main.py` | 3003-3007 | `MCPConnectInput` — unbounded `url`/`agent_name`/`auth_token` |
| 3 | `backend/main.py` | 3990-3994 | `SimulateRequest` — unbounded `custom_prompt` (feeds the LLM) |
| 4 | `backend/main.py` | 4225-4230 | `MultiSimulateRequest` — unbounded `custom_prompt` + uncapped `agent_ids` list |
| 5 | `backend/main.py` | 4693-4695 | `LangSmithIngest` — uncapped `runs` list (`LangFuseIngest` at 4698 mirrors it) |
| 6 | `backend/main.py` | 6560-6562 | `CreateApiKeyRequest` — unbounded `name` |

---

## LOW-003: Seed-admin bootstrap password is logged in cleartext at WARNING on first boot

**File**: `backend/db.py`
**Lines**: 143-148
**OWASP Category**: A09:2021 - Security Logging and Monitoring Failures
**CWE**: CWE-532: Insertion of Sensitive Information into Log File

### Description
`_seed_demo_user` (`backend/db.py:126-148`) seeds the initial `admin@actiongate.io` account when the `users` table is empty. Outside DEMO_MODE it correctly avoids the well-known demo password and generates a random one-time secret with `secrets.token_urlsafe(16)`. It then logs that plaintext secret at WARNING (`db.py:143-148`): `logging.getLogger("actiongate.db").warning("Seeded initial admin 'admin@actiongate.io' with a RANDOM one-time password: %s …", password)`.

The intent is operator convenience — surface the one-time credential so a fresh production DB is reachable — and the DEMO_MODE branch is handled sensibly. The effect, however, is that the initial admin credential is written into the application log stream, the same sink the product routes to a platform log pipeline for its SOC2 access-log control. Anyone with log-read access (aggregators, shared dashboards, retained log files) obtains a working admin password for the default org until it is changed.

Risk is Low because it is a one-time bootstrap password that is expected to be rotated on first login and the exposure window is bootstrap-only; the weakness is that nothing forces that rotation and the secret is durable in whatever retains the logs.

### Impact
- **Credential Exposure**: the initial admin password is written verbatim to the log stream, readable by anyone with log access without touching the database.
- **Privilege Escalation**: that credential is for the `admin` role in the default org — full org control if the log line is read before the password is changed.
- **Compliance Violation**: writing a live credential to logs contradicts the "no bodies or PII in logs" posture the security design claims for the privileged-action log.
- **Defense-in-Depth Gap**: there is no forced reset on first login, so the logged secret can remain valid indefinitely rather than being a true one-time value.

### Remediation Guidance
- Stop logging the password value; log only that an admin was seeded and how to set or rotate its password.
- Source the bootstrap password from an operator-supplied secret (for example `ARCEO_BOOTSTRAP_ADMIN_PASSWORD`), or write it to a `0600` file owned by the service user instead of the shared log stream.
- Set a `must_change_password` flag on the seeded user and force a reset at first login so the bootstrap credential cannot persist.
- Verification: boot a non-DEMO_MODE DB under a `caplog` fixture and assert no emitted log record contains the generated password string.

---

## LOW-004: `_access_log` reads the org contextvar after `_tenant_context` has reset it — every event logs `org_id:"system"`

**File**: `backend/main.py`
**Lines**: 303 (read site); 78-106 (`_tenant_context` set/reset), 273-309 (`_access_log`)
**OWASP Category**: A09:2021 - Security Logging and Monitoring Failures
**CWE**: CWE-778: Insufficient Logging

### Description
`_access_log` (`backend/main.py:273-309`) emits one JSON privileged-action line per mutating or admin API call, including `"org_id": _db.current_org.get()` at `main.py:303`. That org is supposed to be supplied by `_tenant_context` (`main.py:78-106`), which resolves the caller's org from the API key or JWT, sets it with `_db.current_org.set(org)` (line 102), and resets it in a `finally` block (line 106).

The two middlewares are registered as decorators in source order, and Starlette wraps each newly added middleware as a new outer layer. `_tenant_context` is defined first (line 78), so it is the innermost layer; `_access_log` is defined last (line 274), so it is the outermost. `_access_log` therefore reads `current_org` only after `await call_next(request)` has fully unwound the inner stack — including `_tenant_context`'s `finally: reset(token)`. By that point the contextvar is back at its module default `"system"` (`db.py:68`), so every privileged event is logged with `org_id: "system"` instead of the acting tenant. (Independently, `BaseHTTPMiddleware` runs the downstream stack in a copied context, so an inner contextvar mutation would not surface to the outer middleware in any case.)

Risk is Low because this is a logging-fidelity defect, not an access-control defect — RLS and the app-level `org_id` filters are unaffected. But this access log is the SOC2 CC7.1/CC7.2 monitoring control, and per-tenant attribution is exactly what an incident responder needs; a literal `"system"` on every line erases it.

### Impact
- **Compliance Violation**: the privileged-action access log — the claimed SOC2 logging control — records `org_id: "system"` for every event and so cannot attribute an action to a tenant.
- **Defense-in-Depth Gap**: incident response and anomaly detection lose per-org attribution on the one structured audit stream designed to provide it.
- **Cross-Tenant Access**: cross-tenant probing is harder to spot because it surfaces as generic `"system"` activity rather than as one org acting against another's resources.
- **Information Disclosure**: downstream consumers keyed on `org_id` may mis-route or bucket all events under `"system"`, obscuring which tenant generated them.

### Remediation Guidance
- In `_tenant_context`, after resolving `org`, stash it on the request object: `request.state.org = org` — an attribute on the shared request survives the inner `finally: reset`.
- In `_access_log`, read `getattr(request.state, "org", "system")` instead of `_db.current_org.get()`.
- Alternatively, resolve the org inside `_access_log` from the same API key / JWT it already parses to build `actor`, so the logged value does not depend on middleware ordering.
- Verification: extend `test_security_headers.py` (which already exercises `_access_log`) to assert the emitted JSON line carries the caller's real `org_id`, not `"system"`.

---

## LOW-005: Live-trace Redis keys carry no tenant prefix — isolation rests on a fragile global-uniqueness invariant

**File**: `backend/shared_state.py`
**Lines**: 67-72, 88, 134, 148
**OWASP Category**: A01:2021 - Broken Access Control
**CWE**: CWE-668: Exposure of Resource to Wrong Sphere

### Description
Live-trace state on Redis is keyed by agent id alone. `_trace_key` (`backend/shared_state.py:67-68`) returns `trace:list:{agent_id}` and `channel` (`71-72`) returns `trace:chan:{agent_id}`; `push_trace` LPUSHes to that list and publishes to that channel (line 88), and `drain_traces` (`91-99`) does a read-and-clear on the same list. The per-agent WebSocket connection counter is likewise `ws:conns:{agent_id}` (`ws_acquire_slot`, line 134; `ws_release_slot`, line 148). No `org_id` appears in any of these key names.

Cross-tenant isolation of live traces therefore does not live in the key space itself — it holds only because `agents.id` is a global primary key (the code relies on this exact invariant elsewhere, e.g. the "agents.id is a global PK" comment at `main.py:2090`), so two orgs never share an agent id and their trace lists never collide. That invariant is load-bearing: the moment any key here is derived from a non-globally-unique value (a name, a per-org counter), or an attacker learns another org's agent id (the unauthenticated register path already discloses cross-org id existence — see LOW-006), `drain_traces` would read-and-clear another tenant's live buffer with no structural guard. The Redis layer has no `org_id` binding; the only tenant boundary is the app-layer org check on the HTTP endpoints that call these functions.

Risk is Low because the global-PK invariant currently holds and the endpoints add an app-layer org check; the weakness is that tenant isolation for this data rests on an invariant plus an app-layer check rather than on the store's own namespace.

### Impact
- **Cross-Tenant Access**: if an agent id is guessed or leaked, or a future key is derived from a non-unique value, `push_trace`/`drain_traces` operate on another org's live-trace buffer with no key-level tenant boundary.
- **Defense-in-Depth Gap**: isolation depends on the global uniqueness of `agents.id` plus app-layer checks, not on the Redis namespace — a single fragile point rather than a structural one.
- **Information Disclosure**: live traces can carry action parameters; a cross-agent key collision would expose one tenant's runtime activity to another.
- **Compliance Violation**: CC6.1 tenant isolation is not structurally enforced for this data path, unlike the RLS-backed database tables.

### Remediation Guidance
- Namespace every key in this module with the org: `trace:list:{org_id}:{agent_id}`, `trace:chan:{org_id}:{agent_id}`, `ws:conns:{org_id}:{agent_id}`, threading `org_id` (the request's resolved org) through `push_trace`/`drain_traces`/`ws_acquire_slot`/`ws_release_slot`.
- Apply the same prefix convention to the rate-limit (`rl:`), leader (`leader:`), and fire-once (`once:`) keys wherever the subject is tenant-scoped, so the namespace rule is uniform.
- Keep the app-layer org check on `/api/traces/live/{agent_id}` as a second layer rather than the only one.
- Verification: add a test alongside `test_rls_enforcement.py` in which two orgs push traces for distinct agents and assert the Redis keyspaces are disjoint and draining one org's agent never returns the other's entries (a cross-org key-collision test).

---

## LOW-006: Register/ingest discloses "name taken in another workspace" — a cross-org name-enumeration oracle

**File**: `backend/main.py`
**Lines**: 2087-2095
**OWASP Category**: A01:2021 - Broken Access Control
**CWE**: CWE-204: Observable Response Discrepancy

### Description
`_upsert_agent` (`backend/main.py:2064`) first checks for an existing agent scoped to the caller's org — `SELECT id FROM agents WHERE id = %s AND org_id = %s` (line 2087). When that finds nothing, it runs an unscoped probe `SELECT 1 FROM agents WHERE id = %s` (line 2093) and, if a matching row exists in any org, raises `HTTPException(status_code=409, detail=f"An agent named '{agent_id}' already exists in another workspace. Pick a different name.")` (line 2095).

The unscoped probe has a benign purpose — `agents.id` is a global primary key, so an INSERT colliding with another org's id would raise a 500 and abort the transaction, and the code wants a clean 409 instead. But the 409 message discloses that a given id exists in another tenant, turning the endpoint into a cross-org existence oracle. `_upsert_agent` is reached from the unauthenticated `/api/authority/agents/register` path (`register_agent`, `main.py:2153-2154`, calling `_upsert_agent` at line 2177) as well as the authenticated import/connect paths (`3135, 3184, 3242`), so even an unauthenticated caller can probe whether an id or name is taken anywhere in the system.

Risk is Low because the response confirms only the existence of an id — not its owner, contents, or configuration — and ids are not always guessable; the weakness is the confirmation channel itself, crossing a tenant boundary.

### Impact
- **Information Disclosure**: the 409 body confirms that a specific agent id/name exists in another organization — a cross-tenant existence oracle reachable without authentication.
- **Cross-Tenant Access**: a confirmed id can be fed to other agent-id-addressed surfaces (e.g. the live-trace keys in LOW-005) that assume ids are private to a tenant.
- **Defense-in-Depth Gap**: an unauthenticated endpoint distinguishes "free" from "taken elsewhere," leaking a signal a tenant boundary should hide.
- **Compliance Violation**: cross-tenant non-disclosure (CC6.1) is weakened by an observable response discrepancy between the same-org and cross-org cases.

### Remediation Guidance
- Wrap the INSERT in a SAVEPOINT and catch the unique-violation, returning a generic 409 ("That name is unavailable") that does not reveal whether the collision is same-org or cross-org.
- Alternatively, auto-suffix the id/name to a per-org-unique value so registration always succeeds without exposing global state.
- Make the same-org and cross-org failure responses byte-for-byte identical so the two cases are indistinguishable to the caller.
- Keep the org-scoped existence check (line 2087) for the legitimate "update my own agent" path.
- Verification: extend `test_cross_org_matrix.py` to assert that registering an id owned by another org returns a response identical to a generic conflict, with no "another workspace" text.

---

## LOW-007: AES-GCM envelope uses no Associated Data — ciphertext blobs are structurally relocatable across rows/tenants

**File**: `backend/vault.py`
**Lines**: 88, 93, 107, 116, 138, 151
**OWASP Category**: A02:2021 - Cryptographic Failures
**CWE**: CWE-345: Insufficient Verification of Data Authenticity

### Description
Every AES-256-GCM operation in the vault passes `None` as the associated-data argument: the DEK wrap/unwrap in `EnvMasterKey.wrap`/`unwrap` (`backend/vault.py:88, 93`), the credential encrypt/decrypt in `encrypt_credential`/`decrypt_credential` (`107, 116`), and the generic column encrypt/decrypt in `encrypt_value`/`decrypt_value` (`138, 151`). GCM still authenticates the ciphertext against tampering, but with no AAD the authentication says nothing about *where* the blob belongs.

Consequently a stored `encrypted_config`/`wrapped_dek` pair, or an `encrypt_value` blob (for example `execution_log.params` or `pending_requests.body`), is structurally relocatable. An actor who can already write the database can copy a ciphertext from one row to another — a different tenant's `provider_credentials` row, or a different `execution_log` row — and it will decrypt cleanly under the shared master key, because nothing binds the blob to its `(table, column, org_id, row_id)`. The design acknowledges this: the vault intentionally binds nothing cross-row today.

Risk is Low and pre-conditioned on database-write access (an attacker who can write arbitrary rows already holds significant capability), and RLS plus `org_id` filtering remain the primary tenant guard. AAD is the cryptographic backstop that would make a relocated blob fail closed rather than decrypt silently.

### Impact
- **Cross-Tenant Access**: with DB-write access, a ciphertext blob relocated onto another org's row decrypts successfully, since no AAD binds it to a tenant or row.
- **Defense-in-Depth Gap**: GCM authenticates content but not context, so the envelope cannot detect a valid-but-misplaced blob.
- **Credential Exposure**: a vaulted secret moved onto an attacker-controlled row could be injected by the proxy on that row's calls, repurposing another tenant's credential.
- **Compliance Violation**: data-authenticity expectations — that a stored secret belongs to the row it sits in — are not cryptographically enforced.

### Remediation Guidance
- Derive a per-blob AAD string `table:column:org_id:row_id` and pass it as the `associated_data` argument in both `encrypt_value` and `decrypt_value` (and the credential and DEK-wrap paths wherever a stable binding is available).
- Thread the binding context (org id, row id, column identity) into the `vault.encrypt_value`/`decrypt_value` call sites via the `backend/encryption.py` split/read seam so callers supply it uniformly.
- Version the blob format so existing no-AAD blobs stay readable during migration while new writes are bound; perform the rebind in the same pass as `scripts/rotate_vault_master_key.py`.
- Verification: extend `test_encrypt_at_rest.py` with a test that a blob encrypted for one `(org_id, row_id)` raises `InvalidTag` when decrypted under a different binding (a relocated-blob test).

---

## LOW-008: Vault master key lives in a plain environment variable; the KMS seam exists but is unwired

**File**: `backend/vault.py`
**Lines**: 55-93
**OWASP Category**: A02:2021 - Cryptographic Failures
**CWE**: CWE-522: Insufficiently Protected Credentials

### Description
The vault's master key is read from the `ARCEO_VAULT_MASTER_KEY` environment variable by `EnvMasterKey` (`backend/vault.py:55-93`): `_key()` base64-decodes the env var and validates it is exactly 32 bytes, and `wrap`/`unwrap` (lines 86-93) use it directly with AES-256-GCM. The `MasterKeyProvider` interface (`vault.py:44-52`) is the documented KMS seam — a cloud-KMS provider implementing the same `wrap()`/`unwrap()` would keep the key out of process memory — but no such provider exists in the tree; `_default_provider = EnvMasterKey()` (`vault.py:96`) is the only implementation.

This is the interim custody model the design explicitly declares, not an oversight. `docs/SECURITY_DESIGN.md` "Open items for the reviewer" item 1 asks whether env-var custody is acceptable for the pilot, and its "Honest gaps" section repeats that the KMS/HSM seam exists but is not wired to a provider. The residual risk is the documented one: on a fully compromised host, environment access and DB access usually co-occur, and together they yield every vaulted secret. Passing the key via `-e` on a `docker run`/compose command additionally exposes it to process listings and container inspection.

Needs Verification / accepted-interim: the code matches the documented design exactly, so this entry records the residual risk and the migration path rather than a deviation. It should be tracked as an accepted interim posture with a wiring task, not filed as a code defect.

### Impact
- **Credential Exposure**: any path that can read the service environment — a process listing, `docker inspect`, a heap/crash dump, an SSRF-to-metadata on a misconfigured host — yields the master key that unwraps every DEK.
- **Cross-Tenant Access**: the master key together with a DB dump decrypts every org's vaulted secrets at once (the documented residual risk of env-var custody).
- **Defense-in-Depth Gap**: the key resides in process memory for the process lifetime with no HSM/KMS boundary, so compromise of the process is compromise of the key.
- **Compliance Violation**: enterprise key-custody expectations (managed KMS/HSM, no plaintext key material resident on the host) are not met by env-var custody.

### Remediation Guidance
- Implement a `KmsMasterKey(MasterKeyProvider)` that performs `wrap`/`unwrap` via the cloud KMS API without materializing the key in process memory, and select it by config so `_default_provider` can be KMS in production.
- Until then, inject `ARCEO_VAULT_MASTER_KEY` from the platform secret store as a mounted secret or secret env, never as a `-e` flag on the command line, and keep it out of shell history and compose files.
- Restrict who can read the service environment and container metadata; scope the KMS key policy to the service identity alone.
- Keep master-key rotation (`scripts/rotate_vault_master_key.py`) working against whichever provider is active.
- Verification: add a test in which a `KmsMasterKey` (or a fake implementing the same seam) round-trips `wrap`/`unwrap` through `encrypt_value`/`decrypt_value` identically to `EnvMasterKey`, proving the provider is swappable behind `MasterKeyProvider`.

---

## LOW-009: `docker-compose.yml` ships default Postgres credentials and an unauthenticated Redis, published on `0.0.0.0`

**File**: `docker-compose.yml`
**Lines**: 13-37
**OWASP Category**: A05:2021 - Security Misconfiguration
**CWE**: CWE-1188: Insecure Default Initialization of Resource

### Description
The development compose file brings up Postgres with `POSTGRES_USER: postgres` / `POSTGRES_PASSWORD: postgres` (`docker-compose.yml:17-20`) and Redis with no authentication at all — the `redis` service (`29-37`) sets no `--requirepass`. Both publish ports with the short mapping `"5432:5432"` (line 16) and `"6379:6379"` (line 32), which Docker binds on `0.0.0.0` — every host interface — rather than loopback.

The file's own header states it is "Local Postgres + Redis for development and tests," and the customer-facing artifact is the root `Dockerfile`, not this compose file, so this insecure topology is not shipped to customers as a production deployment. The weakness is that default credentials plus an unauthenticated Redis, published on all interfaces, are trivially reachable by anything that can route to the host: on a developer laptop on an untrusted network, or if this file is ever copied toward a shared/staging host, the database and cache are wide open. An unauthenticated, network-reachable Redis in particular is a well-worn path to host compromise.

Risk is Low because the intended use is local dev/CI on loopback-equivalent networks and this is not the production artifact; the weakness is the insecure default itself (all-interfaces bind, absent/guessable credentials) and the ease of promoting a dev file into a less-trusted environment unchanged.

### Impact
- **Cross-Tenant Access**: an exposed Postgres with `postgres/postgres` grants full read/write to every org's rows and, as a superuser, bypasses the FORCED RLS that is the tenant backstop.
- **Information Disclosure**: an unauthenticated Redis on `0.0.0.0` exposes live traces, rate-limit state, and cached data to anyone who can reach port 6379.
- **Privilege Escalation**: an open Redis is a common vector for host takeover (arbitrary file writes / module abuse), and the `postgres` superuser role is unrestricted.
- **Defense-in-Depth Gap**: shipping insecure defaults invites a dev-to-staging copy that silently carries `0.0.0.0` binds and default credentials into a less-trusted network.

### Remediation Guidance
- Bind published ports to loopback — `"127.0.0.1:5432:5432"` and `"127.0.0.1:6379:6379"` — so neither service is reachable off-host.
- Source the Postgres password from an env var / `.env` (for example `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set me}`) instead of the literal `postgres`.
- Set Redis `--requirepass` (via `command:` or a mounted config) and point `REDIS_URL` at the authenticated instance.
- Keep this file clearly scoped to dev/CI and document that production runs the root `Dockerfile` against managed Postgres/Redis, not this compose.
- Verification: after the change, confirm `redis-cli -h 127.0.0.1 ping` returns `NOAUTH Authentication required` and that ports 5432/6379 are not reachable from another host on the network.


---

## LOW-010: Scan action documented with a mutable `@dev` branch pin

**File**: `.github/actions/scan/README.md`
**Lines**: 28
**OWASP Category**: A08:2021 - Software and Data Integrity Failures
**CWE**: CWE-829: Inclusion of Functionality from Untrusted Control Sphere

### Description
The "Quick start" workflow in the scan action's README tells customers to reference the composite action as `uses: Akash-Sathish8/Arceo/.github/actions/scan@dev` (line 28). `@dev` is a mutable Git branch ref, not an immutable release tag or commit SHA. GitHub resolves a branch ref at workflow-run time to whatever commit the branch currently points at, so every customer CI run silently executes whatever code sits on `Akash-Sathish8/Arceo`'s `dev` HEAD at that moment. Because `dev` is the branch where all active work lands, an ordinary in-progress commit, a force-push, or a compromised maintainer account changes what runs inside the customer's `pull_request`/`push` workflow — including the `run.py` runtime, which reads the `ARCEO_API_KEY` repository secret and is granted `pull-requests: write`.

This is a supply-chain hygiene gap rather than an active vulnerability: it is safe today only so long as `dev` HEAD stays trustworthy and is never force-pushed to a hostile state. GitHub's own hardening guidance for third-party actions is to pin to a full commit SHA precisely because branches and tags are mutable, so a customer following this README inherits a weaker posture than the platform recommends.

### Impact
- **Supply-Chain Compromise**: A malicious or accidental change to `Arceo@dev` executes in every customer pipeline on its next run with no version bump or review on the customer side (conditional on the branch being altered).
- **Credential Exposure**: The action runs with the customer's `ARCEO_API_KEY` secret and `github-token` in scope; altered `dev` code could exfiltrate either.
- **Defense-in-Depth Gap**: A pinned SHA surfaces any upstream change as a reviewable diff in the customer repo; `@dev` removes that safeguard entirely.
- **Compliance Violation**: Recommending a mutable ref conflicts with SLSA and GitHub supply-chain-hardening expectations that enterprise customers' own audits enforce.

### Remediation Guidance
- Change the `uses:` line in the README Quick-start block (line 28) to pin a released, immutable tag, e.g. `Akash-Sathish8/Arceo/.github/actions/scan@v1`.
- For the strongest guarantee, document pinning to a full 40-character commit SHA (`...scan@<sha>`), per GitHub hardening guidance.
- Publish signed, semver release tags for the action so customers have a stable ref to pin, and update any first-party workflow that references the action to match.
- Add a note that `@dev` is for first-party dogfooding only, never customer use.
- Verification: run `grep -rn "scan@dev" .github/actions/scan/README.md` and confirm no customer-facing example resolves to a branch ref.

---

## LOW-011: SDK published under the squattable top-level PyPI name `arceo`

**File**: `sdk/pyproject.toml`
**Lines**: 6
**OWASP Category**: A08:2021 - Software and Data Integrity Failures
**CWE**: CWE-829: Inclusion of Functionality from Untrusted Control Sphere

### Description
The SDK's packaging metadata declares `name = "arceo"` (line 6) — a short, unqualified top-level distribution name on the public PyPI index. If Arceo has not registered and does not currently hold this name on PyPI (and on any private index its customers configure), the name is available for a third party to claim. The `description` and install flow position the package to "sit alongside your anthropic/openai client," so a customer who runs `pip install arceo` against an index where the name is attacker-held would pull attacker-controlled code into the same process that wraps LLM calls and, via `wrap_llm()`/the proxy, handles agent traffic and credentials.

This finding is Needs-Verification: exploitability depends entirely on whether the `arceo` name is presently registered and owned by Arceo, and on whether customers are directed to install from PyPI versus the GitHub source. The `dependencies = []` (stdlib-only) posture limits transitive risk but does nothing to secure ownership of the top-level name itself. The metadata also carries `license = { text = "Proprietary" }` and a GitHub `Homepage` (lines 11, 17), suggesting the package may not be intended for public PyPI distribution at all — which makes a purely defensive name hold cheap and low-risk.

### Impact
- **Supply-Chain Compromise**: If the name is unheld, an attacker can publish a malicious `arceo` distribution that installs into the process handling agent/LLM traffic (conditional on ownership status and install source).
- **Credential Exposure**: Malicious install-time or import-time code would run where `ANTHROPIC_API_KEY`, `ARCEO_API_KEY`, and captured request bodies are handled.
- **Defense-in-Depth Gap**: A single short, un-namespaced name leaves no secondary barrier against typo or confusion installs.
- **Compliance Violation**: Enterprise software-composition audits flag packages with unverifiable or unowned provenance.

### Remediation Guidance
- Verify current ownership: check `https://pypi.org/project/arceo/` and confirm the maintainer account is Arceo-controlled; repeat on TestPyPI.
- If the name is unheld, register and hold `arceo` defensively even when publishing from GitHub, to deny squatting.
- Consider shipping under a namespaced, less-squattable distribution name (e.g. `arceo-sdk`) and reserve common typo variants.
- Enable 2FA and a trusted-publisher (OIDC) release flow on the PyPI project so only CI can publish, and pin customers to an exact version plus hash in their lockfiles.
- Verification: run `pip index versions arceo` (or query `https://pypi.org/pypi/arceo/json`) and confirm the only published releases are Arceo's.

---

## LOW-012: Held-for-approval request headers stored cleartext with only two names redacted

**File**: `backend/approvals.py`
**Lines**: 27-31, 45-55
**OWASP Category**: A02:2021 - Cryptographic Failures
**CWE**: CWE-312: Cleartext Storage of Sensitive Information

### Description
When a policy returns `REQUIRE_APPROVAL`, `create_pending_proxy()` (approvals.py:38-56) parks the full proxy request so it can be replayed verbatim on approval. Before persisting, it redacts request headers through `_redact_headers()` (lines 30-31), which drops only the two names in `_REDACT_HEADERS = {"authorization", "x-api-key"}` (line 27); every other header survives and is serialized with `json.dumps(_redact_headers(headers or {}))` into the `headers_json` column (INSERT at lines 45-55). The module comment scopes redaction narrowly to the agent's own inbound credentials, on the rationale that the vault re-injects the real upstream secret at replay time — but that reasoning only covers those two header names. Secret material carried in other headers — `Cookie`/session tokens, `Proxy-Authorization`, or vendor secret headers such as `X-Api-Secret` and bearer-in-custom-header schemes — is stored verbatim.

Compounding this, `headers_json` is a plain `sa.Text` column in migration `0004_pending_requests` (line 47) and is not wired through the encryption-at-rest seam. The same module encrypts the request `body` and `params_json` via `encryption.split()` into `body_enc`/`params_json_enc` (columns added by `0005_encrypt_at_rest`), but no `headers_json_enc` column exists anywhere in the migration history — so any secret left in a non-redacted header persists in cleartext even when encryption-at-rest is enabled.

This is Needs-Verification / conditional: it is a live exposure only if callers actually send secrets in non-allowlisted headers on approval-gated proxy requests. The `pending_requests` table is org-scoped and `FORCE ROW LEVEL SECURITY` is applied (migration 0004), so exposure is within-tenant — to any operator or code path that can read the org's pending queue — not cross-tenant.

### Impact
- **Credential Exposure**: `Cookie`, `Proxy-Authorization`, and vendor secret headers on a held proxy request persist in `pending_requests.headers_json` in cleartext (conditional on callers sending them).
- **Information Disclosure**: Anyone with read access to the org's pending queue can recover those header values directly from the database.
- **Compliance Violation**: Cleartext at-rest storage of session tokens and secrets undercuts the encryption-at-rest control that already protects the record's `body` and `params_json`.
- **Defense-in-Depth Gap**: A two-name denylist fails open for every header not on it, so a newly introduced sensitive header is captured by default.

### Remediation Guidance
- Replace the `_REDACT_HEADERS` denylist with an allowlist inside `_redact_headers()` — store only the headers replay actually needs (e.g. `content-type`, `accept`, idempotency markers) and drop everything else by default.
- Add a `headers_json_enc` column via a new Alembic migration and route `headers_json` through `encryption.split()`/`encryption.read()` exactly as `body` and `params_json` are handled, so the stored blob is encrypted at rest.
- Confirm the replay path (`create_pending_proxy` consumers) reads headers through the same seam and re-injects the vault credential, so tightening to an allowlist does not break replay.
- Purge or re-encrypt existing `pending_requests` rows if the queue may already hold cleartext secrets.
- Verification: extend `backend/tests/test_pending_requests.py` (or `test_replay_on_approve.py`) with a case that parks a proxy request carrying `Cookie` and `X-Api-Secret` and asserts neither value appears in stored `headers_json`, and that the column is ciphertext when at-rest encryption is on.

### Affected Locations

| # | File | Line(s) | Notes |
|---|---|---|---|
| 1 | `backend/approvals.py` | 27, 30-31 | `_REDACT_HEADERS` denylist + `_redact_headers()` drop only two names |
| 2 | `backend/approvals.py` | 45-55 | INSERT stores `_redact_headers(...)` into `headers_json` |
| 3 | `backend/alembic/versions/0004_pending_requests.py` | 47 | `headers_json` is plain `sa.Text`; no `_enc` counterpart exists |

---

## LOW-013: Keyless proxy captures collapse into the default org, exposing them to the default-org admin

**File**: `backend/main.py`
**Lines**: 616-648, 688
**OWASP Category**: A01:2021 - Broken Access Control
**CWE**: CWE-359: Exposure of Private Information ('Privacy Violation')

### Description
The LLM proxy handler resolves the agent from the `X-Agent-ID` header (main.py:616-618) and derives the capture org at line 631: `proxy_org = key_info["org_id"] if key_info else DEFAULT_ORG_ID`. When no API key is presented — the default SDK `wrap_llm` flow, which sends only `X-Agent-ID` — `key_info` is falsy and `proxy_org` becomes `DEFAULT_ORG_ID` (`"default"`, db.py:36). The handler auto-creates the agent under that org (INSERT at 643-646 using `proxy_org`) and, once the upstream response completes, writes an `LLM_CALL_PROXY` audit row carrying the PII-redacted prompt/response via `log_audit(conn, None, agent_id, "LLM_CALL_PROXY", ...)` at line 688. That call omits `org_id`, so `log_audit` falls back through db.py:274-276 — `ctx = current_org.get(); org_id = ctx if ctx and ctx != "system" else DEFAULT_ORG_ID` — and because a keyless request leaves `current_org` at its `"system"` default (the `_tenant_context` middleware sets no tenant without a key or JWT), the audit row is filed under `"default"` as well.

The consequence is that every keyless capture from any real tenant that omits a key lands in the single `"default"` org — both the auto-created `agents` row and the `LLM_CALL_PROXY` audit rows. A `"default"`-org admin reading `/api/audit`, `/api/authority/agents`, or `/api/executions` (each RLS-scoped to their own org, which is `"default"`) therefore sees the captured activity of unrelated keyless callers. Captured detail is PII-redacted before storage (`redaction.redact_value` at line 681), so the exposure is of prompt/response metadata and structure — model, message/tool counts, latency, redacted response — rather than raw PII, but it is still one tenant's agent activity readable by another org's admin.

This finding OVERLAPS HIGH-001 (cross-tenant proxy credential use) and is not restated as its own High; refer to HIGH-001 for the credential/egress dimension. The Low angle here is narrowly the read exposure created by keyless captures collapsing into the default org. It is Needs-Verification / conditional: it matters only in a multi-tenant deployment that leaves the proxy keyless (`ARCEO_PROXY_REQUIRE_KEY` unset, per the MED-007 gate at lines 626-630) and where more than one tenant uses the keyless path.

### Impact
- **Cross-Tenant Access**: In a keyless multi-tenant deployment, one tenant's auto-created agent and captured LLM-call records become readable by the `"default"`-org admin (conditional on keyless use).
- **Information Disclosure**: Captured prompt/response metadata for foreign keyless callers is queryable through the default org's read endpoints.
- **Compliance Violation**: Tenant activity records commingled in a shared org break the per-tenant isolation the RLS design otherwise asserts.
- **Defense-in-Depth Gap**: Isolation of captures rests entirely on operators setting `ARCEO_PROXY_REQUIRE_KEY`; unset, keyless captures have no tenant separation.

### Remediation Guidance
- In any multi-tenant deployment, require a key on the proxy — document and default `ARCEO_PROXY_REQUIRE_KEY=true` (the gate at line 629) so keyless captures cannot land in a shared org.
- Scope keyless captures so they are not readable by the default-org admin — route them to a dedicated, non-tenant quarantine org that no customer admin can read, rather than `DEFAULT_ORG_ID`.
- Alternatively, refuse the capture (400/401) when no key is present and the deployment is multi-tenant, instead of silently attributing it to `"default"`.
- Remediate in lockstep with HIGH-001 so the credential-use and read-exposure angles of the keyless path close together.
- Verification: extend `backend/tests/test_cross_org_matrix.py` to assert that a keyless `POST /proxy/llm/...` capture is not returned by another org's `/api/audit` or `/api/authority/agents`, and that a default-org admin cannot read a foreign keyless capture.

### Affected Locations

| # | File | Line(s) | Notes |
|---|---|---|---|
| 1 | `backend/main.py` | 631 | `proxy_org = ... else DEFAULT_ORG_ID` — keyless falls to the default org |
| 2 | `backend/main.py` | 643-646 | Auto-creates the agent under `proxy_org` |
| 3 | `backend/main.py` | 688 | `LLM_CALL_PROXY` audit row written with no explicit `org_id` |
| 4 | `backend/db.py` | 274-276 | `log_audit` org fallback resolves keyless/`system` context to `DEFAULT_ORG_ID` |

---

## LOW-014: Authorization denials, sensitive reads, and silent auth-resolution failures are not logged

**File**: `backend/main.py`
**Lines**: 99-100, 273-309, 323-326
**OWASP Category**: A09:2021 - Security Logging and Monitoring Failures
**CWE**: CWE-778: Insufficient Logging

### Description
Three gaps in how the backend records authorization outcomes weaken the audit trail. First, `require_role()` (main.py:323-326) raises `HTTPException(status_code=403)` on a role failure without emitting any record — no `log_audit` row and no structured event — so denied privileged attempts leave no trace in the tamper-evident `audit_log`. Second, the `_access_log` middleware (273-309) treats a request as `privileged` only when its method is in `_MUTATING_METHODS` (POST/PUT/PATCH/DELETE) or its path starts with an admin prefix (lines 276-280); read endpoints (GET) — including data-bearing reads such as `/api/audit`, `/api/authority/agents`, and `/api/executions` — are never emitted, so there is no access record of who read what. Third, the `_tenant_context` middleware swallows any auth-resolution exception at lines 99-100 (`except Exception: org = "system"`): a malformed or expired token, or a `verify_api_key` failure, silently drops the request to the `"system"` org context with no warning logged.

Individually each is a monitoring gap rather than an access-control break — endpoint authorization is still enforced, and the `"system"` fallback is an RLS backstop that, per its own docstring, "never grants access." But together they mean denied authorizations, sensitive reads, and silent auth-resolution failures do not reliably reach the audit trail or the log pipeline, which undercuts incident detection and the SOC2 "structured privileged-action events" control the `_access_log` comment explicitly cites.

### Impact
- **Defense-in-Depth Gap**: 403s from `require_role` are absent from `audit_log`, so privilege-probing against admin surfaces leaves no tamper-evident trail.
- **Information Disclosure (undetected)**: Read access to `/api/audit`, `/api/executions`, and agent data is not captured by `_access_log`, so exfiltration-by-reading is not attributable after the fact.
- **Compliance Violation**: Missing denied-authorization and read events weaken the SOC2 structured-privileged-event control the middleware is meant to satisfy.
- **Defense-in-Depth Gap**: The swallowed exception at lines 99-100 hides token/API-key resolution failures (expired secrets, tampering) that operators would otherwise alert on.

### Remediation Guidance
- Emit an `AUTHZ_DENIED` audit event via `log_audit` inside `require_role()` before raising the 403, recording actor, required role, method, and path.
- Broaden the `_access_log` `privileged` predicate (or add a companion read-audit) to record sensitive GET reads — at minimum `/api/audit`, `/api/executions`, and `/api/authority/*` reads — as structured access events.
- Log a warning in the `_tenant_context` `except` (lines 99-100) when auth resolution throws, so silent fallbacks to `"system"` are observable; keep the existing fail-safe behavior.
- Ensure the new audit emission tolerates the request DB context so an audit-write failure cannot convert a 403 into a 500.
- Verification: add a test asserting that a viewer hitting an admin-only mutating route produces both a 403 and an `AUTHZ_DENIED` `audit_log` row, and that an invalid bearer token logs a warning rather than passing silently.

### Affected Locations

| # | File | Line(s) | Notes |
|---|---|---|---|
| 1 | `backend/main.py` | 323-326 | `require_role` raises 403 with no audit event |
| 2 | `backend/main.py` | 273-309 | `_access_log` logs only mutating/admin routes — GET reads are unlogged |
| 3 | `backend/main.py` | 99-100 | `_tenant_context` swallows the auth-resolution exception with no warning |

---

## LOW-015: Forecast-snapshot scheduler writes the whole fleet in one `'system'`-context transaction

**File**: `backend/jobs/snapshot_forecasts.py`
**Lines**: 64-125
**OWASP Category**: A04:2021 - Insecure Design (also A01:2021 - Broken Access Control)
**CWE**: CWE-402: Transmission of Private Resources into a New Sphere; CWE-772: Missing Release of Resource after Effective Lifetime

### Description
The nightly fleet snapshot runs as a single database transaction spanning every org. `snapshot_all_agents()` opens one `with get_db() as conn:` block (snapshot_forecasts.py:64) and, inside it, loads every agent across every org via `get_all_agents_from_db(conn)` (line 65), then loops (66-128) reading each agent's sandbox traces and live-call counts and inserting one `forecast_snapshots` row per agent. Because the job runs from the in-process scheduler daemon (`_snapshot_scheduler_loop`, main.py:469-505) outside any HTTP request, `current_org` is left at its module default `"system"` (db.py:68), and `get_db()` applies `SET LOCAL app.current_org = 'system'` (db.py:87). Under the RLS policy predicate a `'system'` context matches every row (RLS dormant), so this one long transaction reads and writes across all tenants with no per-org scoping.

An active cross-tenant leak was refuted in review — the loop keys every query by the agent's own `org_id` (e.g. `_load_sandbox_traces(conn, agent_id, org_id)` at line 82 filters `org_id = %s`, and each INSERT stamps the agent's `org_id`), so data is not currently mis-attributed. But that isolation rests entirely on hand-written per-agent `org_id` discipline rather than on RLS: any future query added to the loop that forgets its `org_id` filter would silently read or cross-file across tenants, because the transaction's `'system'` context offers no backstop. The pattern is also a long-lived single transaction — it holds one connection open across the entire fleet while performing per-agent forecast computation (`forecast_spend`), so a large fleet or a slow agent extends both the transaction and the connection hold; the `statement_timeout` and `lock_timeout` set in `get_db()` (db.py:91-92) bound individual statements, not the overall transaction.

### Impact
- **Defense-in-Depth Gap**: The fleet write runs with RLS dormant (`'system'` context), so per-tenant isolation depends solely on manual `org_id` filters rather than the database backstop the rest of the app relies on.
- **Data Integrity**: A single omitted `org_id` filter in the batch loop would mis-file or cross-read snapshots across tenants with no RLS to catch it (latent, not active today).
- **Denial of Service**: One long-running transaction holds a connection across the whole fleet; a large or slow fleet lengthens the hold and can contend for connection-pool resources.
- **Compliance Violation**: Processing all tenants' data in a single privileged, un-scoped transaction is harder to defend under tenant-isolation controls than a per-org scoped pass.

### Remediation Guidance
- Set `current_org` to each agent's org and open a short transaction per org (or per agent) so RLS is active and scopes each write, instead of one `'system'`-context batch.
- Snapshot org-by-org: enumerate orgs, then for each set the context, run a bounded transaction, and commit between orgs to release the connection.
- Keep the explicit `org_id` filters as belt-and-suspenders, but stop treating them as the only isolation mechanism.
- Preserve the per-day idempotency guard (lines 74-80) within the per-org transactions so re-runs stay safe.
- Verification: add a test alongside `backend/tests/test_rls_enforcement.py` that seeds two orgs, runs `snapshot_all_agents`, and asserts each org's `forecast_snapshots` contains only its own agents while the job executes under an active per-org (non-`'system'`) context.

### Affected Locations

| # | File | Line(s) | Notes |
|---|---|---|---|
| 1 | `backend/jobs/snapshot_forecasts.py` | 64 | Single `with get_db()` transaction wraps the whole-fleet loop |
| 2 | `backend/jobs/snapshot_forecasts.py` | 65-125 | Reads/writes every org's data in one `'system'`-context transaction |
| 3 | `backend/main.py` | 469-505 | `_snapshot_scheduler_loop` invokes the batch from a request-less daemon (no tenant context) |

---

## LOW-016: WebSocket concurrency slot acquired before the `try/finally`, leaking on a failed handshake

**File**: `backend/main.py`
**Lines**: 4925-4966
**OWASP Category**: A04:2021 - Insecure Design
**CWE**: CWE-772: Missing Release of Resource after Effective Lifetime

### Description
The live-trace WebSocket handler claims a per-agent concurrency slot at line 4925 — `if not shared_state.ws_acquire_slot(agent_id, WS_MAX_CONNECTIONS_PER_AGENT): ... return` (the MED-008 cap, default 5 per agent). `ws_acquire_slot` performs a Redis `INCR` on `ws:conns:{agent_id}` (shared_state.py:134-145). The matching release, `shared_state.ws_release_slot(agent_id)`, runs only in the `finally` of the `try` block that begins at line 4944. Between acquiring the slot (4925) and entering that `try` (4944) there are several `await` points that can raise: `websocket.accept()` (4928, the handshake itself), `shared_state.subscribe_channel(agent_id)` (4933), `pubsub.subscribe(...)` (4934), and `asyncio.create_task(_forward())` (4943). If any of these throws — a failed or aborted handshake, or a Redis pub/sub error — the exception propagates out of the handler before the `try`, so the `finally` never runs and the incremented slot is never decremented.

The counter self-heals only via the `_WS_CONN_TTL = 3600` safety expiry set on first `INCR` (shared_state.py:131, 140-141). So each failed handshake permanently consumes one of the agent's (default 5) slots for up to an hour. A client that reconnects and fails repeatedly — or a flapping network — can exhaust the per-agent slot budget, at which point `ws_acquire_slot` returns `False` and legitimate live-trace subscribers are refused with close code 4429 until the TTL lapses. The slot count is deliberately shared across workers (Redis `INCR`), which is exactly why a leaked increment is not cleaned up by process teardown.

### Impact
- **Denial of Service**: Repeated failed handshakes leak slots and can exhaust an agent's live-trace connection budget, blocking legitimate subscribers for up to the 1-hour TTL.
- **Defense-in-Depth Gap**: Resource release depends on control reaching the `try/finally`, which several pre-`try` `await`s can bypass.
- **Data Integrity (observability)**: A wedged slot count misrepresents true concurrency, undermining the cap's purpose and any capacity signal derived from it.
- **Denial of Service (amplified)**: Because the counter is shared across workers, one misbehaving client's leaks affect subscribers on every worker, not just its own.

### Remediation Guidance
- Acquire the slot inside a `try` and release it in `except`/`finally` so no code path between acquire and the main receive loop can leak it — restructure so the `accept`, `subscribe`, and task-creation failure paths all release the slot.
- Alternatively, wrap the acquire-through-setup span in its own `try/except` that calls `ws_release_slot` (and closes the socket) on any exception before the main loop starts.
- Keep `websocket.accept()` and the Redis subscribe calls within the guarded region, since the handshake is the most likely failure point.
- Retain the `_WS_CONN_TTL` backstop, but treat it as a last resort rather than the primary release path.
- Verification: add a test that forces `subscribe_channel` or `accept` to raise after `ws_acquire_slot` and asserts `ws:conns:{agent_id}` returns to its prior value with no leaked slot.

---

## LOW-017: `MockState(tenant_id=...)` would alias global fixture objects by reference (dead code today)

**File**: `backend/sandbox/mocks/registry.py`
**Lines**: 11-44, 64-68
**OWASP Category**: A01:2021 - Broken Access Control
**CWE**: CWE-488: Exposure of Data Element to Wrong Session

### Description
`MockState.__init__` accepts a `tenant_id` parameter (registry.py:57) and, when set, merges the module-global `TENANT_DATA` fixture into the run's state by reference (lines 64-68): `tenant = TENANT_DATA[tenant_id]; for key, val in tenant.items(): if key not in cd: cd[key] = val`. The values in `TENANT_DATA` (registry.py:11-44) are mutable dicts and lists (`customers`, `instances`, `hubspot_contacts`). Because the merge assigns `val` — the actual global object — into `cd`, and the field initializers then take it as-is (e.g. `self.customers = cd.get("customers") or {...}`), `self.customers` would become the same object as `TENANT_DATA[tenant_id]["customers"]`. Mock handlers mutate this state in place — `_template_delete` appends to `state.deleted_items`, `_template_send` appends to `state.emails_sent`, and stateful service mocks add and remove records — so a run built with a `tenant_id` would mutate the shared module-global fixture, and that mutation would bleed into every later (or concurrent) run reading the same tenant. That directly contradicts the class's stated contract that "Each simulation gets its own MockState so mocks are stateful within a run but isolated between runs."

This is dead code today and therefore not currently exploitable: no caller passes `tenant_id`. Every `MockState(...)` construction in the codebase supplies only `custom_data` (and sometimes `seed`) — `main.py:6375`, `main.py:6420`, `sandbox/runner.py:355` and `:534`, `sandbox/multi_runner.py:320` and `:357`, `sandbox/red_team.py:235`, and the tests — and a repo-wide search for `tenant_id=` finds no call site. The `if tenant_id and tenant_id in TENANT_DATA` branch never executes, so the aliasing never occurs. The risk is latent: it materializes only if the `tenant_id` path is wired up. This item also feeds the Dead Code report.

### Impact
- **Cross-Tenant Access (latent)**: If the `tenant_id` path were enabled, per-run mutations would write through to the shared `TENANT_DATA` global, leaking one simulation's mutated tenant data into others.
- **Data Integrity (latent)**: In-place mutation of a module-global fixture would corrupt the canonical `tenant-alpha`/`tenant-beta` test data for the process lifetime.
- **Defense-in-Depth Gap**: The class's own isolation contract is not upheld by the `tenant_id` merge, which shares references instead of copying.
- **Maintainability**: An unused, unsafe-if-enabled parameter is a latent trap for a future contributor who wires it in expecting per-run isolation.

### Remediation Guidance
- Since the path is unused, delete the `tenant_id` parameter and the `TENANT_DATA` merge (lines 64-68) unless there is a concrete plan to use it.
- If it must stay, `deepcopy` on assignment — `cd[key] = copy.deepcopy(val)` — so each run receives an independent copy of the tenant fixture.
- Apply the same copy discipline to the `custom_data` path if callers may share a dict across runs.
- Document the isolation invariant the class promises so a future caller does not reintroduce shared references.
- Verification: add a test that constructs two `MockState(tenant_id="tenant-alpha")` instances, mutates `customers` and `deleted_items` on the first, and asserts the second instance and `TENANT_DATA` are unchanged.


---

## References

- OWASP Top 10 (2021): [A01 Broken Access Control](https://owasp.org/Top10/A01_2021-Broken_Access_Control/) · [A02 Cryptographic Failures](https://owasp.org/Top10/A02_2021-Cryptographic_Failures/) · [A04 Insecure Design](https://owasp.org/Top10/A04_2021-Insecure_Design/) · [A05 Security Misconfiguration](https://owasp.org/Top10/A05_2021-Security_Misconfiguration/) · [A08 Software & Data Integrity Failures](https://owasp.org/Top10/A08_2021-Software_and_Data_Integrity_Failures/) · [A09 Security Logging & Monitoring Failures](https://owasp.org/Top10/A09_2021-Security_Logging_and_Monitoring_Failures/)
- CWE: [CWE-20](https://cwe.mitre.org/data/definitions/20.html) · [CWE-204](https://cwe.mitre.org/data/definitions/204.html) · [CWE-312](https://cwe.mitre.org/data/definitions/312.html) · [CWE-345](https://cwe.mitre.org/data/definitions/345.html) · [CWE-359](https://cwe.mitre.org/data/definitions/359.html) · [CWE-402](https://cwe.mitre.org/data/definitions/402.html) · [CWE-488](https://cwe.mitre.org/data/definitions/488.html) · [CWE-522](https://cwe.mitre.org/data/definitions/522.html) · [CWE-532](https://cwe.mitre.org/data/definitions/532.html) · [CWE-668](https://cwe.mitre.org/data/definitions/668.html) · [CWE-772](https://cwe.mitre.org/data/definitions/772.html) · [CWE-778](https://cwe.mitre.org/data/definitions/778.html) · [CWE-829](https://cwe.mitre.org/data/definitions/829.html) · [CWE-1188](https://cwe.mitre.org/data/definitions/1188.html) · [CWE-1220](https://cwe.mitre.org/data/definitions/1220.html) · 

## Changelog

| Date | Author | Description |
|---|---|---|
| 2026-07-28 | Arceo Engineering — Internal Security Review | Initial Low-severity findings from the backend security audit (`dev @ 076f0b0`). |
