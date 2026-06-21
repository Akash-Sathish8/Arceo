"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import HeroGraphic from "./HeroGraphic";

export default function Hero() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 60);
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => { clearTimeout(t); window.removeEventListener("pageshow", onPageShow); };
  }, []);

  return (
    <section style={{
      background: "#fff",
      position: "relative",
      overflow: "hidden",
      padding: "96px 0",
    }}>
      <div className="hero-shell" style={{
        maxWidth: 1280,
        margin: "0 auto",
        padding: "0 32px",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
        gap: 56,
        alignItems: "center",
      }}>
        {/* Left — text + CTAs */}
        <div
          className={`hero-left fade-up ${visible ? "visible" : ""}`}
          style={{ maxWidth: 600, minWidth: 0 }}
        >
          {/* Badge */}
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 7,
            background: "rgba(37,99,235,0.08)", border: "1px solid rgba(37,99,235,0.2)",
            borderRadius: 999, padding: "5px 14px 5px 8px", marginBottom: 24,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#2563eb", flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "#2563eb", letterSpacing: "0.04em" }}>
              Predeployment cost & risk
            </span>
          </div>

          <h1 style={{
            fontSize: 56,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: "-0.03em",
            color: "#0f172a",
            marginBottom: 20,
          }}>
            What your AI agent<br />
            will cost — and break —<br />
            <span style={{ color: "#64748b" }}>before you ship it.</span>
          </h1>

          <p style={{ fontSize: 17, color: "#475569", lineHeight: 1.55, marginBottom: 28, maxWidth: 500 }}>
            Arceo forecasts an agent&apos;s monthly cost and worst-case risk in one CFO-readable report. Bring any agent — Anthropic, OpenAI, MCP, or a GitHub repo.
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Link href="/book-demo" className="btn-black">
              Book a demo
            </Link>
            <Link href="#features" className="btn-outline">See how it works</Link>
          </div>

          {/* Stats — hugs CTAs */}
          <div style={{ display: "flex", alignItems: "stretch", marginTop: 24, paddingTop: 18, borderTop: "1px solid #e2e8f0" }}>
            {[
              { n: "1", label: "CFO-ready report" },
              { n: "14", label: "Chain rules" },
              { n: "5",  label: "Risk labels" },
            ].map((s, i) => (
              <div key={s.label} style={{
                flex: 1,
                paddingRight: i < 2 ? 20 : 0,
                borderRight: i < 2 ? "1px solid #e2e8f0" : "none",
                paddingLeft: i > 0 ? 20 : 0,
              }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#0f172a", lineHeight: 1, letterSpacing: "-0.03em", marginBottom: 4 }}>{s.n}</div>
                <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Right — contained editorial graphic */}
        <div className="hero-right" style={{
          position: "relative",
          width: "100%",
          aspectRatio: "5 / 4",
          maxHeight: 460,
          borderRadius: 20,
          overflow: "hidden",
          minWidth: 0,
        }}>
          <HeroGraphic />
        </div>
      </div>

      <style>{`
        @media (max-width: 960px) {
          .hero-shell { grid-template-columns: 1fr !important; gap: 40px !important; }
          .hero-left { max-width: 100% !important; }
          h1 { font-size: 44px !important; }
        }
        @media (max-width: 640px) {
          h1 { font-size: 34px !important; }
        }
      `}</style>
    </section>
  );
}
