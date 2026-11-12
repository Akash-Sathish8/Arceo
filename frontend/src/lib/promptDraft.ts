/**
 * Pure helpers for the prompt page's draft (PromptDetail). Kept apart from the
 * page so they can be unit-tested without a browser.
 */

import type { DangerSummary, Prompt, PromptDraft } from "./promptsApi"
import type { SendablePrompt } from "@/components/prompts/SendDialog"

/** The editable fields of a saved prompt. */
export function toDraft(p: Prompt): PromptDraft {
  return {
    title: p.title, description: p.description ?? "", use_case: p.use_case ?? "", body: p.body,
    variables: p.variables ?? {}, tools: p.tools ?? [], expected_output_tokens: p.expected_output_tokens,
    runs_per_day: p.runs_per_day, model: p.model, dismissed: p.dismissed ?? [],
  }
}

/** The draft after the server changed the prompt's "Doesn't apply to me" list
 *  from the read view: the rest of the draft is kept, the list follows the
 *  server, so a later Save doesn't bring a waved-off warning back. */
export function withServerDismissed(draft: PromptDraft, p: Prompt): PromptDraft {
  return { ...draft, dismissed: p.dismissed ?? [] }
}

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim()

/** Whether Save should ask "is this already in the library?". Always for a new
 *  prompt; for a saved one only when its text really changed, so renaming or
 *  re-describing a prompt never brings the question back. */
export function needsDuplicateCheckOnSave(saved: Pick<Prompt, "body"> | null | undefined, draftBody: string): boolean {
  if (!saved) return true
  return squash(saved.body) !== squash(draftBody)
}

/** What the Send dialog gets while writing. A connected agent is sent the
 *  SAVED text by the server, so a draft that differs from it is marked
 *  unsaved and the dialog won't offer the connected agent. */
export function sendableDraft(saved: Prompt | null, draft: PromptDraft, danger: DangerSummary | null): SendablePrompt {
  return {
    id: saved?.id ?? "",
    title: draft.title,
    body: draft.body,
    variables: draft.variables,
    danger_summary: danger,
    unsaved: !!saved && (saved.body !== draft.body || saved.title !== draft.title),
  }
}
