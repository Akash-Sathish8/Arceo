"""Encryption-at-rest seam (Phase 5 → generalized post-roadmap).

One place that decides whether sensitive columns are envelope-encrypted at rest
(`ARCEO_ENCRYPT_AT_REST`, default OFF) and HOW to write/read them with a
read-both-ways contract, so old plaintext rows and encrypted rows coexist and the
flag is safe to flip either way. The crypto itself is `vault.encrypt_value` /
`decrypt_value` — the one reviewed AES-256-GCM envelope path.

Pattern for a sensitive column `foo`: the table has `foo` (plaintext) and a
companion `foo_enc` (bytea). On write, `split(value)` returns the pair to store;
on read, `read(row, "foo")` / `hydrate(dict_row, "foo")` returns plaintext,
preferring the encrypted column and falling back to plaintext.
"""

from __future__ import annotations

import contextlib
import os

import vault
from envcheck import DEV_ENVS as _DEV_ENVS


# The single source of truth for envelope-encrypted (`encrypt_value`) columns:
# (table, id_col, plaintext_col, enc_col). The master-key rotation and backfill
# scripts BOTH derive their column lists from this, and a CI test asserts every
# `*_enc` column in the live schema is registered here — so a new `_enc` migration
# can't silently desync from the ops tooling (HIGH-004: audit_log.detail_enc was
# added by migration 0011 but never reached the scripts, so a key rotation would
# have permanently bricked it).
ENCRYPTED_COLUMNS = [
    ("pending_requests", "id", "body", "body_enc"),
    ("pending_requests", "id", "params_json", "params_json_enc"),
    ("execution_log", "id", "params", "params_enc"),
    ("audit_log", "id", "detail", "detail_enc"),
    ("llm_captures", "id", "content", "content_enc"),
    # MED-014: a Slack incoming-webhook URL is a bearer credential in a URL. Keyed
    # on `id` (the SERIAL PK) like every entry above — backfill/rotation paginate
    # with ORDER BY <id_col> ... WHERE <id_col> = %s, so this must be the real PK,
    # not org_id (which carries no uniqueness constraint of its own).
    ("workspace_settings", "id", "slack_webhook_url", "slack_webhook_url_enc"),
]

# audit_log carries an append-only trigger (migration 0007, trg_audit_append_only)
# that RAISES on every UPDATE/DELETE for every role, including superuser. The
# rotation (rewrap the DEK header) and backfill (plaintext -> ciphertext) writes to
# audit_log.detail_enc are hash-chain-safe — the tamper-evident chain hashes the
# PLAINTEXT `detail`, which neither operation changes — so the maintenance scripts
# suspend the trigger for the duration of their audit_log writes. This requires the
# connecting role to OWN audit_log (or be superuser): acceptable for a privileged
# maintenance job that already holds the master key. See each script's usage header.
_APPEND_ONLY_TRIGGER = "trg_audit_append_only"


@contextlib.contextmanager
def suspend_append_only_trigger(conn, table: str, write: bool = True):
    """Within the caller's transaction, disable audit_log's append-only trigger for
    the duration of the block, then re-enable it (the committed schema is unchanged).
    No-op unless `table == "audit_log"` and `write` is true (dry-runs make no writes)."""
    active = write and table == "audit_log"
    if active:
        conn.execute(f"ALTER TABLE audit_log DISABLE TRIGGER {_APPEND_ONLY_TRIGGER}")
    try:
        yield
    finally:
        if active:
            conn.execute(f"ALTER TABLE audit_log ENABLE TRIGGER {_APPEND_ONLY_TRIGGER}")


def encrypt_at_rest_enabled() -> bool:
    """Whether new writes of sensitive columns are envelope-encrypted. Default OFF
    — flipping it on is a deliberate, specialist-reviewed step (docs/SECURITY_DESIGN.md)."""
    return os.getenv("ARCEO_ENCRYPT_AT_REST", "").lower() in ("1", "true", "yes", "on")


def enforce_prod_encryption_policy() -> None:
    """LOW-006: refuse to boot in a non-dev environment unless encryption-at-rest
    is enabled — sensitive columns (LLM PII, execution params, held requests) must
    not sit in cleartext in prod. Mirrors auth.py's default-JWT-secret guard. Also
    fails fast if the flag is on but no master key is set (writes would error at
    runtime). Called from app startup; no-op in dev/test/ci."""
    dev = os.getenv("ARCEO_ENV", "").lower() in _DEV_ENVS
    if not encrypt_at_rest_enabled():
        if not dev:
            raise RuntimeError(
                "ARCEO_ENCRYPT_AT_REST is off in a non-dev environment — sensitive "
                "columns would be stored in cleartext. Set ARCEO_ENCRYPT_AT_REST=1 "
                "and ARCEO_VAULT_MASTER_KEY, or set ARCEO_ENV=dev for local work."
            )
        return
    if not os.getenv(vault.MASTER_KEY_ENV):
        raise RuntimeError(
            f"ARCEO_ENCRYPT_AT_REST is on but {vault.MASTER_KEY_ENV} is unset — "
            "encrypted writes would fail. Provide the base64 master key."
        )


def split(plaintext: str | None) -> tuple[str | None, bytes | None]:
    """Return `(plaintext_col, enc_col)` for a sensitive string value. When the
    flag is on and there's a value, encrypt it and null the plaintext column;
    otherwise store plaintext and leave the enc column null."""
    if plaintext is not None and encrypt_at_rest_enabled():
        return None, vault.encrypt_value(plaintext)
    return plaintext, None


def read(row, base: str) -> str | None:
    """Plaintext for a column stored as either `<base>` or `<base>_enc`. Prefers
    the encrypted column; falls back to plaintext (old rows / flag off)."""
    enc = row.get(f"{base}_enc")
    if enc:
        return vault.decrypt_value(enc)
    return row.get(base)


def hydrate(row: dict, *bases: str) -> dict:
    """In a dict row, replace each base column with its decrypted plaintext and
    DROP the `<base>_enc` key so the row is JSON-safe (a raw bytea would break
    serialization). Mutates and returns the dict."""
    for base in bases:
        enc_key = f"{base}_enc"
        if enc_key in row:
            if row.get(enc_key):
                row[base] = vault.decrypt_value(row[enc_key])
            del row[enc_key]
    return row
