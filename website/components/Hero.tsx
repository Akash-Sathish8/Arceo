import ProductPreview from "@/components/ProductPreview";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";

const FEATURES = [
  {
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="3.5" cy="8" r="1.5" fill="currentColor" stroke="none"/><circle cx="12.5" cy="3.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12.5" cy="12.5" r="1.5" fill="currentColor" stroke="none"/><line x1="5" y1="7.5" x2="11" y2="4.2"/><line x1="5" y1="8.5" x2="11" y2="11.8"/><line x1="12.5" y1="5" x2="12.5" y2="11"/></svg>,
    iconBg: "#eff6ff", iconColor: "#2563eb",
    name: "Authority Mapping",
    desc: "Map every tool your agents can reach — automatically.",
  },
  {
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6.5"/><circle cx="8" cy="8" r="3.5"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/></svg>,
    iconBg: "#fff7ed", iconColor: "#ea580c",
    name: "Blast Radius Scoring",
    desc: "Score potential damage from 0–100 before agents run.",
  },
  {
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5L2.5 4v4.5c0 2.8 2.2 4.8 5.5 5.5 3.3-.7 5.5-2.7 5.5-5.5V4L8 1.5z"/><path d="M5.5 8l1.5 1.5 3-3"/></svg>,
    iconBg: "#f0fdf4", iconColor: "#16a34a",
    name: "Runtime Enforcement",
    desc: "Block dangerous actions and require human approval.",
  },
  {
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2v5L2.5 12.5a1 1 0 00.9 1.5h9.2a1 1 0 00.9-1.5L10 7V2"/><line x1="5" y1="2" x2="11" y2="2"/><circle cx="6" cy="11" r="0.7" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="0.7" fill="currentColor" stroke="none"/></svg>,
    iconBg: "#f5f3ff", iconColor: "#7c3aed",
    name: "Sandbox Testing",
    desc: "Run 28 adversarial scenarios against any agent.",
  },
];

export default function Hero() {
  return (
    <section className="hero">
      <div className="container">
        <h1 className="hero-headline">
          Know every action your<br />AI agents can take.
        </h1>
        <p className="hero-tagline">
          The security layer for AI agents — from capability analysis to real-time enforcement.
        </p>

        <div className="hero-split">
          {/* Left card — feature showcase */}
          <div className="hero-card hero-left">
            <div className="hero-card-top">
              <span className="hero-new-badge">AI Agent Security</span>
              <h2 className="hero-card-title">
                Control what your AI agents can do.
              </h2>
              <div className="hero-card-ctas">
                <a href={`${APP_URL}/login?signup=true`} className="hero-card-btn-primary">Get started free</a>
                <a href="#features" className="hero-card-btn-ghost">See how it works →</a>
              </div>
            </div>

            <div className="hero-feature-list">
              {FEATURES.map((f) => (
                <div key={f.name} className="hero-feature-item">
                  <span className="hero-feature-icon" style={{ background: f.iconBg, color: f.iconColor }}>{f.icon}</span>
                  <div className="hero-feature-text">
                    <span className="hero-feature-name">{f.name}</span>
                    <span className="hero-feature-desc">{f.desc}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="hero-card-footer-link">
              <a href="#features">See all features →</a>
            </div>
          </div>

          {/* Right card — live product preview */}
          <div className="hero-card hero-right">
            <ProductPreview />
          </div>
        </div>
      </div>
    </section>
  );
}
