import { afterEach, describe, expect, it, vi } from "vitest"

// api.ts reads localStorage when it loads, which doesn't exist under vitest's
// node environment, so stand in for the two functions agentApi uses.
const base = vi.hoisted(() => ({ value: "" }))
const fetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({ apiBase: () => base.value, apiFetch: fetchMock }))

import { listAgentTokens, listSends, mcpUrl, sendToAgent, testOutcome, waitingSends, type PromptSend } from "./agentApi"

afterEach(() => { base.value = ""; fetchMock.mockReset(); vi.unstubAllGlobals() })

describe("mcpUrl", () => {
  it("uses the app's own origin when the backend is same-origin", () => {
    vi.stubGlobal("window", { location: { origin: "https://app.example.com" } })
    expect(mcpUrl()).toBe("https://app.example.com/mcp")
  })
  it("uses VITE_API_URL's backend when it is set", () => {
    base.value = "https://api.example.com"
    expect(mcpUrl()).toBe("https://api.example.com/mcp")
  })
})

describe("list helpers", () => {
  it("read the envelope or a bare array", async () => {
    fetchMock.mockResolvedValueOnce({ tokens: [{ id: "t1" }] }).mockResolvedValueOnce([{ id: "t2" }])
    expect((await listAgentTokens()).map((t) => t.id)).toEqual(["t1"])
    expect((await listAgentTokens()).map((t) => t.id)).toEqual(["t2"])
    fetchMock.mockResolvedValueOnce({})
    expect(await listSends()).toEqual([])
  })
  it("sendToAgent posts the filled-in values to the prompt's send endpoint", async () => {
    fetchMock.mockResolvedValueOnce({ id: "s1", expires_at: "2026-11-12T00:00:00Z" })
    await sendToAgent("pr/1", { email: "Hi" })
    expect(fetchMock).toHaveBeenCalledWith("/api/prompts/pr%2F1/send", { method: "POST", body: JSON.stringify({ values: { email: "Hi" } }) })
  })
})

describe("the Connect page's test", () => {
  const send = (id: string, over: Partial<PromptSend> = {}): PromptSend => ({
    id, prompt_id: null, title: null, created_at: "2026-11-11T10:00:00Z", delivered_at: null,
    expires_at: "2026-11-12T10:00:00Z", ...over,
  })
  const now = Date.parse("2026-11-11T12:00:00Z")

  it("waitingSends skips delivered and expired ones", () => {
    const list = [send("a"), send("b", { delivered_at: "2026-11-11T11:00:00Z" }), send("c", { expires_at: "2026-11-11T11:00:00Z" })]
    expect(waitingSends(list, now).map((x) => x.id)).toEqual(["a"])
  })
  it("counts the test as received", () => {
    expect(testOutcome([send("t", { delivered_at: "x" })], "t", [])).toBe("got-test")
  })
  // The agent claims the NEWEST waiting send, so it normally gets the test. If it
  // picks up an earlier send instead (asked twice, or another agent took the test),
  // the connection still works and the page mustn't say "Nothing yet".
  it("an earlier send being picked up proves the connection too", () => {
    const list = [send("t"), send("old", { delivered_at: "2026-11-11T12:00:01Z" })]
    expect(testOutcome(list, "t", ["old"])).toBe("got-earlier")
  })
  it("keeps waiting while nothing it watches was picked up", () => {
    const list = [send("t"), send("old"), send("other", { delivered_at: "x" })]
    expect(testOutcome(list, "t", ["old"])).toBe("waiting")
  })
})
