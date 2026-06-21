"use client";

import Link from "next/link";
import { useFadeInOnScroll } from "../lib/useFadeIn";

export default function CTABanner() {
  const { ref, className } = useFadeInOnScroll(0);

  return (
    <section style={{ background: "linear-gradient(160deg, #3A86B8 0%, #245E86 100%)", padding: "112px 0" }}>
      <div ref={ref} className={`container ${className}`} style={{ textAlign: "center" }}>
        <h2 style={{ fontSize: 52, fontWeight: 800, color: "#FAF6F0", letterSpacing: "-0.4px", marginBottom: 14, lineHeight: 1.1 }}>
          Ship your AI agents with a<br />number you can defend.
        </h2>
        <p style={{ fontSize: 20, color: "#EAF4FB", lineHeight: 1.7, maxWidth: 520, margin: "0 auto" }}>
          Bring your own agent and we&apos;ll show you the real numbers, cost and worst case,{" "}
          <span style={{ color: "#FAF6F0", fontWeight: 700 }}>on a live walkthrough.</span>
        </p>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, flexWrap: "wrap", marginTop: 40 }}>
          <Link href="/book-demo" className="btn-white" style={{ padding: "16px 40px" }}>
            Book a demo
          </Link>
        </div>
      </div>
    </section>
  );
}
