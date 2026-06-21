"use client";

import { useFadeInOnScroll } from "../lib/useFadeIn";

const TOOLS = [
  {
    name: "sendgrid.send_email",
    desc: "Sends email to any recipient in your name — no confirmation required. An agent with this tool can email customers, partners, or anyone on file, and every send is metered spend.",
    perm: "sends_external",
    permColor: "#2563eb", permBg: "rgba(37,99,235,0.08)", permBorder: "rgba(37,99,235,0.2)",
    score: 68,
    scoreLabel: "High",
  },
  {
    name: "stripe.create_refund",
    desc: "Issues a full or partial refund to a customer's payment method. Called without a prior approval step, this moves real money with no human checkpoint.",
    perm: "moves_money",
    permColor: "#dc2626", permBg: "rgba(220,38,38,0.08)", permBorder: "rgba(220,38,38,0.2)",
    score: 94,
    scoreLabel: "Critical",
  },
  {
    name: "db.delete_records",
    desc: "Permanently deletes records matching a filter. No recycle bin. If chained after a data read, Arceo flags this as a cover-up chain.",
    perm: "deletes_data",
    permColor: "#ea580c", permBg: "rgba(234,88,12,0.08)", permBorder: "rgba(234,88,12,0.2)",
    score: 88,
    scoreLabel: "Critical",
  },
];

function ToolCard({ tool, delay }: { tool: typeof TOOLS[0]; delay: number }) {
  const { ref, className } = useFadeInOnScroll(delay);

  return (
    <div ref={ref} className={className} style={{
      background: "#fff",
      border: "1px solid #e5e7eb",
      borderRadius: 16,
      padding: "24px",
      minHeight: 200,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      gap: 14,
      position: "relative",
      boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    }}>
      {/* Score — dominant element at top */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        <div>
          <div style={{
            fontSize: 72,
            fontWeight: 800,
            color: tool.permColor,
            lineHeight: 1,
            letterSpacing: "-0.04em",
          }}>
            {tool.score}
          </div>
          <div style={{ fontSize: 12, color: tool.permColor, fontWeight: 600, opacity: 0.7, marginTop: 2 }}>/100</div>
        </div>
        {/* Severity badge */}
        <span style={{
          fontSize: 12,
          fontWeight: 700,
          color: "#fff",
          background: tool.permColor,
          padding: "4px 12px",
          borderRadius: 999,
          letterSpacing: "0.02em",
          alignSelf: "flex-start",
          marginTop: 8,
          flexShrink: 0,
        }}>
          {tool.scoreLabel}
        </span>
      </div>

      {/* Action name */}
      <div className="mono" style={{
        fontSize: 13, fontWeight: 700,
        color: "#374151",
        background: "#f3f4f6",
        border: "1px solid #e5e7eb",
        padding: "5px 12px", borderRadius: 6,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {tool.name}
      </div>

      {/* Description */}
      <p style={{ fontSize: 14, color: "#6b7280", lineHeight: 1.65, flexGrow: 1 }}>
        {tool.desc}
      </p>

      {/* Bottom: risk label chip + bar */}
      <div style={{ marginTop: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            fontSize: 11, fontWeight: 700, letterSpacing: "0.03em",
            padding: "3px 9px", borderRadius: 999,
            color: tool.permColor,
            background: tool.permBg,
            border: `1px solid ${tool.permBorder}`,
            whiteSpace: "nowrap",
          }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: tool.permColor, flexShrink: 0 }} />
            {tool.perm}
          </span>
        </div>
        <div style={{ height: 4, background: "#f3f4f6", borderRadius: 999, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${tool.score}%`, background: tool.permColor, opacity: 0.7, borderRadius: 999 }} />
        </div>
      </div>
    </div>
  );
}

export default function ProblemStatement() {
  const { ref: headRef, className: headClass } = useFadeInOnScroll();

  return (
    <section id="features" style={{ padding: "96px 0", background: "#fff" }}>
      <div className="container">
        <div ref={headRef} className={headClass} style={{ textAlign: "center", marginBottom: 56 }}>
          <span className="eyebrow">The Problem</span>
          <h2 style={{
            fontSize: 48,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "#111827",
            maxWidth: 680,
            margin: "0 auto 16px",
          }}>
            Your AI agents touch money, data, and production. Few teams can say what that costs — or what could go wrong.
          </h2>
          <p style={{ fontSize: 16, color: "#6b7280", maxWidth: 520, margin: "0 auto", lineHeight: 1.6 }}>
            Every tool an agent can call is a line item and a liability. Arceo scores both — monthly cost and worst-case blast radius — before a single request hits production.
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
