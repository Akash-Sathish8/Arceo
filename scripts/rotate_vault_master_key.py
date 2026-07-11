"""Rotate the vault master key: rewrap every credential AND every encrypted-at-rest
column's DEK under a new master key.

Usage:
    ARCEO_VAULT_MASTER_KEY=<current base64 key> \
    ARCEO_VAULT_MASTER_KEY_NEW=<new base64 key> \
    DATABASE_URL=postgresql://... \
        python scripts/rotate_vault_master_key.py [--dry-run]

Only the wrapped DEKs change — ciphertext is never touched and plaintext never
enters memory (envelope design). The rotation is O(rows) and runs in a single
transaction: it either fully completes or leaves everything on the old key.
After it succeeds, deploy the new key as ARCEO_VAULT_MASTER_KEY and retire the
old one.

Covers: provider_credentials (wrapped_dek) + every encrypt_value column added by
the encryption-at-rest rollout (pending_requests.body_enc / params_json_enc,
execution_log.params_enc). Add new `_enc` columns to _BLOB_COLUMNS below.

No key or DEK material is ever printed.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import vault  # noqa: E402
from vault import EnvMasterKey, VaultConfigError  # noqa: E402

# encrypt_value() blob columns, rewrapped with vault.rewrap_blob.
# (table, id_col, enc_col)
_BLOB_COLUMNS = [
    ("pending_requests", "id", "body_enc"),
    ("pending_requests", "id", "params_json_enc"),
    ("execution_log", "id", "params_enc"),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="report how many DEKs would be rewrapped, change nothing")
    args = ap.parse_args()

    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL is not set.")
    try:
        old = EnvMasterKey("ARCEO_VAULT_MASTER_KEY")
        new = EnvMasterKey("ARCEO_VAULT_MASTER_KEY_NEW")
        old._key(), new._key()  # validate both up front, before touching rows
    except VaultConfigError as e:
        sys.exit(str(e))

    counts: dict[str, int] = {}
    with psycopg.connect(url) as conn:
        # 1) Credentials: rewrap the wrapped DEK (config ciphertext untouched).
        creds = conn.execute("SELECT id, wrapped_dek FROM provider_credentials").fetchall()
        for row_id, wrapped in creds:
            if not args.dry_run:
                new_wrapped = vault.rewrap_credential(bytes(wrapped), old, new)
                conn.execute("UPDATE provider_credentials SET wrapped_dek = %s WHERE id = %s",
                             (new_wrapped, row_id))
        counts["provider_credentials.wrapped_dek"] = len(creds)

        # 2) encrypt_value blob columns: rewrap the DEK header in place.
        for table, id_col, enc_col in _BLOB_COLUMNS:
            rows = conn.execute(
                f"SELECT {id_col}, {enc_col} FROM {table} WHERE {enc_col} IS NOT NULL"
            ).fetchall()
            for row_id, blob in rows:
                if not args.dry_run:
                    conn.execute(
                        f"UPDATE {table} SET {enc_col} = %s WHERE {id_col} = %s",
                        (vault.rewrap_blob(bytes(blob), old, new), row_id))
            counts[f"{table}.{enc_col}"] = len(rows)

        if args.dry_run:
            conn.rollback()
        else:
            conn.commit()

    total = sum(counts.values())
    verb = "Would rewrap" if args.dry_run else "Rewrapped"
    print(f"{verb} {total} DEK(s):")
    for k, n in counts.items():
        print(f"  {n:>6}  {k}")
    if not args.dry_run:
        print("Deploy the new key as ARCEO_VAULT_MASTER_KEY and retire the old one.")


if __name__ == "__main__":
    main()
