import Link from "next/link";
import { Wordmark } from "./Logo";

export default function Footer() {
  return (
    <footer style={{ background: "var(--paper)", borderTop: "1px solid var(--rule)", position: "relative" }}>
      {/* The brand moment: the full wordmark, in its own inks, as the close. */}
      <div style={{
        overflow: "hidden",
        display: "flex",
        justifyContent: "center",
        padding: "48px 24px 0",
        userSelect: "none",
      }}>
        <Wordmark width="min(480px, 72vw)" />
      </div>

      <div className="container" style={{
        paddingBottom: 28,
        paddingTop: 20,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
      }}>
        {/* Credibility line */}
        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", textAlign: "center", letterSpacing: "0.01em" }}>
          Cost and risk for AI agents, before they go live · Built for CIOs and CFOs
        </p>

        {/* Footer links */}
        <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", justifyContent: "center" }}>
          <Link href="/pricing" style={{ fontSize: 12, color: "var(--muted-2)", textDecoration: "none" }}>Pricing</Link>
          <Link href="/security" style={{ fontSize: 12, color: "var(--muted-2)", textDecoration: "none" }}>Security</Link>
          <Link href="/book-demo" style={{ fontSize: 12, color: "var(--muted-2)", textDecoration: "none" }}>Book a demo</Link>
        </div>

        <span style={{ fontSize: 12, color: "var(--muted-2)" }}>
          © {new Date().getFullYear()} Arceo. All rights reserved.
        </span>
      </div>
    </footer>
  );
}
