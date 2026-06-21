"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Logo from "./Logo";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";
const BOOK_DEMO_HREF = "/book-demo";

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
      background: "rgba(250,246,240,0.85)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      borderBottom: "1px solid #E0D7C9",
      boxShadow: scrolled ? "0 4px 18px rgba(44,34,21,0.08)" : "none",
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

        {/* Center nav links — absolutely centered in the bar */}
        <nav style={{
          display: "flex", alignItems: "center", gap: 4,
          position: "absolute", left: "50%", top: "50%",
          transform: "translate(-50%, -50%)",
        }} className="desktop-nav">
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
          style={{ display: "none", background: "none", border: "none", color: "#6B5C4A", cursor: "pointer", padding: 6 }}
          className="hamburger" aria-label="Menu">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            {mobileOpen ? <><path d="M4 4l12 12M16 4L4 16"/></> : <><path d="M3 6h14M3 10h14M3 14h14"/></>}
          </svg>
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div style={{
          borderTop: "1px solid #E0D7C9",
          background: "rgba(250,246,240,0.98)",
          backdropFilter: "blur(12px)",
          padding: "12px 24px 20px",
          display: "flex", flexDirection: "column", gap: 2,
        }}>
          <a href={`${APP_URL}/login`}
            style={{ fontSize: 15, fontWeight: 500, color: "#2C2215", padding: "10px 4px" }}>
            Sign In
          </a>
          <div style={{ height: 1, background: "#E0D7C9", margin: "8px 0" }} />
          <Link href={BOOK_DEMO_HREF} className="nav-cta" style={{ justifyContent: "center", marginTop: 4 }}>
            Book a demo
          </Link>
        </div>
      )}

      <style>{`
        .nav-link {
          font-size: 14px; font-weight: 500;
          color: #6B5C4A;
          padding: 8px 14px; border-radius: 999px;
          transition: color 0.12s, background 0.12s;
          text-decoration: none;
        }
        .nav-link:hover {
          color: #2C2215;
          background: #EBE4D8;
        }
        .nav-cta {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 13px; font-weight: 500;
          color: #fff; background: #4B9CD3;
          padding: 9px 20px; border-radius: 999px;
          border: 1px solid transparent;
          box-shadow: var(--shadow-sm), inset var(--color-1-400) 0 10px 6px -6px, var(--color-1-700) 4px 8px 18px -6px;
          text-decoration: none; white-space: nowrap;
          transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
        }
        .nav-cta:hover {
          background: #2C6E9E;
          transform: translateY(-1px);
          box-shadow: var(--shadow-md), inset var(--color-1-400) 0 10px 6px -6px, var(--color-1-700) 4px 10px 22px -6px;
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
