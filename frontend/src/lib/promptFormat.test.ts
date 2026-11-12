import { describe, expect, it } from "vitest"
import { VAR_RE, exampleHint, fillPrompt, formatMonthly, formatMonthlyFloor, formatRunCost, headlineCost, importantWarnings, modelName, variablesIn } from "./promptFormat"
import type { CostSummary, DangerReason, DangerSummary } from "./promptsApi"

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

describe("modelName", () => {
  it("shows known models by the name people use", () => {
    expect(modelName("claude-haiku-4-5")).toBe("Claude Haiku 4.5")
    expect(modelName("gpt-4o-mini")).toBe("GPT-4o mini")
    expect(modelName("gemini-2-5-flash")).toBe("Gemini 2.5 Flash")
  })
  it("turns unknown IDs into readable names instead of showing the ID", () => {
    expect(modelName("claude-opus-4-1")).toBe("Claude Opus 4.1")
    expect(modelName("gpt-6")).toBe("GPT-6")
    expect(modelName("gpt-6-nano")).toBe("GPT-6 nano")
    expect(modelName("gemini-3-pro")).toBe("Gemini 3 Pro")
    expect(modelName(null)).toBe("AI model")
  })
})

describe("variablesIn / VAR_RE", () => {
  it("lists each blank once, in first-appearance order, tolerating spaces", () => {
    expect(variablesIn("Hi {{ name }}, re {{topic}}. Bye {{name}} {{_x1}}")).toEqual(["name", "topic", "_x1"])
  })
  it("ignores things that aren't blanks", () => {
    expect(variablesIn("{{1bad}} {{has space}} {single} {{}} {{ok}}")).toEqual(["ok"])
    expect(variablesIn("")).toEqual([])
    expect(variablesIn(null)).toEqual([])
  })
  it("is safe to reuse: the shared /g regex keeps no state between calls", () => {
    const body = "{{a}} {{b}}"
    expect(variablesIn(body)).toEqual(["a", "b"])
    expect(variablesIn(body)).toEqual(["a", "b"])
    expect(fillPrompt(body, { a: "1", b: "2" })).toBe("1 2")
    expect([..."x {{c}}".matchAll(VAR_RE)].map((m) => m[1])).toEqual(["c"])
  })
})

describe("importantWarnings", () => {
  const reason = (over: Partial<DangerReason>): DangerReason => ({
    id: "injection:email", dismissable: true, dismissed: false, fixable: true, factor: "injection",
    points: 50, severity: "medium", title: "t", detail: "d", evidence: null, ...over,
  })
  const summary = (reasons: DangerReason[], publish_blockers: string[] = []): DangerSummary => ({
    score: 0, band: "low", status: "static", reasons, publish_blockers, untrusted_variables: [],
  })

  it("shows nothing for a prompt with only low or medium reasons", () => {
    expect(importantWarnings(summary([reason({ severity: "low" }), reason({ severity: "medium" })]))).toEqual([])
    expect(importantWarnings(null)).toEqual([])
    expect(importantWarnings(undefined)).toEqual([])
  })

  it("keeps high and critical reasons, critical first, without scoring fields", () => {
    const out = importantWarnings(summary([
      reason({ id: "capability:sends_external", severity: "high", title: "Can send messages", fixable: undefined }),
      reason({ id: "chain:moves_money", severity: "critical", title: "A stranger's message could make it pay", dismissable: true }),
    ]))
    expect(out.map((w) => w.id)).toEqual(["chain:moves_money", "capability:sends_external"])
    expect(out[1]).toEqual({
      id: "capability:sends_external", title: "Can send messages", detail: "d", severity: "high",
      fixable: false, dismissable: true, dismissed: false, blocksSharing: false,
    })
    expect(Object.keys(out[0])).not.toContain("points")
  })

  it("drops reasons the author marked doesn't-apply", () => {
    expect(importantWarnings(summary([reason({ severity: "critical", dismissed: true })]))).toEqual([])
  })

  it("marks the reason behind a sharing blocker instead of repeating it", () => {
    const secret = reason({ id: "data_exposure:secret:prompt", factor: "data_exposure", severity: "critical",
      title: "A password or key is in the prompt", dismissable: false })
    const out = importantWarnings(summary([secret], ["secret_in_prompt"]))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: "data_exposure:secret:prompt", blocksSharing: true, dismissable: false })
  })

  it("adds a plain warning for a blocker with no matching reason", () => {
    const out = importantWarnings(summary([], ["pii_in_prompt", "something_new"]))
    expect(out.map((w) => w.id)).toEqual(["blocker:pii_in_prompt", "blocker:something_new"])
    expect(out.every((w) => w.blocksSharing && !w.dismissable && !w.dismissed)).toBe(true)
    expect(out[0].title).toBe("Personal info in the prompt")
  })

  it("never uses jargon or numbers in what it adds", () => {
    const text = importantWarnings(summary([], ["secret_in_prompt", "pii_in_prompt", "x"]))
      .map((w) => `${w.title} ${w.detail}`).join(" ")
    expect(text).not.toMatch(/\b(token|injection|QA|LLM|API|score|\d+)\b/i)
  })
})

describe("monthly figures", () => {
  it("under a cent reads in words, floor or not", () => {
    expect(formatMonthly(0.004)).toBe("Under $0.01/mo")
    expect(formatMonthlyFloor(0.004, true)).toBe("Under $0.01/mo")
    expect(formatMonthlyFloor(0.004, false)).toBe("Under $0.01/mo")
  })
  it("a floor of a cent or more is marked as at least", () => {
    expect(formatMonthlyFloor(3.1, true)).toBe("≥ $3.10/mo")
    expect(formatMonthlyFloor(3.1, false)).toBe("$3.10/mo")
    expect(formatMonthlyFloor(0, true)).toBe("$0.00/mo")
  })
})

describe("exampleHint", () => {
  it("short examples show whole, on one line", () => {
    expect(exampleHint("Aunt May")).toBe("e.g. Aunt May")
    expect(exampleHint("line one\n\n  line two")).toBe("e.g. line one line two")
    expect(exampleHint("")).toBeUndefined()
    expect(exampleHint(null)).toBeUndefined()
  })
  it("long examples stop at a word, with an ellipsis", () => {
    const long = "Hi team, the March invoice for the Northwind account went out twice and the customer was charged two times for one order today."
    const hint = exampleHint(long)!
    expect(hint.endsWith("…")).toBe(true)
    const body = hint.slice("e.g. ".length, -1)
    expect(body.length).toBeLessThanOrEqual(120)
    expect(long.startsWith(body)).toBe(true)
    expect(long[body.length]).toBe(" ")                     // cut between words
  })
  it("one enormous word is still cut", () => {
    expect(exampleHint("x".repeat(300))).toBe(`e.g. ${"x".repeat(120)}…`)
  })
})
