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

import os

import vault


def encrypt_at_rest_enabled() -> bool:
    """Whether new writes of sensitive columns are envelope-encrypted. Default OFF
    — flipping it on is a deliberate, specialist-reviewed step (SECURITY_DESIGN.md)."""
    return os.getenv("ARCEO_ENCRYPT_AT_REST", "").lower() in ("1", "true", "yes", "on")


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
