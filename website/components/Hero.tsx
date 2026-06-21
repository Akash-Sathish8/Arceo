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
      background: "#FAF6F0",
      position: "relative",
      overflow: "hidden",
      padding: "112px 0",
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
            background: "#E8F3FB", border: "1px solid #BFDDF0",
            borderRadius: 999, padding: "6px 16px 6px 10px", marginBottom: 24,
            boxShadow: "var(--shadow-xs)",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#2C6E9E", flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "#2C6E9E", letterSpacing: "0.04em" }}>
              Cost and risk, before production
            </span>
          </div>

          <h1 style={{
            fontSize: 60,
            fontWeight: 800,
            lineHeight: 1.05,
            letterSpacing: "-0.8px",
            color: "#2C2215",
            marginBottom: 20,
          }}>
            What your AI agent<br />
            could break <span style={{ color: "#2C6E9E" }}>+</span><br />
            cost to run
          </h1>

          <p style={{ fontSize: 20, color: "#6B5C4A", lineHeight: 1.6, marginBottom: 28, maxWidth: 520 }}>
            Arceo maps every tool your agent can call, prices what it&apos;ll cost to run, and flags the action chains that could go wrong, before you ship.
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Link href="/book-demo" className="btn-black">
              Book a demo
            </Link>
          </div>

          {/* Stats — hugs CTAs */}
          <div style={{ display: "flex", alignItems: "stretch", marginTop: 24, paddingTop: 18, borderTop: "1px solid #E0D7C9" }}>
            {[
              { n: "Any agent",  label: "Anthropic · OpenAI · MCP · GitHub · LangChain · Custom" },
              { n: "One report", label: "Cost and risk in one report" },
              { n: "Minutes",    label: "Connect → report" },
            ].map((s, i) => (
              <div key={s.label} style={{
                flex: 1,
                paddingRight: i < 2 ? 20 : 0,
                borderRight: i < 2 ? "1px solid #E0D7C9" : "none",
                paddingLeft: i > 0 ? 20 : 0,
              }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#2C2215", lineHeight: 1, letterSpacing: "-0.03em", marginBottom: 4 }}>{s.n}</div>
                <div style={{ fontSize: 11, lineHeight: 1.4, letterSpacing: "-0.01em", color: "#87786A", fontWeight: 500 }}>{s.label}</div>
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
          overflow: "visible",
          minWidth: 0,
        }}>
          <HeroGraphic />
        </div>
      </div>

      <style>{`
        @media (max-width: 960px) {
          .hero-shell { grid-template-columns: 1fr !important; gap: 40px !important; }
          .hero-left { max-width: 100% !important; }
          h1 { font-size: 40px !important; }
        }
        @media (max-width: 640px) {
          h1 { font-size: 32px !important; }
        }
      `}</style>
    </section>
  );
}
