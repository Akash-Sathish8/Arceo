/**
 * Prompt matching client: "is this already in the library?" and the Similar
 * prompts row. Contracts: docs/prompts-rework-plan.md, "API and module contracts".
 *
 *   POST /api/prompts/similar                    matchDraft
 *   GET  /api/prompts/{id}/similar?k=            similarTo
 *   GET  /api/public/prompts/{id}/similar?k=     publicSimilarTo (share pages, signed out)
 *
 * Each returns the `matches` array, best first. `score` orders results; it is
 * never shown to people. The `shared` / `yours_only` / `theirs_only` labels are
 * already plain words ("summarize", "email", "bullets").
 */

import { apiFetch } from "@/lib/api"
import type { VariableSpec } from "@/lib/promptsApi"

export type MatchLevel = "same" | "close" | "related"

export interface Match {
  id: string
  title: string
  description: string | null
  use_case: string | null
  author_name: string | null
  /** The viewer's own workspace owns it: say "You already have this one". */
  owned: boolean
  /** It's a copy of the prompt being edited (or its original): label, don't interrupt. */
  copy_of_yours: boolean
  level: MatchLevel
  /** True only for an exact copy (same canonical text). */
  exact?: boolean
  score: number
  shared: string[]
  yours_only: string[]
  theirs_only: string[]
  /** Optional one-sentence plain explanation of the difference. */
  note?: string
}

/** What someone has typed or pasted so far. Only `body` is required. */
export interface MatchDraft {
  body: string
  title?: string
  description?: string
  use_case?: string
  variables?: Record<string, VariableSpec>
}

export interface MatchOptions {
  /** The prompt being edited, so it never matches itself. */
  excludeId?: string
  /** How many to return (1-20). Default 5. */
  k?: number
  /** "live" while typing (cheap); "save" on Save (may take a moment longer). */
  mode?: "live" | "save"
  /** Abort a stale live check when the person keeps typing. */
  signal?: AbortSignal
}

type MatchesResponse = { matches?: Match[] }

export const matchDraft = (draft: MatchDraft, opts: MatchOptions = {}): Promise<Match[]> =>
  apiFetch<MatchesResponse>("/api/prompts/similar", {
    method: "POST",
    body: JSON.stringify({
      body: draft.body,
      title: draft.title || undefined,
      description: draft.description || undefined,
      use_case: draft.use_case || undefined,
      variables: draft.variables ?? {},
      exclude_id: opts.excludeId,
      k: opts.k ?? 5,
      mode: opts.mode ?? "live",
    }),
    signal: opts.signal,
  }).then((r) => r.matches ?? [])

export const similarTo = (id: string, k = 6): Promise<Match[]> =>
  apiFetch<MatchesResponse>(`/api/prompts/${encodeURIComponent(id)}/similar?k=${k}`)
    .then((r) => r.matches ?? [])

export const publicSimilarTo = (id: string, k = 6): Promise<Match[]> =>
  apiFetch<MatchesResponse>(`/api/public/prompts/${encodeURIComponent(id)}/similar?k=${k}`, { skipLogoutOn401: true })
    .then((r) => r.matches ?? [])
