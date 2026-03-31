/**
 * Maps a 0–100 risk score to a smooth green → yellow → red color.
 * 0  = green  hsl(120 …)
 * 50 = yellow hsl(60 …)
 * 100 = red   hsl(0 …)
 */
export function scoreToColor(score) {
  const s = Math.max(0, Math.min(100, score ?? 0));
  const hue = Math.round(120 - s * 1.2); // 120 → 0
  return `hsl(${hue}, 72%, 42%)`;
}
