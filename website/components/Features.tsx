const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";

const FEATURES = [
  {
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="3.5" cy="8" r="1.5" fill="currentColor" stroke="none"/><circle cx="12.5" cy="3.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12.5" cy="12.5" r="1.5" fill="currentColor" stroke="none"/><line x1="5" y1="7.5" x2="11" y2="4.2"/><line x1="5" y1="8.5" x2="11" y2="11.8"/><line x1="12.5" y1="5" x2="12.5" y2="11"/></svg>,
    iconBg: "#eff6ff",
    iconColor: "#2563eb",
    title: "Authority Mapping",
    desc: "Automatically parse agent tool manifests and build a graph of every action your agent can take — before it runs.",
    chips: ["MCP tools", "OpenAI functions", "LangChain", "Auto-classify"],
  },
  {
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6.5"/><circle cx="8" cy="8" r="3.5"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/></svg>,
    iconBg: "#fff7ed",
    iconColor: "#ea580c",
    title: "Blast Radius Scoring",
    desc: "Score the potential damage of each agent on a 0–100 scale using 5 universal risk labels and 14 dangerous chain patterns.",
    chips: ["moves_money", "touches_pii", "deletes_data", "sends_external"],
  },
  {
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5L2.5 4v4.5c0 2.8 2.2 4.8 5.5 5.5 3.3-.7 5.5-2.7 5.5-5.5V4L8 1.5z"/><path d="M5.5 8l1.5 1.5 3-3"/></svg>,
    iconBg: "#f0fdf4",
    iconColor: "#16a34a",
    title: "Runtime Enforcement",
    desc: "Enforce policies at the tool call level with conditional logic, human-in-the-loop approvals, and a full audit log.",
    chips: ["BLOCK", "REQUIRE_APPROVAL", "Conditional rules", "Audit log"],
  },
  {
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2v5L2.5 12.5a1 1 0 00.9 1.5h9.2a1 1 0 00.9-1.5L10 7V2"/><line x1="5" y1="2" x2="11" y2="2"/><circle cx="6" cy="11" r="0.7" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="0.7" fill="currentColor" stroke="none"/></svg>,
    iconBg: "#f5f3ff",
    iconColor: "#7c3aed",
    title: "Sandbox Testing",
    desc: "Run 28 adversarial scenarios against any agent — normal, edge case, chain exploits — before deploying to production.",
    chips: ["28 scenarios", "Dry-run mode", "Chain detection", "Full reports"],
  },
];

const LOGOS = [
  "OpenAI", "Anthropic", "LangChain", "CrewAI", "AutoGPT", "MCP",
];

const CHECK = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 7l3 3 6-6"/>
  </svg>
);

const PLANS = [
  {
    name: "Starter",
    price: "Free",
    priceSub: "forever",
    desc: "Everything you need to get started with AI agent security.",
    features: [
      "Up to 3 agents",
      "Blast radius scoring",
      "Basic enforcement (BLOCK / APPROVE)",
      "10 sandbox simulations / month",
      "Community support",
    ],
    cta: "Get started free",
    ctaHref: `${APP_URL}/login?signup=true`,
    highlight: false,
  },
  {
    name: "Pro",
    price: "$49",
    priceSub: "/ month",
    desc: "For teams shipping AI agents at scale with full audit requirements.",
    features: [
      "Unlimited agents",
      "Full sandbox (all 28 scenarios)",
      "Conditional policies & priority rules",
      "Full audit & compliance log",
      "Multi-agent simulation",
      "Priority support",
    ],
    cta: "Start free trial",
    ctaHref: `${APP_URL}/login?signup=true`,
    highlight: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    priceSub: "",
    desc: "For large organizations with custom compliance and deployment needs.",
    features: [
      "Everything in Pro",
      "SSO / SAML",
      "On-premise deployment",
      "Custom integrations & SLAs",
      "Dedicated support",
    ],
    cta: "Contact sales",
    ctaHref: "mailto:support@arceo.ai",
    highlight: false,
  },
];

export default function Features() {
  return (
    <>
      {/* Logos / integrations bar */}
      <div className="logos-bar">
        <div className="container">
          <div className="logos-bar-inner">
            <span className="logos-bar-label">Works with</span>
            <div className="logos-bar-items">
              {LOGOS.map((l) => (
                <span key={l} className="logos-bar-item">{l}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Features grid */}
      <section id="features" className="features-section">
        <div className="container">
          <div className="section-header">
            <span className="section-tag">How it works</span>
            <h2 className="section-title">Everything you need to trust your agents</h2>
            <p className="section-sub">
              Map capabilities, score risk, enforce policies, and test against adversarial scenarios.
            </p>
          </div>

          <div className="features-grid">
            {FEATURES.map((f) => (
              <div key={f.title} className="feature-card">
                <div className="feature-icon" style={{ background: f.iconBg, color: f.iconColor }}>{f.icon}</div>
                <h3 className="feature-title">{f.title}</h3>
                <p className="feature-desc">{f.desc}</p>
                <div className="feature-chips">
                  {f.chips.map((c) => (
                    <span key={c} className="feature-chip">{c}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing section */}
      <section id="pricing" className="pricing-section">
        <div className="container">
          <div className="section-header">
            <span className="section-tag">Pricing</span>
            <h2 className="section-title">Simple, transparent pricing</h2>
            <p className="section-sub">Start free. Upgrade when you need more.</p>
          </div>

          <div className="pricing-grid">
            {PLANS.map((plan) => (
              <div key={plan.name} className={`pricing-card${plan.highlight ? " pricing-card-popular" : ""}`}>
                {plan.highlight && <span className="pricing-popular-badge">Most popular</span>}
                <div className="pricing-plan-name">{plan.name}</div>
                <div className="pricing-plan-price">
                  {plan.price}
                  {plan.priceSub && <span className="pricing-plan-price-sub"> {plan.priceSub}</span>}
                </div>
                <p className="pricing-plan-desc">{plan.desc}</p>
                <div className="pricing-divider" />
                <ul className="pricing-features">
                  {plan.features.map((f) => (
                    <li key={f} className="pricing-feature">
                      <span className="pricing-feature-check">{CHECK}</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href={plan.ctaHref}
                  className={plan.highlight ? "btn-pricing-primary" : "btn-pricing-outline"}
                >
                  {plan.cta}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA banner */}
      <section className="cta-section">
        <div className="container">
          <h2>Start protecting your agents today.</h2>
          <p>Free to start. No credit card required.</p>
          <div className="cta-actions">
            <a href={`${APP_URL}/login?signup=true`} className="btn-primary-lg">
              Get Arceo free
            </a>
            <a href="mailto:support@arceo.ai" className="btn-ghost-lg">
              Talk to us
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
