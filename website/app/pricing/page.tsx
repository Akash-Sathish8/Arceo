"use client";

import Link from "next/link";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";

const PLANS = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    description: "For admins who want to see their blast radius for the first time.",
    cta: "Connect Salesforce → Free scan",
    ctaHref: "/connect-salesforce",
    ctaStyle: "outline" as const,
    features: [
      "1 Agentforce agent",
      "Full action inventory",
      "Blast radius score",
      "Up to 5 chain rules checked",
      "Read-only OAuth",
    ],
    highlight: false,
  },
  {
    name: "SMB",
    price: "$99",
    period: "/ month",
    description: "For growing Salesforce teams deploying multiple Agentforce agents.",
    cta: "Start free trial",
    ctaHref: "/connect-salesforce",
    ctaStyle: "dark" as const,
    features: [
      "Up to 10 Agentforce agents",
      "All 15 chain detection rules",
      "Re-scan on metadata change",
      "Policy recommendations",
      "Slack / email alerts",
      "CSV audit export",
    ],
    highlight: true,
    badge: "Most popular",
  },
  {
    name: "Pro",
    price: "$299",
    period: "/ month",
    description: "For security-conscious orgs with complex multi-agent deployments.",
    cta: "Start free trial",
    ctaHref: "/connect-salesforce",
    ctaStyle: "outline" as const,
    features: [
      "Unlimited agents",
      "Multi-agent chain detection",
      "Human-in-the-loop approvals",
      "Audit log + compliance export",
      "Custom threshold alerts",
      "Priority support",
    ],
    highlight: false,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "For large orgs, ISVs, and partners with SLA and data residency requirements.",
    cta: "Book a call",
    ctaHref: "/book-demo",
    ctaStyle: "outline" as const,
    features: [
      "Everything in Pro",
      "Dedicated sandbox environment",
      "Custom OAuth scope review",
      "SLA + uptime guarantee",
      "SSO / SAML",
      "Data residency options",
    ],
    highlight: false,
  },
];

export default function PricingPage() {
  return (
    <>
      <Navbar />
      <main style={{ background: "#f9fafb", minHeight: "calc(100vh - 64px)" }}>

        {/* Header */}
        <section style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "80px 0 64px" }}>
          <div className="container" style={{ textAlign: "center" }}>
            <span style={{
              display: "inline-block",
              fontSize: 11, fontWeight: 700, color: "#00A1E0",
              textTransform: "uppercase", letterSpacing: "0.12em",
              marginBottom: 16,
            }}>Pricing</span>
            <h1 style={{ fontSize: 52, fontWeight: 700, letterSpacing: "-0.02em", color: "#111827", marginBottom: 16 }}>
              Simple, transparent pricing
            </h1>
            <p style={{ fontSize: 16, color: "#6b7280", lineHeight: 1.7, maxWidth: 480, margin: "0 auto" }}>
              Start with a free scan. Upgrade when you need more agents, chain rules, or alerts. No credit card required to connect.
            </p>
          </div>
        </section>

        {/* Cards */}
        <section style={{ padding: "64px 0 96px" }}>
          <div className="container">
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 20,
              alignItems: "stretch",
            }} className="pricing-grid">
              {PLANS.map((plan) => (
                <div key={plan.name} style={{
                  background: plan.highlight ? "#111827" : "#fff",
                  border: plan.highlight ? "1px solid #111827" : "1px solid #e5e7eb",
                  borderRadius: 20,
                  padding: "32px 28px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 0,
                  position: "relative",
                  boxShadow: plan.highlight ? "0 8px 32px rgba(0,0,0,0.18)" : "0 1px 4px rgba(0,0,0,0.05)",
                }}>
                  {plan.badge && (
                    <div style={{
                      position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)",
                      background: "#00A1E0", color: "#fff",
                      fontSize: 10, fontWeight: 700, padding: "3px 12px", borderRadius: 999,
                      letterSpacing: "0.06em", whiteSpace: "nowrap",
                    }}>
                      {plan.badge}
                    </div>
                  )}

                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: plan.highlight ? "#9ca3af" : "#9ca3af", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                      {plan.name}
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 8 }}>
                      <span style={{ fontSize: 44, fontWeight: 800, color: plan.highlight ? "#fff" : "#111827", letterSpacing: "-0.03em", lineHeight: 1 }}>
                        {plan.price}
                      </span>
                      {plan.period && (
                        <span style={{ fontSize: 14, color: plan.highlight ? "#9ca3af" : "#9ca3af" }}>{plan.period}</span>
                      )}
                    </div>
                    <p style={{ fontSize: 13, color: plan.highlight ? "#9ca3af" : "#6b7280", lineHeight: 1.6 }}>
                      {plan.description}
                    </p>
                  </div>

                  <Link href={plan.ctaHref} style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "11px 20px",
                    borderRadius: 10,
                    fontSize: 13,
                    fontWeight: 700,
                    textDecoration: "none",
                    marginBottom: 28,
                    background: plan.highlight ? "#fff" : "transparent",
                    color: plan.highlight ? "#111827" : "#374151",
                    border: plan.highlight ? "none" : "1.5px solid #d1d5db",
                    transition: "opacity 0.15s",
                  }}>
                    {plan.cta}
                  </Link>

                  <div style={{ borderTop: plan.highlight ? "1px solid #374151" : "1px solid #f3f4f6", paddingTop: 24, display: "flex", flexDirection: "column", gap: 12 }}>
                    {plan.features.map((f) => (
                      <div key={f} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
                          <circle cx="7" cy="7" r="7" fill={plan.highlight ? "#374151" : "#f0fdf4"}/>
                          <path d="M4 7l2 2 4-4" stroke={plan.highlight ? "#4ade80" : "#16a34a"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <span style={{ fontSize: 13, color: plan.highlight ? "#d1d5db" : "#374151", lineHeight: 1.5 }}>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer note */}
            <p style={{ textAlign: "center", fontSize: 13, color: "#9ca3af", marginTop: 40 }}>
              All plans include read-only OAuth — no data leaves your Salesforce org. Questions?{" "}
              <Link href="/book-demo" style={{ color: "#374151", fontWeight: 600 }}>Talk to us →</Link>
            </p>
          </div>
        </section>
      </main>
      <Footer />

      <style>{`
        @media (max-width: 1024px) { .pricing-grid { grid-template-columns: repeat(2, 1fr) !important; } }
        @media (max-width: 600px)  { .pricing-grid { grid-template-columns: 1fr !important; } }
      `}</style>
    </>
  );
}
