/**
 * Pure helpers for the prompt library page (categories and ordering). Kept
 * apart from the page so they can be unit-tested without a browser.
 */

import { CATEGORIES, formatMonthly, formatRunCost, headlineCost, monthlyCost } from "./promptFormat"
import type { PromptListItem } from "./promptsApi"

export const OTHER = "Other"

// Older prompts carry categories from before the library's plain list.
const LEGACY: Record<string, string> = {
  "agency ops": "Running the business", "founder ops": "Running the business", "operations": "Running the business",
  "ops": "Running the business", "marketing": "Marketing & social", "sales": "Sales", "support": "Customer support",
  "customer support": "Customer support", "product": "Planning & decisions", "finance": "Money",
}

/** The library category a prompt files under: a known category (any case), the
 *  closest one for an old category, else "Other". null when it has none. */
export function categoryOf(useCase: string | null | undefined): string | null {
  const key = (useCase ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ")
  if (!key) return null
  return CATEGORIES.find((c) => c.toLowerCase() === key) ?? LEGACY[key] ?? OTHER
}

/** The category to print on a card: its library category, or the author's own word for "Other". */
export function categoryLabel(useCase: string | null | undefined): string | null {
  const c = categoryOf(useCase)
  if (c !== OTHER) return c
  const own = useCase!.trim()
  return own[0].toUpperCase() + own.slice(1)
}

export type LibrarySort = "recent" | "cheapest" | "used"

/** The rows in the order to show. While searching, the server's order (best
 *  match first) is kept: the Sort control is hidden then, so it mustn't apply. */
export function orderForView<T extends { use_count?: number | null }>(
  rows: readonly T[], sort: LibrarySort, searching: boolean, costOf: (row: T) => number | null,
): T[] {
  if (searching || sort === "recent") return [...rows]
  if (sort === "cheapest") {
    const cost = (r: T) => costOf(r) ?? Infinity
    // Unpriced rows go last; two of them compare equal (Infinity - Infinity is NaN).
    return [...rows].sort((a, b) => (cost(a) === cost(b) ? 0 : cost(a) - cost(b)))
  }
  return [...rows].sort((a, b) => (b.use_count ?? 0) - (a.use_count ?? 0))
}

/** Daily uses a card assumes when the prompt doesn't say: the same 20 a day the
 *  library's own prompts are filed with (backend prompts/seed.py) and the public
 *  cost check uses (PUBLIC_DEFAULT_RUNS_PER_DAY). */
export const CARD_RUNS_PER_DAY = 20

/** A library card's cost line, the number "Cheapest first" sorts by, and a
 *  hover note saying what it assumes.
 *
 *  Every card uses the same basis: a month, at the prompt's own daily use, or
 *  20 a day when it doesn't give one. Almost every library prompt is filed at 20
 *  a day, so a prompt someone added without a daily use reads like its
 *  neighbours instead of switching to "each time", and the cheapest sort never
 *  compares a month on one card with a single use on another. */
export function cardCost(p: Pick<PromptListItem, "cost_summary" | "model" | "runs_per_day">): { value: number | null; text: string; note: string } {
  const row = headlineCost(p.cost_summary, p.model)
  if (!row || row.usd_per_run == null) return { value: null, text: "", note: "" }
  const perDay = p.runs_per_day && p.runs_per_day > 0 ? p.runs_per_day : CARD_RUNS_PER_DAY
  const m = monthlyCost(row.usd_per_run, perDay)!
  const text = m < 0.01 ? "Costs under a cent a month"
    : `${row.is_floor ? "At least" : "About"} ${formatMonthly(m).replace("/mo", "")} a month`
  const note = `Used ${perDay} ${perDay === 1 ? "time" : "times"} a day, ${formatRunCost(row.usd_per_run)} each time`
  return { value: m, text, note }
}
