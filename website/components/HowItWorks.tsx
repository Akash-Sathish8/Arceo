"use client";

import { useFadeInOnScroll } from "../lib/useFadeIn";

const STEPS = [
  {
    n: "01",
    icon: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#2C2215" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 2a9 9 0 100 18A9 9 0 0011 2z"/>
        <path d="M7 11l3 3 5-5"/>
      </svg>
    ),
    title: "Connect any agent",
    desc: "Point Arceo at your agent, whether it's built on the Anthropic SDK, OpenAI, an MCP server, or a GitHub repo. It's read-only, there's no code to change, and nothing leaves your stack. Takes a couple of minutes.",
    mockup: (
      <div className="card" style={{ padding: "16px 18px" }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#87786A", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          Agent Sources
        </div>
        {[
          { label: "Anthropic SDK",        status: "Connected", c: "#16a34a", bg: "#dcfce7" },
          { label: "OpenAI Assistants",    status: "Connected", c: "#16a34a", bg: "#dcfce7" },
          { label: "MCP server / GitHub",  status: "Connected", c: "#16a34a", bg: "#dcfce7" },
          { label: "Write / modify access", status: "Not requested", c: "#87786A", bg: "#EBE4D8" },
        ].map((p) => (
          <div key={p.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #EBE4D8", gap: 10 }}>
            <div style={{ fontSize: 11.5, fontWeight: 500, color: "#2C2215", minWidth: 0, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.label}</div>
            <span style={{ fontSize: 9, fontWeight: 700, color: p.c, background: p.bg, padding: "2px 7px", borderRadius: 4, flexShrink: 0 }}>{p.status}</span>
          </div>
        ))}
        <div style={{ marginTop: 10, fontSize: 10.5, color: "#87786A", textAlign: "center" }}>Nothing leaves your stack · Read-only</div>
      </div>
    ),
  },
  {
    n: "02",
    icon: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#2C2215" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
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
    title: "Map capabilities, forecast cost",
    desc: "Arceo lists every tool the agent can call, sorts each by risk, and works out the monthly cost from its model, how much it runs, and real traces. The longer it watches, the tighter the number gets.",
    mockup: (
      <div className="card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#87786A", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>
          Capability Inventory
        </div>
        {[
          { name: "payments.refund",   type: "Payments", label: "moves_money",    labelColor: "#dc2626", labelBg: "#fef2f2" },
          { name: "db.delete_records", type: "Database", label: "deletes_data",   labelColor: "#ea580c", labelBg: "#fff7ed" },
          { name: "email.send",        type: "Email",    label: "sends_external", labelColor: "#2563eb", labelBg: "#eff6ff" },
          { name: "contacts.read",     type: "CRM",      label: "touches_pii",    labelColor: "#7c3aed", labelBg: "#faf5ff" },
        ].map((a) => (
          <div key={a.name} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "9px 0", borderBottom: "1px solid #EBE4D8", gap: 10,
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#2C2215", fontFamily: '"SF Mono", monospace', whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div>
              <div style={{ fontSize: 11, color: "#87786A", marginTop: 1 }}>{a.type}</div>
            </div>
            <span style={{
              fontSize: 10, fontWeight: 700, color: a.labelColor,
              background: a.labelBg, padding: "2px 8px", borderRadius: 4,
              whiteSpace: "nowrap", flexShrink: 0,
            }}>{a.label}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    n: "03",
    icon: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#2C2215" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 2L4 5.5v5c0 4.5 3.2 7.5 7 8.5 3.8-1 7-4 7-8.5v-5L11 2z"/>
        <path d="M8 11l2 2 4-4"/>
      </svg>
    ),
    title: "Get the danger/cost report",
    desc: "You get the monthly cost with a confidence range, the worst case in dollars if a risky chain fires, and a budget cap you can actually enforce. It's one report, written so a CFO can sign it.",
    mockup: (
      <div className="card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#87786A", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Monthly forecast</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginBottom: 5 }}>
          <span style={{ fontSize: 52, fontWeight: 800, color: "#2C6E9E", fontFamily: "var(--font-poppins), system-ui", letterSpacing: "-2px", lineHeight: 1 }}>$20</span>
          <span style={{ fontSize: 16, color: "#C9BBA8" }}>/mo</span>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#2C6E9E", letterSpacing: "0.04em", marginBottom: 18 }}>±15% · HIGH CONFIDENCE</div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "#87786A", marginBottom: 6 }}>
          <span>Projected range</span><span>$17 to $23 / mo</span>
        </div>
        <div style={{ height: 8, background: "#EBE4D8", borderRadius: 999, overflow: "hidden", marginBottom: 16, position: "relative" }}>
          <div style={{ position: "absolute", left: "20%", width: "32%", top: 0, bottom: 0, background: "linear-gradient(90deg, #7BC0E8, #2C6E9E)", borderRadius: 999 }}/>
        </div>
        <div style={{ paddingTop: 12, borderTop: "1px solid #EBE4D8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#BE123C" }}>Worst case if a chain fires</span>
          <span style={{ fontSize: 14, fontWeight: 800, color: "#BE123C" }}>up to $50k</span>
        </div>
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
        background: "#FAF6F0",
        border: "1px solid #E0D7C9",
        borderRadius: 36,
        padding: "32px",
        boxShadow: "var(--shadow-md)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      <div style={{
        fontSize: 48,
        fontWeight: 800,
        color: "#BFDDF0",
        lineHeight: 1,
        letterSpacing: "-0.02em",
        marginBottom: 20,
        userSelect: "none",
      }}>
        {step.n}
      </div>

      <div style={{
        width: 48,
        height: 48,
        background: "#EBE4D8",
        border: "1px solid #E0D7C9",
        borderRadius: 999,
        boxShadow: "var(--shadow-xs)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginBottom: 16,
      }}>
        {step.icon}
      </div>

      <h3 style={{ fontSize: 20, fontWeight: 600, color: "#2C2215", letterSpacing: "-0.02em", marginBottom: 10 }}>
        {step.title}
      </h3>
      <p style={{ fontSize: 14, color: "#6B5C4A", lineHeight: 1.7, marginBottom: 22 }}>
        {step.desc}
      </p>
      <div style={{ marginTop: "auto" }}>{step.mockup}</div>
    </div>
  );
}

export default function HowItWorks() {
  return (
    <section style={{ padding: "112px 0", background: "#FAF6F0", borderTop: "1px solid #E0D7C9" }}>
      <div className="container">
        <div style={{ textAlign: "center", marginBottom: 56 }}>
          <span className="eyebrow">How It Works</span>
          <h2 style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.4px", color: "#2C2215" }}>
            From connected agent, to a report you can read. In minutes.
          </h2>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24, alignItems: "stretch", position: "relative" }} className="steps-grid">
          <div style={{
            position: "absolute",
            top: 56,
            left: "calc(33.33% + 12px)",
            right: "calc(33.33% + 12px)",
            height: 1,
            background: "#E0D7C9",
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
            border-left: 6px solid #C9BBA8;
          }
        }
        @media (max-width: 768px) { .steps-grid { grid-template-columns: 1fr !important; } }
      `}</style>
    </section>
  );
}
