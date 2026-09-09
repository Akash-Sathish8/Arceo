import { ImageResponse } from "next/og";

// iOS home-screen icon. The SVG favicon covers desktop browsers; Safari on iOS
// needs a raster touch icon or it screenshots the page instead.
// The mark is the wordmark's closing gesture: the broken O with the teal dash.
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
          background: "#FFFFFF",
        }}
      >
        <svg width="128" height="128" viewBox="0 0 32 32" fill="none">
          <path
            d="M7.39 12.81 A10.6 10.6 0 1 1 7.39 19.19"
            stroke="#63D2E0"
            strokeWidth="4.4"
          />
          <rect x="2.2" y="13.8" width="6.3" height="4.4" fill="#13B7A3" />
        </svg>
      </div>
    ),
    size
  );
}
