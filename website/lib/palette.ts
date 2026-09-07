/* Literal palette for SVG and canvas.
 *
 * CSS variables do NOT resolve inside SVG presentation attributes —
 * `fill="var(--ink)"` is parsed as an SVG attribute, not a CSS value, so
 * the browser silently drops it and falls back to black (or nothing).
 * Anything painted through an SVG attribute has to use a literal colour.
 *
 * These values are the same ones declared as CSS custom properties in
 * app/globals.css. Change one, change the other. */

export const C = {
  /* Surfaces */
  paper:      "#FFFFFF",
  ground:     "#F7F8FA",
  ground2:    "#F1F3F5",
  ground3:    "#E9ECEF",

  /* Ink */
  ink:        "#111827",
  inkStrong:  "#0B1220",
  muted:      "#6B7280",
  muted2:     "#9CA3AF",
  disabled:   "#D1D5DB",

  /* Rules */
  rule:       "#E5E7EB",
  ruleLight:  "#F0F2F4",

  /* Severity — the only saturated colour in the system */
  critical:       "#dc2626",
  criticalFill:   "#FEF2F2",
  criticalBorder: "#FCA5A5",
  elevated:       "#f59e0b",
  elevatedFill:   "#FFFBEB",
  elevatedBorder: "#FDE68A",
  safe:           "#9ca3af",
  safeFill:       "#F7F8FA",
  safeBorder:     "#E5E7EB",
  clear:          "#059669",
  clearFill:      "#ECFDF5",
} as const;

export default C;
