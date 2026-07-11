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

# Order matters: card/SSN before the looser digit-run patterns wouldn't help
# here since we run each independently, but email before generic text is fine.
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
# 13–16 digit runs allowing spaces/dashes (card-shaped).
_CARD = re.compile(r"\b(?:\d[ -]?){13,16}\b")
# US SSN 123-45-6789.
_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
# Phone: +1 555-123-4567 / (555) 123-4567 / 555.123.4567 — 10+ digits with seps.
_PHONE = re.compile(r"(?<!\d)(?:\+?\d{1,3}[ .\-]?)?(?:\(\d{3}\)|\d{3})[ .\-]?\d{3}[ .\-]?\d{4}(?!\d)")


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
