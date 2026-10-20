"use client";

import Link from "next/link";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";
import PromptScoreBox from "../../components/PromptScoreBox";

/* Prompt library landing. Same shell, tokens and voice as /pricing: one
   message, what a prompt costs to run and how it can be abused, shown on a
   worked example rather than claimed. */

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:5173" : null);

const START_HREF = APP_URL ? `${APP_URL}/login?for=prompts` : "/book-demo";

const POINTS = [
  {
    title: "What it costs a month, on every model",
    body: "Paste a prompt and see what it costs a month at your volume on Claude, GPT and Gemini, and what switching models would save. Run QA and the answer length is measured, not guessed.",
  },
  {
    title: "How it can be abused, and the fix",
    body: "A 0-100 danger score with the reason behind every point: pasted keys or personal data, blanks where an email can rewrite your instructions, steps that act on what they read. Fix it for me rewrites the prompt safely in one click.",
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
              A shared library for the prompts your team runs every week. Every prompt carries its monthly cost and a danger score you can read, and fixes itself in one click.
            </p>
            <p style={{ fontSize: 13, color: "var(--muted-2)", margin: "0 auto 24px" }}>
              Free during beta: unlimited scoring and fixes, 10 test runs a month on us, or unlimited with your own model key.
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              <a href={START_HREF} className="btn-black">Start free</a>
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

            <PromptScoreBox />
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
