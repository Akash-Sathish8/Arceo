"""Credential vault — envelope encryption for upstream provider secrets.

Arceo holds each org's provider credentials (Stripe/GitHub/SendGrid keys) so
the enforcing proxy can strip whatever an agent sent and inject the vaulted
secret. These are DECRYPTABLE by design — the opposite contract from
api_keys' one-way SHA-256 identity hashes. Keep the two concepts in separate
tables and separate code paths; an upstream secret is never stored hashed or
in plaintext.

Scheme (envelope):
  - Per credential-set: a fresh 256-bit data-encryption key (DEK).
  - The config JSON is encrypted AES-256-GCM under the DEK; the unique
    12-byte nonce is prepended to the ciphertext.
  - The DEK is wrapped (AES-256-GCM again, own nonce) by the master key.
  - Rotation: credential rotation = a PUT re-encrypts with a fresh DEK;
    master-key rotation = rewrap every DEK (scripts/rotate_vault_master_key.py)
    without touching credential ciphertext.

Key custody is INTERIM: `EnvMasterKey` reads the master key from an
environment variable. `MasterKeyProvider` is the KMS seam — a cloud-KMS
provider (wrap/unwrap via KMS API, key never in process memory) implements
the same two methods later. See docs/SECURITY_DESIGN.md.

Never put secret material (master key, DEKs, decrypted config) in logs,
exceptions, or reprs.
"""

from __future__ import annotations

import base64
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_NONCE_LEN = 12  # AES-GCM standard nonce size
MASTER_KEY_ENV = "ARCEO_VAULT_MASTER_KEY"


class VaultConfigError(RuntimeError):
    """The vault is misconfigured (missing/malformed master key)."""


class MasterKeyProvider:
    """The KMS seam: wrap/unwrap a DEK. Implementations must never expose the
    master key itself beyond what wrap/unwrap require."""

    def wrap(self, dek: bytes) -> bytes:
        raise NotImplementedError

    def unwrap(self, wrapped: bytes) -> bytes:
        raise NotImplementedError


class EnvMasterKey(MasterKeyProvider):
    """Master key from the ARCEO_VAULT_MASTER_KEY env var (base64, 32 bytes).

    Interim custody — suitable for a single-host deploy where the env var is
    injected by the platform's secret store. The env var is read lazily on
    each use so a process never caches a stale key across rotation and tests
    can set it after import.
    """

    def __init__(self, env_var: str = MASTER_KEY_ENV):
        self._env_var = env_var

    def _key(self) -> bytes:
        raw = os.environ.get(self._env_var, "")
        if not raw:
            raise VaultConfigError(
                f"{self._env_var} is not set. The credential vault needs a 32-byte "
                f"base64 master key — generate one with: "
                f"python -c \"import base64,os;print(base64.b64encode(os.urandom(32)).decode())\""
            )
        try:
            key = base64.b64decode(raw, validate=True)
        except Exception:
            raise VaultConfigError(f"{self._env_var} is not valid base64.") from None
        if len(key) != 32:
            raise VaultConfigError(
                f"{self._env_var} must decode to exactly 32 bytes (got {len(key)}). "
                f"Short or weak keys are refused."
            )
        return key

    def wrap(self, dek: bytes) -> bytes:
        nonce = os.urandom(_NONCE_LEN)
        return nonce + AESGCM(self._key()).encrypt(nonce, dek, None)

    def unwrap(self, wrapped: bytes) -> bytes:
        # A wrong/rotated master key raises cryptography's InvalidTag here —
        # deliberately loud, never swallowed.
        return AESGCM(self._key()).decrypt(wrapped[:_NONCE_LEN], wrapped[_NONCE_LEN:], None)


_default_provider = EnvMasterKey()


def encrypt_credential(config: dict, provider: MasterKeyProvider = _default_provider) -> tuple[bytes, bytes]:
    """Encrypt a credential config; returns (wrapped_dek, encrypted_config).

    A fresh DEK per call means every store/rotate gets new key material, and
    a compromised DEK exposes exactly one credential-set version.
    """
    dek = os.urandom(32)
    nonce = os.urandom(_NONCE_LEN)
    ciphertext = AESGCM(dek).encrypt(nonce, json.dumps(config).encode(), None)
    return provider.wrap(dek), nonce + ciphertext


def decrypt_credential(wrapped_dek: bytes, encrypted_config: bytes,
                       provider: MasterKeyProvider = _default_provider) -> dict:
    """Decrypt a stored credential config back to its dict form."""
    dek = provider.unwrap(bytes(wrapped_dek))
    blob = bytes(encrypted_config)
    plaintext = AESGCM(dek).decrypt(blob[:_NONCE_LEN], blob[_NONCE_LEN:], None)
    return json.loads(plaintext)


# ── Generic column encryption (Phase 5) ──────────────────────────────────────
# The same envelope scheme, packaged for arbitrary column values so sensitive
# data (held request bodies, action params, prompts, traces) is encrypted at
# rest. Each value is self-contained: [2-byte wrapped-DEK length][wrapped DEK]
# [nonce+ciphertext], so one bytea column holds everything needed to decrypt.

import struct as _struct


def encrypt_value(value, provider: MasterKeyProvider = _default_provider) -> bytes:
    """Encrypt a string or JSON-serializable value into a self-contained blob.

    Fresh DEK per value (so a leaked DEK exposes exactly one value), wrapped by
    the master key. Reuses the exact AES-256-GCM scheme the credential vault
    uses — one reviewed cryptographic path for the whole product."""
    dek = os.urandom(32)
    nonce = os.urandom(_NONCE_LEN)
    plaintext = value.encode() if isinstance(value, str) else json.dumps(value).encode()
    ciphertext = AESGCM(dek).encrypt(nonce, plaintext, None)
    wrapped = provider.wrap(dek)
    return _struct.pack(">H", len(wrapped)) + wrapped + nonce + ciphertext


def decrypt_value(blob: bytes, as_json: bool = False,
                  provider: MasterKeyProvider = _default_provider):
    """Decrypt a blob from encrypt_value back to str (or dict if as_json)."""
    blob = bytes(blob)
    wlen = _struct.unpack(">H", blob[:2])[0]
    wrapped = blob[2:2 + wlen]
    rest = blob[2 + wlen:]
    dek = provider.unwrap(wrapped)
    plaintext = AESGCM(dek).decrypt(rest[:_NONCE_LEN], rest[_NONCE_LEN:], None)
    return json.loads(plaintext) if as_json else plaintext.decode()


# ── Master-key rotation ───────────────────────────────────────────────────────
# Rotating the master key rewraps each value's DEK under the new key WITHOUT
# touching (or ever decrypting) the ciphertext — the envelope design makes this a
# DEK-only operation, so plaintext never enters memory during a rotation.

def rewrap_blob(blob: bytes, old_provider: MasterKeyProvider,
                new_provider: MasterKeyProvider) -> bytes:
    """Rewrap an encrypt_value blob's DEK from old_provider to new_provider.
    Unwraps the DEK with the old master key and rewraps it with the new one; the
    nonce+ciphertext are left byte-for-byte unchanged."""
    blob = bytes(blob)
    wlen = _struct.unpack(">H", blob[:2])[0]
    wrapped = blob[2:2 + wlen]
    rest = blob[2 + wlen:]
    dek = old_provider.unwrap(wrapped)
    new_wrapped = new_provider.wrap(dek)
    return _struct.pack(">H", len(new_wrapped)) + new_wrapped + rest


def rewrap_credential(wrapped_dek: bytes, old_provider: MasterKeyProvider,
                      new_provider: MasterKeyProvider) -> bytes:
    """Rewrap a credential's wrapped DEK (from encrypt_credential) under the new
    master key. The encrypted_config bytes are unchanged and never decrypted."""
    dek = old_provider.unwrap(bytes(wrapped_dek))
    return new_provider.wrap(dek)
