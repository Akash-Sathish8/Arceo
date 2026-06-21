"use client";

const FEATURES = [
  {
    tag: "Action inventory",
    headline: "See — and price — every action your agent can take",
    body: "Arceo enumerates every tool, API, and function each agent can call, forecasts what it costs to run, and translates the rest into plain-language risk labels your finance and security teams can act on — no code required.",
    mockup: (
      <div className="card" style={{ padding: "24px", overflow: "hidden", minHeight: 240 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
          Action inventory — Support agent
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "130px 110px 1fr 52px", gap: 10, paddingBottom: 8, borderBottom: "1px solid #f3f4f6" }}>
          {["Action", "Type", "Score", "Status"].map(h => (
            <span key={h} style={{ fontSize: 9, fontWeight: 700, color: "#d1d5db", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</span>
          ))}
        </div>

        {[
          { action: "create_refund",   type: "Stripe",   score: 94, color: "#dc2626", bg: "#fef2f2", status: "BLOCK"  },
          { action: "delete_records",  type: "Postgres", score: 88, color: "#ea580c", bg: "#fff7ed", status: "BLOCK"  },
          { action: "send_email",      type: "SendGrid", score: 68, color: "#2563eb", bg: "#eff6ff", status: "WARN"   },
          { action: "get_contact",     type: "HubSpot",  score: 42, color: "#6b7280", bg: "#f3f4f6", status: "ALLOW"  },
        ].map((row, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "130px 110px 1fr 52px", gap: 10, padding: "9px 0", borderBottom: "1px solid #f9fafb", alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 9.5, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.action}</span>
            <span style={{ fontSize: 9, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.type}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ flex: 1, height: 4, background: "#f3f4f6", borderRadius: 999 }}>
                <div style={{ height: "100%", width: `${row.score}%`, background: row.color, borderRadius: 999 }} />
              </div>
              <span style={{ fontSize: 9, fontWeight: 700, color: row.color, minWidth: 18, textAlign: "right" }}>{row.score}</span>
            </div>
            <span style={{ fontSize: 8.5, fontWeight: 700, color: row.color, background: row.bg, padding: "2px 6px", borderRadius: 4, textAlign: "center" }}>{row.status}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    tag: "Chain Detection",
    headline: "Catch the multi-step risks one-action scanners miss",
    body: "Permission scanners flag one action at a time. Arceo detects dangerous risk-label chains — like an agent that reads customer records then sends external email, or deletes data after querying it. 14 transition rules, applied statically before your agent runs a single request.",
    mockup: (
      <div className="card" style={{ padding: "24px", overflow: "hidden", minHeight: 240 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 18 }}>
          Detected Chain — PII Exfiltration
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
            <div className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "#7c3aed", marginBottom: 4 }}>get_contact</div>
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
            <div className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "#2563eb", marginBottom: 4 }}>send_email</div>
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
            <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", marginBottom: 2 }}>PII Exfiltration chain detected</div>
            <div style={{ fontSize: 10.5, color: "#991b1b" }}>Reads customer records, then sends external email. Recommend BLOCK or REQUIRE_APPROVAL on <span className="mono">send_email</span>.</div>
          </div>
          <span style={{ fontSize: 9, fontWeight: 700, color: "#fff", background: "#dc2626", padding: "3px 8px", borderRadius: 4, letterSpacing: "0.04em", flexShrink: 0 }}>CRITICAL</span>
        </div>

        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #f3f4f6", display: "flex", gap: 24 }}>
          {[{ n: "14", l: "Chain rules" }, { n: "3", l: "Detected" }, { n: "2", l: "Critical" }].map(s => (
            <div key={s.l}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#111827", lineHeight: 1, letterSpacing: "-0.02em" }}>{s.n}</div>
              <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    tag: "Continuous monitoring",
    headline: "Watch cost and risk drift after you ship",
    body: "Agents change — new tools, more traffic, a swapped model. Arceo ingests live production traces, tracks actual spend against the forecast, and alerts you when cost or blast radius crosses your threshold.",
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
          { text: "live traffic ingested: support-agent",    glow: false, dim: false },
          { text: "",                                          glow: false, dim: false },
          { text: "  recomputing forecast...",                glow: false, dim: true  },
          { text: "  spend: $612/mo → $1,840/mo (3x)",        glow: true,  dim: false },
          { text: "  blast_radius: 72 → 91 (+19)",            glow: true,  dim: false },
          { text: "",                                          glow: false, dim: true  },
          { text: "  ALERT: cost + risk threshold exceeded",  glow: true,  dim: false },
          { text: "  notifying: finops@yourcompany.com",      glow: false, dim: true  },
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
      borderBottom: "1px solid #e5e7eb",
    }}>
      <div style={{ order: even ? 0 : 1 }}>
        <span className="eyebrow">{f.tag}</span>
        <h3 style={{ fontSize: 36, fontWeight: 700, letterSpacing: "-0.02em", color: "#111827", marginBottom: 16, lineHeight: 1.2 }}>
          {f.headline}
        </h3>
        <p style={{ fontSize: 17, color: "#6b7280", lineHeight: 1.75 }}>{f.body}</p>
      </div>
      <div style={{ order: even ? 1 : 0 }}>{f.mockup}</div>
    </div>
  );
}

export default function FeatureRows() {
  return (
    <section id="features" style={{ padding: "96px 0", background: "#f8faff", borderTop: "1px solid #e5e7eb" }}>
      <div className="container">
        {/* Section header — always visible, no fade-in */}
        <div style={{ marginBottom: 48 }}>
          <span className="eyebrow">Features</span>
          <h2 style={{ fontSize: 48, fontWeight: 700, letterSpacing: "-0.02em", color: "#111827" }}>
            Cost and risk,<br />in one CFO-readable report.
          </h2>
        </div>

        {/* Trust signal row */}
        <div style={{
          display: "flex", alignItems: "center", gap: 0,
          marginBottom: 64,
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          overflow: "hidden",
        }} className="trust-row">
          {[
            { icon: "🔌", label: "Any platform",          sub: "Anthropic, OpenAI, MCP, GitHub" },
            { icon: "🛡️", label: "No production traffic", sub: "Forecast before you deploy" },
            { icon: "📄", label: "CFO-readable",          sub: "One report, two answers" },
          ].map((t, i) => (
            <div key={t.label} style={{
              flex: 1,
              padding: "20px 24px",
              borderRight: i < 2 ? "1px solid #e5e7eb" : "none",
              display: "flex", alignItems: "center", gap: 14,
            }}>
              <span style={{ fontSize: 22, flexShrink: 0 }}>{t.icon}</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 2 }}>{t.label}</div>
                <div style={{ fontSize: 12, color: "#9ca3af" }}>{t.sub}</div>
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
          .trust-row > div { border-right: none !important; border-bottom: 1px solid #e5e7eb; }
          .trust-row > div:last-child { border-bottom: none !important; }
        }
      `}</style>
    </section>
  );
}
