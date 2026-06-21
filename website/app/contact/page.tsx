"use client";

import { useState } from "react";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";

export default function ContactPage() {
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    message: "",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = [
      `Name: ${form.name}`,
      `Email: ${form.email}`,
      `Company: ${form.company || "(not provided)"}`,
      "",
      "Message:",
      form.message || "(none)",
    ].join("\n");
    const mailto = `mailto:akakash.sathish@gmail.com`
      + `?subject=${encodeURIComponent("Arceo contact: " + (form.name || form.email))}`
      + `&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
    setSubmitted(true);
  };

  const update = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <Navbar />
      <section style={{
        minHeight: "calc(100vh - 64px)",
        background: "#fff",
        display: "flex",
        alignItems: "center",
        padding: "80px 24px",
      }}>
        <div style={{ maxWidth: 560, margin: "0 auto", width: "100%" }}>

          {!submitted ? (
            <>
              <h1 style={{
                fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
                fontSize: 44,
                fontWeight: 700,
                lineHeight: 1.15,
                letterSpacing: "-0.02em",
                color: "#111827",
                marginBottom: 12,
              }}>
                Contact us
              </h1>
              <p style={{
                fontSize: 16,
                color: "#6b7280",
                lineHeight: 1.6,
                marginBottom: 40,
              }}>
                Questions about Arceo, pricing, or a pilot? Send us a note and we&apos;ll get back within one business day.
              </p>

              <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <Field label="Full name" required>
                  <input type="text" required value={form.name} onChange={update("name")} style={inputStyle} />
                </Field>

                <Field label="Work email" required>
                  <input type="email" required value={form.email} onChange={update("email")} style={inputStyle} />
                </Field>

                <Field label="Company">
                  <input type="text" value={form.company} onChange={update("company")} style={inputStyle} />
                </Field>

                <Field label="How can we help?">
                  <textarea
                    rows={4}
                    value={form.message}
                    onChange={update("message")}
                    style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
                  />
                </Field>

                <button type="submit" className="btn-black" style={{
                  marginTop: 12,
                  fontSize: 14,
                  padding: "12px 22px",
                  justifyContent: "center",
                  cursor: "pointer",
                  border: "none",
                }}>
                  Send message
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 6.5h8M7 3l3.5 3.5L7 10"/>
                  </svg>
                </button>
              </form>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{
                width: 56, height: 56, borderRadius: "50%",
                background: "#111827", color: "#fff",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                marginBottom: 24,
              }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h1 style={{
                fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
                fontSize: 36,
                fontWeight: 700,
                color: "#111827",
                marginBottom: 12,
                letterSpacing: "-0.02em",
              }}>
                Thanks, {form.name || "we got it"}
              </h1>
              <p style={{ fontSize: 16, color: "#6b7280", lineHeight: 1.6 }}>
                We&apos;ll get back to you at <strong style={{ color: "#111827" }}>{form.email}</strong> within one business day.
              </p>
            </div>
          )}

        </div>
      </section>
      <Footer />
    </>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
        {label}{required && <span style={{ color: "#dc2626", marginLeft: 4 }}>*</span>}
      </span>
      {children}
    </label>
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
