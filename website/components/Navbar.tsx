"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { motion, useScroll } from "motion/react";
import Logo from "./Logo";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";
const BOOK_DEMO_HREF = "/book-demo";

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled]     = useState(false);
  const { scrollYProgress }         = useScroll();

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
      background: "rgba(255,255,255,0.85)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      borderBottom: "1px solid var(--rule)",
      boxShadow: scrolled ? "0 4px 18px rgba(17,24,39,0.08)" : "none",
      transition: "box-shadow 0.3s",
    }}>
      {/* How far down a long page you are. It sits on the bar's own hairline,
          so it reads as that rule filling rather than as a second element. */}
      <motion.span
        aria-hidden="true"
        style={{
          position: "absolute", left: 0, right: 0, bottom: -1, height: 2,
          background: "var(--ink)", transformOrigin: "left",
          scaleX: scrollYProgress,
        }}
      />
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

        {/* Center nav links — absolutely centered in the bar */}
        <nav style={{
          display: "flex", alignItems: "center", gap: 4,
          position: "absolute", left: "50%", top: "50%",
          transform: "translate(-50%, -50%)",
        }} className="desktop-nav">
          <Link href="/pricing" className="nav-link">Pricing</Link>
          <Link href="/security" className="nav-link">Security</Link>
        </nav>

        {/* Right actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }} className="desktop-actions">
          <a href={`${APP_URL}/login`} className="nav-link">Sign In</a>
          <Link href={BOOK_DEMO_HREF} className="nav-cta">
            Book a demo
          </Link>
        </div>

        {/* Hamburger */}
        <button onClick={() => setMobileOpen(!mobileOpen)}
          style={{ display: "none", background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 6 }}
          className="hamburger" aria-label="Menu">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            {mobileOpen ? <><path d="M4 4l12 12M16 4L4 16"/></> : <><path d="M3 6h14M3 10h14M3 14h14"/></>}
          </svg>
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div style={{
          borderTop: "1px solid var(--rule)",
          background: "rgba(255,255,255,0.98)",
          backdropFilter: "blur(12px)",
          padding: "12px 24px 20px",
          display: "flex", flexDirection: "column", gap: 2,
        }}>
          <Link href="/pricing" onClick={() => setMobileOpen(false)}
            style={{ fontSize: 15, fontWeight: 500, color: "var(--ink)", padding: "10px 4px" }}>
            Pricing
          </Link>
          <Link href="/security" onClick={() => setMobileOpen(false)}
            style={{ fontSize: 15, fontWeight: 500, color: "var(--ink)", padding: "10px 4px" }}>
            Security
          </Link>
          <a href={`${APP_URL}/login`}
            style={{ fontSize: 15, fontWeight: 500, color: "var(--ink)", padding: "10px 4px" }}>
            Sign In
          </a>
          <div style={{ height: 1, background: "var(--rule)", margin: "8px 0" }} />
          <Link href={BOOK_DEMO_HREF} className="nav-cta" style={{ justifyContent: "center", marginTop: 4 }}>
            Book a demo
          </Link>
        </div>
      )}

      <style>{`
        .nav-link {
          font-size: 14px; font-weight: 500;
          color: var(--muted);
          padding: 8px 14px; border-radius: 999px;
          transition: color 0.12s, background 0.12s;
          text-decoration: none;
        }
        .nav-link:hover {
          color: var(--ink);
          background: var(--ground-2);
        }
        .nav-cta {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 13px; font-weight: 500;
          color: #fff; background: var(--ink);
          padding: 9px 20px; border-radius: 999px;
          border: 1px solid transparent;
          /* Was reaching for --color-1-400 / --color-1-700, which this design
             system has never defined: the whole box-shadow was invalid and the
             browser dropped it, so the button had no lift at all. */
          box-shadow: var(--shadow-sm);
          text-decoration: none; white-space: nowrap;
          transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
        }
        .nav-cta:hover {
          background: #1f2937;
          transform: translateY(-1px);
          box-shadow: var(--shadow-md);
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
