"use client";

import { useFadeInOnScroll } from "../lib/useFadeIn";

const STEPS = [
  {
    n: "01",
    icon: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#374151" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 2a9 9 0 100 18A9 9 0 0011 2z"/>
        <path d="M7 11l3 3 5-5"/>
      </svg>
    ),
    title: "Connect any agent",
    desc: "Point Arceo at your agent — an Anthropic or OpenAI SDK, an MCP server, or a GitHub repo. No code changes and no production traffic required. Setup takes under 2 minutes.",
    mockup: (
      <div className="card" style={{ padding: "16px 18px" }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          Connect your agent
        </div>
        {[
          { label: "Anthropic / OpenAI SDK", status: "Connected", c: "#16a34a", bg: "#dcfce7" },
          { label: "MCP server",             status: "Connected", c: "#16a34a", bg: "#dcfce7" },
          { label: "GitHub repo scan",       status: "Connected", c: "#16a34a", bg: "#dcfce7" },
          { label: "Production traffic",     status: "Not required", c: "#6b7280", bg: "#f3f4f6" },
        ].map((p) => (
          <div key={p.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f9fafb", gap: 10 }}>
            <div style={{ fontSize: 11.5, fontWeight: 500, color: "#111827", minWidth: 0, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.label}</div>
            <span style={{ fontSize: 9, fontWeight: 700, color: p.c, background: p.bg, padding: "2px 7px", borderRadius: 4, flexShrink: 0 }}>{p.status}</span>
          </div>
        ))}
        <div style={{ marginTop: 10, fontSize: 10.5, color: "#9ca3af", textAlign: "center" }}>No code changes · Read-only</div>
      </div>
    ),
  },
  {
    n: "02",
    icon: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#374151" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="3"/>
        <circle cx="4"  cy="5"  r="2"/>
        <circle cx="18" cy="5"  r="2"/>
        <circle cx="4"  cy="17" r="2"/>
        <circle cx="18" cy="17" r="2"/>
        <line x1="8" y1="10" x2="6" y2="6.5"/>
        <line x1="14" y1="10" x2="16" y2="6.5"/>
        <line x1="8" y1="12" x2="6" y2="15.5"/>
        <line x1="14" y1="12" x2="16" y2="15.5"/>
      </svg>
    ),
    title: "Arceo maps and prices every action",
    desc: "We enumerate every tool, API, and function your agent can invoke — then forecast what each costs to run and score its blast radius against your data and money.",
    mockup: (
      <div className="card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>
          Agent action inventory
        </div>
        {[
          { name: "create_refund",  type: "Stripe",   label: "moves_money",    labelColor: "#dc2626", labelBg: "#fef2f2", score: 94 },
          { name: "delete_records", type: "Postgres", label: "deletes_data",   labelColor: "#ea580c", labelBg: "#fff7ed", score: 88 },
          { name: "send_email",     type: "SendGrid", label: "sends_external", labelColor: "#2563eb", labelBg: "#eff6ff", score: 68 },
          { name: "get_contact",    type: "HubSpot",  label: "touches_pii",    labelColor: "#7c3aed", labelBg: "#faf5ff", score: 42 },
        ].map((a) => (
          <div key={a.name} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "9px 0", borderBottom: "1px solid #f3f4f6", gap: 10,
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", fontFamily: '"SF Mono", monospace', whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div>
              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>{a.type}</div>
            </div>
            <span style={{
              fontSize: 10, fontWeight: 700, color: a.labelColor,
              background: a.labelBg, padding: "2px 8px", borderRadius: 4,
              whiteSpace: "nowrap", flexShrink: 0,
            }}>{a.label}</span>
            <span style={{ fontSize: 13, fontWeight: 800, color: a.labelColor, width: 24, textAlign: "right", flexShrink: 0 }}>{a.score}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    n: "03",
    icon: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#374151" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 2L4 5.5v5c0 4.5 3.2 7.5 7 8.5 3.8-1 7-4 7-8.5v-5L11 2z"/>
        <path d="M8 11l2 2 4-4"/>
      </svg>
    ),
    title: "Deploy with confidence",
    desc: "A monthly cost forecast, a 0–100 blast-radius score, and flagged dangerous chains — one CFO-readable report, ready before you flip the agent live.",
    mockup: (
      <div className="card" style={{ padding: "16px 18px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.08em", paddingTop: 8 }}>Blast Radius</span>
          <div style={{ textAlign: "right", lineHeight: 1 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
              <span style={{ fontSize: 80, fontWeight: 800, color: "#dc2626", fontFamily: "var(--font-dm-sans), system-ui", letterSpacing: "-4px" }}>87</span>
              <span style={{ fontSize: 18, color: "#d1d5db" }}>/100</span>
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", letterSpacing: "0.04em", marginTop: 2 }}>CRITICAL</div>
          </div>
        </div>
        <div style={{ height: 8, background: "#f3f4f6", borderRadius: 999, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ height: "100%", width: "87%", background: "linear-gradient(90deg, #f97316, #ef4444)", borderRadius: 999 }}/>
        </div>
        {[
          { l: "moves_money",  v: 94, c: "#dc2626" },
          { l: "deletes_data", v: 88, c: "#ea580c" },
          { l: "sends_external", v: 68, c: "#2563eb" },
        ].map((r) => (
          <div key={r.l} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }}>
            <span className="mono" style={{ fontSize: 10.5, fontWeight: 600, color: r.c, width: 116, flexShrink: 0 }}>{r.l}</span>
            <div style={{ flex: 1, height: 5, background: "#f3f4f6", borderRadius: 999, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${r.v}%`, background: r.c, opacity: 0.55, borderRadius: 999 }}/>
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, color: r.c, width: 22, textAlign: "right" }}>{r.v}</span>
          </div>
        ))}
      </div>
    ),
  },
];

function StepCard({ step, i }: { step: typeof STEPS[0]; i: number }) {
  const { ref, className } = useFadeInOnScroll(i * 120);
  return (
    <div
      ref={ref}
      className={className}
      style={{
        position: "relative",
        zIndex: 1,
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 16,
        padding: "32px",
        boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      <div style={{
        fontSize: 48,
        fontWeight: 800,
        color: "#e5e7eb",
        lineHeight: 1,
        letterSpacing: "-0.02em",
        marginBottom: 20,
        userSelect: "none",
      }}>
        {step.n}
      </div>

      <div style={{
        width: 44,
        height: 44,
        background: "#f9fafb",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginBottom: 16,
      }}>
        {step.icon}
      </div>

      <h3 style={{ fontSize: 18, fontWeight: 700, color: "#111827", letterSpacing: "-0.02em", marginBottom: 10 }}>
        {step.title}
      </h3>
      <p style={{ fontSize: 14, color: "#6b7280", lineHeight: 1.7, marginBottom: 22 }}>
        {step.desc}
      </p>
      <div style={{ marginTop: "auto" }}>{step.mockup}</div>
    </div>
  );
}

export default function HowItWorks() {
  return (
    <section style={{ padding: "96px 0", background: "#f8faff", borderTop: "1px solid #e5e7eb" }}>
      <div className="container">
        <div style={{ textAlign: "center", marginBottom: 56 }}>
          <span className="eyebrow">How It Works</span>
          <h2 style={{ fontSize: 48, fontWeight: 700, letterSpacing: "-0.02em", color: "#111827" }}>
            Your cost + risk report in three steps
          </h2>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24, alignItems: "stretch", position: "relative" }} className="steps-grid">
          <div style={{
            position: "absolute",
            top: 56,
            left: "calc(33.33% + 12px)",
            right: "calc(33.33% + 12px)",
            height: 1,
            background: "#e5e7eb",
            zIndex: 0,
            display: "none",
          }} className="step-connector"/>

          {STEPS.map((step, i) => (
            <StepCard key={step.n} step={step} i={i} />
          ))}
        </div>
      </div>
      <style>{`
        @media (min-width: 900px) {
          .step-connector { display: block !important; }
          .step-connector::after {
            content: '';
            position: absolute;
            right: -5px;
            top: -4px;
            width: 0;
            height: 0;
            border-top: 4px solid transparent;
            border-bottom: 4px solid transparent;
            border-left: 6px solid #d1d5db;
          }
        }
        @media (max-width: 768px) { .steps-grid { grid-template-columns: 1fr !important; } }
      `}</style>
    </section>
  );
}
