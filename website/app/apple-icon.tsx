import { ImageResponse } from "next/og";

// iOS home-screen icon. The SVG favicon covers desktop browsers; Safari on iOS
// needs a raster touch icon or it screenshots the page instead.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#FAF6F0",
        }}
      >
        <svg width="124" height="124" viewBox="0 0 32 32" fill="none">
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
      </div>
    ),
    size
  );
}
