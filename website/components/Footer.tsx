import Link from "next/link";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";
const CONTACT_EMAIL = "akakash.sathish@gmail.com";

// Only destinations that actually exist. A footer link to a 404 costs more
// trust than a missing link does.
const COLUMNS: { heading: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "How it works", href: "/#how-it-works" },
      { label: "What it does", href: "/#features" },
      { label: "Why Arceo", href: "/#positioning" },
      { label: "Proof", href: "/#proof" },
    ],
  },
  {
    heading: "Trust",
    links: [
      { label: "Security", href: "/security" },
      { label: "What we haven't done yet", href: "/security#honest" },
    ],
  },
  {
    heading: "Get started",
    links: [
      { label: "Book a demo", href: "/book-demo" },
      { label: "Sign in", href: `${APP_URL}/login`, external: true },
      { label: "Contact us", href: `mailto:${CONTACT_EMAIL}`, external: true },
    ],
  },
];

export default function Footer() {
  return (
    <footer style={{ background: "#FAF6F0", borderTop: "1px solid #E0D7C9", position: "relative" }}>
      {/* Oversized wordmark */}
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

      {/* Link columns */}
      <div className="container" style={{ paddingTop: 8, paddingBottom: 40 }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 32,
          maxWidth: 720,
          margin: "0 auto",
        }} className="footer-cols">
          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <div style={{
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: "0.09em",
                textTransform: "uppercase",
                color: "#87786A",
                marginBottom: 14,
              }}>
                {col.heading}
              </div>
              <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 9 }}>
                {col.links.map((l) => (
                  <li key={l.href + l.label}>
                    {l.external ? (
                      <a href={l.href} className="footer-link">{l.label}</a>
                    ) : (
                      <Link href={l.href} className="footer-link">{l.label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Baseline */}
      <div className="container" style={{
        borderTop: "1px solid #EBE4D8",
        paddingTop: 20,
        paddingBottom: 28,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
      }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: "#2C2215", textAlign: "center", letterSpacing: "0.01em" }}>
          Cost and risk for AI agents, before they go live
        </p>
        <span style={{ fontSize: 12, color: "#C9BBA8" }}>
          © {new Date().getFullYear()} Arceo. All rights reserved.
        </span>
      </div>

      <style>{`
        .footer-link {
          font-size: 13.5px;
          color: #6B5C4A;
          text-decoration: none;
          transition: color 0.12s;
        }
        .footer-link:hover { color: #2C2215; }
        @media (max-width: 640px) {
          .footer-cols { grid-template-columns: 1fr 1fr !important; gap: 28px !important; }
        }
      `}</style>
    </footer>
  );
}
