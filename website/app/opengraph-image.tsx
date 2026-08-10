import { ImageResponse } from "next/og";

// Social preview card. Without this, sharing arceo.io on LinkedIn or Slack
// renders a bare text link with no image.
export const alt = "Arceo — cost and risk forecasting for AI agents";
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
        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <svg width="44" height="44" viewBox="0 0 32 32" fill="none">
            <line x1="16" y1="5" x2="10" y2="18" stroke="#2C2215" strokeWidth="2.4" strokeLinecap="round" />
            <line x1="16" y1="5" x2="22" y2="18" stroke="#2C2215" strokeWidth="2.4" strokeLinecap="round" />
            <line x1="10" y1="18" x2="22" y2="18" stroke="#2C2215" strokeWidth="2.4" strokeLinecap="round" />
            <line x1="10" y1="18" x2="5" y2="27" stroke="#2C2215" strokeWidth="2.4" strokeLinecap="round" />
            <line x1="22" y1="18" x2="27" y2="27" stroke="#2C2215" strokeWidth="2.4" strokeLinecap="round" />
            <circle cx="16" cy="5" r="2.8" fill="#2C2215" />
            <circle cx="10" cy="18" r="2.8" fill="#2C2215" />
            <circle cx="22" cy="18" r="2.8" fill="#2C2215" />
            <circle cx="5" cy="27" r="2.8" fill="#2C2215" />
            <circle cx="27" cy="27" r="2.8" fill="#2C2215" />
          </svg>
          <div style={{ fontSize: 40, fontWeight: 800, color: "#2C2215", letterSpacing: "-1px" }}>
            Arceo
          </div>
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
            <div style={{ fontSize: 34, fontWeight: 800, color: "#2C6E9E" }}>$20/mo</div>
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
