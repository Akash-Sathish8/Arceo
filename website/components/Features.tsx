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
];

export default function Features() {
  return (
    <>
      <section id="features" className="features-section">
        <div className="container">
          <div className="section-header">
            <span className="section-tag">How it works</span>
            <h2 className="section-title">Everything you need to trust your agents</h2>
            <p className="section-sub">
              Three layers of protection — from capability analysis to real-time enforcement.
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

      {/* CTA banner */}
      <section id="pricing" className="cta-section">
        <div className="container">
          <h2>Start protecting your agents today.</h2>
          <p>Free to start. No credit card required.</p>
          <a href={`${APP_URL}/login?signup=true`} className="btn-primary-lg">
            Get Arceo free
          </a>
        </div>
      </section>
    </>
  );
}
