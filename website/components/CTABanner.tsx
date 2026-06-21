"use client";

import Link from "next/link";
import { useFadeInOnScroll } from "../lib/useFadeIn";

export default function CTABanner() {
  const { ref, className } = useFadeInOnScroll(0);

  return (
    <section style={{ background: "#0a1628", padding: "96px 0" }}>
      <div ref={ref} className={`container ${className}`} style={{ textAlign: "center" }}>
        <h2 style={{ fontSize: 56, fontWeight: 700, color: "#fff", letterSpacing: "-0.02em", marginBottom: 14, lineHeight: 1.1 }}>
          Answer the budget question<br />before you scale your agents.
        </h2>
        <p style={{ fontSize: 16, color: "#9ca3af", lineHeight: 1.7, maxWidth: 480, margin: "0 auto" }}>
          One CFO-readable report: what it costs, and what could go wrong.{" "}
          <span style={{ color: "#fff", fontWeight: 700 }}>Before it hits production.</span>
        </p>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, flexWrap: "wrap", marginTop: 40 }}>
          <Link href="/book-demo" className="btn-white" style={{ padding: "16px 40px" }}>
            Book a demo
          </Link>
          <Link href="/pricing" className="btn-white-outline" style={{ padding: "15px 40px" }}>
            See pricing
          </Link>
        </div>
      </div>
    </section>
  );
}
