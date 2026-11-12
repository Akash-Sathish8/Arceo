import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"

// api.ts reads localStorage when it loads (no such thing under node), and
// nothing here should reach the network.
const fetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({ apiBase: () => "", apiFetch: fetchMock }))

import {
  DuplicateCard, DuplicateSaveSheet, LIVE_DEBOUNCE_MS, LiveDuplicateChecker, MIN_CONTENT_WORDS,
  contentWordCount, dismissMatch, findBlockingMatch, isExactMatch, isMatchDismissed, matchDifferences, matchHeadline,
  pickInterruption, resetDismissedMatches, type MatchFetcher,
} from "./DuplicateCheck"
import type { Match, MatchOptions } from "@/lib/similarApi"

const match = (over: Partial<Match> = {}): Match => ({
  id: "p1", title: "Client email to 3 bullets", description: "Turns a long email into three short points.",
  use_case: "Email & messages", author_name: "Arceo Library", owned: false, copy_of_yours: false,
  level: "same", score: 0.97, shared: ["summarize", "email"], yours_only: [], theirs_only: [], ...over,
})

const LONG = "Summarize this customer email into three short bullet points for my manager today"
const LONGER = LONG + " and suggest a friendly reply"

/** A fetcher whose answers the test hands out one by one. */
function deferredFetcher() {
  const calls: { draft: Parameters<MatchFetcher>[0]; opts: MatchOptions; resolve: (m: Match[]) => void; reject: (e: unknown) => void }[] = []
  const fetcher: MatchFetcher = (draft, opts) => new Promise((resolve, reject) => { calls.push({ draft, opts, resolve, reject }) })
  return { fetcher, calls }
}

const flush = () => Promise.resolve().then(() => Promise.resolve())

beforeEach(() => resetDismissedMatches())
afterEach(() => { vi.useRealTimers(); fetchMock.mockReset() })

describe("contentWordCount", () => {
  it("counts meaningful words only", () => {
    expect(contentWordCount("")).toBe(0)
    expect(contentWordCount(null)).toBe(0)
    expect(contentWordCount("Please summarize the email")).toBe(2)        // summarize, email
    expect(contentWordCount("You are a helpful assistant. Do it.")).toBe(2)   // helpful, assistant
  })
  it("ignores blanks but counts their surroundings", () => {
    expect(contentWordCount("Summarize {{customer_email}} into {{count}} bullets")).toBe(2)
  })
  it("handles punctuation, numbers, contractions and other languages", () => {
    expect(contentWordCount("Don't write 5 bullets; write 3!")).toBe(6)      // don't, write, 5, bullets, write, 3
    expect(contentWordCount("It's what they're for")).toBe(0)                // all filler
    expect(contentWordCount("Résumé für Kunden zusammenfassen")).toBe(4)
  })
  it("LONG is just over the threshold the live check needs", () => {
    expect(contentWordCount(LONG)).toBeGreaterThanOrEqual(MIN_CONTENT_WORDS)
    expect(contentWordCount("Summarize this email into bullets")).toBeLessThan(MIN_CONTENT_WORDS)
  })
})

describe("pickInterruption", () => {
  it("prefers a same-job match, then a close one, never a related one", () => {
    expect(pickInterruption([match({ id: "a", level: "close" }), match({ id: "b", level: "same" })])?.id).toBe("b")
    expect(pickInterruption([match({ id: "a", level: "related" }), match({ id: "b", level: "close" })])?.id).toBe("b")
    expect(pickInterruption([match({ level: "related" })])).toBeNull()
    expect(pickInterruption([])).toBeNull()
  })
  it("skips copies of the prompt being edited and ones the person waved off", () => {
    expect(pickInterruption([match({ id: "a", copy_of_yours: true }), match({ id: "b", level: "close" })])?.id).toBe("b")
    dismissMatch("a")
    expect(isMatchDismissed("a")).toBe(true)
    expect(pickInterruption([match({ id: "a" }), match({ id: "b", level: "close" })])?.id).toBe("b")
    expect(pickInterruption([match({ id: "a" })], new Set())?.id).toBe("a")
  })
})

describe("LiveDuplicateChecker", () => {
  beforeEach(() => vi.useFakeTimers())

  it("waits for a pause in typing, then checks once with the latest text", async () => {
    const { fetcher, calls } = deferredFetcher()
    const c = new LiveDuplicateChecker(fetcher)
    c.update({ body: LONG })
    vi.advanceTimersByTime(300)
    c.update({ body: LONGER, title: "Email to bullets" }, "self")
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS - 1)
    expect(calls).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].draft).toMatchObject({ body: LONGER, title: "Email to bullets" })
    expect(calls[0].opts).toMatchObject({ excludeId: "self", k: 5, mode: "live" })
    expect(c.getState().checking).toBe(true)
    calls[0].resolve([match()])
    await flush()
    expect(c.getState()).toMatchObject({ checking: false, enoughWords: true })
    expect(c.getState().matches.map((m) => m.id)).toEqual(["p1"])
  })

  it("doesn't check until there are enough real words", () => {
    const { fetcher, calls } = deferredFetcher()
    const c = new LiveDuplicateChecker(fetcher)
    c.update({ body: "Summarize this email into bullets please" })
    vi.advanceTimersByTime(5_000)
    expect(calls).toHaveLength(0)
    expect(c.getState().enoughWords).toBe(false)
    c.update({ body: "{{a}} {{b}} {{c}} {{d}} {{e}} {{f}} {{g}} {{h}} {{i}}" })   // blanks aren't words
    vi.advanceTimersByTime(5_000)
    expect(calls).toHaveLength(0)
  })

  it("ignores whitespace-only edits", () => {
    const { fetcher, calls } = deferredFetcher()
    const c = new LiveDuplicateChecker(fetcher)
    c.update({ body: LONG })
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS)
    c.update({ body: `  ${LONG.replace(/ /g, "  ")}\n` })
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS * 4)
    expect(calls).toHaveLength(1)
    expect(calls[0].opts.signal?.aborted).toBe(false)
  })

  it("cancels a stale request and never shows its late answer", async () => {
    const { fetcher, calls } = deferredFetcher()
    const c = new LiveDuplicateChecker(fetcher)
    c.update({ body: LONG })
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS)
    expect(calls).toHaveLength(1)

    c.update({ body: LONGER })                       // typing again
    expect(calls[0].opts.signal?.aborted).toBe(true)
    expect(c.getState().checking).toBe(false)
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS)
    expect(calls).toHaveLength(2)

    calls[1].resolve([match({ id: "new" })])
    await flush()
    calls[0].resolve([match({ id: "old" })])         // the old answer straggles in
    await flush()
    expect(c.getState().matches.map((m) => m.id)).toEqual(["new"])
    expect(c.getState().checking).toBe(false)
  })

  it("keeps the last answer on screen while the next check is pending", async () => {
    const { fetcher, calls } = deferredFetcher()
    const c = new LiveDuplicateChecker(fetcher)
    c.update({ body: LONG })
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS)
    calls[0].resolve([match()])
    await flush()
    c.update({ body: LONGER })
    expect(c.getState().matches).toHaveLength(1)
  })

  it("clears matches when the text gets too short again", async () => {
    const { fetcher, calls } = deferredFetcher()
    const c = new LiveDuplicateChecker(fetcher)
    c.update({ body: LONG })
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS)
    calls[0].resolve([match()])
    await flush()
    c.update({ body: "Summarize" })
    expect(c.getState()).toEqual({ matches: [], checking: false, enoughWords: false })
  })

  it("a failed check keeps what was there and stays quiet", async () => {
    const { fetcher, calls } = deferredFetcher()
    const c = new LiveDuplicateChecker(fetcher)
    c.update({ body: LONG })
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS)
    calls[0].resolve([match()])
    await flush()
    c.update({ body: LONGER })
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS)
    calls[1].reject(new Error("offline"))
    await flush()
    expect(c.getState()).toMatchObject({ checking: false })
    expect(c.getState().matches).toHaveLength(1)
  })

  it("survives a fetcher that throws synchronously", async () => {
    const c = new LiveDuplicateChecker(() => { throw new Error("boom") })
    c.update({ body: LONG })
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS)
    await flush()
    expect(c.getState().checking).toBe(false)
  })

  it("reset() stops pending work and lets the same draft check again (remount)", async () => {
    const { fetcher, calls } = deferredFetcher()
    const c = new LiveDuplicateChecker(fetcher)
    const seen: boolean[] = []
    c.subscribe(() => seen.push(c.getState().checking))
    c.update({ body: LONG })
    c.reset()
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS * 2)
    expect(calls).toHaveLength(0)
    c.update({ body: LONG })
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS)
    expect(calls).toHaveLength(1)
    expect(seen).toContain(true)
  })

  it("re-checks when the title changes, not only the text", () => {
    const { fetcher, calls } = deferredFetcher()
    const c = new LiveDuplicateChecker(fetcher)
    c.update({ body: LONG })
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS)
    c.update({ body: LONG, title: "Bullets for my boss" })
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS)
    expect(calls).toHaveLength(2)
  })
})

describe("findBlockingMatch (on Save)", () => {
  it("stops the save only for a same-job match", async () => {
    const fetcher = vi.fn<MatchFetcher>().mockResolvedValue([match()])
    expect((await findBlockingMatch({ body: LONG }, { excludeId: "self", fetcher }))?.id).toBe("p1")
    expect(fetcher.mock.calls[0][1]).toMatchObject({ excludeId: "self", mode: "save" })
    fetcher.mockResolvedValue([match({ level: "close" })])
    expect(await findBlockingMatch({ body: LONG }, { fetcher })).toBeNull()
    fetcher.mockResolvedValue([match({ level: "related" })])
    expect(await findBlockingMatch({ body: LONG }, { fetcher })).toBeNull()
  })

  it("never asks again after Keep writing mine / Save mine anyway, nor for a copy of this prompt", async () => {
    const fetcher = vi.fn<MatchFetcher>().mockResolvedValue([match({ copy_of_yours: true })])
    expect(await findBlockingMatch({ body: LONG }, { fetcher })).toBeNull()
    fetcher.mockResolvedValue([match()])
    dismissMatch("p1")
    expect(await findBlockingMatch({ body: LONG }, { fetcher })).toBeNull()
  })

  it("lets the save go ahead when the check fails, is slow, or there's no text", async () => {
    expect(await findBlockingMatch({ body: LONG }, { fetcher: () => Promise.reject(new Error("down")) })).toBeNull()
    expect(await findBlockingMatch({ body: LONG }, { fetcher: () => { throw new Error("sync") } })).toBeNull()
    const never = vi.fn<MatchFetcher>(() => new Promise(() => {}))
    expect(await findBlockingMatch({ body: LONG }, { fetcher: never, timeoutMs: 20 })).toBeNull()
    expect(never.mock.calls[0][1].signal?.aborted).toBe(true)
    const unused = vi.fn<MatchFetcher>()
    expect(await findBlockingMatch({ body: "   " }, { fetcher: unused })).toBeNull()
    expect(unused).not.toHaveBeenCalled()
  })

  it("uses the real client by default", async () => {
    fetchMock.mockResolvedValueOnce({ matches: [match()] })
    expect((await findBlockingMatch({ body: LONG }))?.id).toBe("p1")
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe("/api/prompts/similar")
    expect(JSON.parse(init.body)).toMatchObject({ body: LONG, mode: "save", k: 3 })
  })
})

// ── What people read ────────────────────────────────────────────────────

const render = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>)
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ")
const JARGON = /\b(score|token|QA|red team|injection|probe|jailbreak|fork|LLM|API|band|rank|grade|leaderboard|per run)\b|\d+(\.\d+)?\s*%|0\.9\d/i

describe("DuplicateCard copy", () => {
  const send = (m: Match) => <button type="button">Send it now ({m.id})</button>

  it("same job while typing: doesn't claim it's identical before Save's check, same buttons", () => {
    const t = text(render(<DuplicateCard match={match()} renderAction={send} onKeepWriting={() => {}} />))
    expect(t).toContain("Looks like “Client email to 3 bullets”")
    expect(t).not.toContain("Already in the library")
    expect(t).toContain("Use that one")
    expect(t).toContain("Send it now (p1)")
    expect(t).toContain("Keep writing mine")
    expect(t).not.toMatch(JARGON)
  })

  it("same job, an exact copy: already in the library", () => {
    const t = text(render(<DuplicateCard match={{ ...match(), exact: true } as Match} renderAction={send} onKeepWriting={() => {}} />))
    expect(t).toContain("Already in the library: “Client email to 3 bullets”")
    expect(t).toContain("Use that one")
    expect(t).toContain("Send it now (p1)")
    expect(t).not.toMatch(JARGON)
  })

  it("same job, from the Save check: already in the library", () => {
    const t = text(render(<DuplicateCard match={match()} checked renderAction={send} onKeepWriting={() => {}} />))
    expect(t).toContain("Already in the library: “Client email to 3 bullets”")
  })

  it("same job, already yours", () => {
    const html = render(<DuplicateCard match={match({ owned: true })} renderAction={send} onKeepWriting={() => {}} />)
    expect(text(html)).toContain("Looks like one of yours: “Client email to 3 bullets”")
    expect(text(html)).toContain("Open mine")
    expect(html).toContain('href="/prompts/p1"')
    const exact = render(<DuplicateCard match={{ ...match({ owned: true }), exact: true } as Match} renderAction={send} onKeepWriting={() => {}} />)
    expect(text(exact)).toContain("You already have this one: “Client email to 3 bullets”")
  })

  it("close: says what differs, opens in a new tab, never offers to send", () => {
    const m = match({ level: "close", yours_only: ["draft a reply"], theirs_only: ["deadline", "tone"], note: "Yours: 5 bullets, theirs: 3." })
    const html = render(<DuplicateCard match={m} renderAction={send} onKeepWriting={() => {}} />)
    const t = text(html)
    expect(t).toContain("Close to “Client email to 3 bullets”")
    expect(t).toContain("Yours also: draft a reply")
    expect(t).toContain("Theirs also: deadline · tone")
    expect(t).toContain("Yours: 5 bullets, theirs: 3.")
    expect(t).toContain("Open it")
    expect(t).not.toContain("Send it now")
    expect(html).toContain('target="_blank"')
    expect(t).not.toMatch(JARGON)
  })

  it("headline and differences helpers", () => {
    expect(matchHeadline(match({ level: "close", owned: true }))).toBe("Close to one of yours: “Client email to 3 bullets”")
    expect(matchHeadline(match())).toBe("Looks like “Client email to 3 bullets”")
    expect(matchHeadline(match(), { checked: true })).toBe("Already in the library: “Client email to 3 bullets”")
    expect(matchHeadline({ ...match(), exact: true } as Match)).toBe("Already in the library: “Client email to 3 bullets”")
    expect(matchHeadline({ ...match({ level: "close" }), exact: false } as Match)).toBe("Close to “Client email to 3 bullets”")
    expect(isExactMatch(match())).toBe(false)
    expect(matchDifferences(match({ yours_only: ["a", "b", "c", "d", "e"] })).yoursAlso).toBe("a · b · c · d")
    expect(matchDifferences(match({ note: "  " })).note).toBeNull()
  })
})

describe("DuplicateSaveSheet copy", () => {
  it("asks once, in plain words", () => {
    const t = text(render(<DuplicateSaveSheet match={match()} onUse={() => {}} onSaveAnyway={() => {}} onCancel={() => {}} />))
    expect(t).toContain("This one's already in the library")
    expect(t).toContain("“Client email to 3 bullets” by Arceo Library does the same job.")
    expect(t).toContain("Use that one")
    expect(t).toContain("Save mine anyway")
    expect(t).not.toMatch(JARGON)
  })
  it("says so when it's the person's own", () => {
    const t = text(render(<DuplicateSaveSheet match={match({ owned: true })} onUse={() => {}} onSaveAnyway={() => {}} onCancel={() => {}} />))
    expect(t).toContain("You already have this one")
    expect(t).toContain("Open mine")
    expect(t).not.toContain("by Arceo Library")
  })
})
