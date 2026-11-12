import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/api", () => ({ apiBase: () => "", apiFetch: vi.fn() }))

import Warnings from "./Warnings"
import type { DangerReason, DangerSummary } from "@/lib/promptsApi"

const reason = (over: Partial<DangerReason> = {}): DangerReason => ({
  id: "injection:email", dismissable: true, dismissed: false, fixable: true, factor: "injection", points: 40,
  severity: "high", title: "Someone could hide instructions in the email",
  detail: "Text pasted into the email blank could tell the AI to do something else.", evidence: null, ...over,
})

const danger = (reasons: DangerReason[], publish_blockers: string[] = []): DangerSummary => ({
  score: 62, band: "high", status: "probed", reasons, publish_blockers, untrusted_variables: [], ai_checked: true,
})

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ")
// Nothing about ratings may reach the page: no number, band word, severity word or "tested".
const RATING = /\b(score|band|critical|high|medium|low|severity|tested|probed|rating|grade|rank)\b|\b62\b|\/100|\b40\b/i

const draft = { body: "Reply to {{email}}", variables: {}, tools: [] }

describe("Warnings", () => {
  it("renders nothing when there's nothing worth saying", () => {
    expect(renderToStaticMarkup(<Warnings danger={null} />)).toBe("")
    expect(renderToStaticMarkup(<Warnings danger={danger([])} />)).toBe("")
    expect(renderToStaticMarkup(<Warnings danger={danger([reason({ severity: "medium" }), reason({ id: "x", severity: "low" })])} />)).toBe("")
    expect(renderToStaticMarkup(<Warnings danger={danger([reason({ dismissed: true })])} editable onFixed={() => {}} />)).toBe("")
  })

  it("one plain item per problem, with no rating anywhere", () => {
    const html = renderToStaticMarkup(<Warnings danger={danger([reason(), reason({ id: "y", severity: "medium", title: "Medium thing" })])} />)
    const t = text(html)
    expect(t).toContain("Read this before you use it")
    expect(t).toContain("Someone could hide instructions in the email")
    expect(t).toContain("Text pasted into the email blank")
    expect(t).not.toContain("Medium thing")
    expect(t).not.toMatch(RATING)
    expect(t).not.toContain("Fix it for me")           // read-only by default
    expect(t).not.toContain("Doesn't apply")
  })

  it("editors get Fix it for me and Doesn't apply to me", () => {
    const t = text(renderToStaticMarkup(
      <Warnings danger={danger([reason()])} promptId="p1" fixDraft={draft} editable onFixed={() => {}} />))
    expect(t).toContain("Fix it for me")
    expect(t).toContain("Doesn't apply to me")
    expect(t).not.toMatch(RATING)
  })

  it("no Fix button without somewhere to put the fix, or when nothing is fixable", () => {
    expect(text(renderToStaticMarkup(<Warnings danger={danger([reason()])} promptId="p1" fixDraft={draft} editable />))).not.toContain("Fix it for me")
    expect(text(renderToStaticMarkup(
      <Warnings danger={danger([reason({ fixable: false })])} fixDraft={draft} editable onFixed={() => {}} />))).not.toContain("Fix it for me")
  })

  it("Doesn't apply to me needs a saved prompt or an onDismiss", () => {
    expect(text(renderToStaticMarkup(<Warnings danger={danger([reason()])} editable />))).not.toContain("Doesn't apply")
    expect(text(renderToStaticMarkup(<Warnings danger={danger([reason()])} editable onDismiss={() => {}} />))).toContain("Doesn't apply to me")
    expect(text(renderToStaticMarkup(<Warnings danger={danger([reason({ dismissable: false })])} editable promptId="p1" />))).not.toContain("Doesn't apply")
  })

  it("sharing blockers say so to the editor, several items get counted", () => {
    const secret = reason({ id: "data_exposure:secret:body", severity: "critical", title: "A password or key is in the prompt", detail: "Take it out.", dismissable: false })
    const t = text(renderToStaticMarkup(
      <Warnings danger={danger([reason(), secret], ["secret_in_prompt"])} fixDraft={draft} editable onFixed={() => {}} />))
    expect(t).toContain("Read these 2 things before you use it")
    expect(t.indexOf("A password or key")).toBeLessThan(t.indexOf("Someone could hide"))   // worst first
    expect(t).toContain("This has to come out before you can share it.")
    expect(t).not.toMatch(RATING)
  })

  it("takes everything from a saved prompt", () => {
    const prompt = { id: "p1", danger_summary: danger([reason()]), body: "x", variables: null, tools: null }
    expect(text(renderToStaticMarkup(<Warnings prompt={prompt} />))).toContain("Someone could hide instructions")
    // An explicit danger (a live check) wins, even when it's null.
    expect(renderToStaticMarkup(<Warnings prompt={prompt} danger={null} />)).toBe("")
  })

  it("compact: a short note with no buttons, even for editors", () => {
    const html = renderToStaticMarkup(
      <Warnings danger={danger([reason()])} promptId="p1" fixDraft={draft} editable onFixed={() => {}} onUndoFix={() => {}} compact />)
    const t = text(html)
    expect(t).toContain("Someone could hide instructions in the email. Text pasted")
    expect(html).not.toContain("<button")
    expect(t).not.toMatch(RATING)
  })

  it("keeps Undo reachable after a fix clears every warning", () => {
    const t = text(renderToStaticMarkup(<Warnings danger={danger([])} editable onUndoFix={() => {}} />))
    expect(t).toContain("We changed the prompt to make it safer")
    expect(t).toContain("Undo")
    expect(renderToStaticMarkup(<Warnings danger={danger([])} onUndoFix={() => {}} />)).toBe("")   // not for readers
  })
})
