import { C } from "@/lib/palette";

/* The Arceo wordmark, rebuilt as vectors from the brand asset
 * (arceo-logo.png, 2026-09). Every measurement below is traced from that
 * file and normalised to a 104-unit cap height: uniform 13.4-unit stroke,
 * the E drawn as three floating bars with the middle bar in teal, and the
 * O's left wall broken so the teal dash sits in the gap — the signal
 * entering the agent.
 *
 * Colours are literals, not CSS vars: SVG presentation attributes do not
 * resolve var() (see lib/palette.ts). The same two hexes live in
 * globals.css as --brand / --brand-teal.
 */

export const BRAND_CYAN = C.brand;
export const BRAND_TEAL = C.brandTeal;

const VIEW_W = 504;
const VIEW_H = 104;

export function Wordmark({
  height = 22,
  width,
  cyan = BRAND_CYAN,
  teal = BRAND_TEAL,
  style,
}: {
  height?: number;
  /** CSS width (e.g. "min(460px, 72vw)"). Overrides height when given. */
  width?: string | number;
  cyan?: string;
  teal?: string;
  style?: React.CSSProperties;
}) {
  const dims = width
    ? { width, height: "auto" as const }
    : { width: (height * VIEW_W) / VIEW_H, height };

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      fill="none"
      role="img"
      aria-label="Arceo"
      style={{ display: "block", flexShrink: 0, ...dims, ...style }}
    >
      {/* A — flat apex, open counter above and below the crossbar */}
      <path
        fill={cyan}
        fillRule="evenodd"
        d="M0 102 L42.75 2 H54.95 L97.65 102 Z
           M48.85 23.1 L66.6 64.7 H31.05 Z
           M25.5 77.6 H72.15 L82.6 102 H15.05 Z"
      />
      {/* R — stem, stadium bowl, straight leg */}
      <g stroke={cyan} strokeWidth="13.4">
        <path d="M121.85 2 V102" />
        <path d="M121.85 8.7 H156.6 A21.5 21.5 0 0 1 156.6 51.7 H121.85" />
        <path d="M148 51.7 L182.2 102" />
      </g>
      {/* C — circular arc, flat-cut opening on the right */}
      <path stroke={cyan} strokeWidth="13.4" d="M284.9 21.9 A43.35 43.35 0 1 0 284.9 82.1" />
      {/* E — three floating bars; the middle one carries the teal */}
      <rect x="308.7" y="2" width="75.3" height="13.4" fill={cyan} />
      <rect x="308.7" y="45.3" width="75.3" height="13.4" fill={teal} />
      <rect x="308.7" y="88.6" width="75.3" height="13.4" fill={cyan} />
      {/* the dash — seated in the O's broken left wall */}
      <rect x="398.3" y="45.3" width="19.3" height="13.4" fill={teal} />
      {/* O — ring with the left segment removed for the dash */}
      <path stroke={cyan} strokeWidth="13.4" d="M412.3 38.97 A43.35 43.35 0 1 1 412.3 65.03" />
    </svg>
  );
}

/* Compact mark for favicons, tiles and tight chrome: the wordmark's final
   gesture — the broken O with the teal dash entering it. */
export function LogoIcon({
  size = 24,
  color = BRAND_CYAN,
  teal = BRAND_TEAL,
}: {
  size?: number;
  color?: string;
  teal?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M7.39 12.81 A10.6 10.6 0 1 1 7.39 19.19" stroke={color} strokeWidth="4.4" />
      <rect x="2.2" y="13.8" width="6.3" height="4.4" fill={teal} />
    </svg>
  );
}

export default function Logo({
  size = 24,
  color,
  showWord = true,
  wordSize,
}: {
  size?: number;
  /** Single-colour override — mutes both inks (footer watermark, dark chrome). */
  color?: string;
  showWord?: boolean;
  wordSize?: number;
}) {
  if (!showWord) return <LogoIcon size={size} color={color} teal={color} />;
  const h = wordSize ?? Math.round(size * 0.8);
  return <Wordmark height={h} cyan={color} teal={color} />;
}
