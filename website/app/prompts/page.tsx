"use client";

import Link from "next/link";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";

/* Prompt library landing. Same shell, tokens and voice as /pricing: one
   message, what a prompt costs to run and how it can be abused, shown on a
   worked example rather than claimed. */

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:5173" : null);

const START_HREF = APP_URL ? `${APP_URL}/prompts/new` : "/book-demo";

const POINTS = [
  {
    title: "Cost per run, on every model",
    body: "Paste a prompt and see what one run costs on Claude, GPT and Gemini, per run and per thousand. Run QA and the output length is measured, not guessed.",
  },
  {
    title: "How it can be abused",
    body: "A 0-100 danger score with the reason behind every point: pasted keys or personal data, slots where an email can rewrite your instructions, and steps that can act on what they read.",
  },
  {
    title: "Attacked before you share it",
    body: "QA runs your prompt on real models, then tries to inject instructions, leak a planted secret and hijack the output. You see which attacks worked.",
  },
  {
    title: "Compare prompts on cost and safety",
    body: "Same task, same hidden inputs, blind votes. The leaderboard sorts by best, by the cheapest prompt that's still good, or by the safest.",
  },
];

/* Illustrative example, labelled as such on the page. */
const EXAMPLE_ROWS = [
  { model: "claude-haiku-4-5", run: "$0.0014", k: "$1.37" },
  { model: "gpt-5-mini", run: "$0.0005", k: "$0.45" },
  { model: "claude-sonnet-4-6", run: "$0.0041", k: "$4.10" },
];

export default function PromptsPage() {
  return (
    <>
      <Navbar />
      <main style={{ background: "var(--ground)", minHeight: "calc(100vh - 64px)" }}>
        <section style={{ background: "var(--paper)", borderBottom: "1px solid var(--rule)", padding: "80px 0 64px" }}>
          <div className="container" style={{ textAlign: "center" }}>
            <span style={{
              display: "inline-block", fontSize: 11, fontWeight: 700, color: "var(--ink)",
              textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 16,
            }}>Prompt library</span>
            <h1 style={{ fontSize: "clamp(34px, 9vw, 52px)", fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ink)", marginBottom: 16 }}>
              Know what a prompt costs and how it can be abused, before you ship it
            </h1>
            <p style={{ fontSize: 16, color: "var(--muted)", lineHeight: 1.7, maxWidth: 560, margin: "0 auto 28px" }}>
              A shared library for the prompts your team runs every week. Every prompt carries its cost per run and a danger score you can read.
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              <a href={START_HREF} className="btn-black">Score a prompt</a>
              <Link href="/book-demo" className="btn-outline">Talk to us</Link>
            </div>
          </div>
        </section>

        <section style={{ padding: "64px 0" }}>
          <div className="container prompts-split" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              {POINTS.map((p) => (
                <div key={p.title}>
                  <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--ink)", marginBottom: 6 }}>{p.title}</h2>
                  <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.7 }}>{p.body}</p>
                </div>
              ))}
            </div>

            <div style={{ background: "var(--paper)", borderRadius: 20, padding: "24px 24px 20px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Example
              </div>
              <pre style={{
                whiteSpace: "pre-wrap", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12.5, lineHeight: 1.6,
                color: "var(--ink)", background: "var(--ground)", borderRadius: 12, padding: 14, margin: "10px 0 18px",
              }}>
{`Read the support email {{email}} and send a reply
to the customer. Issue a refund if they ask.`}
              </pre>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--risk-critical)" }}>Critical danger</span>
                <span style={{ fontSize: 13, color: "var(--muted-2)" }}>98 / 100</span>
              </div>
              <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, marginBottom: 16 }}>
                Text pasted into <code>{"{{email}}"}</code> can rewrite what the model does, and this prompt can move money. One malicious email could issue a refund for the attacker.
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ color: "var(--muted-2)", textAlign: "left" }}>
                    <th style={{ padding: "6px 0", fontWeight: 600, borderBottom: "1px solid var(--rule)" }}>Model</th>
                    <th style={{ padding: "6px 0", fontWeight: 600, borderBottom: "1px solid var(--rule)", textAlign: "right" }}>Per run</th>
                    <th style={{ padding: "6px 0", fontWeight: 600, borderBottom: "1px solid var(--rule)", textAlign: "right" }}>Per 1,000</th>
                  </tr>
                </thead>
                <tbody>
                  {EXAMPLE_ROWS.map((r) => (
                    <tr key={r.model}>
                      <td style={{ padding: "7px 0", borderBottom: "1px solid var(--rule)", color: "var(--ink)" }}>{r.model}</td>
                      <td style={{ padding: "7px 0", borderBottom: "1px solid var(--rule)", textAlign: "right", color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{r.run}</td>
                      <td style={{ padding: "7px 0", borderBottom: "1px solid var(--rule)", textAlign: "right", color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{r.k}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 11.5, color: "var(--muted-2)", marginTop: 10 }}>
                Illustrative figures for a ~600-token input and 150-token output at list prices.
              </p>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <style>{`
        @media (max-width: 860px) { .prompts-split { grid-template-columns: 1fr !important; } }
      `}</style>
    </>
  );
}
