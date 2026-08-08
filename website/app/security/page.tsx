import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Security",
  description:
    "What Arceo can see, where it runs, the controls in the product, and an honest account of what we have not done yet.",
  alternates: { canonical: "/security" },
};

const ACCESS = [
  {
    title: "Discovery is read-only",
    body: "Arceo reads your agent's tool definitions and source to work out what it can call. Producing the report needs no write access to any of your systems, and Arceo never asks for one.",
  },
  {
    title: "No production credentials required",
    body: "Mapping capabilities and forecasting cost work from the agent's own definition. You do not hand over live keys to your payment processor, CRM, or database to get a report.",
  },
  {
    title: "Runtime enforcement is opt-in and separate",
    body: "If you later want Arceo to actually block actions, that is a deliberate second step you configure. Nothing about the forecast requires it.",
  },
];

const CONTROLS = [
  {
    control: "Tenant isolation",
    detail: "PostgreSQL row-level security, ENABLEd and FORCEd on every organisation-scoped table — enforced by the database, not only by application code.",
  },
  {
    control: "Encryption at rest",
    detail: "Envelope encryption for sensitive columns, including captured prompts and responses, behind a deployment-level switch with a documented key-rotation path.",
  },
  {
    control: "Tamper-evident audit log",
    detail: "Every privileged action is written to a hash-chained audit log, so a deleted or edited entry breaks the chain and is detectable.",
  },
  {
    control: "Session revocation",
    detail: "Tokens carry a version, so disabling a user or rotating an organisation's secret invalidates issued sessions rather than waiting for expiry.",
  },
  {
    control: "Transport hardening",
    detail: "HSTS, a restrictive Content-Security-Policy, frame-ancestors none, and nosniff are set on responses.",
  },
  {
    control: "Scoped API keys",
    detail: "Machine access uses hashed, scoped, individually revocable keys rather than a shared account password.",
  },
];

export default function SecurityPage() {
  return (
    <>
      <Navbar />
      <main>
        {/* Hero */}
        <section style={{ padding: "96px 0 72px", background: "var(--clay-cream)" }}>
          <div className="container" style={{ maxWidth: 820 }}>
            <span className="eyebrow">Security</span>
            <h1 style={{
              fontSize: 46,
              fontWeight: 700,
              letterSpacing: "-1px",
              lineHeight: 1.12,
              color: "var(--clay-heading)",
              margin: "10px 0 20px",
            }}>
              You are pointing us at the agents that run your business.
            </h1>
            <p style={{ fontSize: 20, color: "var(--clay-body)", lineHeight: 1.6 }}>
              So here is exactly what Arceo can see, where it runs, what is built into the
              product, and — at the bottom — a plain account of what we have not done yet.
            </p>
          </div>
        </section>

        {/* What Arceo can see */}
        <section style={{ padding: "80px 0", background: "var(--clay-cream-2)" }}>
          <div className="container">
            <h2 style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.5px", color: "var(--clay-heading)", marginBottom: 12 }}>
              What Arceo can see
            </h2>
            <p style={{ fontSize: 17, color: "var(--clay-body)", maxWidth: 640, marginBottom: 40, lineHeight: 1.65 }}>
              The whole product is built around answering a question before deployment, which
              means it needs far less access than tools that sit in the runtime path.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }} className="sec-grid">
              {ACCESS.map((a) => (
                <div key={a.title} className="card" style={{ padding: 28 }}>
                  <h3 style={{ fontSize: 17, fontWeight: 700, color: "var(--clay-heading)", marginBottom: 10, lineHeight: 1.35 }}>
                    {a.title}
                  </h3>
                  <p style={{ fontSize: 14.5, color: "var(--clay-body)", lineHeight: 1.65 }}>{a.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Where it runs */}
        <section style={{ padding: "80px 0", background: "var(--clay-cream)" }}>
          <div className="container" style={{ maxWidth: 820 }}>
            <h2 style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.5px", color: "var(--clay-heading)", marginBottom: 16 }}>
              Where Arceo runs
            </h2>
            <p style={{ fontSize: 17, color: "var(--clay-body)", lineHeight: 1.7, marginBottom: 16 }}>
              Pilots run <strong style={{ color: "var(--clay-heading)" }}>inside your own infrastructure</strong>.
              Arceo ships as a single container that you deploy to your cloud account, against a
              PostgreSQL database you control. You supply the TLS termination, the database, and
              your own model API key.
            </p>
            <p style={{ fontSize: 17, color: "var(--clay-body)", lineHeight: 1.7 }}>
              In that configuration your agent definitions, traces, and cost data stay within your
              network boundary. The only outbound calls are the ones you configure — to your model
              provider for risk classification, and to your own alerting webhook if you set one.
            </p>
          </div>
        </section>

        {/* Controls */}
        <section style={{ padding: "80px 0", background: "var(--clay-cream-2)" }}>
          <div className="container">
            <h2 style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.5px", color: "var(--clay-heading)", marginBottom: 32 }}>
              Controls built into the product
            </h2>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              {CONTROLS.map((c, i) => (
                <div
                  key={c.control}
                  className="ctrl-row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 220px) minmax(0, 1fr)",
                    gap: 24,
                    padding: "20px 28px",
                    borderTop: i === 0 ? "none" : "1px solid var(--clay-border-light)",
                    alignItems: "start",
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--clay-heading)" }}>{c.control}</div>
                  <div style={{ fontSize: 14.5, color: "var(--clay-body)", lineHeight: 1.65 }}>{c.detail}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Independent review */}
        <section style={{ padding: "80px 0", background: "var(--clay-cream)" }}>
          <div className="container" style={{ maxWidth: 820 }}>
            <h2 style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.5px", color: "var(--clay-heading)", marginBottom: 16 }}>
              Independent review
            </h2>
            <p style={{ fontSize: 17, color: "var(--clay-body)", lineHeight: 1.7, marginBottom: 20 }}>
              The backend has been through a full independent security audit covering
              authentication, tenant isolation, injection, cryptography, dependencies, logging,
              and cost abuse — endpoint by endpoint, across the whole service.
            </p>

            <div className="card" style={{ padding: 28, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--clay-body-subtle)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>
                Headline result
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, color: "var(--clay-heading)", marginBottom: 10, letterSpacing: "-0.3px" }}>
                Zero critical findings
              </div>
              <p style={{ fontSize: 15, color: "var(--clay-body)", lineHeight: 1.65 }}>
                No SQL injection, no reachable code execution, and no cross-tenant read leak at the
                application layer. Findings that were raised are tracked in a phased remediation
                roadmap with per-item validation.
              </p>
            </div>

            <p style={{ fontSize: 16, color: "var(--clay-body)", lineHeight: 1.7 }}>
              We share the full report, the finding-by-finding detail, and current remediation
              status under NDA with pilot customers. Ask for it — we would rather you read it than
              take the summary on trust.
            </p>
          </div>
        </section>

        {/* Honest status */}
        <section id="honest" style={{ padding: "80px 0", background: "var(--clay-dark)", scrollMarginTop: 80 }}>
          <div className="container" style={{ maxWidth: 820 }}>
            <span style={{
              display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.1em",
              textTransform: "uppercase", color: "var(--clay-brand-soft)", marginBottom: 12,
            }}>
              What we have not done yet
            </span>
            <h2 style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.5px", color: "#FAF6F0", marginBottom: 20 }}>
              The honest version
            </h2>
            <p style={{ fontSize: 17, color: "rgba(250,246,240,0.78)", lineHeight: 1.7, marginBottom: 28 }}>
              Any vendor can list controls. The more useful question is what they leave out, so
              here is ours.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {[
                {
                  t: "We are not SOC 2 certified.",
                  d: "The code-side control work is underway — audit logging, transport hardening, encryption, backups — but no auditor has attested to it. If SOC 2 is a hard gate for you, we are not there yet and will say so rather than point at a roadmap.",
                },
                {
                  t: "There is no multi-tenant hosted offering.",
                  d: "Every pilot today is a single-tenant deployment in the customer's own environment. That is a deliberate choice while the shared-tenancy path finishes hardening.",
                },
                {
                  t: "We are early.",
                  d: "Arceo is pre-general-availability and working with its first design partners. You would be evaluating a product that is genuinely working, not a finished platform, and we would rather you know that going in.",
                },
              ].map((x) => (
                <div key={x.t} style={{
                  borderLeft: "2px solid var(--clay-brand)",
                  paddingLeft: 20,
                }}>
                  <div style={{ fontSize: 17, fontWeight: 700, color: "#FAF6F0", marginBottom: 6 }}>{x.t}</div>
                  <p style={{ fontSize: 15, color: "rgba(250,246,240,0.72)", lineHeight: 1.65 }}>{x.d}</p>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 40 }}>
              <Link href="/book-demo" className="btn-white" style={{ fontSize: 14, padding: "12px 24px" }}>
                Ask us anything about this
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 6.5h8M7 3l3.5 3.5L7 10" />
                </svg>
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />

      <style>{`
        @media (max-width: 860px) {
          .sec-grid { grid-template-columns: 1fr !important; }
          .ctrl-row { grid-template-columns: 1fr !important; gap: 8px !important; }
        }
      `}</style>
    </>
  );
}
