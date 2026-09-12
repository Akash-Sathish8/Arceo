import Link from "next/link";
import { LogoWordmark } from "./Logo";

/* Big, but it has to survive a 360px phone: the wordmark is 4.5x as wide
   as it is tall, so 104px of height is already ~470px of width. */
const FOOTER_MARK_HEIGHT = 96;

export default function Footer() {
  return (
    <footer style={{ background: "var(--paper)", borderTop: "1px solid var(--rule)", position: "relative" }}>
      {/* The official wordmark, full size, closing the page. It is the real
          artwork rather than a font approximation, so the aqua bridge in the
          E survives at display scale — that bridge is the mark's whole idea. */}
      <div
        style={{
          overflow: "hidden",
          display: "flex",
          justifyContent: "center",
          padding: "56px 24px 0",
          userSelect: "none",
        }}
      >
        <LogoWordmark height={FOOTER_MARK_HEIGHT} title="Arceo" />
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
