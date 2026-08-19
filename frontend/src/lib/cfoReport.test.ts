import { describe, test, expect } from "vitest"
import { buildCFOReportData } from "./cfoReport"
import type { MockSpend } from "./mockSpend"

function fixture(confidence: "low" | "medium" | "high"): MockSpend {
  return {
    point: 1200, low: 900, high: 1500, annual: 14400, vsLastMonth: 0,
    callsPerDay: 100, runtime: 30, tokensPerCall: 4000, cacheHit: 0.5, retryRate: 0.02,
    tokensPct: 70, toolsPct: 20, infraPct: 10, tokensUsd: 840, toolsUsd: 240, infraUsd: 120,
    topTools: [], unitEcon: [], sensitivity: [], confidence,
  }
}

const build = (forecast: MockSpend) => buildCFOReportData({
  orgName: "Acme", agentDisplayName: "Support Agent", toolKeys: [],
  forecast, costReport: null, today: new Date("2026-08-18"),
})

// The real HIGH gate is 50 captured LLM calls in a trailing 7-day window
// spanning >=3 distinct calendar days (spend_forecast.py LIVE_TRACE_MIN_CALLS
// / LIVE_TRACE_MIN_ACTIVE_DAYS). Seven days is never required. This PDF is
// the artifact that leaves the building; its copy must state the real gate.
describe("confidence copy states the real gate (50 calls / 3+ days), never a 7-day rule", () => {
  test("high tier names the real criterion", () => {
    const line = build(fixture("high")).confidenceLine
    expect(line).toMatch(/50/)
    expect(line).toMatch(/3\+? (distinct )?days/)
    expect(line).not.toMatch(/seven|7 days/i)
  })

  test("medium tier promises the real upgrade path, not a time-based one", () => {
    const line = build(fixture("medium")).confidenceLine
    expect(line).not.toMatch(/seven|7 days/i)
    expect(line).toMatch(/50/)
  })
})

describe("basis block carries provenance from the forecast object", () => {
  test("all basis fields populate from fields the screen already renders", () => {
    const f = fixture("medium")
    f.lastCalibrated = "2026-08-09"
    f.coverage = {
      modelRecognized: true, modelMatch: "exact",
      declaredModel: "claude-sonnet-5", pricedModel: "claude-sonnet-5",
      toolsPriced: 3, toolsTotal: 4,
    }
    f.inputSources = { runsPerDay: "declared", tokensPerCall: "measured" }
    f.observedDays = 2.5
    f.isDemo = true
    const d = build(f)
    expect(d.basis.lastCalibrated).toBe("2026-08-09")
    expect(d.basis.pricedModelLine).toContain("claude-sonnet-5")
    expect(d.basis.toolsPricedLine).toContain("3 of 4")
    expect(d.basis.observedDaysLine).toMatch(/2\.5|3 days/)
    expect(d.basis.inputProvenance.length).toBeGreaterThan(0)
    expect(d.isDemo).toBe(true)
  })

  test("a guessed model price is disclosed, not presented as exact", () => {
    const f = fixture("low")
    f.coverage = {
      modelRecognized: false, modelMatch: "family",
      declaredModel: "gpt-5-ultra", pricedModel: "gpt-5",
      toolsPriced: 0, toolsTotal: 0,
    }
    const d = build(f)
    expect(d.basis.pricedModelLine).toContain("gpt-5")
    expect(d.basis.pricedModelLine).toMatch(/related|guess|estimate/i)
  })

  test("no live data is stated plainly instead of omitted", () => {
    const d = build(fixture("medium"))
    expect(d.basis.observedDaysLine).toMatch(/no live production data/i)
    expect(d.isDemo).toBe(false)
  })
})
