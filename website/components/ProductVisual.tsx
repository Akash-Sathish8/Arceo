"use client";

import { useFadeInOnScroll } from "../lib/useFadeIn";

/* Nodes arranged around a center Agent node */
const TOOLS = [
  { id: "stripe",     label: "Stripe",     x: 120, y:  80, lineColor: "#dc2626", lineLabel: "Irreversible", fill: "#fef2f2", stroke: "#fca5a5", text: "#dc2626" },
  { id: "zendesk",    label: "Zendesk",    x: 420, y:  80, lineColor: "#f59e0b", lineLabel: "Risky",        fill: "#fffbeb", stroke: "#fde68a", text: "#b45309" },
  { id: "github",     label: "GitHub",     x: 530, y: 230, lineColor: "#f59e0b", lineLabel: "Risky",        fill: "#fffbeb", stroke: "#fde68a", text: "#b45309" },
  { id: "sendgrid",   label: "SendGrid",   x: 120, y: 230, lineColor: "#9ca3af", lineLabel: "Safe",         fill: "#f9fafb", stroke: "#e5e7eb", text: "#6b7280" },
  { id: "slack",      label: "Slack",      x: 305, y: 320, lineColor: "#9ca3af", lineLabel: "Safe",         fill: "#f9fafb", stroke: "#e5e7eb", text: "#6b7280" },
];
const CENTER = { x: 305, y: 175 };
const NODE_W = 110, NODE_H = 44;

function AuthorityGraph() {
  return (
    <svg viewBox="0 0 650 380" fill="none" xmlns="http://www.w3.org/2000/svg"
      style={{ width: "100%", height: "auto" }}>

      {/* Connecting lines */}
      {TOOLS.map((t) => (
        <line key={t.id}
          x1={CENTER.x} y1={CENTER.y}
          x2={t.x} y2={t.y}
          stroke={t.lineColor}
          strokeWidth={t.lineColor === "#9ca3af" ? 1.5 : 2}
          strokeDasharray={t.lineColor === "#dc2626" ? "none" : t.lineColor === "#f59e0b" ? "6 3" : "none"}
          opacity={t.lineColor === "#9ca3af" ? 0.5 : 0.8}
        />
      ))}

      {/* Tool nodes */}
      {TOOLS.map((t) => (
        <g key={t.id}>
          <rect
            x={t.x - NODE_W / 2} y={t.y - NODE_H / 2}
            width={NODE_W} height={NODE_H} rx={10}
            fill={t.fill} stroke={t.stroke} strokeWidth={1.5}
          />
          <text x={t.x} y={t.y} textAnchor="middle" dominantBaseline="middle"
            fontSize={15} fontWeight="700" fill={t.text}
            fontFamily="var(--font-dm-sans), system-ui">
            {t.label}
          </text>
        </g>
      ))}

      {/* Center Agent node */}
      <g style={{ filter: "drop-shadow(0 4px 16px rgba(0,0,0,0.20))" }}>
        <rect
          x={CENTER.x - 60} y={CENTER.y - 30}
          width={120} height={60} rx={14}
          fill="#111827"
        />
        <text x={CENTER.x} y={CENTER.y - 6} textAnchor="middle" dominantBaseline="middle"
          fontSize={10} fontWeight="600" fill="rgba(255,255,255,0.45)"
          fontFamily="system-ui" letterSpacing="0.08em">AI</text>
        <text x={CENTER.x} y={CENTER.y + 12} textAnchor="middle" dominantBaseline="middle"
          fontSize={16} fontWeight="700" fill="#fff"
          fontFamily="var(--font-dm-sans), system-ui">Agent</text>
      </g>

      {/* Legend */}
      <g transform="translate(20, 345)">
        {[
          { color: "#dc2626", label: "Irreversible / Critical" },
          { color: "#f59e0b", label: "Risky" },
          { color: "#9ca3af", label: "Safe" },
        ].map((l, i) => (
          <g key={l.label} transform={`translate(${i * 185}, 0)`}>
            <line x1="0" y1="8" x2="20" y2="8" stroke={l.color} strokeWidth="2"
              strokeDasharray={l.color === "#f59e0b" ? "6 3" : "none"} opacity="0.8"/>
            <text x="28" y="8" dominantBaseline="middle" fontSize="12" fill="#9ca3af"
              fontFamily="system-ui" fontWeight="500">{l.label}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

export default function ProductVisual() {
  const { ref: textRef, className: textClass } = useFadeInOnScroll(0);

  return (
    <section style={{ padding: "96px 0", background: "#fff", borderTop: "1px solid #e5e7eb" }}>
      <div className="container">
        <div style={{ display: "grid", gridTemplateColumns: "5fr 7fr", gap: 64, alignItems: "center" }} className="pv-grid">

          {/* Text column */}
          <div ref={textRef} className={textClass}>
            <span className="eyebrow">Authority Mapping</span>
            <h2 style={{ fontSize: 42, fontWeight: 700, letterSpacing: "-0.8px", color: "#111827", marginBottom: 20, lineHeight: 1.15 }}>
              One view of everything your agent can reach
            </h2>
            <p style={{ fontSize: 16, color: "#6b7280", lineHeight: 1.75, marginBottom: 36 }}>
              Arceo maps every tool, API, and data source your AI agent can invoke, then scores the worst-case business impact if any of them were abused or compromised.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[
                { color: "#dc2626", bg: "#fef2f2", b: "#fecaca", label: "Critical / Irreversible", desc: "Actions that can't be undone: payments, bulk deletes, infrastructure" },
                { color: "#f59e0b", bg: "#fffbeb", b: "#fde68a", label: "Risky",                   desc: "External messaging, PII access, code execution" },
                { color: "#6b7280", bg: "#f9fafb", b: "#e5e7eb", label: "Safe",                    desc: "Read-only access, internal lookups, no side-effects" },
              ].map((item) => (
                <div key={item.label} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <span className="chip" style={{ color: item.color, background: item.bg, borderColor: item.b, marginTop: 2, flexShrink: 0 }}>{item.label}</span>
                  <span style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}>{item.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Graph column, full width, no obscuring gradients */}
          <div style={{
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            borderRadius: 20,
            padding: "32px 24px 24px",
            position: "relative",
            overflow: "hidden",
          }}>
            <div className="halftone" style={{ position: "absolute", inset: 0, opacity: 0.35, borderRadius: 20 }}/>
            <div style={{ position: "relative", zIndex: 1 }}>
              <AuthorityGraph />
            </div>
          </div>

        </div>
      </div>
      <style>{`@media (max-width: 860px) { .pv-grid { grid-template-columns: 1fr !important; gap: 48px !important; } }`}</style>
    </section>
  );
}
