"use client";

import { useFadeInOnScroll } from "../lib/useFadeIn";

// Framed by category, so it answers the "isn't this like X?" question
// without a public teardown. Both columns state positions: the right one
// places each neighbouring category and where Arceo sits beside it.
const IS = [
  "Cost and risk for AI agents, in one report a finance team can sign off on",
  "Pre-deployment: the answer arrives before the agent handles a real request",
  "Platform-agnostic: Anthropic, OpenAI, MCP, GitHub, LangChain, or your own code",
];

const DIFFERS = [
  "Evaluation platforms score answer quality; Arceo prices what the agent can reach",
  "Security tools sell to the CISO; Arceo reports to the CIO and the CFO",
  "Observability measures spend after deploy; Arceo forecasts it before",
];

function Column({
  label, items, tone, delay,
}: {
  label: string;
  items: string[];
  tone: "is" | "differs";
  delay: number;
}) {
  const { ref, className } = useFadeInOnScroll(delay);
  const accent = tone === "is" ? "var(--ink)" : "var(--muted-2)";

  return (
    <div ref={ref} className={className}>
      <div style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: accent,
        marginBottom: 18,
      }}>
        {label}
      </div>

      <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 14 }}>
        {items.map((t) => (
          <li key={t} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ flexShrink: 0, marginTop: 5 }}>
              {tone === "is" ? (
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--ink)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 8.5 6.5 12 13 4" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--muted-2)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" />
                </svg>
              )}
            </span>
            <span style={{
              fontSize: 15.5,
              lineHeight: 1.6,
              color: tone === "is" ? "var(--ink)" : "var(--muted)",
              fontWeight: tone === "is" ? 500 : 400,
            }}>
              {t}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Positioning() {
  const { ref: headRef, className: headClass } = useFadeInOnScroll();

  return (
    <section id="positioning" style={{ padding: "104px 0", background: "var(--paper)" }}>
      <div className="container">
        <div ref={headRef} className={headClass} style={{ textAlign: "center", marginBottom: 56 }}>
          <span className="eyebrow">Where we fit</span>
          <h2 style={{
            fontSize: "clamp(30px, 8vw, 44px)",
            fontWeight: 600,
            letterSpacing: "-0.4px",
            color: "var(--ink)",
            maxWidth: 760,
            margin: "0 auto 16px",
          }}>
            Everyone else measures agents after you deploy them
          </h2>
          <p style={{ fontSize: 20, color: "var(--muted)", maxWidth: 620, margin: "0 auto", lineHeight: 1.6 }}>
            Observability tells you what you already spent. Security tooling tells you
            what already broke. Arceo answers the question that gates deployment,
            before the agent goes live.
          </p>
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 48,
          maxWidth: 960,
          margin: "0 auto",
        }} className="pos-grid">
          <Column label="What Arceo is" items={IS} tone="is" delay={0} />
          <Column label="How Arceo differs" items={DIFFERS} tone="differs" delay={120} />
        </div>

        <p style={{
          textAlign: "center",
          marginTop: 56,
          fontSize: 22,
          fontWeight: 600,
          color: "var(--ink)",
          letterSpacing: "-0.2px",
        }}>
          Arceo governs the agents you build.
        </p>
      </div>

      <style>{`@media (max-width: 860px) { .pos-grid { grid-template-columns: 1fr !important; gap: 40px !important; } }`}</style>
    </section>
  );
}
