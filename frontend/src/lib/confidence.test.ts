import { describe, test, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  HIGH_GATE_CALLS, HIGH_GATE_DAYS, HIGH_GATE_WINDOW_DAYS, HIGH_GATE_MONTHLY_EQUIV,
} from "./confidence"

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

// ── The derivation ─────────────────────────────────────────────────────────
//
// The monthly figure is the whole point of item 1.13: "50 calls in a rolling
// week" is not a number a CFO can check against their own agent, and it is the
// number that decides whether an agent can EVER leave its current band. If it
// is ever typed by hand it will disagree with the gate the moment the gate
// moves, and it will disagree quietly, in the reassuring direction.

describe("the monthly equivalent is derived from the gate, not typed", () => {
  test("it is the gate's own rate over 30 days", () => {
    expect(HIGH_GATE_MONTHLY_EQUIV).toBe(
      Math.round((HIGH_GATE_CALLS / HIGH_GATE_WINDOW_DAYS) * 30 / 5) * 5,
    )
  })

  test("it lands where the arithmetic says", () => {
    // 50 / 7 = 7.14 calls/day; x30 = 214.3; rounded to the nearest 5 = 215.
    expect(HIGH_GATE_MONTHLY_EQUIV).toBe(215)
  })

  test("it is rounded enough to be spoken aloud but not enough to mislead", () => {
    const exact = (HIGH_GATE_CALLS / HIGH_GATE_WINDOW_DAYS) * 30
    expect(Math.abs(HIGH_GATE_MONTHLY_EQUIV - exact)).toBeLessThan(5)
    // Rounding DOWN would quote a bar an agent can hit and still miss the gate.
    expect(HIGH_GATE_MONTHLY_EQUIV).toBeGreaterThanOrEqual(Math.floor(exact))
  })
})

// ── The backend is the source of truth; this module only mirrors it ────────
//
// Four frontend surfaces quote these numbers to a customer. If someone moves
// the gate in Python, nothing else in this repo notices — the numbers are
// copy, not code paths, so no type error and no runtime failure occurs. The
// forecast keeps working and the explanation of it quietly becomes false.

describe("the mirrored constants still match the engine", () => {
  const enginePath = at("../../../backend/analysis/spend_forecast.py")
  // ⚠️ The two call/day thresholds are named constants in spend_forecast.py, but
  // the WINDOW is not: it is an inline `timedelta(days=7)` written out four
  // separate times in main.py, assigned to a local called `seven_days_ago`.
  // That is exactly why the window was never written down as a decision and why
  // three UI surfaces described it wrongly — there was no constant to read.
  const windowPath = at("../../../backend/main.py")

  test("the engine file is where this test expects it", () => {
    // Deliberately a hard failure, not a skip. A silently-skipping mirror test
    // is worse than no mirror test: it reports success forever.
    expect(existsSync(enginePath), `cannot find ${enginePath}`).toBe(true)
  })

  test("LIVE_TRACE_MIN_CALLS and LIVE_TRACE_MIN_ACTIVE_DAYS are unchanged", () => {
    const src = readFileSync(enginePath, "utf-8")
    const num = (name: string) => {
      const m = src.match(new RegExp(`^${name}\\s*=\\s*(\\d+)`, "m"))
      expect(m, `${name} not found in spend_forecast.py`).toBeTruthy()
      return Number(m![1])
    }
    expect(num("LIVE_TRACE_MIN_CALLS")).toBe(HIGH_GATE_CALLS)
    expect(num("LIVE_TRACE_MIN_ACTIVE_DAYS")).toBe(HIGH_GATE_DAYS)
  })

  test("the trailing window is still 7 days", () => {
    const src = readFileSync(windowPath, "utf-8")
    const hits = src.match(/seven_days_ago = \(datetime\.utcnow\(\) - timedelta\(days=(\d+)\)\)/g) ?? []
    expect(hits.length, "the live-trace window query moved or was renamed").toBeGreaterThan(0)
    for (const h of hits) {
      expect(Number(h.match(/days=(\d+)/)![1]),
        "one copy of the window drifted from the others").toBe(HIGH_GATE_WINDOW_DAYS)
    }
  })
})

// ── No surface may tell a customer that waiting is the remedy ──────────────
//
// The defect 1.13 fixed was not one sentence. Four surfaces independently told
// the customer their band would tighten with time: the Cost Portfolio said "it
// narrows as evidence accumulates" and "accumulate 30+ days of live data", the
// Spend Dashboard said "accumulate 30+ days of live data to tighten it", and
// the fleet PDF said "it tightens as agents accumulate live production data".
//
// None of that is true. The window is rolling, so nothing banks: an agent below
// roughly HIGH_GATE_MONTHLY_EQUIV calls a month holds its band forever. Three
// of these are React components and there is no jsdom in this project, so they
// cannot be rendered — the guard reads the source instead. That is coarse, and
// it is the difference between catching this class of regression and not.

/**
 * Comments are stripped before matching. A comment explaining why a phrase was
 * banned necessarily contains the banned phrase, and the guard is about what
 * reaches the customer, not about what the source says to the next engineer.
 * The `//` strip skips `://` so URLs in string literals survive intact.
 */
function shippedCopy(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

const SURFACES = [
  "../pages/CostPortfolio.tsx",
  "../pages/SpendDashboard.tsx",
  "../components/FleetCFOReport.tsx",
  "../components/CFOReport.tsx",
  "./cfoReport.ts",
]

const BANNED: Array<[RegExp, string]> = [
  [/accumulates?\s+(30|thirty)/i,        "promises a day count that does nothing"],
  [/(30|thirty)\+?\s*days of live/i,     "promises a day count that does nothing"],
  [/narrows as evidence accumulates/i,   "the original false claim"],
  [/tightens as agents accumulate/i,     "the fleet PDF's version of it"],
  [/once we capture/i,                   "'once' promises arrival to an agent that will never arrive"],
  [/confidence (improves|rises|grows) over time/i, "time is not the variable"],
]

describe("no customer-facing surface says the band tightens with time", () => {
  for (const rel of SURFACES) {
    test(`${rel} makes no time-based promise`, () => {
      const src = shippedCopy(readFileSync(at(rel), "utf-8"))
      for (const [pattern, why] of BANNED) {
        expect(src, `${rel}: ${why} — matched ${pattern}`).not.toMatch(pattern)
      }
    })
  }

  test("the surfaces that explain the gate say it is a rate", () => {
    // The three that carry the explanation must state the cap, not merely avoid
    // denying it. CFOReport.tsx renders cfoReport.ts's line and is checked there.
    for (const rel of ["../pages/CostPortfolio.tsx", "../pages/SpendDashboard.tsx",
                       "../components/FleetCFOReport.tsx"]) {
      const src = readFileSync(at(rel), "utf-8")
      expect(src, `${rel} never mentions the rolling window`).toMatch(/rolling/i)
      expect(src, `${rel} does not import the shared gate`).toMatch(/from ["']@\/lib\/confidence["']/)
    }
  })

  test("nobody has re-hardcoded the gate next to the shared one", () => {
    for (const rel of SURFACES) {
      const src = readFileSync(at(rel), "utf-8")
      expect(src, `${rel} declares its own copy of the gate`)
        .not.toMatch(/const HIGH_GATE_\w+\s*=/)
    }
  })
})
