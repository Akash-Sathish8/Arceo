"""Rotate the vault master key: rewrap every credential's DEK.

Usage:
    ARCEO_VAULT_MASTER_KEY=<current base64 key> \
    ARCEO_VAULT_MASTER_KEY_NEW=<new base64 key> \
    DATABASE_URL=postgresql://... \
        python scripts/rotate_vault_master_key.py

Only the wrapped DEKs change — credential ciphertext is untouched, so the
rotation is O(rows) and runs in a single transaction: it either fully
completes or leaves everything on the old key. After it succeeds, deploy the
new key as ARCEO_VAULT_MASTER_KEY and retire the old one.

No key or DEK material is ever printed.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from vault import EnvMasterKey, VaultConfigError  # noqa: E402


def main() -> None:
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL is not set.")
    try:
        old = EnvMasterKey("ARCEO_VAULT_MASTER_KEY")
        new = EnvMasterKey("ARCEO_VAULT_MASTER_KEY_NEW")
        old._key(), new._key()  # validate both up front, before touching rows
    except VaultConfigError as e:
        sys.exit(str(e))

    with psycopg.connect(url) as conn:
        rows = conn.execute(
            "SELECT id, wrapped_dek FROM provider_credentials"
        ).fetchall()
        for row_id, wrapped in rows:
            dek = old.unwrap(bytes(wrapped))  # InvalidTag here = wrong current key; abort loudly
            conn.execute(
                "UPDATE provider_credentials SET wrapped_dek = %s WHERE id = %s",
                (new.wrap(dek), row_id),
            )
        conn.commit()
    print(f"Rewrapped {len(rows)} credential DEK(s). "
          f"Deploy the new key as ARCEO_VAULT_MASTER_KEY and retire the old one.")


if __name__ == "__main__":
    main()
