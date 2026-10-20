import { describe, expect, it } from "vitest"
import { formatRunCost, headlineCost } from "./promptFormat"
import type { CostSummary } from "./promptsApi"

describe("formatRunCost", () => {
  it("keeps sub-cent prices readable instead of rounding to $0", () => {
    expect(formatRunCost(0.0013664)).toBe("$0.0014")
    expect(formatRunCost(0.0412)).toBe("$0.041")
    expect(formatRunCost(1.5)).toBe("$1.50")
    expect(formatRunCost(0.0000757)).toBe("$0.00008")
    expect(formatRunCost(0)).toBe("$0")
  })
  it("never invents a number", () => {
    expect(formatRunCost(null)).toBe("Unavailable")
    expect(formatRunCost(undefined)).toBe("Unavailable")
  })
})

describe("headlineCost", () => {
  const cost: CostSummary = {
    models: [
      { model: "a", model_key: "a", provider: null, available: true, usd_per_run: 0.01 },
      { model: "b", model_key: "b", provider: null, available: true, usd_per_run: 0.001 },
      { model: "c", model_key: null, provider: null, available: false },
    ],
    cheapest_model: "b", unsized_variables: [], catalog_date: null, rates: "none",
  }
  it("picks the cheapest priced model", () => expect(headlineCost(cost)?.model_key).toBe("b"))
  it("is null with nothing priced", () => {
    expect(headlineCost({ ...cost, models: [cost.models[2]], cheapest_model: null })).toBeNull()
    expect(headlineCost(null)).toBeNull()
  })
})
