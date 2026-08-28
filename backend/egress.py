"""Outbound-request guards for server-side fetches (MED-010).

Everything here exists because a URL the server fetches on a user's behalf is an
SSRF primitive unless it is validated, and the validation has to live somewhere
both `main.py` and `authority/enforcement.py` can import — `main` already imports
`enforcement`, so the guard could not stay in `main`.

Two layers:

* `validate_external_url` — resolves the host ONCE and rejects internal targets,
  returning the vetted IP so the caller can pin the connection to it. Pinning is
  what defeats DNS rebinding: without it, a hostname that validates as public can
  re-resolve to 169.254.169.254 between the check and the request.
* `post_webhook` — the whole dance (validate, pin, no redirects, SNI preserved)
  for the one place users supply a URL we later POST to: the org Slack webhook.
"""

from __future__ import annotations

import logging
import os

import envcheck
from urllib.parse import urlparse, urlunparse

from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Hosts the org webhook may point at. Slack's own endpoints by default, so the
# field can't be repurposed as a generic "make the server POST anywhere" gadget.
# ARCEO_WEBHOOK_ALLOWED_HOSTS (comma-separated) adds Slack-compatible receivers —
# Mattermost, Discord, an internal relay — without a code change.
_DEFAULT_WEBHOOK_HOSTS = ("hooks.slack.com", "hooks.slack-gov.com")


def webhook_allowed_hosts() -> tuple[str, ...]:
    """Read at call time, not import time, so a deployment can change the env
    without a restart and so tests can monkeypatch it."""
    extra = [h.strip().lower() for h in
             os.getenv("ARCEO_WEBHOOK_ALLOWED_HOSTS", "").split(",") if h.strip()]
    return tuple(_DEFAULT_WEBHOOK_HOSTS) + tuple(extra)


def validate_external_url(url: str) -> str | None:
    """SSRF guard for server-side fetches (MCP connect, org webhooks). Requires
    http(s), resolves the host ONCE, and rejects loopback / link-local / private /
    reserved addresses unless ARCEO_ALLOW_INTERNAL_MCP is set (for local-dev MCP
    servers).

    Returns a *validated* IP for the caller to pin the connection to — so a DNS
    rebind can't swap in an internal/metadata address between this check and the
    actual request (TOCTOU). Returns None when the internal-MCP bypass is on, in
    which case the caller should use the hostname unchanged."""
    import ipaddress
    import socket as _socket

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL must be http(s)")
    host = parsed.hostname
    if not host:
        raise HTTPException(status_code=400, detail="URL must include a host")
    # ⚠️ 2.10: this bypass is a full SSRF primitive and had NO production gate.
    # Returning here skips getaddrinfo entirely, which disables BOTH the
    # loopback/private/link-local rejection below AND the DNS-rebind IP pinning
    # (the caller sees pinned_ip=None and sends to the hostname unchanged). It is
    # reached from MCP connect, where the URL is caller-supplied and there is no
    # host allowlist — so with the flag set, "connect to an MCP server" fetches
    # any address the server can reach. On Cloud Run that includes
    # 169.254.169.254, the metadata server that issues service-account tokens.
    #
    # It is now gated on ARCEO_ENV the same way DEMO_MODE is, so setting it on a
    # real deploy does nothing.
    #
    # ⚠️ docs/security/backend/Dead_Code_Report.md asserted this flag was
    # "fenced against production by an explicit gate". That was false, and is
    # very likely why it survived a security review — the doc is corrected.
    if os.getenv("ARCEO_ALLOW_INTERNAL_MCP", "").lower() in ("1", "true", "yes"):
        if envcheck.is_dev_env():
            return None
        logger.warning(
            "ARCEO_ALLOW_INTERNAL_MCP is set but ARCEO_ENV does not name a dev "
            "environment — ignoring it. The SSRF guard stays on."
        )
    try:
        infos = _socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except _socket.gaierror:
        raise HTTPException(status_code=400, detail="Could not resolve URL host")
    validated_ip = None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_loopback or ip.is_private or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise HTTPException(status_code=400, detail="URL resolves to a disallowed internal address")
        if validated_ip is None:
            validated_ip = str(ip)
    if validated_ip is None:
        raise HTTPException(status_code=400, detail="Could not resolve URL host")
    return validated_ip


def pin_url_to_ip(url: str, ip: str) -> tuple[str, str]:
    """Rewrite `url` so the request connects to the already-validated `ip`, and
    return (pinned_url, host_header). Defeats DNS rebinding: we talk to the exact
    IP we vetted, while the returned Host header (and TLS SNI, set by the caller)
    preserve the real hostname so routing and cert verification still work."""
    p = urlparse(url)
    host_header = p.hostname + (f":{p.port}" if p.port else "")
    ip_host = f"[{ip}]" if ":" in ip else ip
    netloc = f"{ip_host}:{p.port}" if p.port else ip_host
    return urlunparse(p._replace(netloc=netloc)), host_header


def validate_webhook_url(url: str) -> str:
    """Check an org webhook URL: allowlisted host AND not an internal target.

    Raises HTTPException(400) so `save_notification_settings` can reject a bad URL
    at the point an admin types it. Returns the URL unchanged when it passes.
    """
    host = (urlparse(url).hostname or "").lower()
    allowed = webhook_allowed_hosts()
    if host not in allowed:
        raise HTTPException(
            status_code=400,
            detail=(f"Webhook host '{host or url}' is not allowed. Permitted hosts: "
                    f"{', '.join(allowed)}. Set ARCEO_WEBHOOK_ALLOWED_HOSTS to add one."),
        )
    validate_external_url(url)  # raises 400 on an internal/unresolvable target
    return url


def post_webhook(url: str, payload: dict, *, timeout: float = 4.0) -> bool:
    """POST to an org-configured webhook, guarded. Returns True if it was sent.

    Re-validates at fire time rather than trusting the stored value: the column
    predates this guard (so it may already hold an internal URL), and a hostname
    that validated at save time can re-resolve to an internal address later. The
    connection is pinned to the vetted IP, redirects are refused so a 30x can't
    bounce us inward, and SNI keeps TLS verification against the real hostname.

    Never raises — a notification must not break enforcement or ingestion. A URL
    that fails the guard is logged and dropped.
    """
    import httpx

    try:
        validate_webhook_url(url)
        pinned_ip = validate_external_url(url)
    except HTTPException as e:
        logger.warning("webhook not sent: %s", e.detail)
        return False
    except Exception:
        logger.warning("webhook not sent: URL could not be validated")
        return False

    try:
        headers = {"Content-Type": "application/json"}
        request_url, tls_ext = url, {}
        if pinned_ip:  # None only under the ARCEO_ALLOW_INTERNAL_MCP dev bypass
            request_url, host_header = pin_url_to_ip(url, pinned_ip)
            headers["Host"] = host_header
            tls_ext = {"sni_hostname": urlparse(url).hostname}
        with httpx.Client(timeout=timeout, follow_redirects=False) as c:
            c.send(c.build_request("POST", request_url, json=payload,
                                   headers=headers, extensions=tls_ext))
        return True
    except Exception:
        logger.warning("webhook POST failed", exc_info=True)
        return False
