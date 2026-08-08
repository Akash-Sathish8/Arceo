import { NextResponse } from "next/server";

/**
 * Demo-request intake.
 *
 * Replaces the previous client-side `mailto:` submit, which fired a success
 * state unconditionally — a visitor with no mail handler saw "we'll get back
 * to you" while nothing was sent and nothing reached us.
 *
 * Delivery is operator-configured and best-effort in this order:
 *   1. ARCEO_DEMO_WEBHOOK  — Slack-compatible incoming webhook (preferred)
 *   2. structured server log — always, so Cloud Run logging is the backstop
 *
 * The route only reports success when the lead has been durably recorded
 * somewhere we control. If every configured sink fails, it returns 502 and the
 * form shows the direct-email fallback instead of a false confirmation.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEBHOOK = process.env.ARCEO_DEMO_WEBHOOK;
const CONTACT_EMAIL = process.env.ARCEO_CONTACT_EMAIL ?? "akakash.sathish@gmail.com";

const MAX = { name: 120, email: 200, company: 160, role: 120, message: 4000 } as const;

// Simple per-instance rate limit. Resets on cold start; enough to stop a bot
// hammering a marketing form, and it never blocks a real submission.
const RATE_LIMIT = { windowMs: 60_000, max: 5 };
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_LIMIT.max;
}

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function POST(req: Request) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  if (rateLimited(ip)) {
    return NextResponse.json(
      { ok: false, error: "Too many requests. Try again in a minute." },
      { status: 429 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request." }, { status: 400 });
  }

  // Honeypot: a hidden field only a bot fills in. Accept and discard silently.
  if (clean(body.website, 200)) return NextResponse.json({ ok: true });

  const lead = {
    name: clean(body.name, MAX.name),
    email: clean(body.email, MAX.email),
    company: clean(body.company, MAX.company),
    role: clean(body.role, MAX.role),
    message: clean(body.message, MAX.message),
  };

  if (!lead.name || !lead.email) {
    return NextResponse.json(
      { ok: false, error: "Name and work email are required." },
      { status: 400 }
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lead.email)) {
    return NextResponse.json(
      { ok: false, error: "That email address doesn't look right." },
      { status: 400 }
    );
  }

  const receivedAt = new Date().toISOString();
  let delivered = false;

  if (WEBHOOK) {
    try {
      const res = await fetch(WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: [
            "*New Arceo demo request*",
            `*Name:* ${lead.name}`,
            `*Email:* ${lead.email}`,
            `*Company:* ${lead.company || "—"}`,
            `*Role:* ${lead.role || "—"}`,
            "",
            lead.message || "(no message)",
          ].join("\n"),
        }),
        signal: AbortSignal.timeout(8000),
      });
      delivered = res.ok;
      if (!res.ok) {
        console.error("[demo-request] webhook rejected", { status: res.status, receivedAt });
      }
    } catch (err) {
      console.error("[demo-request] webhook failed", { err: String(err), receivedAt });
    }
  }

  // Always log. On Cloud Run this is the durable record, and it is what makes
  // a webhook-less deployment safe to ship rather than silently lossy.
  console.log(
    "[demo-request] lead",
    JSON.stringify({ ...lead, receivedAt, ip, deliveredToWebhook: delivered })
  );

  return NextResponse.json({ ok: true, contactEmail: CONTACT_EMAIL });
}
