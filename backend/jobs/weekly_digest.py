"""Weekly cost + risk digest email, one per org.

Reuses the same forecaster the dashboard uses, composes a CFO-readable HTML
summary, and sends it to the org's configured `alert_email`. No-op for orgs
without an alert_email and when SMTP isn't configured (see email_utils).

The backend runs this weekly via the in-process scheduler (see main.py). Manual:
    cd arceo/backend && python3 -m jobs.weekly_digest
"""
from __future__ import annotations

import html as _html
import os
import sys
from datetime import datetime, timedelta

from analysis.spend_forecast import forecast_spend
from db import get_db, get_all_agents_from_db
from email_utils import send_email, smtp_configured

DIGEST_INTERVAL_DAYS = 7


def _fleet_summary(conn, org_id: str) -> dict:
    """Per-org rollup: projected fleet spend, top agents, blocked actions."""
    agents = get_all_agents_from_db(conn, org_id=org_id)
    rows = []
    for a in agents:
        try:
            f = forecast_spend(a, org_id=org_id, _skip_sensitivity=True)
            rows.append({"name": a["name"], "point": int(f.get("point", 0) or 0)})
        except Exception:
            continue
    rows.sort(key=lambda r: r["point"], reverse=True)
    total = sum(r["point"] for r in rows)

    seven_days_ago = (datetime.utcnow() - timedelta(days=7)).isoformat()
    blocked = conn.execute(
        "SELECT COUNT(*) FROM execution_log WHERE org_id = ? AND status = 'BLOCKED' AND timestamp > ?",
        (org_id, seven_days_ago),
    ).fetchone()[0]

    return {
        "total": total,
        "annual": total * 12,
        "agents": rows,
        "agent_count": len(rows),
        "blocked_this_week": int(blocked),
    }


def _digest_html(org_name: str, s: dict, app_url: str) -> str:
    top = s["agents"][:5]
    if top:
        agent_rows = "".join(
            f'<tr><td style="padding:7px 0;border-bottom:1px solid #f1f5f9;color:#334155;font-size:14px;">{_html.escape(a["name"])}</td>'
            f'<td style="padding:7px 0;border-bottom:1px solid #f1f5f9;text-align:right;font-family:monospace;color:#0f172a;font-size:14px;">${a["point"]:,}/mo</td></tr>'
            for a in top
        )
    else:
        agent_rows = '<tr><td style="padding:7px 0;color:#94a3b8;font-size:14px;">No agents connected yet.</td><td></td></tr>'

    cta = (
        f'<a href="{_html.escape(app_url)}" style="display:inline-block;background:#0f172a;color:#fff;'
        f'text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px;">Open dashboard</a>'
        if app_url else ""
    )
    return f"""<!doctype html>
<html><body style="margin:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="font-size:13px;font-weight:700;letter-spacing:1px;color:#0f172a;">ARCEO</div>
    <div style="font-size:12px;color:#64748b;margin-top:2px;">Weekly cost &amp; risk review · {_html.escape(org_name)}</div>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:24px;margin-top:20px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#94a3b8;">Projected fleet spend</div>
      <div style="font-size:40px;font-weight:700;font-family:monospace;color:#0f172a;letter-spacing:-1px;margin-top:4px;">${s['total']:,}<span style="font-size:15px;color:#64748b;font-family:inherit;font-weight:400;"> / month</span></div>
      <div style="font-size:13px;color:#64748b;margin-top:4px;">≈ ${s['annual']:,} / year across {s['agent_count']} agent{'s' if s['agent_count'] != 1 else ''}</div>
    </div>

    <div style="display:flex;gap:12px;margin-top:16px;">
      <div style="flex:1;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;">Actions blocked this week</div>
        <div style="font-size:24px;font-weight:700;color:#0f172a;margin-top:4px;">{s['blocked_this_week']}</div>
      </div>
    </div>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:24px;margin-top:16px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#94a3b8;margin-bottom:8px;">Top spenders</div>
      <table style="width:100%;border-collapse:collapse;">{agent_rows}</table>
    </div>

    <div style="margin-top:24px;">{cta}</div>

    <div style="font-size:11px;color:#94a3b8;margin-top:28px;line-height:1.6;">
      Projected figures are pre-deployment estimates and tighten with live usage. You're receiving this
      because an alert email is set in Arceo → Settings → Notifications.
    </div>
  </div>
</body></html>"""


def build_and_send(org_id: str, email: str, org_name: str = "your organization") -> tuple[bool, str]:
    """Compose and send the digest for one org. Returns (sent, reason)."""
    with get_db() as conn:
        summary = _fleet_summary(conn, org_id)
    app_url = os.getenv("APP_PUBLIC_URL", "")
    html_body = _digest_html(org_name, summary, app_url)
    subject = f"Arceo weekly review — ${summary['total']:,}/mo across {summary['agent_count']} agents"
    return send_email(email, subject, html_body)


def run_weekly() -> dict:
    """Send to every org whose digest is due (alert_email set, >= 7 days since last)."""
    if not smtp_configured():
        return {"sent": 0, "failed": 0, "due": 0, "reason": "SMTP not configured"}

    now = datetime.utcnow()
    cutoff = (now - timedelta(days=DIGEST_INTERVAL_DAYS)).isoformat()
    with get_db() as conn:
        orgs = conn.execute(
            "SELECT ws.org_id AS org_id, ws.alert_email AS alert_email, "
            "ws.last_digest_sent AS last_digest_sent, o.name AS name "
            "FROM workspace_settings ws LEFT JOIN organizations o ON o.id = ws.org_id "
            "WHERE ws.alert_email IS NOT NULL AND ws.alert_email != ''"
        ).fetchall()
    due = [r for r in orgs if not r["last_digest_sent"] or r["last_digest_sent"] < cutoff]

    sent = failed = 0
    for r in due:
        ok, _reason = build_and_send(r["org_id"], r["alert_email"], r["name"] or "your organization")
        if ok:
            with get_db() as conn:
                conn.execute(
                    "UPDATE workspace_settings SET last_digest_sent = ? WHERE org_id = ?",
                    (now.isoformat(), r["org_id"]),
                )
            sent += 1
        else:
            failed += 1
    return {"sent": sent, "failed": failed, "due": len(due)}


if __name__ == "__main__":
    result = run_weekly()
    print(result)
    sys.exit(0 if result.get("failed", 0) == 0 else 1)
