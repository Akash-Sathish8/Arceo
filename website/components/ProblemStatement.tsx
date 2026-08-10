"use client";

import { useFadeInOnScroll } from "../lib/useFadeIn";

const TOOLS = [
  {
    name: "email.send",
    desc: "Sends email on the agent's behalf, no confirmation needed. Every call costs a little, and any one of them can send company data to the wrong person.",
    perm: "sends_external",
    permColor: "#2563eb", permBg: "rgba(37,99,235,0.08)", permBorder: "rgba(37,99,235,0.2)",
    scoreLabel: "High",
  },
  {
    name: "payments.refund",
    desc: "Refunds money to a customer. If nothing checks it first, the agent can move real money with nobody in the loop, and there's no ceiling on how bad that gets.",
    perm: "moves_money",
    permColor: "#dc2626", permBg: "rgba(220,38,38,0.08)", permBorder: "rgba(220,38,38,0.2)",
    scoreLabel: "Critical",
  },
  {
    name: "db.delete_records",
    desc: "Deletes records for good, no undo. When it runs right after the agent reads sensitive data, Arceo flags it as a cover-up and puts a dollar figure on the damage.",
    perm: "deletes_data",
    permColor: "#ea580c", permBg: "rgba(234,88,12,0.08)", permBorder: "rgba(234,88,12,0.2)",
    scoreLabel: "Critical",
  },
];

function ToolCard({ tool, delay }: { tool: typeof TOOLS[0]; delay: number }) {
  const { ref, className } = useFadeInOnScroll(delay);

  return (
    <div ref={ref} className={className} style={{
      background: "#FAF6F0",
      border: "1px solid #E0D7C9",
      borderRadius: 24,
      padding: "28px",
      minHeight: 200,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      gap: 14,
      position: "relative",
      boxShadow: "var(--shadow-md)",
    }}>
      {/* Top: action name + severity */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span className="mono" style={{
          fontSize: 14, fontWeight: 700,
          color: "#2C2215",
          background: "#EBE4D8",
          border: "1px solid #E0D7C9",
          padding: "6px 14px", borderRadius: 999,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {tool.name}
        </span>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color: "#fff",
          background: tool.permColor,
          padding: "4px 12px",
          borderRadius: 999,
          letterSpacing: "0.02em",
          flexShrink: 0,
        }}>
          {tool.scoreLabel}
        </span>
      </div>

      {/* Risk label — the real classification, as the focal element */}
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em",
        color: tool.permColor,
      }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: tool.permColor, flexShrink: 0 }} />
        {tool.perm}
      </span>

      {/* Description */}
      <p style={{ fontSize: 14, color: "#6B5C4A", lineHeight: 1.65, flexGrow: 1 }}>
        {tool.desc}
      </p>
    </div>
  );
}

export default function ProblemStatement() {
  const { ref: headRef, className: headClass } = useFadeInOnScroll();

  return (
    <section id="problem" style={{ padding: "112px 0", background: "#F3EDE4" }}>
      <div className="container">
        <div ref={headRef} className={headClass} style={{ textAlign: "center", marginBottom: 56 }}>
          <span className="eyebrow">The Problem</span>
          <h2 style={{
            fontSize: 44,
            fontWeight: 600,
            letterSpacing: "-0.4px",
            color: "#2C2215",
            maxWidth: 720,
            margin: "0 auto 16px",
          }}>
            Two questions block every agent from production: what will it cost, and what could go wrong?
          </h2>
          <p style={{ fontSize: 20, color: "#6B5C4A", maxWidth: 600, margin: "0 auto", lineHeight: 1.6 }}>
            Token costs add up in ways nobody predicts, and you usually find the worst case the hard way, after it&apos;s live. Every action your agent can take is both a line on the bill and a way things go wrong. Arceo puts a number on both before you deploy.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }} className="cards-grid">
          {TOOLS.map((t, i) => <ToolCard key={t.name} tool={t} delay={i * 100} />)}
        </div>
      </div>
      <style>{`@media (max-width: 768px) { .cards-grid { grid-template-columns: 1fr !important; } }`}</style>
    </section>
  );
}
