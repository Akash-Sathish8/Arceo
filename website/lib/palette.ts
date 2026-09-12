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
  /* ── Brand ─────────────────────────────────────────────────── */
  brand:       "#0E3C90",  /* accent — deep blue, authority */
  brandDeep:   "#023892",  /* the logo artwork's own navy */
  brandHover:  "#092C6E",
  brandSoft:   "#EEF2FA",
  brandBorder: "#CBD8EE",
  brandDark:   "#0B2E73",  /* navy act, raised plane */
  brandDarker: "#07245A",  /* navy act, ground */

  /* Aquamarine — "Controlled": safe, approved, bounded. */
  aqua:        "#7FFFD4",  /* fills, bars, meters */
  aquaInk:     "#0E9B7D",  /* rings, arcs, thin marks */
  aquaDeep:    "#0B7F66",  /* text — 4.95:1 on white */
  aquaSoft:    "#ECF7F2",
  aquaLine:    "#C3E3D5",
  /* Legacy aliases from before the 2026-09-02 aquamarine pass. */
  teal:        "#0B7F66",
  tealSoft:    "#ECF7F2",
  tealBorder:  "#C3E3D5",

  /* Cyan — carries no meaning. Warmth and brand chrome only, never state.
     Also the exact aquamarine in the logo's E-bridge. */
  cyanTint:    "#E1F7F9",
  cyanSoft:    "#C4EFF3",
  cyan:        "#71D9E2",
  cyanRing:    "#34C9D5",
  cyanInk:     "#1A777F",

  /* Amber — "Attention". The surface is the brand amber itself, so
     anything sitting on it takes graphite, not the amber text tone. */
  amber:       "#F59E0B",
  amberInk:    "#9C6206",
  onAmber:     "#1E2836",

  graphite:    "#1E2836",

  /* ── Surfaces ──────────────────────────────────────────────── */
  paper:      "#FFFFFF",
  ground:     "#EEEDF5",
  ground2:    "#F7F7F5",
  ground3:    "#E3E2DF",
  bandBlue:   "#E4EBF8",
  bandTeal:   "#E2F2EC",
  bandAqua:   "#DFF3F7",

  /* ── Ink — the app's warm Notion ramp, not cool blue-grays ─── */
  ink:        "#37352F",
  inkStrong:  "#1E2836",
  muted:      "#6B6966",
  muted2:     "#9B9A97",
  disabled:   "#C9C7C4",

  /* ── Rules ─────────────────────────────────────────────────── */
  rule:       "#E9E9E7",
  ruleLight:  "#F1F1EF",

  /* ── Severity — the app's four real tiers ──────────────────── */
  safe:           "#0B7F66",
  safeFill:       "#ECF7F2",
  safeBorder:     "#C3E3D5",
  safeRing:       "#0E9B7D",
  elevated:       "#9C6206",  /* text tone on white */
  elevatedFill:   "#F59E0B",  /* the brand amber IS the surface */
  elevatedBorder: "#F59E0B",
  elevatedRing:   "#F59E0B",
  high:           "#C2410C",
  highFill:       "#FDF0E7",
  highBorder:     "#F5D5BC",
  critical:       "#B3261E",
  criticalFill:   "#FBECE8",
  criticalBorder: "#F3D6CF",
  criticalRing:   "#AD2418",
  clear:          "#0B7F66",
  clearFill:      "#ECF7F2",
} as const;

export default C;
