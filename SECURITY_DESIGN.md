# Credential vault — security design

For external security review. **The vault PR does not merge until this design
is signed off.** Implementation: `backend/vault.py`, `backend/main.py`
(`/api/credentials` + the proxy strip-and-inject), Alembic
`0002_provider_credentials`, `scripts/rotate_vault_master_key.py`.

## What the vault is for

Arceo's proxy enforces policies on agent API calls. Before the vault, the
proxy forwarded the agent's own `Authorization` header upstream — so any agent
holding its own Stripe key could bypass Arceo entirely and the product's
"blocked" claims were only true for cooperating agents. With the vault, the
org's credential lives in Arceo; on an allowed call the proxy **strips the
agent-supplied `Authorization` and `X-API-Key` and injects the vaulted
secret**. The agent never holds a working upstream credential.
`ARCEO_REQUIRE_VAULT=on` completes the posture: no vaulted credential → the
call is blocked ("no credential, no call"). Default is off for rollout safety.

## Envelope scheme

- **Primitives:** AES-256-GCM throughout (authenticated encryption; tampering
  or a wrong key raises `InvalidTag` — always propagated, never swallowed).
  12-byte nonces from `os.urandom`, generated fresh for every encryption and
  stored prepended to their ciphertext. Nonce reuse cannot occur across
  rotations because rotation always generates a fresh DEK.
- **Per credential-set DEK:** each `PUT /api/credentials/{provider}` generates
  a fresh 256-bit DEK (`os.urandom(32)`), encrypts the config JSON
  (`{secret, subdomain?, instance?}`) under it, and wraps the DEK under the
  master key. Compromise of one DEK exposes exactly one credential-set
  version.
- **Storage** (`provider_credentials`): `encrypted_config` (nonce ‖
  ciphertext) and `wrapped_dek` (nonce ‖ wrapped key) as BYTEA; unique
  `(org_id, provider)`. Secrets are never stored hashed (they must be
  injectable) and never plaintext. This table is deliberately separate from
  `api_keys` (one-way SHA-256 identity hashes — the opposite contract).

## Key custody (interim) and the KMS seam

The master key is a 32-byte base64 env var, `ARCEO_VAULT_MASTER_KEY`, behind a
`MasterKeyProvider` interface (`wrap(dek)`/`unwrap(wrapped)`). `EnvMasterKey`
validates lazily on use: unset, non-base64, or ≠32 bytes → `VaultConfigError`
with operator guidance (vault features fail loudly; the rest of the app runs).
**This custody model is interim.** A cloud-KMS provider (wrap/unwrap via KMS
API; master key never in process memory) implements the same two methods —
that migration requires only a rewrap pass, not a re-encryption of data.

## Rotation

- **Credential rotation:** `PUT /api/credentials/{provider}` re-encrypts with
  a fresh DEK. The proxy picks up the new secret on the next call.
- **Master-key rotation:** `scripts/rotate_vault_master_key.py` — validates
  old + new keys up front, rewraps every DEK in one transaction (all-or-
  nothing), touches no credential ciphertext, prints only a row count.

## Threat model

| Attacker has | They get |
|---|---|
| DB dump alone | Ciphertext + wrapped DEKs only. No plaintext secrets. |
| Master key alone | Nothing — there is nothing to decrypt without the DB rows. |
| DB dump + master key | Every vaulted secret. This is the accepted residual risk of env-var custody: on a fully compromised host, env + DB access usually co-occur. KMS custody (above) is the mitigation path. |
| A viewer-role account | 403 on all `/api/credentials` routes (`require_admin` — the codebase's first role gate). |
| Another org's admin | Nothing cross-tenant: rows are keyed and queried by `org_id`; the proxy resolves the org from the **agent's DB row**, never from a caller-supplied header. |
| An agent with a vaulted org | It never sees the secret — injection happens server-side after the policy decision; its own `Authorization` is discarded. |

## Log-leak surface

Deliberately never logged or returned: master key, DEKs, decrypted config,
the stored secret. `GET /api/credentials` returns metadata only (no show-key
path — rotation is the only recovery). Audit rows (`VAULT_SET_CREDENTIAL`,
`VAULT_DELETE_CREDENTIAL`) name the provider only. Decrypt-failure block
reasons name the provider, not the material. `vault.py` defines no `__repr__`
that could carry key bytes; exceptions raised are cryptography's own
(`InvalidTag`) or config guidance strings.

## Failure posture

- Vault misconfigured at PUT time → 503 with operator guidance.
- Decrypt failure at proxy time (wrong/rotated key, corrupt row) → the call is
  **blocked** (fail closed) and logged to `execution_log`; the agent's own
  header is NOT forwarded as a fallback.
- No credential + `ARCEO_REQUIRE_VAULT=on` → blocked and logged.
- No credential + flag off (default) → passthrough (pre-vault behavior), so
  enabling the vault org-by-org cannot break uncredentialed tenants.

## Open items for the reviewer

1. **Env-var custody** — is the interim model acceptable for the pilot
   timeframe, given the residual-risk row above?
2. **No KMS/HSM yet** — the seam exists (`MasterKeyProvider`); is that
   sufficient for now?
3. **No key-usage audit trail** — decrypts are not individually logged (only
   proxied calls are, via `execution_log`). Worth adding?
4. **Launch scope** — bearer-token providers only (stripe, github, sendgrid).
   zendesk/salesforce need base-URL placeholder substitution and are refused
   at PUT until then.
5. **Memory hygiene** — DEKs/plaintext live transiently in Python memory
   (no zeroization; not generally achievable in CPython). Flagged, not fixed.

---

## Encryption at rest (Phase 5)

`vault.encrypt_value` / `decrypt_value` reuse the exact same envelope scheme as
the credential vault (fresh 256-bit DEK per value, AES-256-GCM with a unique
nonce, DEK wrapped by the master key via the `MasterKeyProvider` seam) — one
reviewed cryptographic path for the whole product. A value is stored as a single
self-contained `bytea`: `[2-byte wrapped-DEK length][wrapped DEK][nonce+ciphertext]`.

**Rollout is flag-gated and reversible.** `ARCEO_ENCRYPT_AT_REST` (default OFF):
when on, sensitive fields are written to a companion `*_enc` column and the
plaintext column is left NULL; the read path prefers `*_enc` and falls back to
plaintext, so old rows keep working and the flag is safe to flip both ways.

**Applied first to the highest-value at-rest fields** — the held request body
and action params in `pending_requests` (raw outbound payloads awaiting
approval, i.e. actual customer data en route to a third party). The same helper
extends to `agents.system_prompt` and `simulations.trace_json`/`report_json` as
follow-ons; `trace_json` is already PII-redacted (Phase 5 PR-2) in the interim.

**For the reviewer:** the scheme, the pack/unpack framing, the flag semantics,
and the safe-both-ways read path are the review surface — the number of columns
using it is an incremental rollout detail. Turning `ARCEO_ENCRYPT_AT_REST=on` in
production waits on your sign-off.

---

# SOC2 Type I — code-side controls

This section maps the SOC2 Common Criteria that are satisfied *in code* to where
they live and the test that proves each. It is the code-side readiness picture,
not a full SOC2 package — Type I also needs operating policies and an auditor
(business actions outside this repo). What is **not** yet code-satisfied is listed
honestly at the end.

## Tenant isolation (CC6.1, CC6.3)
Every org-scoped table has Postgres **Row-Level Security** with `FORCE ROW LEVEL
SECURITY` (migration `0002`); the app sets `app.current_org` transaction-locally
in `get_db()` from a request contextvar (`main._tenant_context`). This is a
structural backstop *under* the app-level `org_id` filters. **Caveat that gates
prod:** a superuser bypasses even FORCED RLS, so the app must run as a
non-superuser role for RLS to bite (see `MIGRATION_RUNBOOK.md`). Proven by
`test_rls_enforcement.py` (naked cross-org SELECT as a restricted role returns
zero rows) and `test_cross_org_matrix.py` (~25 id-addressed endpoints, all
403/404 cross-org, never 200).

## Access control (CC6.1, CC6.2, CC6.3)
Three roles (viewer < editor < admin) enforced centrally in `main._rbac` — one
middleware, no per-route miss. Admin-only prefixes cover org security/billing
(credentials, keys, notifications, cost, team). Instant session revocation via
`users.token_version` (migration `0006`), bumped on password change. Proven by
`test_rbac.py`.

## Audit trail integrity (CC7.2, CC7.3)
Per-org **tamper-evident hash chain** + **append-only** DB trigger (migration
`0007`); `GET /api/audit/verify` (admin) proves the chain. Writes are
same-transaction with the action they record (never an async queue that could
drop rows on crash). Proven by `test_audit_grade.py`.

## Logging & monitoring (CC7.1, CC7.2)
Structured **privileged-action access log** — one JSON line per mutating/privileged
API call (`main._access_log`): method, path, status, org, actor, latency; **no
bodies or PII**. Emitted to the `arceo.access` logger for the platform pipeline.
The `execution_log` separately records every enforced agent action with a `source`
tag (runtime/sandbox/replay/…). Proven by `test_security_headers.py`.

## Transport & browser hardening (CC6.7)
`main._security_headers` sets `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, a strict `Content-Security-Policy`, and **HSTS outside dev**
(withheld under `ARCEO_ENV in {dev,local,test,ci}` so local/HTTP pilots work).

## Confidentiality at rest (CC6.1)
Credential vault + optional field encryption-at-rest (above), AES-256-GCM
envelope, KMS-ready seam.

## Availability / abuse resistance (CC6.6, A1.1)
Per-caller rate limiting: tight limits on auth/enforce/scan, plus a broad global
ceiling across all `/api/*` (`main._global_rate_limit`), env-tunable. Fail-closed
enforcement semantics. Healthcheck at `GET /api/health`.

## Controls-mapping table

| SOC2 CC | Control | Where | Test |
|---|---|---|---|
| CC6.1/6.3 | Tenant isolation (RLS) | `0002`, `_tenant_context` | `test_rls_enforcement`, `test_cross_org_matrix` |
| CC6.1/6.2 | RBAC + session revocation | `_rbac`, `0006` | `test_rbac` |
| CC6.7 | Security headers / HSTS | `_security_headers` | `test_security_headers` |
| CC6.6/A1.1 | Rate limiting | `_global_rate_limit`, `check_rate_limit` | `test_rate_limit_and_scoping` |
| CC6.1 | Encryption at rest / vault | `vault.py`, `0005/0008` | `test_encrypt_at_rest` |
| CC7.1/7.2 | Access + execution logging | `_access_log`, `execution_log` | `test_security_headers` |
| CC7.2/7.3 | Audit trail integrity | `0007`, `/api/audit/verify` | `test_audit_grade` |

## Honest gaps (not yet code-satisfied)
- **Master-key custody** is an env var (`ARCEO_VAULT_MASTER_KEY`); the KMS/HSM
  seam exists but is not wired to a provider.
- **Encryption-at-rest is default OFF** and awaits this review to flip on.
- **Backups/DR** are delegated to the deployment platform; the repo ships a
  backup/restore *drill* script but no managed backup schedule.
- **SOC2 Type II** needs 3–6 months of *operating* evidence — calendar-bound,
  independent of code.
