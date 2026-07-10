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
