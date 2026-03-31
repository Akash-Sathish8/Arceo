"use client";

import { useState } from "react";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";

// ── SVG Icons ─────────────────────────────────────────────────────────
const I = {
  mapping: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="3.5" cy="8" r="1.5" fill="currentColor" stroke="none"/><circle cx="12.5" cy="3.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12.5" cy="12.5" r="1.5" fill="currentColor" stroke="none"/><line x1="5" y1="7.5" x2="11" y2="4.2"/><line x1="5" y1="8.5" x2="11" y2="11.8"/><line x1="12.5" y1="5" x2="12.5" y2="11"/></svg>,
  blast:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6.5"/><circle cx="8" cy="8" r="3.5"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/></svg>,
  shield:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5L2.5 4v4.5c0 2.8 2.2 4.8 5.5 5.5 3.3-.7 5.5-2.7 5.5-5.5V4L8 1.5z"/><path d="M5.5 8l1.5 1.5 3-3"/></svg>,
  flask:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2v5L2.5 12.5a1 1 0 00.9 1.5h9.2a1 1 0 00.9-1.5L10 7V2"/><line x1="5" y1="2" x2="11" y2="2"/><circle cx="6" cy="11" r="0.7" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="0.7" fill="currentColor" stroke="none"/></svg>,
  audit:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="1.5" width="10" height="13" rx="1.5"/><line x1="5.5" y1="5.5" x2="10.5" y2="5.5"/><line x1="5.5" y1="8" x2="10.5" y2="8"/><line x1="5.5" y1="10.5" x2="8.5" y2="10.5"/></svg>,
  puzzle:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2h1.5a1.5 1.5 0 010 3H6v2.5h2.5a1.5 1.5 0 010 3H6V13H2.5V9.5a1.5 1.5 0 01-3 0V6a1.5 1.5 0 013 0V2H6z" transform="translate(2,0.5)"/></svg>,
  chat:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v6A1.5 1.5 0 0112.5 11H9l-3 3v-3H3.5A1.5 1.5 0 012 9.5v-6z"/><line x1="5" y1="6" x2="11" y2="6"/><line x1="5" y1="8.5" x2="9" y2="8.5"/></svg>,
  terminal:<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6l2.5 2-2.5 2"/><line x1="9.5" y1="10" x2="12" y2="10"/></svg>,
  trending:<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1.5 11.5l4-4 2.5 2.5 5-6"/><path d="M10 4h4v4"/></svg>,
  dollar:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="8" y1="1.5" x2="8" y2="14.5"/><path d="M11 4.5H6.5a2.5 2.5 0 000 5h3a2.5 2.5 0 010 5H5"/></svg>,
  lock:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="10" height="8" rx="1.5"/><path d="M5 7V5a3 3 0 016 0v2"/><line x1="8" y1="10.5" x2="8" y2="12"/></svg>,
  code:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4L1 8l4 4"/><path d="M11 4l4 4-4 4"/><line x1="9.5" y1="2.5" x2="6.5" y2="13.5"/></svg>,
  book:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3.5A1.5 1.5 0 013.5 2H12v11H3.5A1.5 1.5 0 012 11.5V3.5z"/><line x1="12" y1="2" x2="12" y2="13"/><line x1="5" y1="5.5" x2="9" y2="5.5"/><line x1="5" y1="8" x2="9" y2="8"/></svg>,
  api:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3H3a1 1 0 00-1 1v8a1 1 0 001 1h2"/><path d="M11 3h2a1 1 0 011 1v8a1 1 0 01-1 1h-2"/><path d="M7 6l2 2-2 2"/></svg>,
  python:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M5.5 2h3A1.5 1.5 0 0110 3.5V6H6a2 2 0 00-2 2v2.5A1.5 1.5 0 005.5 12H8"/><path d="M10.5 14h-3A1.5 1.5 0 016 12.5V10h4a2 2 0 002-2V5.5A1.5 1.5 0 0010.5 4H8"/><circle cx="6.5" cy="4" r="0.6" fill="currentColor" stroke="none"/><circle cx="9.5" cy="12" r="0.6" fill="currentColor" stroke="none"/></svg>,
  js:      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M9.5 6v5"/><path d="M6.5 6v3.5a1.5 1.5 0 01-3 0"/></svg>,
  pen:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 2l3 3L5.5 13H2.5v-3L11 2z"/><line x1="9" y1="4" x2="12" y2="7"/></svg>,
  clock:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 1.5"/></svg>,
};

// ── Data ──────────────────────────────────────────────────────────────
const PRODUCT = [
  { icon: I.mapping, bg: "#eff6ff", color: "#2563eb", name: "Authority Mapping",   desc: "Visualize every tool your agents can reach",       href: "#features" },
  { icon: I.blast,   bg: "#fff7ed", color: "#ea580c", name: "Blast Radius Scoring", desc: "Quantify potential damage from 0–100 instantly",   href: "#features" },
  { icon: I.shield,  bg: "#f0fdf4", color: "#16a34a", name: "Runtime Enforcement", desc: "Block dangerous actions at the tool call level",   href: "#features" },
  { icon: I.flask,   bg: "#f5f3ff", color: "#7c3aed", name: "Sandbox Testing",     desc: "Run 28 adversarial scenarios against any agent",   href: "#features" },
  { icon: I.audit,   bg: "#f0fdfa", color: "#0d9488", name: "Audit & Compliance",  desc: "Full audit trail and execution log for every run", href: `${APP_URL}/history` },
  { icon: I.puzzle,  bg: "#fafafa", color: "#374151", name: "Integrations",        desc: "OpenAI, Anthropic, LangChain, CrewAI, and more",   href: "#features" },
];

const SOLUTIONS = [
  {
    section: "By Use Case",
    items: [
      { icon: I.chat,     bg: "#eff6ff", color: "#2563eb", name: "Customer Support",     desc: "Protect agents with access to CRM and tickets",     href: `${APP_URL}/login?signup=true` },
      { icon: I.terminal, bg: "#fff7ed", color: "#ea580c", name: "DevOps & Engineering", desc: "Secure agents that touch production infrastructure",  href: `${APP_URL}/login?signup=true` },
      { icon: I.trending, bg: "#f0fdf4", color: "#16a34a", name: "Sales & Revenue",      desc: "Control agents that access customer and deal data",  href: `${APP_URL}/login?signup=true` },
      { icon: I.dollar,   bg: "#fefce8", color: "#ca8a04", name: "Finance & Operations", desc: "Audit agents that move money or send sensitive data", href: `${APP_URL}/login?signup=true` },
    ],
  },
  {
    section: "By Team",
    items: [
      { icon: I.lock, bg: "#fef2f2", color: "#dc2626", name: "Security Teams",    desc: "Enforce policies across your entire agent fleet",    href: `${APP_URL}/login?signup=true` },
      { icon: I.code, bg: "#f5f3ff", color: "#7c3aed", name: "Engineering Teams", desc: "Integrate Arceo directly into your CI/CD pipeline", href: `${APP_URL}/login?signup=true` },
    ],
  },
];

const RESOURCES = [
  { icon: I.book,   bg: "#eff6ff", color: "#2563eb", name: "Documentation",  desc: "Guides, tutorials, and core concepts",     href: "#", soon: true },
  { icon: I.api,    bg: "#f5f3ff", color: "#7c3aed", name: "API Reference",  desc: "Full REST API with request examples",      href: "#", soon: true },
  { icon: I.python, bg: "#f0fdf4", color: "#16a34a", name: "Python SDK",     desc: "pip install arceo — integrate in minutes", href: "#", soon: true },
  { icon: I.js,     bg: "#fefce8", color: "#ca8a04", name: "JavaScript SDK", desc: "Browser and Node.js support",              href: "#", soon: true },
  { icon: I.pen,    bg: "#fff7ed", color: "#ea580c", name: "Blog",           desc: "Insights on AI agent security",            href: "#", soon: true },
  { icon: I.clock,  bg: "#f0fdfa", color: "#0d9488", name: "Changelog",      desc: "What's new in Arceo",                      href: "#", soon: true },
];

// ── Components ────────────────────────────────────────────────────────
type Item = { icon: React.ReactNode; bg: string; color: string; name: string; desc: string; href: string; soon?: boolean };

function DDItem({ icon, bg, color, name, desc, href, soon }: Item) {
  return (
    <a href={soon ? undefined : href} className={`nav-dd-item${soon ? " nav-dd-item-soon" : ""}`}>
      <span className="nav-dd-icon" style={{ background: bg, color }}>{icon}</span>
      <span className="nav-dd-text">
        <span className="nav-dd-name">{name}</span>
        <span className="nav-dd-desc">{desc}</span>
      </span>
      {soon && <span className="nav-dd-soon">Soon</span>}
    </a>
  );
}

const Caret = () => (
  <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ marginLeft: 3, opacity: 0.6, flexShrink: 0, transition: "transform 0.15s" }}>
    <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// ── Navbar ────────────────────────────────────────────────────────────
export default function Navbar() {
  const [open, setOpen] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="nav">
      <div className="nav-inner">
        <a href="/" className="nav-logo">
          Arceo<span className="nav-logo-dot" />
        </a>

        <nav className="nav-links">
          {/* Product */}
          <div className="nav-dropdown-wrap" onMouseEnter={() => setOpen("product")} onMouseLeave={() => setOpen(null)}>
            <span className={`nav-link nav-link-caret${open === "product" ? " nav-link-open" : ""}`}>
              Product <Caret />
            </span>
            {open === "product" && (
              <div className="nav-dropdown-panel nav-dd-product">
                <div className="nav-dd-grid">
                  {PRODUCT.map((item) => <DDItem key={item.name} {...item} />)}
                </div>
                <div className="nav-dd-footer">
                  <a href={`${APP_URL}/login?signup=true`} className="nav-dd-footer-cta">
                    <span>Start for free</span>
                    <span className="nav-dd-footer-arrow">→</span>
                  </a>
                  <span className="nav-dd-footer-sub">No credit card required</span>
                </div>
              </div>
            )}
          </div>

          {/* Solutions */}
          <div className="nav-dropdown-wrap" onMouseEnter={() => setOpen("solutions")} onMouseLeave={() => setOpen(null)}>
            <span className={`nav-link nav-link-caret${open === "solutions" ? " nav-link-open" : ""}`}>
              Solutions <Caret />
            </span>
            {open === "solutions" && (
              <div className="nav-dropdown-panel nav-dd-solutions">
                {SOLUTIONS.map((group) => (
                  <div key={group.section} className="nav-dd-group">
                    <div className="nav-dd-section">{group.section}</div>
                    {group.items.map((item) => <DDItem key={item.name} {...item} />)}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Resources */}
          <div className="nav-dropdown-wrap" onMouseEnter={() => setOpen("resources")} onMouseLeave={() => setOpen(null)}>
            <span className={`nav-link nav-link-caret${open === "resources" ? " nav-link-open" : ""}`}>
              Resources <Caret />
            </span>
            {open === "resources" && (
              <div className="nav-dropdown-panel nav-dd-resources">
                {RESOURCES.map((item) => <DDItem key={item.name} {...item} />)}
              </div>
            )}
          </div>

          <a href="#features" className="nav-link">Enterprise</a>
          <a href="#pricing" className="nav-link">Pricing</a>
          <a href={`${APP_URL}/login?signup=true`} className="nav-link">Request a demo</a>
        </nav>

        <div className="nav-actions">
          <a href={`${APP_URL}/login?signup=true`} className="btn-nav-primary">Get Arceo free</a>
          <a href={`${APP_URL}/login`} className="btn-nav-ghost">Log in</a>
        </div>

        {/* Hamburger */}
        <button className="nav-hamburger" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle menu">
          {mobileOpen ? (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 3L15 15M15 3L3 15"/>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 5h12M3 9h12M3 13h12"/>
            </svg>
          )}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="nav-mobile">
          <a href="#features" className="nav-mobile-link" onClick={() => setMobileOpen(false)}>Product</a>
          <a href="#features" className="nav-mobile-link" onClick={() => setMobileOpen(false)}>Solutions</a>
          <a href="#features" className="nav-mobile-link" onClick={() => setMobileOpen(false)}>Enterprise</a>
          <a href="#pricing"  className="nav-mobile-link" onClick={() => setMobileOpen(false)}>Pricing</a>
          <div className="nav-mobile-sep" />
          <a href={`${APP_URL}/login?signup=true`} className="nav-mobile-cta">Get Arceo free</a>
          <a href={`${APP_URL}/login`} className="nav-mobile-ghost">Log in</a>
        </div>
      )}
    </header>
  );
}
