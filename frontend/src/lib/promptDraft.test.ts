import { describe, expect, it } from "vitest"
import { needsDuplicateCheckOnSave, sendableDraft, toDraft, withServerDismissed } from "./promptDraft"
import type { Prompt } from "./promptsApi"

const saved = {
  id: "pr_1", title: "Haiku", description: "", use_case: "", body: "Write a haiku about autumn leaves.",
  variables: {}, tools: [], expected_output_tokens: 100, runs_per_day: 1, model: null, dismissed: [],
} as unknown as Prompt

describe("sendableDraft", () => {
  // Regression: an Edit's unsaved text went to the dialog with the saved
  // prompt's id; "My connected agent" then got the OLD saved text from the server.
  it("marks a draft whose text differs from the saved prompt", () => {
    const draft = { ...toDraft(saved), body: "Write a limerick about a cat named {{cat_name}}." }
    const s = sendableDraft(saved, draft, null)
    expect(s.unsaved).toBe(true)
    expect(s.body).toBe(draft.body)
    expect(s.id).toBe("pr_1")
  })
  it("doesn't mark a draft that matches what's saved", () => {
    expect(sendableDraft(saved, toDraft(saved), null).unsaved).toBe(false)
  })
  it("a new prompt has no id and nothing saved to differ from", () => {
    const s = sendableDraft(null, toDraft(saved), null)
    expect(s.id).toBe("")
    expect(s.unsaved).toBe(false)
  })
})

describe("withServerDismissed", () => {
  // Regression: "Doesn't apply to me" on the read view updated the prompt but
  // not the draft, so the next Edit + Save sent dismissed: [] and undid it.
  it("takes the server's list and keeps the rest of the draft", () => {
    const draft = { ...toDraft(saved), title: "Typed" }
    const next = withServerDismissed(draft, { ...saved, dismissed: ["chain:moves_money"] } as Prompt)
    expect(next.dismissed).toEqual(["chain:moves_money"])
    expect(next.title).toBe("Typed")
  })
})

describe("needsDuplicateCheckOnSave", () => {
  // Regression: every Save of a saved prompt asked "already in the library?"
  // again in each new tab, even when only the description changed.
  it("skips the question when the saved text didn't change", () => {
    expect(needsDuplicateCheckOnSave(saved, saved.body)).toBe(false)
    expect(needsDuplicateCheckOnSave(saved, `  ${saved.body}\n`)).toBe(false)
  })
  it("asks for new prompts and changed text", () => {
    expect(needsDuplicateCheckOnSave(null, saved.body)).toBe(true)
    expect(needsDuplicateCheckOnSave(saved, "Summarize this email thread for someone new.")).toBe(true)
  })
})
