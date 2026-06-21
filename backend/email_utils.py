"""Email transport — SMTP via the stdlib, configured by environment.

No-op (returns False) when SMTP isn't configured, exactly like the Slack
webhook path: alerting is opt-in by the operator and never silently faked.

Env:
  SMTP_HOST      (required — absence disables email entirely)
  SMTP_PORT      (default 587)
  SMTP_USER      (optional — login only if set)
  SMTP_PASSWORD
  SMTP_FROM      (default SMTP_USER, then "arceo@localhost")
  SMTP_USE_TLS   (default "true"; set "false" to skip STARTTLS)

Works with any SMTP provider — SendGrid, Postmark, SES, Gmail app passwords.
"""
from __future__ import annotations

import os
import smtplib
import ssl
from email.message import EmailMessage


def smtp_configured() -> bool:
    return bool(os.getenv("SMTP_HOST"))


def send_email(to: str, subject: str, html: str, text: str | None = None) -> tuple[bool, str]:
    """Send one HTML email. Returns (sent, reason). Never raises."""
    host = os.getenv("SMTP_HOST")
    if not host:
        return False, "SMTP not configured"
    if not to:
        return False, "no recipient"
    try:
        port = int(os.getenv("SMTP_PORT", "587"))
        user = os.getenv("SMTP_USER", "")
        password = os.getenv("SMTP_PASSWORD", "")
        sender = os.getenv("SMTP_FROM") or user or "arceo@localhost"
        use_tls = os.getenv("SMTP_USE_TLS", "true").lower() != "false"

        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = sender
        msg["To"] = to
        msg.set_content(text or "Open this digest in an HTML-capable email client.")
        msg.add_alternative(html, subtype="html")

        with smtplib.SMTP(host, port, timeout=15) as server:
            if use_tls:
                server.starttls(context=ssl.create_default_context())
            if user:
                server.login(user, password)
            server.send_message(msg)
        return True, "sent"
    except Exception as e:  # noqa: BLE001 — email failures must never break callers
        return False, f"send failed: {e}"
