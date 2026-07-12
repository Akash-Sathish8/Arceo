/**
 * Spend forecast type.
 *
 * Shape returned by /api/agents/{id}/spend-forecast and the batch endpoint.
 * Lives here (historical name `MockSpend`) so existing imports continue to work.
 */

export interface MockSpend {
  /** False when there's no real signal (no declared volume / sandbox sweep /
   * live traces) — the forecast is SUPPRESSED rather than fabricated. When
   * false, point/low/high are null; render the "needs data" state. */
  available?: boolean
  /** "no_data" = nothing connected; "collecting_live_traffic" = live capture
   * is working but has fewer calls than the forecast floor — show progress. */
  reason?: string
  needs?: string[]
  /** Live calls captured in the last 7 days / calls needed to unlock a
   * forecast. Present on unavailable responses so the empty state can say
   * "3 of 5 calls captured" instead of contradicting the sources panel. */
  liveCalls7d?: number
  liveCallsNeeded?: number
  /** Per-input provenance so a defaulted input is never shown as measured. */
  inputSources?: {
    runsPerDay?: string; turnsPerRun?: string; tokensPerCall?: string
    cacheHit?: string; model?: string; toolMix?: string
  }
  point: number
  low: number
  high: number
  annual: number
  vsLastMonth: number
  /** False until a ~30-day-old snapshot exists. When false, vsLastMonth is 0
   * meaning "no baseline yet", not "no change" — hide the stat. */
  vsLastMonthAvailable?: boolean
  callsPerDay: number       // total LLM calls/day (= runs × turns)
  runsPerDay?: number       // business volume (agent invocations/day)
  turnsPerRun?: number      // LLM round-trips per run
  runtime: number
  tokensPerCall: number
  cacheHit: number
  retryRate: number
  tokensPct: number
  toolsPct: number
  infraPct: number
  tokensUsd: number
  toolsUsd: number
  infraUsd: number
  model?: string
  topTools: { tool: string; callsPerMonth: number; costPer: number; monthly: number }[]
  unitEcon: { label: string; value: string | null }[]   // null = not measured (no canned $)
  sensitivity: { label: string; pct: number; color: string }[]
  confidence: "low" | "medium" | "high"
  /** Days of live traffic behind a live-fed forecast (any tier — early live
   * traffic runs at the wide band) — caption the number with it so a
   * 20-minute burst never reads as a month of evidence. */
  observedDays?: number | null
  /** Distinct calendar days with captured traffic (live path only) — the
   * burst-guard signal behind confidenceCap. */
  activeDays?: number | null
  /** Why confidence was demoted despite heavy traffic: "single_day_burst"
   * means the 50-call floor was met but traffic spans <3 distinct days, so
   * the ±15% band would ride on one burst. */
  confidenceCap?: "single_day_burst" | null
  /** Coverage disclosure: whether we actually recognize the agent's model and
   * how many of its tools we can price. Drives the "numbers may be off" banner. */
  coverage?: {
    modelRecognized: boolean
    /** How the declared model mapped to a price row: "exact" | "prefix" (dated
     * snapshot of a priced model) | "family" (price GUESSED from a related
     * model — confidence capped) | "default" (no overlap; default model rates).
     * Null when no model was declared. */
    modelMatch?: "exact" | "prefix" | "family" | "default" | null
    declaredModel: string | null
    pricedModel: string
    toolsPriced: number
    toolsTotal: number
  }
  lastCalibrated?: string
  capturedAt?: string
  /** Seeded demo agent: the traffic behind these numbers is synthetic.
   * Rendered as a "Demo data" chip so illustrative numbers can never pass
   * as measured. Set only by the demo seeder, never via the API. */
  isDemo?: boolean
  dataSources?: { label: string; status: string; statusTone: "calibrated" | "active" | "partial" | "disconnected" }[]
}
