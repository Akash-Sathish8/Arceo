"use client";

import { useFadeInOnScroll } from "../lib/useFadeIn";

// Framed by category rather than by competitor name — it answers the
// "isn't this like X?" question without a public teardown.
const IS = [
  "Cost and risk governance for AI agents, in one report a finance team can sign off on",
  "Pre-deployment — the answer arrives before the agent handles a real request",
  "Platform-agnostic: Anthropic, OpenAI, MCP, GitHub, LangChain, or your own code",
];

const IS_NOT = [
  "Not an evaluation platform — we don't score whether your agent gives good answers",
  "Not an agent-security tool sold to a security team — our buyer is the CIO and the CFO together",
  "Not observability — those tools measure what you already spent, after deployment",
];

function Column({
  label, items, tone, delay,
}: {
  label: string;
  items: string[];
  tone: "is" | "not";
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
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--muted-2)" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
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
            fontSize: 44,
            fontWeight: 600,
            letterSpacing: "-0.4px",
            color: "var(--ink)",
            maxWidth: 760,
            margin: "0 auto 16px",
          }}>
            Everyone else measures agents after you deploy them
          </h2>
          <p style={{ fontSize: 20, color: "var(--muted)", maxWidth: 620, margin: "0 auto", lineHeight: 1.6 }}>
            Observability tells you what you already spent. Security tooling tells you what
            already broke. The decision that actually gates deployment happens before either,
            and nobody owns it.
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
          <Column label="What Arceo is not" items={IS_NOT} tone="not" delay={120} />
        </div>

        <p style={{
          textAlign: "center",
          marginTop: 56,
          fontSize: 22,
          fontWeight: 600,
          color: "var(--ink)",
          letterSpacing: "-0.2px",
        }}>
          We don&apos;t build agents. We govern them.
        </p>
      </div>

      <style>{`@media (max-width: 860px) { .pos-grid { grid-template-columns: 1fr !important; gap: 40px !important; } }`}</style>
    </section>
  );
}
