/**
 * One money formatter for the whole app. Was duplicated three ways
 * (AgentCard.fmtMoney, FleetStrip.fmtMoney, inline toLocaleString) which let
 * fractional forecast sums render as "$1,234.567" next to "$1.2k" elsewhere.
 *
 * Default: whole dollars with thousands separators ($1,234). `compact` gives
 * $1.2k / $3.4M for tight spaces. `cents` keeps two decimals ($12.34).
 */
export function formatMoney(n: number | null | undefined, opts?: { compact?: boolean; cents?: boolean }): string {
  if (n == null || isNaN(n)) return "No data";
  if (opts?.compact) {
    if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
    return `$${Math.round(n)}`;
  }
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: opts?.cents ? 2 : 0,
    maximumFractionDigits: opts?.cents ? 2 : 0,
  })}`;
}
