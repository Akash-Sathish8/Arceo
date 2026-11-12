/**
 * What a prompt costs.
 *
 * CostPanel leads with what a founder budgets in: the monthly cost at their
 * volume on their model, and what switching would save. Each AI model's figures
 * sit in a short table below. In a narrow panel (a phone) the "Each time" figure
 * moves under the monthly one, so the table never scrolls sideways.
 */

import { useEffect, useRef, useState } from "react"
import { CARD, EYEBROW, TD, TH } from "@/components/prompts/ui"
import {
  BASIS_HELP, BASIS_LABEL, blankName, formatMonthly, formatRunCost, modelName, monthlyCost, rowBasis,
  type CostRow, type CostSummary,
} from "@/lib/promptsApi"
import { formatMonthlyFloor } from "@/lib/promptFormat"

const DEFAULT_VISIBLE_MODELS = 3
/** Below this panel width the table drops its "Each time" column. */
const NARROW_PX = 500

function pickVisible(cost: CostSummary, preferred: string | null | undefined): CostRow[] {
  const priced = cost.models.filter((m) => m.available)
  const order: CostRow[] = []
  const add = (r?: CostRow) => { if (r && !order.includes(r)) order.push(r) }
  add(priced.find((m) => m.model_key === preferred || m.model === preferred))
  add(priced.find((m) => m.model_key === cost.cheapest_model))
  for (const m of priced) { if (order.length >= DEFAULT_VISIBLE_MODELS) break; add(m) }
  return order
}

/** Whether the element is narrower than `px`. Starts from the window width so a
 *  phone's first paint is already the narrow layout. */
function useNarrow(px: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < px)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < px))
    ro.observe(el)
    return () => ro.disconnect()
  }, [px])
  return { ref, narrow }
}

const SUB: React.CSSProperties = { fontSize: "var(--fs-micro)", color: "var(--ink-400)", fontFamily: "var(--font-sans)" }

export function CostPanel({ cost, runsPerDay, preferredModel, writing = false }: {
  cost: CostSummary | null
  runsPerDay?: number | null
  preferredModel?: string | null
  /** The writing view, where the blanks' examples can be filled in. */
  writing?: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const { ref, narrow } = useNarrow(NARROW_PX)
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
  const perMonth = !!runsPerDay
  // Narrow and showing a month: "Each time" goes under the monthly figure.
  const stack = perMonth && narrow

  return (
    <div style={CARD} ref={ref}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div style={EYEBROW}>What it costs</div>
        <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)" }}>
          {cost.catalog_date ? `Prices as of ${cost.catalog_date}` : "Current prices"}{cost.rates === "applied" ? " · your negotiated rates" : ""}
        </div>
      </div>

      {headline && (
        <div style={{ marginTop: 10 }}>
          {monthly != null ? (
            <>
              <div style={{ fontFamily: "var(--font-num)", fontSize: 28, fontWeight: 600, color: "var(--ink-900)", lineHeight: 1.1 }}>
                {formatMonthlyFloor(monthly, headline.is_floor)}
              </div>
              <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 4 }}>
                Used {runsPerDay} {runsPerDay === 1 ? "time" : "times"} a day on {modelName(headline.model_key)} · {formatRunCost(headline.usd_per_run)} each time
                {headBasis && <span title={BASIS_HELP[headBasis]}> · {BASIS_LABEL[headBasis]}</span>}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontFamily: "var(--font-num)", fontSize: 24, fontWeight: 600, color: "var(--ink-900)" }}>
                {headline.is_floor ? "≥ " : ""}{formatRunCost(headline.usd_per_run)} <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", fontWeight: 400 }}>each time, on {modelName(headline.model_key)}</span>
              </div>
              <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 4 }}>
                Add how many times a day you use it to see the monthly cost.
              </div>
            </>
          )}
          {saving != null && saving >= 0.01 && cheapest && (
            <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--accent-soft)", color: "var(--accent-ink)", fontSize: "var(--fs-small)" }}>
              Switching to <b>{modelName(cheapest.model_key)}</b> would save about <b>{formatMonthly(saving)}</b>. Its answers can differ, so check a few before you switch.
            </div>
          )}
        </div>
      )}

      <div style={{ overflowX: "auto", marginTop: 12 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={TH}>AI model</th>
              {perMonth ? <th style={{ ...TH, textAlign: "right" }}>Per month</th> : null}
              {stack ? null : <th style={{ ...TH, textAlign: "right" }}>Each time</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const basis = rowBasis(r)
              const tags = [r.model_key === cost.cheapest_model ? "cheapest" : null,
                            r === yours ? "you use this" : null].filter(Boolean).join(" · ")
              const each = `${r.is_floor ? "≥ " : ""}${formatRunCost(r.usd_per_run)}`
              return (
                <tr key={r.model}>
                  <td style={TD}>
                    <span style={{ fontWeight: r === yours ? 600 : 400 }}>{modelName(r.model_key ?? r.model)}</span>
                    {tags && (stack
                      ? <div style={{ fontSize: "var(--fs-micro)", color: "var(--accent)" }}>{tags}</div>
                      : <span style={{ marginLeft: 6, fontSize: "var(--fs-micro)", color: "var(--accent)", whiteSpace: "nowrap" }}>{tags}</span>)}
                    {r.provider && <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)" }}>{r.provider}</div>}
                  </td>
                  {r.available ? (
                    <>
                      {perMonth ? (
                        <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)" }}
                          title={stack ? BASIS_HELP[basis] : undefined}>
                          <span style={{ whiteSpace: "nowrap" }}>{formatMonthlyFloor(monthlyCost(r.usd_per_run, runsPerDay), r.is_floor)}</span>
                          {stack && <div style={SUB}><span style={{ whiteSpace: "nowrap" }}>{each} each time</span> · {BASIS_LABEL[basis]}</div>}
                        </td>
                      ) : null}
                      {stack ? null : (
                        <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)", whiteSpace: "nowrap" }} title={BASIS_HELP[basis]}>
                          {each}
                          <div style={SUB}>{BASIS_LABEL[basis]}</div>
                        </td>
                      )}
                    </>
                  ) : (
                    <td style={{ ...TD, color: "var(--ink-400)", textAlign: "right" }} colSpan={perMonth && !stack ? 2 : 1}>Price not available yet</td>
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
          {showAll ? "Show fewer" : `Show all ${cost.models.length} AI models`}
        </button>
      )}
      {cost.unsized_variables.length > 0 && (
        <p style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", marginTop: 10 }}>
          The {cost.unsized_variables.map(blankName).join(", ")} {cost.unsized_variables.length === 1 ? "blank has" : "blanks have"} no
          example text yet, so the real cost will be a bit higher.{writing ? " Add an example below." : ""}
        </p>
      )}
    </div>
  )
}
