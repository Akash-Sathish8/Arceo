"use client";

import { useState } from "react";
import Link from "next/link";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";

const STEPS_PREVIEW = [
  { n: "1", label: "Authorize via OAuth", desc: "Read-only. Takes 30 seconds." },
  { n: "2", label: "We scan your agents", desc: "All Agentforce agents, actions, and chains." },
  { n: "3", label: "Review your blast radius", desc: "Score, risks, and policy recommendations." },
];

const TRUST = [
  "Read-only OAuth — we cannot modify your org",
  "No customer records or data ever leave Salesforce",
  "Revoke access anytime from Connected Apps",
  "First scan free — no credit card required",
];

export default function ConnectSalesforcePage() {
  const [form, setForm] = useState({ email: "", company: "", orgType: "" });
  const [submitted, setSubmitted] = useState(false);

  const update = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // In production: POST to backend to initiate Salesforce OAuth flow.
    // For now, redirect to the app signup with email pre-filled.
    const params = new URLSearchParams({ signup: "true" });
    if (form.email) params.set("email", form.email);
    window.location.href = `${APP_URL}/login?${params.toString()}`;
    setSubmitted(true);
  };

  return (
    <>
      <Navbar />
      <main style={{ background: "#fff", minHeight: "calc(100vh - 64px)" }}>

        {/* Two-column layout */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          minHeight: "calc(100vh - 64px)",
        }} className="connect-grid">

          {/* Left: value prop */}
          <div style={{
            background: "#f9fafb",
            borderRight: "1px solid #e5e7eb",
            padding: "80px 64px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}>
            {/* Badge */}
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              background: "#f0f9ff", border: "1px solid #bae6fd",
              borderRadius: 999, padding: "5px 14px 5px 8px", marginBottom: 28,
              width: "fit-content",
            }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#00A1E0", flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: "#0369a1", letterSpacing: "0.02em" }}>
                Free Agentforce Scan
              </span>
            </div>

            <h1 style={{ fontSize: 42, fontWeight: 700, color: "#111827", letterSpacing: "-0.02em", lineHeight: 1.15, marginBottom: 16 }}>
              See your Agentforce blast radius in 60 seconds.
            </h1>
            <p style={{ fontSize: 15, color: "#6b7280", lineHeight: 1.7, marginBottom: 48 }}>
              Connect your Salesforce org once. Arceo maps every action your Agentforce agents can take and scores their risk — before they hit production.
            </p>

            {/* Steps preview */}
            <div style={{ display: "flex", flexDirection: "column", gap: 20, marginBottom: 48 }}>
              {STEPS_PREVIEW.map((s) => (
                <div key={s.n} style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: "50%",
                    background: "#111827", color: "#fff",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 13, fontWeight: 700, flexShrink: 0,
                  }}>
                    {s.n}
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 2 }}>{s.label}</div>
                    <div style={{ fontSize: 13, color: "#9ca3af" }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Trust signals */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {TRUST.map(t => (
                <div key={t} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
                    <circle cx="7" cy="7" r="7" fill="#dcfce7"/>
                    <path d="M4 7l2 2 4-4" stroke="#16a34a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span style={{ fontSize: 13, color: "#6b7280" }}>{t}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Right: form */}
          <div style={{
            padding: "80px 64px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}>
            {!submitted ? (
              <>
                <h2 style={{ fontSize: 28, fontWeight: 700, color: "#111827", letterSpacing: "-0.02em", marginBottom: 8 }}>
                  Start your free scan
                </h2>
                <p style={{ fontSize: 14, color: "#9ca3af", marginBottom: 36 }}>
                  Takes 2 minutes. No credit card required.
                </p>

                <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
                      Work email <span style={{ color: "#dc2626" }}>*</span>
                    </span>
                    <input
                      type="email"
                      required
                      placeholder="you@company.com"
                      value={form.email}
                      onChange={update("email")}
                      style={inputStyle}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Company name</span>
                    <input
                      type="text"
                      placeholder="Acme Corp"
                      value={form.company}
                      onChange={update("company")}
                      style={inputStyle}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Salesforce org type</span>
                    <select value={form.orgType} onChange={update("orgType")} style={inputStyle}>
                      <option value="">Select one</option>
                      <option value="production">Production</option>
                      <option value="sandbox">Sandbox / Developer</option>
                      <option value="scratch">Scratch org</option>
                    </select>
                  </label>

                  <button type="submit" style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    background: "#111827", color: "#fff",
                    fontSize: 14, fontWeight: 700,
                    padding: "14px 24px", borderRadius: 10,
                    border: "none", cursor: "pointer",
                    marginTop: 8,
                  }}>
                    Connect Salesforce → Free scan
                  </button>

                  <p style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", lineHeight: 1.6 }}>
                    By connecting, you authorize read-only access to your org&apos;s metadata.{" "}
                    <Link href="/security" style={{ color: "#374151", fontWeight: 600 }}>Learn what we access →</Link>
                  </p>
                </form>

                <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid #f3f4f6", textAlign: "center" }}>
                  <span style={{ fontSize: 13, color: "#9ca3af" }}>
                    Not ready to connect?{" "}
                    <Link href="/book-demo" style={{ color: "#374151", fontWeight: 600 }}>Book a demo instead →</Link>
                  </span>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center" }}>
                <div style={{
                  width: 56, height: 56, borderRadius: "50%",
                  background: "#00A1E0", color: "#fff",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 24,
                }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h2 style={{ fontSize: 28, fontWeight: 700, color: "#111827", marginBottom: 12 }}>Redirecting you to the app…</h2>
                <p style={{ fontSize: 14, color: "#9ca3af" }}>You&apos;ll authorize Salesforce OAuth on the next screen.</p>
              </div>
            )}
          </div>
        </div>
      </main>
      <Footer />

      <style>{`
        @media (max-width: 900px) {
          .connect-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  fontSize: 15,
  padding: "11px 14px",
  border: "1px solid #d1d5db",
  borderRadius: 8,
  background: "#fff",
  color: "#111827",
  outline: "none",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};
