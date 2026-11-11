"use client";

import { useState } from "react";
import { API_URL, APP_URL, BAND, modelName, type Band } from "../lib/prompts";

/* The live demand test on /prompts: paste a prompt, see its danger and monthly
   cost in a second. Calls the app's anonymous, IP-rate-limited score endpoint
   straight from the browser (so the limit keys on the visitor, not on this
   site's server); nothing is stored. Needs this site's origin in the
   backend's CORS_ORIGINS on a deploy. */

const EXAMPLE = "Read the customer's email {{email}} and send a reply. If they ask for their money back, issue a refund.";

interface Result {
  danger: { score: number; band: Band; reasons: { title: string; detail: string; severity: Band }[] };
  cost: { models: { model_key: string | null; available: boolean; usd_per_month?: number }[] };
  runs_per_day: number;
}

export default function PromptScoreBox() {
  const [body, setBody] = useState(EXAMPLE);
  const [perDay, setPerDay] = useState(20);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function score() {
    if (!API_URL) { setErr("Checking isn't available on this preview."); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${API_URL}/api/public/prompts/score`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, runs_per_day: perDay }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Couldn't check that prompt.");
      setRes(data as Result);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't check that prompt.");
    } finally {
      setBusy(false);
    }
  }

  const band = res ? BAND[res.danger.band] : null;
  return (
    <div style={{ background: "var(--paper)", borderRadius: "var(--r-lg)", padding: 22, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
      <label htmlFor="score-box" style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        Paste in something you ask AI to do
      </label>
      <textarea id="score-box" value={body} onChange={(e) => setBody(e.target.value.slice(0, 8000))} rows={6}
        style={{ width: "100%", boxSizing: "border-box", marginTop: 8, padding: 12, borderRadius: "var(--r-md)", border: "1px solid var(--rule)", fontFamily: "inherit", fontSize: 14, lineHeight: 1.55, color: "var(--ink)", background: "var(--ground)", resize: "vertical" }} />
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <label style={{ fontSize: 13, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
          Times used a day
          <input type="number" min={1} value={perDay} onChange={(e) => setPerDay(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 80, padding: "6px 8px", borderRadius: "var(--r-md)", border: "1px solid var(--rule)", fontSize: 13 }} />
        </label>
        <button type="button" onClick={() => void score()} disabled={busy || !body.trim()} className="btn-black" style={{ border: 0, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Checking…" : "Check it"}
        </button>
      </div>
      {err && <p role="alert" style={{ fontSize: 13, color: "var(--risk-critical)", marginTop: 10 }}>{err}</p>}
      {res && band && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--rule)", paddingTop: 14 }} aria-live="polite">
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: band.ink }}>{band.label} danger</span>
            <span style={{ fontSize: 13, color: "var(--muted-2)" }}>{res.danger.score} / 100</span>
          </div>
          {res.danger.reasons.slice(0, 2).map((r, i) => (
            <div key={i} style={{ borderLeft: `3px solid ${BAND[r.severity].ring}`, paddingLeft: 10, marginTop: 10 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{r.title}</div>
              <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>{r.detail}</div>
            </div>
          ))}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 14 }}>
            <tbody>
              {res.cost.models.filter((m) => m.available).map((m) => (
                <tr key={m.model_key ?? ""}>
                  <td style={{ padding: "6px 0", borderBottom: "1px solid var(--rule)", color: "var(--ink)" }}>{modelName(m.model_key)}</td>
                  <td style={{ padding: "6px 0", borderBottom: "1px solid var(--rule)", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--ink)" }}>
                    {m.usd_per_month != null ? `$${m.usd_per_month.toFixed(2)}/mo` : "n/a"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 12, color: "var(--muted-2)", marginTop: 8 }}>
            An estimate for {res.runs_per_day} uses a day with medium-length answers (about 225 words). Sign up free to test it for real and make it safer in one click.
          </p>
          {APP_URL && <a href={`${APP_URL}/login?for=prompts`} className="btn-black" style={{ display: "inline-block", marginTop: 6 }}>Fix it for free</a>}
        </div>
      )}
    </div>
  );
}
