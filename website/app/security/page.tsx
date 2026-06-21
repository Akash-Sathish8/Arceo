import Link from "next/link";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";

const DO_SEE = [
  "Agent, tool, and action names",
  "Parameter schemas — field names and types, not values",
  "Model names and token usage",
  "Captured LLM requests and responses — only if you connect traces or our proxy",
  "Policies and budgets you configure in Arceo",
];

const DONT_SEE = [
  "Your customers' data — unless it is inside a trace or prompt you choose to send",
  "Your provider credentials — proxied API keys pass through to your own accounts, never stored",
  "Anything we sell, share, or hand to third parties",
  "Anything used to train AI models",
];

const SUBPROCESSORS = [
  { name: "Anthropic (Claude)", reason: "Classifies unfamiliar tools and generates the plain-language CFO report. Receives tool and action names — not your data." },
  { name: "Your LLM providers", reason: "When you route calls through Arceo's proxy, requests pass through to your own OpenAI / Anthropic / other accounts using your keys." },
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: 28, fontWeight: 700, color: "#111827", letterSpacing: "-0.02em", marginBottom: 12 }}>
      {children}
    </h2>
  );
}

export default function SecurityPage() {
  return (
    <>
      <Navbar />
      <main style={{ background: "#fff" }}>

        {/* Hero */}
        <section style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb", padding: "80px 0 64px" }}>
          <div className="container" style={{ maxWidth: 760 }}>
            <span style={{
              display: "inline-block",
              fontSize: 11, fontWeight: 700, color: "#2563eb",
              textTransform: "uppercase", letterSpacing: "0.12em",
              marginBottom: 16,
            }}>Security</span>
            <h1 style={{ fontSize: 52, fontWeight: 700, letterSpacing: "-0.02em", color: "#111827", marginBottom: 20 }}>
              What Arceo accesses — and what it doesn&apos;t.
            </h1>
            <p style={{ fontSize: 17, color: "#6b7280", lineHeight: 1.7, maxWidth: 600 }}>
              Arceo analyzes how your agents are configured — the tools and actions they can call — to forecast cost and score risk. Here is exactly what that requires, what leaves your environment, and where we are on compliance. No marketing claims we can&apos;t back.
            </p>
          </div>
        </section>

        {/* What Arceo needs */}
        <section style={{ padding: "72px 0", borderBottom: "1px solid #e5e7eb" }}>
          <div className="container" style={{ maxWidth: 760 }}>
            <SectionTitle>What Arceo needs</SectionTitle>
            <p style={{ fontSize: 15, color: "#6b7280", lineHeight: 1.7 }}>
              To map and price an agent, Arceo reads its definition — the tools, actions, and parameter
              schemas it can invoke. That is enough to produce a cost forecast and a blast-radius score
              with no production traffic at all. To tighten the forecast with real usage, you can
              optionally connect production traces or route LLM calls through Arceo. That choice is
              entirely yours, and you can start without it.
            </p>
          </div>
        </section>

        {/* What we see / don't see */}
        <section style={{ padding: "72px 0", borderBottom: "1px solid #e5e7eb" }}>
          <div className="container" style={{ maxWidth: 760 }}>
            <SectionTitle>What Arceo sees — and doesn&apos;t see</SectionTitle>
            <p style={{ fontSize: 15, color: "#6b7280", lineHeight: 1.7, marginBottom: 40 }}>
              By default Arceo works from your agents&apos; <strong style={{ color: "#374151" }}>configuration</strong>,
              not their runtime data. Data only flows in when you explicitly connect a trace source.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32 }} className="see-grid">
              <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 14, padding: "28px 24px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#16a34a", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 18 }}>
                  We do see
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {DO_SEE.map(item => (
                    <div key={item} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
                        <circle cx="7" cy="7" r="7" fill="#16a34a"/>
                        <path d="M4 7l2 2 4-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <span style={{ fontSize: 13, color: "#374151", lineHeight: 1.5 }}>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 14, padding: "28px 24px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#ea580c", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 18 }}>
                  We never see
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {DONT_SEE.map(item => (
                    <div key={item} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
                        <circle cx="7" cy="7" r="7" fill="#ea580c"/>
                        <path d="M4 4l6 6M10 4L4 10" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                      <span style={{ fontSize: 13, color: "#374151", lineHeight: 1.5 }}>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Sub-processors */}
        <section style={{ padding: "72px 0", borderBottom: "1px solid #e5e7eb" }}>
          <div className="container" style={{ maxWidth: 760 }}>
            <SectionTitle>What leaves your environment</SectionTitle>
            <p style={{ fontSize: 15, color: "#6b7280", lineHeight: 1.7, marginBottom: 32 }}>
              We believe in disclosing sub-processors up front. Two services may receive data, and we do
              not use any of it to train models.
            </p>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
              {SUBPROCESSORS.map((s, i) => (
                <div key={s.name} style={{
                  padding: "18px 20px",
                  borderBottom: i < SUBPROCESSORS.length - 1 ? "1px solid #f3f4f6" : "none",
                }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 4 }}>{s.name}</div>
                  <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>{s.reason}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Compliance — honest */}
        <section style={{ padding: "72px 0", borderBottom: "1px solid #e5e7eb" }}>
          <div className="container" style={{ maxWidth: 760 }}>
            <SectionTitle>Compliance</SectionTitle>
            <p style={{ fontSize: 15, color: "#6b7280", lineHeight: 1.7 }}>
              Arceo is an early-stage product, and we&apos;d rather be straight with your security team than
              over-promise. <strong style={{ color: "#374151" }}>SOC 2 Type 1 is in progress.</strong> We
              scope every security review to your specific requirements on a call — tell us what your team
              needs and we&apos;ll walk through our controls, our data flows, and our roadmap honestly.
            </p>
          </div>
        </section>

        {/* CTA */}
        <section style={{ padding: "72px 0", background: "#f9fafb" }}>
          <div className="container" style={{ textAlign: "center" }}>
            <h2 style={{ fontSize: 36, fontWeight: 700, color: "#111827", letterSpacing: "-0.02em", marginBottom: 12 }}>
              Want the full security detail?
            </h2>
            <p style={{ fontSize: 15, color: "#6b7280", marginBottom: 32 }}>
              Book a call and we&apos;ll walk your team through exactly what Arceo accesses and where we are on compliance.
            </p>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
              <Link href="/book-demo" className="btn-black">
                Book a demo
              </Link>
              <Link href="/pricing" className="btn-outline">See pricing</Link>
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
