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

export const BASIS_LABEL: Record<CostBasis | "floor", string> = {
  floor: "floor",
  measured: "measured",
  exact: "exact tokens",
  declared: "declared",
  heuristic: "estimate",
  unavailable: "input only",
}

export const BASIS_HELP: Record<CostBasis | "floor", string> = {
  floor: "At least this much: a variable has no sample or expected length yet, so its tokens aren't counted.",
  measured: "Output length measured from QA runs of this prompt.",
  exact: "Counted with the provider's own tokenizer.",
  declared: "Uses the output length you declared. Run QA to measure it.",
  heuristic: "Input estimated at ~4 characters per token. Exact counts need the provider tokenizer.",
  unavailable: "No output length yet, so this is the input cost only. Declare an expected output length or run QA.",
}

/** The headline cost for a prompt: the cheapest priced model. */
export function headlineCost(cost: CostSummary | null | undefined): CostRow | null {
  if (!cost) return null
  const priced = cost.models.filter((m) => m.available && m.usd_per_run != null)
  return priced.find((m) => m.model_key === cost.cheapest_model) ?? priced[0] ?? null
}
