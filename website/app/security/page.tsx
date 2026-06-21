import Link from "next/link";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";

const CONNECTIONS = [
  { src: "Anthropic SDK",  reads: "Tool definitions and model config from your traces", write: false },
  { src: "OpenAI",         reads: "Assistant and function-calling schemas",            write: false },
  { src: "MCP server",     reads: "Advertised tools via tools/list",                   write: false },
  { src: "GitHub repo",    reads: "Agent source code (read-only scan)",                write: false },
];

const DO_SEE = [
  "Tool and function definitions",
  "Action names and parameter schemas",
  "Which model each agent runs on",
  "Agent source code in repos you connect",
  "Usage metadata: token counts, call volume",
  "Declared scopes and permissions",
];

const DONT_SEE = [
  "Customer data or PII",
  "The content of prompts or responses",
  "Message bodies or email content",
  "API keys, passwords, or secrets",
  "Payment or financial records",
  "Anything your agent does in production",
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: 28, fontWeight: 600, color: "var(--clay-heading)", letterSpacing: "-0.02em", marginBottom: 12 }}>
      {children}
    </h2>
  );
}

export default function SecurityPage() {
  return (
    <>
      <Navbar />
      <main style={{ background: "var(--clay-cream)" }}>

        {/* Hero */}
        <section style={{ background: "var(--clay-cream-2)", borderBottom: "1px solid var(--clay-border)", padding: "80px 0 64px" }}>
          <div className="container" style={{ maxWidth: 760 }}>
            <span style={{
              display: "inline-block",
              fontSize: 11, fontWeight: 700, color: "var(--clay-brand-strong)",
              textTransform: "uppercase", letterSpacing: "0.12em",
              marginBottom: 16,
            }}>Security</span>
            <h1 style={{ fontSize: 52, fontWeight: 800, letterSpacing: "-0.8px", color: "var(--clay-heading)", marginBottom: 20 }}>
              Your agents. Your data. Read-only.
            </h1>
            <p style={{ fontSize: 20, color: "var(--clay-body)", lineHeight: 1.7, maxWidth: 600 }}>
              Arceo connects to your agents read-only and looks at what they <em>can</em> do, not what they actually handle at runtime. Nothing your agents touch in production leaves your stack.
            </p>
          </div>
        </section>

        {/* How we connect */}
        <section style={{ padding: "72px 0", borderBottom: "1px solid var(--clay-border)" }}>
          <div className="container" style={{ maxWidth: 760 }}>
            <SectionTitle>How we connect</SectionTitle>
            <p style={{ fontSize: 16, color: "var(--clay-body)", lineHeight: 1.7, marginBottom: 32 }}>
              Point Arceo at an agent however it&apos;s built. Every connection is read-only, and you can disconnect any source at any time.
            </p>
            <div style={{ border: "1px solid var(--clay-border)", borderRadius: 20, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 90px", background: "var(--clay-cream-2)", padding: "10px 20px", borderBottom: "1px solid var(--clay-border)" }}>
                {["Source", "What we read", "Write access"].map(h => (
                  <span key={h} style={{ fontSize: 11, fontWeight: 700, color: "var(--clay-body-subtle)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{h}</span>
                ))}
              </div>
              {CONNECTIONS.map((s, i) => (
                <div key={s.src} style={{
                  display: "grid", gridTemplateColumns: "180px 1fr 90px",
                  padding: "14px 20px",
                  borderBottom: i < CONNECTIONS.length - 1 ? "1px solid var(--clay-border-light)" : "none",
                  alignItems: "center",
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--clay-heading)" }}>{s.src}</span>
                  <span style={{ fontSize: 13, color: "var(--clay-body)" }}>{s.reads}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    color: s.write ? "#dc2626" : "#16a34a",
                    background: s.write ? "#fef2f2" : "#dcfce7",
                    padding: "2px 8px", borderRadius: 4,
                    display: "inline-block",
                  }}>
                    {s.write ? "Yes" : "Never"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* What we see / don't see */}
        <section style={{ padding: "72px 0", borderBottom: "1px solid var(--clay-border)" }}>
          <div className="container" style={{ maxWidth: 760 }}>
            <SectionTitle>What Arceo sees, and what it doesn&apos;t</SectionTitle>
            <p style={{ fontSize: 16, color: "var(--clay-body)", lineHeight: 1.7, marginBottom: 40 }}>
              We read the <strong style={{ color: "var(--clay-heading)" }}>capability layer</strong> (what an agent is wired to do) and lightweight usage metadata for the cost forecast. We never read the content your agent handles.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32 }} className="see-grid">
              <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 20, padding: "28px 24px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#16a34a", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 18 }}>
                  What we read
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {DO_SEE.map(item => (
                    <div key={item} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, marginTop: 3 }}>
                        <circle cx="7" cy="7" r="7" fill="#16a34a"/>
                        <path d="M4 7l2 2 4-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <span style={{ fontSize: 13, color: "var(--clay-heading)", lineHeight: 1.5 }}>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 20, padding: "28px 24px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#ea580c", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 18 }}>
                  What we never read
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {DONT_SEE.map(item => (
                    <div key={item} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, marginTop: 3 }}>
                        <circle cx="7" cy="7" r="7" fill="#ea580c"/>
                        <path d="M4 4l6 6M10 4L4 10" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                      <span style={{ fontSize: 13, color: "var(--clay-heading)", lineHeight: 1.5 }}>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Data residency */}
        <section style={{ padding: "72px 0", borderBottom: "1px solid var(--clay-border)" }}>
          <div className="container" style={{ maxWidth: 760 }}>
            <SectionTitle>Data residency</SectionTitle>
            <p style={{ fontSize: 16, color: "var(--clay-body)", lineHeight: 1.7, marginBottom: 24 }}>
              Arceo stores only what it needs to compute your cost forecast and risk picture. The data that leaves your stack is:
            </p>
            <ul style={{ display: "flex", flexDirection: "column", gap: 10, paddingLeft: 0, listStyle: "none" }}>
              {[
                "Tool and action names with parameter schemas (not values)",
                "Usage metadata: token counts, call volume, model",
                "Cost forecasts and risk classifications computed by Arceo",
                "Policies and budget caps you configure in Arceo",
              ].map(item => (
                <li key={item} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <span style={{ fontSize: 16, color: "var(--clay-brand-strong)", marginTop: -1 }}>&rarr;</span>
                  <span style={{ fontSize: 15, color: "var(--clay-heading)" }}>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* CTA */}
        <section style={{ padding: "72px 0", background: "var(--clay-cream-2)" }}>
          <div className="container" style={{ textAlign: "center" }}>
            <h2 style={{ fontSize: 36, fontWeight: 800, color: "var(--clay-heading)", letterSpacing: "-0.4px", marginBottom: 12 }}>
              See what your agents cost, and what could go wrong
            </h2>
            <p style={{ fontSize: 16, color: "var(--clay-body)", marginBottom: 32 }}>
              Connect an agent in minutes. Read-only, and your finance team gets a report it can read.
            </p>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
              <Link href="/book-demo" className="btn-black">
                Book a demo
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />

      <style>{`
        @media (max-width: 640px) { .see-grid { grid-template-columns: 1fr !important; } }
      `}</style>
    </>
  );
}
