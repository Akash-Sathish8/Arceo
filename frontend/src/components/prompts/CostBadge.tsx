/**
 * Cost per run, in graphite. Cost and danger never share a colour channel:
 * cost is ink, danger is the severity scale (DangerBadge), the same split the
 * Spend and Authority pages use.
 */

import { BASIS_HELP, BASIS_LABEL, formatRunCost, rowBasis, type CostRow } from "@/lib/promptsApi"

export default function CostBadge({ row, compact }: { row: CostRow | null; compact?: boolean }) {
  if (!row || !row.available) {
    return (
      <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-400)" }} title="No priced model for this prompt yet.">
        Cost unavailable
      </span>
    )
  }
  const basis = rowBasis(row)
  return (
    <span
      title={`${row.model_key}: ${BASIS_HELP[basis]}`}
      style={{ display: "inline-flex", alignItems: "baseline", gap: 6, minWidth: 0 }}
    >
      <span style={{ fontFamily: "var(--font-num)", fontWeight: 600, color: "var(--ink-900)", fontSize: compact ? "var(--fs-small)" : "var(--fs-title)" }}>
        {row.is_floor ? "≥ " : ""}{formatRunCost(row.usd_per_run)}
      </span>
      <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)" }}>/run</span>
      {!compact && (
        <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", whiteSpace: "nowrap" }}>
          · {BASIS_LABEL[basis]}
        </span>
      )}
    </span>
  )
}
