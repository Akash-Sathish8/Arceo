/**
 * The two read-outs every prompt carries.
 *
 * CostPanel leads with what a founder budgets in: the monthly cost at their
 * volume on their model, and what switching would save. Per-run and per-1,000
 * figures stay one click down. DangerPanel explains every point, fixes what it
 * can in one click, and lets the author mark judgement calls not applicable.
 */

import { useState } from "react"
import { AlertTriangle, Sparkles, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/Button"
import DangerBadge from "@/components/prompts/DangerBadge"
import { CARD, EYEBROW, TD, TH } from "@/components/prompts/ui"
import {
  BASIS_HELP, BASIS_LABEL, formatMonthly, formatRunCost, monthlyCost, rowBasis,
  type CostRow, type CostSummary, type DangerReason, type DangerSummary,
} from "@/lib/promptsApi"
import { scoreBand } from "@/lib/utils"

const FACTOR_LABEL: Record<string, string> = {
  data_exposure: "Data exposure",
  injection: "Injection",
  jailbreak: "Jailbreak",
  capability: "Can act",
  chain: "Injection → action",
  probed: "Red team",
}

const DEFAULT_VISIBLE_MODELS = 3

function pickVisible(cost: CostSummary, preferred: string | null | undefined): CostRow[] {
  const priced = cost.models.filter((m) => m.available)
  const order: CostRow[] = []
  const add = (r?: CostRow) => { if (r && !order.includes(r)) order.push(r) }
  add(priced.find((m) => m.model_key === preferred || m.model === preferred))
  add(priced.find((m) => m.model_key === cost.cheapest_model))
  for (const m of priced) { if (order.length >= DEFAULT_VISIBLE_MODELS) break; add(m) }
  return order
}

export function CostPanel({ cost, runsPerDay, preferredModel }: {
  cost: CostSummary | null
  runsPerDay?: number | null
  preferredModel?: string | null
}) {
  const [showAll, setShowAll] = useState(false)
  if (!cost) return null
  const priced = cost.models.filter((m) => m.available)
  const yours = priced.find((m) => m.model_key === preferredModel || m.model === preferredModel)
  const cheapest = priced.find((m) => m.model_key === cost.cheapest_model)
  const headline = yours ?? cheapest
  const monthly = headline ? monthlyCost(headline.usd_per_run, runsPerDay) : null
  const cheapMonthly = cheapest ? monthlyCost(cheapest.usd_per_run, runsPerDay) : null
  const saving = yours && cheapest && yours !== cheapest && monthly != null && cheapMonthly != null ? monthly - cheapMonthly : null
  const rows = showAll ? cost.models : pickVisible(cost, preferredModel)
  const headBasis = headline ? rowBasis(headline) : null

  return (
    <div style={CARD}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div style={EYEBROW}>Cost to run</div>
        <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)" }}>
          Prices checked {cost.catalog_date ?? "n/a"}{cost.rates === "applied" ? " · your negotiated rates" : ""}
        </div>
      </div>

      {headline && (
        <div style={{ marginTop: 10 }}>
          {monthly != null ? (
            <>
              <div style={{ fontFamily: "var(--font-num)", fontSize: 28, fontWeight: 600, color: "var(--ink-900)", lineHeight: 1.1 }}>
                {headline.is_floor ? "≥ " : ""}{formatMonthly(monthly)}
              </div>
              <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 4 }}>
                {runsPerDay} runs a day on {headline.model_key} · {formatRunCost(headline.usd_per_run)} a run
                {headBasis && <span title={BASIS_HELP[headBasis]}> · {BASIS_LABEL[headBasis]}</span>}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontFamily: "var(--font-num)", fontSize: 24, fontWeight: 600, color: "var(--ink-900)" }}>
                {headline.is_floor ? "≥ " : ""}{formatRunCost(headline.usd_per_run)} <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", fontWeight: 400 }}>a run on {headline.model_key}</span>
              </div>
              <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 4 }}>
                Add how often you run it to see the monthly cost.
              </div>
            </>
          )}
          {saving != null && saving >= 0.01 && cheapest && (
            <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--accent-soft)", color: "var(--accent-ink)", fontSize: "var(--fs-small)" }}>
              Switching to <b>{cheapest.model_key}</b> would save about <b>{formatMonthly(saving)}</b> at this volume. Run QA on it first to check the quality holds.
            </div>
          )}
        </div>
      )}

      <div style={{ overflowX: "auto", marginTop: 12 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 380 }}>
          <thead>
            <tr>
              <th style={TH}>Model</th>
              {runsPerDay ? <th style={{ ...TH, textAlign: "right" }}>Per month</th> : null}
              <th style={{ ...TH, textAlign: "right" }}>Per run</th>
              <th style={{ ...TH, textAlign: "right" }}>Per 1,000</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const basis = rowBasis(r)
              const tags = [r.model_key === cost.cheapest_model ? "cheapest" : null,
                            r === yours ? "yours" : null].filter(Boolean).join(" · ")
              return (
                <tr key={r.model}>
                  <td style={TD}>
                    <span style={{ fontWeight: r === yours ? 600 : 400 }}>{r.model_key ?? r.model}</span>
                    {tags && <span style={{ marginLeft: 6, fontSize: "var(--fs-micro)", color: "var(--accent)" }}>{tags}</span>}
                    {r.provider && <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)" }}>{r.provider}</div>}
                  </td>
                  {r.available ? (
                    <>
                      {runsPerDay ? (
                        <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)" }}>
                          {r.is_floor ? "≥ " : ""}{formatMonthly(monthlyCost(r.usd_per_run, runsPerDay))}
                        </td>
                      ) : null}
                      <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)" }} title={BASIS_HELP[basis]}>
                        {r.is_floor ? "≥ " : ""}{formatRunCost(r.usd_per_run)}
                        <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)", fontFamily: "var(--font-sans)" }}>{BASIS_LABEL[basis]}</div>
                      </td>
                      <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)" }}>
                        {r.is_floor ? "≥ " : ""}{formatRunCost(r.usd_per_1k_runs)}
                      </td>
                    </>
                  ) : (
                    <td style={{ ...TD, color: "var(--ink-400)" }} colSpan={runsPerDay ? 3 : 2}>Not in the price list yet</td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {cost.models.length > DEFAULT_VISIBLE_MODELS && (
        <button type="button" onClick={() => setShowAll((v) => !v)}
          style={{ marginTop: 8, border: 0, background: "none", padding: 0, color: "var(--accent)", fontSize: "var(--fs-small)", cursor: "pointer" }}>
          {showAll ? "Show fewer models" : `Show all ${cost.models.length} models`}
        </button>
      )}
      {cost.unsized_variables.length > 0 && (
        <p style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", marginTop: 10 }}>
          {cost.unsized_variables.map((v) => `{{${v}}}`).join(", ")} {cost.unsized_variables.length === 1 ? "has" : "have"} no
          example text or length yet, so these figures are a minimum.
        </p>
      )}
    </div>
  )
}

/** Kept for callers that only need the plain table (comparisons). */
export const CostTable = ({ cost }: { cost: CostSummary | null }) => <CostPanel cost={cost} />

const VISIBLE_REASONS = 3

function ReasonItem({ r, onToggle }: { r: DangerReason; onToggle?: (r: DangerReason) => void }) {
  const b = scoreBand(r.points, 0, r.severity)
  return (
    <li style={{ borderLeft: `3px solid ${r.dismissed ? "var(--line)" : b.ring}`, paddingLeft: 10, opacity: r.dismissed ? 0.6 : 1 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--fs-micro)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: r.dismissed ? "var(--ink-400)" : b.color }}>
          {r.dismissed ? "Not applicable" : b.label}
        </span>
        <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)" }}>{FACTOR_LABEL[r.factor] ?? r.factor}</span>
        {onToggle && r.dismissable && (
          <button type="button" onClick={() => onToggle(r)}
            style={{ marginLeft: "auto", border: 0, background: "none", padding: 0, fontSize: "var(--fs-micro)", color: "var(--ink-500)", textDecoration: "underline", cursor: "pointer" }}>
            {r.dismissed ? "Count it again" : "Not applicable"}
          </button>
        )}
      </div>
      <div style={{ fontSize: "var(--fs-small)", fontWeight: 600, color: "var(--ink-900)", marginTop: 2, textDecoration: r.dismissed ? "line-through" : undefined }}>{r.title}</div>
      {!r.dismissed && <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)", marginTop: 2, lineHeight: 1.5 }}>{r.detail}</div>}
    </li>
  )
}

export function DangerPanel({ danger, onFix, fixing, onUndoFix, onToggleDismiss }: {
  danger: DangerSummary | null
  onFix?: () => void
  fixing?: boolean
  onUndoFix?: () => void
  onToggleDismiss?: (r: DangerReason) => void
}) {
  const [showAll, setShowAll] = useState(false)
  if (!danger) return null
  const live = danger.reasons.filter((r) => !r.dismissed)
  const fixable = live.some((r) => r.fixable)
  const shown = showAll ? danger.reasons : danger.reasons.slice(0, VISIBLE_REASONS)
  const hidden = danger.reasons.length - shown.length
  return (
    <div style={CARD}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={EYEBROW}>How dangerous</div>
        {danger.ai_checked && <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)" }} title="Rules plus an AI read of what the prompt makes the model do.">AI-checked</span>}
      </div>
      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <DangerBadge danger={danger} size={52} />
        <div style={{ flex: 1 }} />
        {onUndoFix && (
          <Button variant="ghost" size="sm" icon={<Undo2 size={13} />} onClick={onUndoFix}>Undo fix</Button>
        )}
        {onFix && fixable && (
          <Button size="sm" icon={<Sparkles size={13} />} loading={fixing} onClick={onFix}>Fix it for me</Button>
        )}
      </div>
      {danger.publish_blockers.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--critical-bg)", color: "var(--critical)", fontSize: "var(--fs-small)" }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          This can't be published until the key or personal data is removed.{onFix ? " Fix it for me does that." : ""}
        </div>
      )}
      {danger.reasons.length === 0 ? (
        <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 12 }}>
          No risky patterns found.{danger.status === "static" ? " Run QA to attack it for real." : ""}
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "flex", flexDirection: "column", gap: 10 }}>
          {shown.map((r) => <ReasonItem key={r.id ?? r.title} r={r} onToggle={onToggleDismiss} />)}
        </ul>
      )}
      {hidden > 0 && (
        <button type="button" onClick={() => setShowAll(true)}
          style={{ marginTop: 10, border: 0, background: "none", padding: 0, color: "var(--accent)", fontSize: "var(--fs-small)", cursor: "pointer" }}>
          +{hidden} more
        </button>
      )}
    </div>
  )
}
