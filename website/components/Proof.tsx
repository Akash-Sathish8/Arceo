"use client";

import Link from "next/link";
import { useFadeInOnScroll } from "../lib/useFadeIn";

/**
 * Proof without customer logos.
 *
 * Every figure here is checkable against the product: the backtest count comes
 * from the ground-truth reporter, and the framework mappings are cited in the
 * chain-detection rule set itself.
 */
const LEGS = [
  {
    stat: "829",
    statLabel: "real API calls repriced",
    title: "The cost model is backtested, not asserted",
    body: "We took 829 real Anthropic usage records — captured independently of the forecaster — and re-priced them through the engine. The high-confidence tier reproduces the actual spend exactly. That test runs in CI, so a change that breaks pricing accuracy fails the build.",
  },
  {
    stat: "32",
    statLabel: "risk-chain rules",
    title: "The risk model is mapped to published frameworks",
    body: "Chain detection works on risk-label transitions rather than hardcoded tool names, so it generalises across every tool and vendor. The rule set is mapped to OWASP Agentic Security categories and MITRE ATT&CK tactics — privilege escalation, credential access, defense evasion, and collection.",
  },
  {
    stat: "0",
    statLabel: "critical audit findings",
    title: "The backend has been independently audited",
    body: "A full security audit covering authentication, tenant isolation, injection, cryptography, dependencies, logging, and cost abuse returned zero critical findings. We share the report, and current remediation status, under NDA.",
    href: "/security",
    hrefLabel: "Read the security page",
  },
];

function Leg({ leg, delay }: { leg: typeof LEGS[0]; delay: number }) {
  const { ref, className } = useFadeInOnScroll(delay);

  return (
    <div ref={ref} className={className} style={{
      display: "grid",
      gridTemplateColumns: "minmax(0, 200px) minmax(0, 1fr)",
      gap: 32,
      alignItems: "start",
      padding: "32px 0",
      borderTop: "1px solid var(--clay-border)",
    }}>
      <div>
        <div style={{
          fontSize: 52,
          fontWeight: 800,
          lineHeight: 1,
          letterSpacing: "-2px",
          color: "var(--clay-brand-strong)",
        }}>
          {leg.stat}
        </div>
        <div style={{ fontSize: 13, color: "var(--clay-body-subtle)", marginTop: 8, lineHeight: 1.4 }}>
          {leg.statLabel}
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: 20, fontWeight: 700, color: "var(--clay-heading)", marginBottom: 10, letterSpacing: "-0.2px" }}>
          {leg.title}
        </h3>
        <p style={{ fontSize: 15.5, color: "var(--clay-body)", lineHeight: 1.7 }}>{leg.body}</p>
        {leg.href && (
          <Link
            href={leg.href}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              fontSize: 14, fontWeight: 600, color: "var(--clay-brand-strong)",
              textDecoration: "none", marginTop: 12,
            }}
          >
            {leg.hrefLabel}
            <svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 6.5h8M7 3l3.5 3.5L7 10" />
            </svg>
          </Link>
        )}
      </div>
    </div>
  );
}

export default function Proof() {
  const { ref: headRef, className: headClass } = useFadeInOnScroll();

  return (
    <section id="proof" style={{ padding: "112px 0", background: "var(--clay-cream)" }}>
      <div className="container" style={{ maxWidth: 920 }}>
        <div ref={headRef} className={headClass} style={{ marginBottom: 24 }}>
          <span className="eyebrow">Proof</span>
          <h2 style={{
            fontSize: 44,
            fontWeight: 600,
            letterSpacing: "-0.4px",
            color: "var(--clay-heading)",
            maxWidth: 720,
            margin: "8px 0 16px",
          }}>
            Three things you can check before you trust the number
          </h2>
          <p style={{ fontSize: 19, color: "var(--clay-body)", maxWidth: 620, lineHeight: 1.6 }}>
            We are early and we are not going to pretend otherwise with a wall of customer logos.
            Here is what we can actually show you instead.
          </p>
        </div>

        {LEGS.map((leg, i) => <Leg key={leg.stat} leg={leg} delay={i * 100} />)}
      </div>

      <style>{`
        @media (max-width: 720px) {
          #proof [style*="grid-template-columns"] { grid-template-columns: 1fr !important; gap: 16px !important; }
        }
      `}</style>
    </section>
  );
}
