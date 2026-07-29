"""Backfill encryption-at-rest: encrypt existing plaintext rows in place.

Turning on `ARCEO_ENCRYPT_AT_REST` only encrypts NEW writes — rows written while
it was off keep their plaintext (the read path handles both). Run this once, with
the master key present, to bring existing rows to encrypted-at-rest: for each
sensitive column it reads the plaintext, writes the `_enc` companion, and NULLs
the plaintext.

Usage:
    ARCEO_VAULT_MASTER_KEY=<base64 key> \
    DATABASE_URL=postgresql://... \
        python scripts/backfill_encryption.py [--dry-run] [--batch 500]

Idempotent: only rows with non-NULL plaintext AND NULL `_enc` are touched, so
re-running is a no-op. Off the request path. Encrypts regardless of the flag
(you run it precisely when adopting encryption). No plaintext is ever printed.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import encryption  # noqa: E402
import vault  # noqa: E402
from vault import EnvMasterKey, VaultConfigError  # noqa: E402

# (table, id_col, plaintext_col, enc_col) — the shared registry of sensitive columns
# with a plaintext + `_enc` companion pair (the same source the rotation script uses).
# audit_log.detail is included; its append-only trigger is suspended around the write.
_COLUMNS = encryption.ENCRYPTED_COLUMNS


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="report how many rows would be encrypted, change nothing")
    ap.add_argument("--batch", type=int, default=500, help="rows per fetch")
    args = ap.parse_args()

    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL is not set.")
    try:
        EnvMasterKey("ARCEO_VAULT_MASTER_KEY")._key()  # validate up front
    except VaultConfigError as e:
        sys.exit(str(e))

    counts: dict[str, int] = {}
    with psycopg.connect(url) as conn:
        for table, id_col, pt_col, enc_col in _COLUMNS:
            n = 0
            # audit_log's append-only trigger is suspended around its (hash-chain-safe)
            # plaintext -> ciphertext backfill; a no-op for the other tables.
            with encryption.suspend_append_only_trigger(conn, table, write=not args.dry_run):
                while True:
                    rows = conn.execute(
                        f"SELECT {id_col}, {pt_col} FROM {table} "
                        f"WHERE {pt_col} IS NOT NULL AND {enc_col} IS NULL "
                        f"ORDER BY {id_col} LIMIT %s",
                        (args.batch,),
                    ).fetchall()
                    if not rows:
                        break
                    for row_id, plaintext in rows:
                        if args.dry_run:
                            continue
                        conn.execute(
                            f"UPDATE {table} SET {enc_col} = %s, {pt_col} = NULL WHERE {id_col} = %s",
                            (vault.encrypt_value(plaintext), row_id),
                        )
                    n += len(rows)
                    if args.dry_run:
                        break  # counting only — one page is enough to report intent
            counts[f"{table}.{pt_col}"] = n
        if args.dry_run:
            conn.rollback()
        else:
            conn.commit()

    verb = "Would encrypt" if args.dry_run else "Encrypted"
    total = sum(counts.values())
    print(f"{verb} {total} row(s):")
    for k, n in counts.items():
        print(f"  {n:>6}  {k}")


if __name__ == "__main__":
    main()
