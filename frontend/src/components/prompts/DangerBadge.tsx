/**
 * Danger score on the one shared band scale (lib/utils scoreBand, mirroring
 * authority/graph.py). Band word and number always travel together, and a
 * score that hasn't been red-teamed yet says so.
 */

import RiskRing from "@/components/shared/RiskRing"
import { scoreBand } from "@/lib/utils"
import type { DangerSummary } from "@/lib/promptsApi"

export default function DangerBadge({ danger, size = 40 }: { danger: DangerSummary | null; size?: number }) {
  if (!danger) {
    return <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-400)" }}>Not scored</span>
  }
  const b = scoreBand(danger.score, 0, danger.band)
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <RiskRing value={danger.score} size={size} stroke={3} color={b.ring} label={Math.round(danger.score)} />
      <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
        <span style={{ fontSize: "var(--fs-micro)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: b.color }}>
          {b.label} danger
        </span>
        <span
          style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)" }}
          title={danger.status === "static"
            ? "Scored from the prompt text only. Run QA to attack it with real injection and leak probes."
            : "Includes results from real red-team probes."}
        >
          {danger.status === "static" ? "static only" : "red-teamed"}
        </span>
      </span>
    </span>
  )
}
