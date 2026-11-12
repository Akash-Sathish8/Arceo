import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"

vi.mock("@/lib/api", () => ({ apiBase: () => "", apiFetch: vi.fn(() => new Promise(() => {})) }))

import SimilarPrompts, { SimilarCard, matchTag, similarHref } from "./SimilarPrompts"
import type { Match } from "@/lib/similarApi"

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ")
const render = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>)

const match = (over: Partial<Match> = {}): Match => ({
  id: "p2", title: "Turn meeting notes into action items", description: "Pulls out who does what by when.",
  use_case: "Meetings & notes", author_name: "Arceo Library", owned: false, copy_of_yours: false,
  level: "related", score: 0.71, shared: [], yours_only: [], theirs_only: [], ...over,
})

describe("SimilarPrompts", () => {
  it("shows a quiet placeholder while it loads", () => {
    const html = render(<SimilarPrompts promptId="p1" />)
    expect(text(html)).toContain("Similar prompts")
    expect(html).toContain("skeleton")
    expect(html).toContain('aria-busy="true"')
  })

  it("renders nothing without a prompt", () => {
    expect(render(<SimilarPrompts promptId="" />)).toBe("")
  })

  it("a card: title link, one-line description, category, tag, action; never the score", () => {
    const html = render(<SimilarCard match={match({ owned: true })} href="/prompts/p2" action={<button>Send</button>} />)
    const t = text(html)
    expect(html).toContain('href="/prompts/p2"')
    expect(t).toContain("Turn meeting notes into action items")
    expect(t).toContain("Pulls out who does what by when.")
    expect(t).toContain("Meetings &amp; notes")
    expect(t).toContain("Yours")
    expect(t).toContain("Send")
    expect(t).not.toMatch(/0\.71|71|score|related/i)
  })

  it("a card without a description or category still renders cleanly", () => {
    const t = text(render(<SimilarCard match={match({ description: null, use_case: null })} href="/p/p2" />))
    expect(t.trim()).toBe("Turn meeting notes into action items")
  })

  it("files the category under the same words as the library's cards", () => {
    expect(text(render(<SimilarCard match={match({ use_case: "ops" })} href="/p/p2" />))).toContain("Running the business")
    expect(text(render(<SimilarCard match={match({ use_case: "meetings & NOTES" })} href="/p/p2" />))).toContain("Meetings &amp; notes")
    expect(text(render(<SimilarCard match={match({ use_case: "knitting" })} href="/p/p2" />))).toContain("Knitting")
  })

  it("tags and links", () => {
    expect(matchTag({ owned: true, copy_of_yours: false })).toBe("Yours")
    expect(matchTag({ owned: true, copy_of_yours: true })).toBe("Your copy")
    expect(matchTag({ owned: false, copy_of_yours: true })).toBe("Original")
    expect(matchTag({ owned: false, copy_of_yours: false })).toBeNull()
    expect(similarHref({ id: "a/b" })).toBe("/prompts/a%2Fb")
    expect(similarHref({ id: "a" }, true)).toBe("/p/a")
  })
})
