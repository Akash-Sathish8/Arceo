"use client";

import Link from "next/link";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";
import PromptScoreBox from "../../components/PromptScoreBox";

/* Prompt library landing, written for people who use AI at work but don't
   build software: no tokens, models-as-IDs or security jargon. Same shell
   and tokens as /pricing; the claim is shown on a worked example. */

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:5173" : null);

const START_HREF = APP_URL ? `${APP_URL}/login?for=prompts` : "/book-demo";

const POINTS = [
  {
    title: "Know what it costs before the bill comes",
    body: "Paste in something you ask ChatGPT or Claude to do. See what it costs a month at the rate you use it, on Claude, GPT and Gemini, and how much a cheaper AI would save you.",
  },
  {
    title: "Spot what could go wrong, in plain English",
    body: "Every prompt gets a safety rating with the reason behind it: a password left in by mistake, a customer's personal details, or a spot where a stranger's email could trick the AI. Fix it for me makes it safer in one click.",
  },
  {
    title: "Tested before you share it",
    body: "We run your prompt on a real AI to check it does the job, then try to trick it the way a scammer would. You see what held up and what didn't.",
  },
  {
    title: "Find the best prompt for the job",
    body: "Ask your team or the community to write a prompt for the same task. People vote on the answers without knowing whose is whose, and you see which is best, which is cheapest and which is safest.",
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
              AI prompts your team can trust, with the price on the label
            </h1>
            <p style={{ fontSize: 16, color: "var(--muted)", lineHeight: 1.7, maxWidth: 560, margin: "0 auto 28px" }}>
              One shared place for the things your team asks AI to do every week. Every prompt shows what it costs a month and whether it's safe to use, and you can make it safer in one click.
            </p>
            <p style={{ fontSize: 13, color: "var(--muted-2)", margin: "0 auto 24px" }}>
              Free during beta: unlimited checks and fixes, plus 10 free tests a month. No setup and no technical knowledge needed.
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
