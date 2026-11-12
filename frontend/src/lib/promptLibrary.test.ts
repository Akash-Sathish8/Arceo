import { describe, expect, it } from "vitest"
import { CATEGORIES } from "./promptFormat"
import { CARD_RUNS_PER_DAY, OTHER, cardCost, categoryOf, orderForView } from "./promptLibrary"

const rows = [
  { id: "best", use_count: 1, cost: 9 },
  { id: "second", use_count: 50, cost: 1 },
  { id: "third", use_count: 5, cost: null },
]
const costOf = (r: (typeof rows)[number]) => r.cost

describe("orderForView", () => {
  // Regression: with "Cheapest first" picked, a search re-sorted the server's
  // best-match-first results by cost, while the Sort control was hidden.
  it("keeps the search order whatever sort was picked", () => {
    for (const sort of ["recent", "cheapest", "used"] as const) {
      expect(orderForView(rows, sort, true, costOf).map((r) => r.id)).toEqual(["best", "second", "third"])
    }
  })
  it("sorts when not searching, unpriced last", () => {
    expect(orderForView(rows, "cheapest", false, costOf).map((r) => r.id)).toEqual(["second", "best", "third"])
    expect(orderForView(rows, "used", false, costOf).map((r) => r.id)).toEqual(["second", "third", "best"])
  })
})

describe("categories", () => {
  // Regression: "Meetings & notes" and "Personal" had no chip, so 20 library
  // prompts only showed under "Other".
  it("every category the seed library uses has its own chip", () => {
    const files = import.meta.glob<string>("../../../backend/prompts/seed/*.yaml", { query: "?raw", import: "default", eager: true })
    const used = new Set<string>()
    for (const text of Object.values(files)) {
      for (const m of text.matchAll(/^\s*use_case:\s*"?([^"\n]+?)"?\s*$/gm)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(10)
    expect([...used].filter((c) => !(CATEGORIES as readonly string[]).includes(c))).toEqual([])
    expect(categoryOf("Meetings & notes")).toBe("Meetings & notes")
    expect(categoryOf("personal")).toBe("Personal")
    expect(categoryOf("Gardening")).toBe(OTHER)
  })
})

describe("cardCost", () => {
  const summary = (usd: number, floor = false) => ({
    models: [{ model: "m", model_key: "m", provider: "x", available: true, usd_per_run: usd, is_floor: floor, basis: "heuristic" as const, output_basis: null }],
    cheapest_model: "m", unsized_variables: [], catalog_date: null, rates: null,
  }) as never
  it("every card shows a month: at its own daily use, else the library's 20 a day", () => {
    expect(cardCost({ cost_summary: summary(0.01), model: null, runs_per_day: 10 })).toEqual(
      { value: 3, text: "About $3.00 a month", note: "Used 10 times a day, $0.010 each time" })
    expect(cardCost({ cost_summary: summary(0.01), model: null, runs_per_day: null }).text).toBe("About $6.00 a month")
    expect(cardCost({ cost_summary: summary(0.01), model: null, runs_per_day: 0 }).note).toContain(`Used ${CARD_RUNS_PER_DAY} times a day`)
  })
  it("a floor says at least; under a cent says so in words", () => {
    expect(cardCost({ cost_summary: summary(0.01, true), model: "m", runs_per_day: 20 }).text).toBe("At least $6.00 a month")
    expect(cardCost({ cost_summary: summary(0.00001, true), model: "m", runs_per_day: 1 }).text).toBe("Costs under a cent a month")
  })
  it("no price, no line", () => {
    expect(cardCost({ cost_summary: null, model: null, runs_per_day: 20 })).toEqual({ value: null, text: "", note: "" })
  })
})
