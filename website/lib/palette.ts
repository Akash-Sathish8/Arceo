/* Literal palette for SVG and canvas.
 *
 * CSS variables do NOT resolve inside SVG presentation attributes —
 * `fill="var(--ink)"` is parsed as an SVG attribute, not a CSS value, so
 * the browser silently drops it and falls back to black (or nothing).
 * Anything painted through an SVG attribute has to use a literal colour.
 *
 * These values mirror the CSS custom properties in app/globals.css, which
 * in turn are lifted verbatim from the product app (frontend/src/index.css).
 * The site and the thing you sign in to are one design system: if a colour
 * changes in the app, it changes here and in globals.css too.
 *
 * ── The brand palette ───────────────────────────────────────────────
 *   DEEP BLUE   #0E3C90  Authority   structure, headings, the CFO's number
 *   AQUAMARINE  #7FFFD4  Controlled  an approved or bounded outcome — SAFE
 *   AMBER       #F59E0B  Attention   review it, uncertainty, a decision
 *   GRAPHITE    #1E2836  Gravity     the one dark surface tone
 *   CYAN        #71D9E2  (no meaning) warmth and brand chrome only
 *
 * Aquamarine is intrinsically light — 1.21:1 on white — so it is a FILL.
 * Its darker members carry any text: --aquaInk for rings and thin marks,
 * --aquaDeep for type.
 *
 * Red is not a brand colour. It is held back for one job: a genuinely
 * critical consequence. Most of a fleet reads aquamarine, a few agents
 * read amber, and red stays rare enough that it still means something.
 */

export const C = {
  /* ── Brand — near-black (shadcn design system, 2026-09-25) ──── */
  brand:       "#2E2E2E",
  brandDeep:   "#0A0A0A",
  brandHover:  "#1A1A1A",
  brandSoft:   "#F5F5F5",
  brandBorder: "#D4D4D4",
  brandDark:   "#18181B",
  brandDarker: "#09090B",

  /* Success scale in the aquamarine slots. */
  aqua:        "#DCFCE7",
  aquaInk:     "#16A34A",
  aquaDeep:    "#15803D",
  aquaSoft:    "#F0FDF4",
  aquaLine:    "#BBF7D0",
  teal:        "#15803D",
  tealSoft:    "#F0FDF4",
  tealBorder:  "#BBF7D0",

  /* Former cyan family, now zinc. */
  cyanTint:    "#F4F4F5",
  cyanSoft:    "#E4E4E7",
  cyan:        "#A1A1AA",
  cyanRing:    "#52525B",
  cyanInk:     "#3F3F46",

  amber:       "#F59E0B",
  amberInk:    "#92400E",
  onAmber:     "#92400E",

  graphite:    "#18181B",

  /* ── Surfaces ──────────────────────────────────────────────── */
  paper:      "#FFFFFF",
  ground:     "#FAFAFA",
  ground2:    "#F4F4F5",
  ground3:    "#E4E4E7",
  bandBlue:   "#F4F4F5",
  bandTeal:   "#FAFAFA",
  bandAqua:   "#F4F4F5",

  /* ── Ink (zinc) ─────────────────────────────────────────────── */
  ink:        "#09090B",
  inkStrong:  "#09090B",
  muted:      "#71717A",
  muted2:     "#A1A1AA",
  disabled:   "#D4D4D8",

  /* ── Rules ─────────────────────────────────────────────────── */
  rule:       "#E4E4E7",
  ruleLight:  "#F4F4F5",

  /* ── Severity ──────────────────────────────────────────────── */
  safe:           "#15803D",
  safeFill:       "#F0FDF4",
  safeBorder:     "#BBF7D0",
  safeRing:       "#16A34A",
  elevated:       "#92400E",
  elevatedFill:   "#FFFBEB",
  elevatedBorder: "#FDE68A",
  elevatedRing:   "#F59E0B",
  high:           "#C2410C",
  highFill:       "#FFF7ED",
  highBorder:     "#FED7AA",
  critical:       "#B91C1C",
  criticalFill:   "#FEF2F2",
  criticalBorder: "#FECACA",
  criticalRing:   "#DC2626",
  clear:          "#15803D",
  clearFill:      "#F0FDF4",
} as const;

export default C;
