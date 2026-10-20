/**
 * The two read-outs every prompt carries: cost per run on each model, and the
 * danger breakdown with the reason behind every point. Shared by the editor,
 * the read-only view and the public share page.
 */

import { AlertTriangle } from "lucide-react"
import DangerBadge from "@/components/prompts/DangerBadge"
import { CARD, EYEBROW, TD, TH } from "@/components/prompts/ui"
import { BASIS_HELP, BASIS_LABEL, formatRunCost, type CostSummary, type DangerSummary } from "@/lib/promptsApi"
import { scoreBand } from "@/lib/utils"

const FACTOR_LABEL: Record<string, string> = {
  data_exposure: "Data exposure",
  injection: "Injection",
  jailbreak: "Jailbreak",
  capability: "Can act",
  chain: "Injection → action",
  probed: "Red team",
}

export function CostTable({ cost }: { cost: CostSummary | null }) {
  if (!cost) return null
  const rows = cost.models
  return (
    <div style={CARD}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div style={EYEBROW}>Cost to run</div>
        <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)" }}>
          Catalog verified {cost.catalog_date ?? "n/a"}{cost.rates === "applied" ? " · your negotiated rates" : ""}
        </div>
      </div>
      <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 420 }}>
          <thead>
            <tr>
              <th style={TH}>Model</th>
              <th style={{ ...TH, textAlign: "right" }}>Per run</th>
              <th style={{ ...TH, textAlign: "right" }}>Per 1,000</th>
              <th style={{ ...TH, textAlign: "right" }}>Tokens in / out</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const basis = r.is_floor && r.basis !== "unavailable" ? "unavailable" : (r.basis ?? "heuristic")
              const cheapest = r.model_key && r.model_key === cost.cheapest_model
              return (
                <tr key={r.model}>
                  <td style={TD}>
                    <span style={{ fontWeight: cheapest ? 600 : 400 }}>{r.model_key ?? r.model}</span>
                    {cheapest && <span style={{ marginLeft: 6, fontSize: "var(--fs-micro)", color: "var(--accent)" }}>cheapest</span>}
                    {r.provider && <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)" }}>{r.provider}</div>}
                  </td>
                  {r.available ? (
                    <>
                      <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)" }} title={BASIS_HELP[basis]}>
                        {r.is_floor ? "≥ " : ""}{formatRunCost(r.usd_per_run)}
                        <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)", fontFamily: "var(--font-sans)" }}>{BASIS_LABEL[basis]}</div>
                      </td>
                      <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)" }}>
                        {r.is_floor ? "≥ " : ""}{formatRunCost(r.usd_per_1k_runs)}
                      </td>
                      <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)", color: "var(--ink-600)" }}>
                        {r.input_tokens?.toLocaleString()} / {r.output_tokens != null ? r.output_tokens.toLocaleString() : "?"}
                      </td>
                    </>
                  ) : (
                    <td style={{ ...TD, color: "var(--ink-400)" }} colSpan={3}>Not in the price catalog, so not priced</td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {cost.unsized_variables.length > 0 && (
        <p style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", marginTop: 10 }}>
          {cost.unsized_variables.map((v) => `{{${v}}}`).join(", ")} {cost.unsized_variables.length === 1 ? "has" : "have"} no
          sample or expected length, so these figures are a floor.
        </p>
      )}
    </div>
  )
}

export function DangerPanel({ danger }: { danger: DangerSummary | null }) {
  if (!danger) return null
  return (
    <div style={CARD}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={EYEBROW}>How dangerous</div>
      </div>
      <div style={{ marginTop: 10 }}>
        <DangerBadge danger={danger} size={52} />
      </div>
      {danger.publish_blockers.length > 0 && (
        <div style={{
          display: "flex", gap: 8, marginTop: 12, padding: "8px 10px", borderRadius: "var(--radius-md)",
          background: "var(--critical-bg)", color: "var(--critical)", fontSize: "var(--fs-small)",
        }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          This can't be published until the credential or personal data is removed.
        </div>
      )}
      {danger.reasons.length === 0 ? (
        <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 12 }}>
          No risky patterns found in the text.{danger.status === "static" ? " Run QA to attack it with real injection and leak probes." : ""}
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "flex", flexDirection: "column", gap: 10 }}>
          {danger.reasons.map((r, i) => {
            const b = scoreBand(r.points, 0, r.severity)
            return (
              <li key={i} style={{ borderLeft: `3px solid ${b.ring}`, paddingLeft: 10 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "var(--fs-micro)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: b.color }}>
                    {b.label}
                  </span>
                  <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)" }}>{FACTOR_LABEL[r.factor] ?? r.factor}</span>
                </div>
                <div style={{ fontSize: "var(--fs-small)", fontWeight: 600, color: "var(--ink-900)", marginTop: 2 }}>{r.title}</div>
                <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)", marginTop: 2, lineHeight: 1.5 }}>{r.detail}</div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
