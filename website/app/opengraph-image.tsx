import { ImageResponse } from "next/og";

// Social preview card. Without this, sharing arceo.io on LinkedIn or Slack
// renders a bare text link with no image.
export const alt = "Arceo: cost and risk forecasting for AI agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#FAF6F0",
          padding: "64px 72px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Wordmark — same vectors as components/Logo.tsx */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <svg width="204" height="42" viewBox="0 0 504 104" fill="none">
            <path
              fill="#63D2E0"
              fillRule="evenodd"
              d="M0 102 L42.75 2 H54.95 L97.65 102 Z M48.85 23.1 L66.6 64.7 H31.05 Z M25.5 77.6 H72.15 L82.6 102 H15.05 Z"
            />
            <path stroke="#63D2E0" strokeWidth="13.4" d="M121.85 2 V102" />
            <path stroke="#63D2E0" strokeWidth="13.4" d="M121.85 8.7 H156.6 A21.5 21.5 0 0 1 156.6 51.7 H121.85" />
            <path stroke="#63D2E0" strokeWidth="13.4" d="M148 51.7 L182.2 102" />
            <path stroke="#63D2E0" strokeWidth="13.4" d="M284.9 21.9 A43.35 43.35 0 1 0 284.9 82.1" />
            <rect x="308.7" y="2" width="75.3" height="13.4" fill="#63D2E0" />
            <rect x="308.7" y="45.3" width="75.3" height="13.4" fill="#13B7A3" />
            <rect x="308.7" y="88.6" width="75.3" height="13.4" fill="#63D2E0" />
            <rect x="398.3" y="45.3" width="19.3" height="13.4" fill="#13B7A3" />
            <path stroke="#63D2E0" strokeWidth="13.4" d="M412.3 38.97 A43.35 43.35 0 1 1 412.3 65.03" />
          </svg>
        </div>

        {/* Headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div
            style={{
              fontSize: 68,
              fontWeight: 800,
              color: "#2C2215",
              lineHeight: 1.08,
              letterSpacing: "-2.5px",
              maxWidth: 900,
            }}
          >
            What your AI agent could break, and cost to run.
          </div>
          <div style={{ fontSize: 30, color: "#6B5C4A", lineHeight: 1.4, maxWidth: 860 }}>
            Cost and risk in one report, before you put it in production.
          </div>
        </div>

        {/* Proof strip */}
        <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 34, fontWeight: 800, color: "#2C6E9E" }}>$2,840/mo</div>
            <div style={{ fontSize: 20, color: "#87786A" }}>forecast, ±15%</div>
          </div>
          <div style={{ width: 1, height: 52, background: "#E0D7C9" }} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 34, fontWeight: 800, color: "#dc2626" }}>$50k</div>
            <div style={{ fontSize: 20, color: "#87786A" }}>worst case if a chain fires</div>
          </div>
          <div style={{ width: 1, height: 52, background: "#E0D7C9" }} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 34, fontWeight: 800, color: "#2C2215" }}>32</div>
            <div style={{ fontSize: 20, color: "#87786A" }}>risk-chain rules</div>
          </div>
        </div>
      </div>
    ),
    size
  );
}
