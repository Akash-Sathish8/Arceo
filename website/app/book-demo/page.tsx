"use client";

import { useState } from "react";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";

const FALLBACK_EMAIL = "akakash.sathish@gmail.com";

type Status = "idle" | "submitting" | "success" | "error";

export default function BookDemoPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    role: "",
    message: "",
    website: "", // honeypot — hidden from humans, bots fill it in
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("submitting");
    setError("");

    try {
      const res = await fetch("/api/demo-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        setError(data.error || "We couldn't send that just now.");
        setStatus("error");
        return;
      }
      setStatus("success");
    } catch {
      setError("We couldn't reach the server.");
      setStatus("error");
    }
  };

  const update = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const mailtoFallback =
    `mailto:${FALLBACK_EMAIL}` +
    `?subject=${encodeURIComponent("Arceo demo request: " + (form.name || form.email))}` +
    `&body=${encodeURIComponent(
      [
        `Name: ${form.name}`,
        `Email: ${form.email}`,
        `Company: ${form.company || "(not provided)"}`,
        `Role: ${form.role || "(not provided)"}`,
        "",
        "Message:",
        form.message || "(none)",
      ].join("\n")
    )}`;

  return (
    <>
      <Navbar />
      <section style={{
        minHeight: "calc(100vh - 64px)",
        background: "var(--clay-cream)",
        display: "flex",
        alignItems: "center",
        padding: "80px 24px",
      }}>
        <div style={{ maxWidth: 560, margin: "0 auto", width: "100%" }}>

          {status !== "success" ? (
            <>
              <span className="eyebrow">Design partner pilot</span>
              <h1 style={{
                fontSize: 44,
                fontWeight: 700,
                lineHeight: 1.15,
                letterSpacing: "-0.02em",
                color: "var(--clay-heading)",
                margin: "8px 0 12px",
              }}>
                Book a demo
              </h1>
              <p style={{
                fontSize: 16,
                color: "var(--clay-body)",
                lineHeight: 1.6,
                marginBottom: 40,
              }}>
                Bring one real agent. We&apos;ll put a cost figure and a worst-case number on it
                with you, on a live walkthrough.
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

                <Field label="Role">
                  <input
                    type="text"
                    placeholder="CIO, CFO, Platform Lead, Engineer..."
                    value={form.role}
                    onChange={update("role")}
                    style={inputStyle}
                  />
                </Field>

                <Field label="What brings you to Arceo?">
                  <textarea
                    rows={4}
                    value={form.message}
                    onChange={update("message")}
                    style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
                  />
                </Field>

                {/* Honeypot — visually hidden, never announced to screen readers */}
                <input
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  value={form.website}
                  onChange={update("website")}
                  style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
                />

                {status === "error" && (
                  <div role="alert" style={{
                    background: "var(--risk-critical-fill)",
                    border: "1px solid var(--risk-critical-border)",
                    borderRadius: 12,
                    padding: "12px 14px",
                    fontSize: 14,
                    color: "#991b1b",
                    lineHeight: 1.55,
                  }}>
                    {error}{" "}
                    <a href={mailtoFallback} style={{ color: "#991b1b", fontWeight: 600, textDecoration: "underline" }}>
                      Email us directly instead
                    </a>{" "}
                    and we&apos;ll pick it up from there.
                  </div>
                )}

                <button
                  type="submit"
                  className="btn-black"
                  disabled={status === "submitting"}
                  style={{
                    marginTop: 12,
                    fontSize: 14,
                    padding: "12px 22px",
                    justifyContent: "center",
                    cursor: status === "submitting" ? "wait" : "pointer",
                    border: "none",
                    opacity: status === "submitting" ? 0.65 : 1,
                  }}
                >
                  {status === "submitting" ? "Sending..." : "Request a walkthrough"}
                  {status !== "submitting" && (
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.5 6.5h8M7 3l3.5 3.5L7 10" />
                    </svg>
                  )}
                </button>

                <p style={{ fontSize: 12.5, color: "var(--clay-body-subtle)", textAlign: "center", lineHeight: 1.6 }}>
                  We use this only to get back to you about a pilot. No newsletter, no reselling.
                </p>
              </form>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{
                width: 56, height: 56, borderRadius: "50%",
                background: "var(--clay-brand)", color: "#fff",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                marginBottom: 24,
                boxShadow: "var(--shadow-sm)",
              }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h1 style={{
                fontSize: 36,
                fontWeight: 700,
                color: "var(--clay-heading)",
                marginBottom: 12,
                letterSpacing: "-0.02em",
              }}>
                Thanks, {form.name.split(" ")[0] || "we got it"}
              </h1>
              <p style={{ fontSize: 16, color: "var(--clay-body)", lineHeight: 1.6 }}>
                Your request is in. We&apos;ll reach out to{" "}
                <strong style={{ color: "var(--clay-heading)" }}>{form.email}</strong> to find a time.
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
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--clay-heading)" }}>
        {label}{required && <span style={{ color: "var(--risk-critical)", marginLeft: 4 }}>*</span>}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  fontSize: 15,
  padding: "11px 14px",
  border: "1px solid var(--clay-border)",
  borderRadius: 12,
  background: "#fff",
  color: "var(--clay-heading)",
  outline: "none",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};
