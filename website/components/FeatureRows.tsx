"use client";

const FEATURES = [
  {
    tag: "Cost Forecasting",
    headline: "Know what it costs before the first invoice",
    body: "Arceo works out each agent's monthly bill from its tools, model, and how much it runs. As real traces come in, the number tightens to within about 15%. Set a budget cap, and if spend starts heading past it, you hear about it. The figure comes back in plain English, ready for the CFO.",
    mockup: (
      <div style={{
        background: "#0d1117",
        borderRadius: 16,
        padding: "24px",
        overflow: "hidden",
        minHeight: 240,
        fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
      }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
          {["#ff5f56", "#ffbd2e", "#27c93f"].map(c => (
            <div key={c} style={{ width: 10, height: 10, borderRadius: "50%", background: c, flexShrink: 0 }} />
          ))}
        </div>

        {[
          { text: "forecasting Beacon Support...",          glow: false, dim: true  },
          { text: "",                                        glow: false, dim: false },
          { text: "  model: claude-sonnet",                 glow: false, dim: true  },
          { text: "  monthly: $20  ±15%",                   glow: true,  dim: false },
          { text: "  range: $17 to $23 / mo",               glow: false, dim: true  },
          { text: "  worst case (pii to external): $50k",   glow: true,  dim: false },
          { text: "",                                        glow: false, dim: true  },
          { text: "  confidence: high (654 live calls)",    glow: true,  dim: false },
        ].map((line, i) => (
          <div key={i} style={{
            fontSize: 11,
            color: line.dim
              ? "rgba(74,222,128,0.3)"
              : line.glow
                ? "#4ade80"
                : "rgba(74,222,128,0.65)",
            lineHeight: 1.7,
            letterSpacing: "0.01em",
            textShadow: line.glow ? "0 0 10px rgba(74,222,128,0.45)" : "none",
            minHeight: "1.7em",
          }}>
            {line.text || " "}
          </div>
        ))}
      </div>
    ),
  },
  {
    tag: "Capability Mapping",
    headline: "See every tool your agent can call",
    body: "Arceo lists every tool, API, and action an agent has access to and tags each one with a plain risk label your security and finance people can read without a glossary. No code required, and it works whether the agent runs on the Anthropic SDK, OpenAI, an MCP server, or a GitHub repo.",
    mockup: (
      <div className="card" style={{ padding: "24px", overflow: "hidden", minHeight: 240 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#87786A", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
          Capability Inventory · Support Agent
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,0.7fr) minmax(0,1fr) minmax(0,0.7fr)", gap: 8, paddingBottom: 8, borderBottom: "1px solid #EBE4D8" }}>
          {["Action", "Type", "Risk label", "Status"].map(h => (
            <span key={h} style={{ fontSize: 9, fontWeight: 700, color: "#C9BBA8", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</span>
          ))}
        </div>

        {[
          { action: "payments.refund",   type: "Payments", label: "moves_money",    color: "#dc2626", bg: "#fef2f2", status: "BLOCK"  },
          { action: "db.delete_records", type: "Database", label: "deletes_data",   color: "#ea580c", bg: "#fff7ed", status: "BLOCK"  },
          { action: "email.send",        type: "Email",    label: "sends_external", color: "#2563eb", bg: "#eff6ff", status: "WARN"   },
          { action: "contacts.read",     type: "CRM",      label: "touches_pii",    color: "#7c3aed", bg: "#faf5ff", status: "ALLOW"  },
        ].map((row, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,0.7fr) minmax(0,1fr) minmax(0,0.7fr)", gap: 8, padding: "9px 0", borderBottom: "1px solid #EBE4D8", alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 9.5, color: "#2C2215", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.action}</span>
            <span style={{ fontSize: 9, color: "#87786A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.type}</span>
            <span className="mono" style={{ fontSize: 9, fontWeight: 700, color: row.color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
            <span style={{ fontSize: 8.5, fontWeight: 700, color: row.color, background: row.bg, padding: "2px 6px", borderRadius: 4, textAlign: "center" }}>{row.status}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    tag: "Chain Detection",
    headline: "Catch the multi-step risks a single-action scan misses",
    body: "Most scanners look at one action at a time. Arceo watches for dangerous sequences instead, like an agent that reads customer records and then emails them out, or deletes data right after a query, and tells you what each one could cost. It runs 15 of these rules before the agent ever handles a real request.",
    mockup: (
      <div className="card" style={{ padding: "24px", overflow: "hidden", minHeight: 240 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#87786A", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 18 }}>
          Detected Chain · PII Exfiltration
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 16 }}>
          <div style={{
            flex: 1,
            padding: "12px 10px",
            background: "#faf5ff",
            border: "1px solid #d8b4fe",
            borderRadius: 10,
            textAlign: "center",
          }}>
            <div className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "#7c3aed", marginBottom: 4 }}>contacts.read</div>
            <div style={{ fontSize: 9, color: "#a855f7", fontWeight: 600, letterSpacing: "0.04em" }}>touches_pii</div>
          </div>

          <svg width="32" height="20" viewBox="0 0 32 20" fill="none" style={{ flexShrink: 0 }}>
            <line x1="2" y1="10" x2="26" y2="10" stroke="#dc2626" strokeWidth="2" strokeDasharray="3 2"/>
            <path d="M22 4l8 6-8 6" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          </svg>

          <div style={{
            flex: 1,
            padding: "12px 10px",
            background: "#eff6ff",
            border: "1px solid #93c5fd",
            borderRadius: 10,
            textAlign: "center",
          }}>
            <div className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "#2563eb", marginBottom: 4 }}>email.send</div>
            <div style={{ fontSize: 9, color: "#3b82f6", fontWeight: 600, letterSpacing: "0.04em" }}>sends_external</div>
          </div>
        </div>

        <div style={{
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: 10,
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", marginBottom: 2 }}>PII exfiltration chain detected</div>
            <div style={{ fontSize: 10.5, color: "#991b1b" }}>Reads customer records, then sends external email. Recommend BLOCK or REQUIRE_APPROVAL on <span className="mono">email.send</span>.</div>
          </div>
          <span style={{ fontSize: 9, fontWeight: 700, color: "#fff", background: "#dc2626", padding: "3px 8px", borderRadius: 4, letterSpacing: "0.04em", flexShrink: 0 }}>CRITICAL</span>
        </div>

        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #EBE4D8", display: "flex", gap: 24 }}>
          {[{ n: "15", l: "Chain rules" }, { n: "5", l: "Risk labels" }, { n: "$50k", l: "Worst case" }].map(s => (
            <div key={s.l}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#2C2215", lineHeight: 1, letterSpacing: "-0.02em" }}>{s.n}</div>
              <div style={{ fontSize: 10, color: "#87786A", marginTop: 3 }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>
    ),
  },
];

function FeatureRow({ f, index }: { f: typeof FEATURES[0]; index: number }) {
  const even = index % 2 === 0;

  return (
    <div className="feature-row" style={{
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 80,
      alignItems: "center",
      padding: "56px 0",
      borderBottom: "1px solid #E0D7C9",
    }}>
      <div style={{ order: even ? 0 : 1 }}>
        <span className="eyebrow">{f.tag}</span>
        <h3 style={{ fontSize: 36, fontWeight: 600, letterSpacing: "-0.02em", color: "#2C2215", marginBottom: 16, lineHeight: 1.2 }}>
          {f.headline}
        </h3>
        <p style={{ fontSize: 20, color: "#6B5C4A", lineHeight: 1.75 }}>{f.body}</p>
      </div>
      <div style={{ order: even ? 1 : 0 }}>{f.mockup}</div>
    </div>
  );
}

export default function FeatureRows() {
  return (
    <section id="features" style={{ padding: "112px 0", background: "#FAF6F0", borderTop: "1px solid #E0D7C9" }}>
      <div className="container">
        {/* Section header — always visible, no fade-in */}
        <div style={{ marginBottom: 48 }}>
          <span className="eyebrow">Features</span>
          <h2 style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.4px", color: "#2C2215" }}>
            Cost and risk, in one report
          </h2>
        </div>

        {/* Trust signal row */}
        <div style={{
          display: "flex", alignItems: "center", gap: 0,
          marginBottom: 64,
          background: "#FAF6F0",
          border: "1px solid #E0D7C9",
          borderRadius: 24,
          boxShadow: "var(--shadow-md)",
          overflow: "hidden",
        }} className="trust-row">
          {[
            {
              icon: (
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
                  <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
                </svg>
              ),
              label: "Connect any agent", sub: "Anthropic, OpenAI, MCP, GitHub",
            },
            {
              icon: (
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 3v18h18" />
                  <path d="M7 14l3-4 3 3 4-6" />
                </svg>
              ),
              label: "Forecast before you ship", sub: "Predeployment, not post-hoc",
            },
            {
              icon: (
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 2h8l4 4v16H6z" />
                  <path d="M14 2v4h4" />
                  <path d="M9 13h6M9 17h6" />
                </svg>
              ),
              label: "Readable financial report", sub: "Cost + worst case in one view",
            },
          ].map((t, i) => (
            <div key={t.label} style={{
              flex: 1,
              padding: "20px 24px",
              borderRight: i < 2 ? "1px solid #E0D7C9" : "none",
              display: "flex", alignItems: "center", gap: 14,
            }}>
              <span style={{
                flexShrink: 0,
                width: 38, height: 38,
                borderRadius: 12,
                background: "#EBE4D8",
                border: "1px solid #E0D7C9",
                color: "#2C6E9E",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>{t.icon}</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#2C2215", marginBottom: 2 }}>{t.label}</div>
                <div style={{ fontSize: 12, color: "#87786A" }}>{t.sub}</div>
              </div>
            </div>
          ))}
        </div>

        {FEATURES.map((f, i) => <FeatureRow key={i} f={f} index={i} />)}
      </div>

      <style>{`
        @media (max-width: 860px) {
          .feature-row { grid-template-columns: 1fr !important; gap: 32px !important; }
          .feature-row > div { order: unset !important; }
          .trust-row { flex-direction: column !important; }
          .trust-row > div { border-right: none !important; border-bottom: 1px solid #E0D7C9; }
          .trust-row > div:last-child { border-bottom: none !important; }
        }
      `}</style>
    </section>
  );
}
