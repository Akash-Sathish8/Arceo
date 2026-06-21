import Link from "next/link";

export default function Footer() {
  return (
    <footer style={{ background: "#FAF6F0", borderTop: "1px solid #E0D7C9", position: "relative" }}>
      <div style={{
        overflow: "hidden",
        textAlign: "center",
        padding: "48px 0 0",
        userSelect: "none",
      }}>
        <span style={{
          display: "inline-flex",
          alignItems: "baseline",
          fontFamily: "var(--font-poppins), system-ui, sans-serif",
          fontSize: "clamp(80px, 10vw, 120px)",
          fontWeight: 900,
          color: "#EBE4D8",
          letterSpacing: "-3px",
          lineHeight: 0.9,
        }}>
          <svg width="0.9em" height="0.9em" viewBox="0 0 32 32" fill="none" aria-hidden="true" style={{ alignSelf: "center" }}>
            <line x1="16" y1="5"  x2="10" y2="18" stroke="#EBE4D8" strokeWidth="2" strokeLinecap="round" />
            <line x1="16" y1="5"  x2="22" y2="18" stroke="#EBE4D8" strokeWidth="2" strokeLinecap="round" />
            <line x1="10" y1="18" x2="22" y2="18" stroke="#EBE4D8" strokeWidth="2" strokeLinecap="round" />
            <line x1="10" y1="18" x2="5"  y2="27" stroke="#EBE4D8" strokeWidth="2" strokeLinecap="round" />
            <line x1="22" y1="18" x2="27" y2="27" stroke="#EBE4D8" strokeWidth="2" strokeLinecap="round" />
            <circle cx="16" cy="5"  r="2.5" fill="#EBE4D8" />
            <circle cx="10" cy="18" r="2.5" fill="#EBE4D8" />
            <circle cx="22" cy="18" r="2.5" fill="#EBE4D8" />
            <circle cx="5"  cy="27" r="2.5" fill="#EBE4D8" />
            <circle cx="27" cy="27" r="2.5" fill="#EBE4D8" />
          </svg>
          <span style={{ marginLeft: "-0.05em" }}>rceo</span>
        </span>
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
        <p style={{ fontSize: 13, fontWeight: 600, color: "#2C2215", textAlign: "center", letterSpacing: "0.01em" }}>
          Cost and risk for AI agents, before they go live · Built for CIOs and CFOs
        </p>

        {/* Footer links */}
        <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", justifyContent: "center" }}>
          <Link href="/pricing" style={{ fontSize: 12, color: "#87786A", textDecoration: "none" }}>Pricing</Link>
          <Link href="/security" style={{ fontSize: 12, color: "#87786A", textDecoration: "none" }}>Security</Link>
          <Link href="/book-demo" style={{ fontSize: 12, color: "#87786A", textDecoration: "none" }}>Book a demo</Link>
        </div>

        <span style={{ fontSize: 12, color: "#C9BBA8" }}>
          © {new Date().getFullYear()} Arceo. All rights reserved.
        </span>
      </div>
    </footer>
  );
}
