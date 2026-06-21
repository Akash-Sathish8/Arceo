"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Logo from "./Logo";

// NEXT_PUBLIC_* values are inlined at BUILD time, not read at runtime — so
// NEXT_PUBLIC_APP_URL must be set when the marketing site is built (e.g. the
// Railway build env), pointing at the deployed dashboard. If it's missing we
// fall back to the local dashboard in dev; in a production build we send users
// to the on-site demo page so "Sign In" never becomes a dead link to the
// visitor's own localhost.
const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.NODE_ENV === "production" ? "" : "http://localhost:5173");
const BOOK_DEMO_HREF = "/book-demo";
const SIGN_IN_HREF = APP_URL ? `${APP_URL}/login` : BOOK_DEMO_HREF;

if (process.env.NODE_ENV === "production" && !process.env.NEXT_PUBLIC_APP_URL) {
  console.warn(
    "[arceo] NEXT_PUBLIC_APP_URL was not set at build time — 'Sign In' falls back to /book-demo. " +
      "Set it to the deployed dashboard URL in the build environment."
  );
}

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled]     = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header style={{
      position: "sticky",
      top: 0,
      zIndex: 50,
      width: "100%",
      background: "rgba(255,255,255,0.95)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      borderBottom: "1px solid #e2e8f0",
      boxShadow: scrolled ? "0 1px 12px rgba(0,0,0,0.06)" : "none",
      transition: "box-shadow 0.3s",
    }}>
      <div style={{
        width: "100%",
        padding: "0 24px",
        height: 64,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "relative",
      }}>

        {/* Logo */}
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            if (window.location.pathname === "/") window.location.reload();
            else window.location.href = "/";
          }}
          style={{ flexShrink: 0, textDecoration: "none", cursor: "pointer" }}
          aria-label="arceo home"
        >
          <Logo size={28} wordSize={22} />
        </a>

        {/* Center nav links */}
        <nav style={{ display: "flex", alignItems: "center", gap: 4 }} className="desktop-nav">
          <Link href={BOOK_DEMO_HREF} className="nav-link" style={{ fontWeight: 600 }}>Book Demo</Link>
        </nav>

        {/* Right actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }} className="desktop-actions">
          <a href={SIGN_IN_HREF} className="nav-link">Sign In</a>
          <Link href="/book-demo" className="nav-cta">
            Book a demo
          </Link>
        </div>

        {/* Hamburger */}
        <button onClick={() => setMobileOpen(!mobileOpen)}
          style={{ display: "none", background: "none", border: "none", color: "#64748b", cursor: "pointer", padding: 6 }}
          className="hamburger" aria-label="Menu">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            {mobileOpen ? <><path d="M4 4l12 12M16 4L4 16"/></> : <><path d="M3 6h14M3 10h14M3 14h14"/></>}
          </svg>
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div style={{
          borderTop: "1px solid #e2e8f0",
          background: "rgba(255,255,255,0.98)",
          backdropFilter: "blur(12px)",
          padding: "12px 24px 20px",
          display: "flex", flexDirection: "column", gap: 2,
        }}>
          <Link href={BOOK_DEMO_HREF} onClick={() => setMobileOpen(false)}
            style={{ fontSize: 15, fontWeight: 500, color: "#374151", padding: "10px 4px" }}>
            Book Demo
          </Link>
          <a href={SIGN_IN_HREF}
            style={{ fontSize: 15, fontWeight: 500, color: "#374151", padding: "10px 4px" }}>
            Sign In
          </a>
          <div style={{ height: 1, background: "#e2e8f0", margin: "8px 0" }} />
          <Link href="/book-demo" className="nav-cta" style={{ justifyContent: "center", marginTop: 4 }}>
            Book a demo
          </Link>
        </div>
      )}

      <style>{`
        .nav-link {
          font-size: 14px; font-weight: 500;
          color: #6b7280;
          padding: 6px 12px; border-radius: 8px;
          transition: color 0.12s, background 0.12s;
          text-decoration: none;
        }
        .nav-link:hover {
          color: #111827;
          background: #f3f4f6;
        }
        .nav-cta {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 13px; font-weight: 700;
          color: #fff; background: #111827;
          padding: 8px 18px; border-radius: 999px; border: none;
          text-decoration: none; white-space: nowrap;
          transition: background 0.15s, transform 0.1s;
        }
        .nav-cta:hover {
          background: #1e293b;
          transform: translateY(-1px);
        }
        @media (max-width: 768px) {
          .desktop-actions { display: none !important; }
          .desktop-nav { display: none !important; }
          .hamburger { display: flex !important; }
        }
      `}</style>
    </header>
  );
}
