interface LogoMarkProps {
  size?: number;
}

/* Brand vectors traced from the wordmark asset (arceo-logo.png, 2026-09).
   Literal colours on purpose: SVG presentation attributes do not resolve
   CSS var(). Same hexes as the website's --brand / --brand-teal. */
export const BRAND_CYAN = "#63D2E0";
export const BRAND_TEAL = "#13B7A3";

/**
 * Brand mark — the wordmark's closing gesture (the broken O with the teal
 * dash entering it) on the app-icon tile.
 */
export default function LogoMark({ size = 26 }: LogoMarkProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      <rect width="100" height="100" rx="22" fill="var(--accent)" />
      <g transform="translate(50 50) scale(2.1) translate(-16.25 -16)">
        <path
          d="M7.39 12.81 A10.6 10.6 0 1 1 7.39 19.19"
          stroke={BRAND_CYAN}
          strokeWidth="4.4"
        />
        <rect x="2.2" y="13.8" width="6.3" height="4.4" fill={BRAND_TEAL} />
      </g>
    </svg>
  );
}

/**
 * The full ARCEO wordmark, normalised to a 104-unit cap height with a
 * uniform 13.4-unit stroke. The E is three floating bars, the middle one
 * teal; the O's left wall is broken and the teal dash sits in the gap.
 */
export function ArceoWordmark({
  height = 14,
  cyan = BRAND_CYAN,
  teal = BRAND_TEAL,
}: {
  height?: number;
  cyan?: string;
  teal?: string;
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 504 104"
      width={(height * 504) / 104}
      height={height}
      fill="none"
      role="img"
      aria-label="Arceo"
      style={{ display: "block", flexShrink: 0 }}
    >
      <path
        fill={cyan}
        fillRule="evenodd"
        d="M0 102 L42.75 2 H54.95 L97.65 102 Z
           M48.85 23.1 L66.6 64.7 H31.05 Z
           M25.5 77.6 H72.15 L82.6 102 H15.05 Z"
      />
      <g stroke={cyan} strokeWidth="13.4">
        <path d="M121.85 2 V102" />
        <path d="M121.85 8.7 H156.6 A21.5 21.5 0 0 1 156.6 51.7 H121.85" />
        <path d="M148 51.7 L182.2 102" />
        <path d="M284.9 21.9 A43.35 43.35 0 1 0 284.9 82.1" />
        <path d="M412.3 38.97 A43.35 43.35 0 1 1 412.3 65.03" />
      </g>
      <rect x="308.7" y="2" width="75.3" height="13.4" fill={cyan} />
      <rect x="308.7" y="45.3" width="75.3" height="13.4" fill={teal} />
      <rect x="308.7" y="88.6" width="75.3" height="13.4" fill={cyan} />
      <rect x="398.3" y="45.3" width="19.3" height="13.4" fill={teal} />
    </svg>
  );
}
