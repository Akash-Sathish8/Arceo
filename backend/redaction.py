"""Best-effort PII redaction (Phase 5).

Arceo stores what agents did — traces, prompts, request bodies — which routinely
contain customer PII (emails, phone numbers, card numbers, SSNs). This masks the
obvious patterns before anything is persisted, keeping the surrounding structure
(which tool, which action, the shape of the data) so the traces stay useful.

This is a redaction pass, not encryption — it drops sensitive VALUES, it doesn't
protect the rest. Encryption-at-rest is the complementary layer. Controlled by
ARCEO_PII_REDACTION (default ON — customers who accept the privacy tradeoff for
fuller traces can turn it off).
"""

from __future__ import annotations

import os
import re

# Best-effort, US-biased patterns. Known limitations (accepted by design — this
# is a first-pass scrub, encryption-at-rest is the real protection): the phone
# pattern assumes a 3-digit area code so some international formats slip through,
# and the card pattern is deliberately permissive — the Luhn check in
# redact_text is REQUIRED to keep it from masking non-card digit runs (order
# ids, prices). Do not remove the Luhn filter.
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
# 13–16 digit runs allowing spaces/dashes (card-shaped). Luhn-gated below.
_CARD = re.compile(r"\b(?:\d[ -]?){13,16}\b")
# US SSN 123-45-6789.
_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
# Phone: +1 555-123-4567 / (555) 123-4567 / 555.123.4567 — US-shaped, 3-digit area.
_PHONE = re.compile(r"(?<!\d)(?:\+?\d{1,3}[ .\-]?)?(?:\(\d{3}\)|\d{3})[ .\-]?\d{3}[ .\-]?\d{4}(?!\d)")

# LOW-007: secrets/credentials — redaction was blind to these, yet captured LLM
# prompts routinely contain them. High-signal, low-false-positive prefixes only
# (no generic high-entropy scan, which would over-mask ids/hashes). Ordered so
# sk-ant- matches before the broader sk- rule.
_ANTHROPIC_KEY = re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}")
_OPENAI_KEY = re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}")
_AWS_KEY = re.compile(r"\bAKIA[0-9A-Z]{16}\b")
_GITHUB_TOKEN = re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-]{20,}")
_SECRETS = (_ANTHROPIC_KEY, _OPENAI_KEY, _AWS_KEY, _GITHUB_TOKEN, _BEARER)


def redaction_enabled() -> bool:
    return os.getenv("ARCEO_PII_REDACTION", "true").lower() not in ("0", "false", "no", "off")


def _luhn_ok(digits: str) -> bool:
    """Card-shaped runs that fail the Luhn checksum are almost certainly not
    card numbers (order ids, timestamps) — leave them alone to avoid over-masking."""
    d = [int(c) for c in digits if c.isdigit()]
    if not (13 <= len(d) <= 16):
        return False
    checksum, parity = 0, len(d) % 2
    for i, n in enumerate(d):
        if i % 2 == parity:
            n *= 2
            if n > 9:
                n -= 9
        checksum += n
    return checksum % 10 == 0


def redact_text(text: str) -> str:
    """Mask PII patterns in a string. No-op when redaction is disabled."""
    if not text or not redaction_enabled():
        return text
    # Secrets first: an API key that happens to contain a digit run shouldn't be
    # partially rewritten by the card/phone rules.
    for pat in _SECRETS:
        text = pat.sub("[REDACTED_SECRET]", text)
    text = _EMAIL.sub("[REDACTED_EMAIL]", text)
    text = _SSN.sub("[REDACTED_SSN]", text)
    text = _CARD.sub(lambda m: "[REDACTED_CARD]" if _luhn_ok(m.group(0)) else m.group(0), text)
    text = _PHONE.sub("[REDACTED_PHONE]", text)
    return text


def redact_value(value):
    """Recursively redact strings inside dicts/lists/scalars, preserving shape."""
    if not redaction_enabled():
        return value
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {k: redact_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_value(v) for v in value]
    return value


# ── Log-safe values (MED-017) ─────────────────────────────────────────────────
# Caller-supplied identifiers — X-Agent-ID, tool/action names from customer
# manifests — reached the plain-text application logger through f-strings with no
# neutralisation. `.strip()` only trims the ENDS, so an interior "\n" let a caller
# forge whole log lines: fabricating events, attributing actions to another
# tenant's agent, or breaking a SIEM that assumes one event per line.
#
# The audit_log sink was never the problem — log_audit writes through a fully
# parameterised INSERT, so values are stored as column data and the hash chain
# stays intact. The unstructured logger is the real injectable sink.
_LOG_UNSAFE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def log_safe(value, max_length: int = 200) -> str:
    """Neutralise a caller-derived value for a log line.

    Strips CR/LF and every other C0/C1 control character (escaping them rather
    than dropping them would still let a reader be misled), and caps the length so
    an oversized field can't push the real content off the line.
    """
    text = "" if value is None else str(value)
    cleaned = _LOG_UNSAFE.sub("", text)
    if len(cleaned) > max_length:
        cleaned = cleaned[:max_length] + "…"
    return cleaned
