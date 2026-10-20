/**
 * Pure formatting for prompt cost read-outs. Kept free of the API client so
 * it can be unit-tested without a browser (api.ts reads localStorage on load).
 */

import type { CostBasis, CostRow, CostSummary } from "./promptsApi"

/** Per-run prices are routinely fractions of a cent, so formatMoney's whole
 *  dollars would print $0 for every prompt. Show enough digits to compare. */
export function formatRunCost(usd: number | null | undefined): string {
  if (usd == null || isNaN(usd)) return "Unavailable"
  if (usd === 0) return "$0"
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`
  return `$${usd.toPrecision(1)}`
}

/** The basis word to show for one cost row. A floor whose output IS known
 *  (only a variable is unsized) is a "floor", not "input only". */
export function rowBasis(row: Pick<CostRow, "basis" | "is_floor" | "output_basis">): CostBasis | "floor" {
  if (row.output_basis === "unavailable") return "unavailable"
  if (row.is_floor) return "floor"
  return row.basis ?? "heuristic"
}

// Plain words for how sure a cost figure is. Founders don't think in tokens.
export const BASIS_LABEL: Record<CostBasis | "floor", string> = {
  floor: "at least this",
  measured: "measured from real runs",
  exact: "exact count",
  declared: "based on your length",
  heuristic: "estimated",
  unavailable: "add an output length",
}

export const BASIS_HELP: Record<CostBasis | "floor", string> = {
  floor: "At least this much: a variable has no sample or expected length yet, so its tokens aren't counted.",
  measured: "Output length measured from QA runs of this prompt.",
  exact: "Counted with the provider's own tokenizer.",
  declared: "Uses the output length you declared. Run QA to measure it.",
  heuristic: "Input estimated at ~4 characters per token. Exact counts need the provider tokenizer.",
  unavailable: "No output length yet, so this is the input cost only. Declare an expected output length or run QA.",
}

/** The headline cost for a prompt: the author's own model if priced, else the cheapest. */
export function headlineCost(cost: CostSummary | null | undefined, preferred?: string | null): CostRow | null {
  if (!cost) return null
  const priced = cost.models.filter((m) => m.available && m.usd_per_run != null)
  return (preferred ? priced.find((m) => m.model_key === preferred || m.model === preferred) : undefined)
    ?? priced.find((m) => m.model_key === cost.cheapest_model) ?? priced[0] ?? null
}


/** Monthly cost at the author's volume (30-day month). null when either is unknown. */
export function monthlyCost(usdPerRun: number | null | undefined, runsPerDay: number | null | undefined): number | null {
  if (usdPerRun == null || runsPerDay == null || runsPerDay <= 0) return null
  return usdPerRun * runsPerDay * 30
}

/** "$3.10/mo", "$1,240/mo", "<$0.01/mo". */
export function formatMonthly(usd: number | null | undefined): string {
  if (usd == null || isNaN(usd)) return "n/a"
  if (usd > 0 && usd < 0.01) return "<$0.01/mo"
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: usd < 100 ? 2 : 0, maximumFractionDigits: usd < 100 ? 2 : 0 })}/mo`
}

// ~0.75 English words per token. Shown to people as words; stored as tokens.
export const wordsToTokens = (words: number): number => Math.round(words / 0.75)
export const tokensToWords = (tokens: number): number => Math.round(tokens * 0.75)

export const OUTPUT_PRESETS = [
  { key: "short", label: "Short", hint: "about 75 words", tokens: 100 },
  { key: "medium", label: "Medium", hint: "about 250 words", tokens: 330 },
  { key: "long", label: "Long", hint: "about 600 words", tokens: 800 },
] as const

/** The finished prompt: every {{variable}} replaced, missing ones left blank. */
export function fillPrompt(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name: string) => values[name] ?? "")
}
