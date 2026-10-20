/**
 * Prompt library API client: /api/prompts/* (signed in) and /api/public/* (share links).
 *
 * Every cost row carries its basis (exact | heuristic | declared | measured |
 * unavailable) and every danger score its status (static | probed). The UI
 * shows both, the same honesty rule as the agent spend forecast.
 */

import { apiFetch } from "@/lib/api"

export type CostBasis = "exact" | "heuristic" | "declared" | "measured" | "unavailable"

export interface VariableSpec {
  sample?: string
  expected_tokens?: number
  untrusted?: boolean
}

export interface CostRow {
  model: string
  model_key: string | null
  provider: string | null
  available: boolean
  reason?: string
  input_tokens?: number
  output_tokens?: number | null
  input_basis?: CostBasis
  output_basis?: CostBasis
  is_floor?: boolean
  usd_per_run?: number
  usd_per_1k_runs?: number
  basis?: CostBasis
  verified_on?: string
}

export interface CostSummary {
  models: CostRow[]
  cheapest_model: string | null
  unsized_variables: string[]
  catalog_date: string | null
  rates: "applied" | "none" | "unavailable"
}

export interface DangerReason {
  factor: "data_exposure" | "injection" | "jailbreak" | "capability" | "chain" | "probed"
  points: number
  severity: "low" | "medium" | "high" | "critical"
  title: string
  detail: string
  evidence: string | null
}

export interface DangerSummary {
  score: number
  band: "low" | "medium" | "high" | "critical"
  status: "static" | "probed"
  reasons: DangerReason[]
  publish_blockers: string[]
  untrusted_variables: string[]
}

export interface PromptVersion {
  id: string
  version: number
  title: string
  cost: CostSummary | null
  danger: DangerSummary | null
  reliability: number | null
  created_at: string
}

export interface Prompt {
  id: string
  author_id: string | null
  author_name: string | null
  title: string
  description: string | null
  use_case: string | null
  body: string
  variables: Record<string, VariableSpec> | null
  tools: string[] | null
  expected_output_tokens: number | null
  tests?: QaSuite | null
  visibility: "private" | "org" | "public"
  status: "draft" | "published"
  published_version: number
  parent_id: string | null
  cost_summary: CostSummary | null
  danger_summary: DangerSummary | null
  reliability: number | null
  owned: boolean
  created_at: string
  updated_at: string
  versions?: PromptVersion[]
}

export type PromptListItem = Omit<Prompt, "body" | "variables" | "tools" | "expected_output_tokens" | "tests">

export interface PromptDraft {
  title: string
  description: string
  use_case: string
  body: string
  variables: Record<string, VariableSpec>
  tools: string[]
  expected_output_tokens: number | null
}

export interface ScoreResult {
  variables: string[]
  unknown_variables: string[]
  cost: CostSummary
  danger: DangerSummary
}

// ── QA (phase 3) ─────────────────────────────────────────────────────────
export interface QaCheck {
  type: "contains" | "not_contains" | "regex" | "json" | "max_words" | "judge"
  value?: string
}

export interface QaCase {
  label: string
  values: Record<string, string>
}

export interface QaSuite {
  cases: QaCase[]
  checks: QaCheck[]
  models: string[]
  probes: boolean
}

export const scorePrompt = (draft: Pick<PromptDraft, "body" | "variables" | "tools" | "expected_output_tokens">) =>
  apiFetch<ScoreResult>("/api/prompts/score", {
    method: "POST",
    body: JSON.stringify({ ...draft, expected_output_tokens: draft.expected_output_tokens ?? undefined }),
  })

export const listPrompts = (scope: "all" | "mine" | "public", q?: string) => {
  const params = new URLSearchParams({ scope })
  if (q) params.set("q", q)
  return apiFetch<{ prompts: PromptListItem[] }>(`/api/prompts?${params}`)
}

export const getPrompt = (id: string) => apiFetch<Prompt>(`/api/prompts/${encodeURIComponent(id)}`)

export const createPrompt = (draft: PromptDraft) =>
  apiFetch<Prompt>("/api/prompts", { method: "POST", body: JSON.stringify(draft) })

export const updatePrompt = (id: string, draft: PromptDraft) =>
  apiFetch<Prompt>(`/api/prompts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(draft) })

export const deletePrompt = (id: string) =>
  apiFetch<{ deleted: string }>(`/api/prompts/${encodeURIComponent(id)}`, { method: "DELETE" })

export const publishPrompt = (id: string, visibility: Prompt["visibility"], acknowledge_risk: boolean) =>
  apiFetch<Prompt>(`/api/prompts/${encodeURIComponent(id)}/publish`, {
    method: "POST", body: JSON.stringify({ visibility, acknowledge_risk }),
  })

export const unpublishPrompt = (id: string) =>
  apiFetch<Prompt>(`/api/prompts/${encodeURIComponent(id)}/unpublish`, { method: "POST" })

export const forkPrompt = (id: string) =>
  apiFetch<Prompt>(`/api/prompts/${encodeURIComponent(id)}/fork`, { method: "POST" })

export const getPublicPrompt = (id: string) =>
  apiFetch<Prompt>(`/api/public/prompts/${encodeURIComponent(id)}`, { skipLogoutOn401: true })

// ── formatting ───────────────────────────────────────────────────────────

/** Per-run prices are routinely fractions of a cent, so formatMoney's whole
 *  dollars would print $0 for every prompt. Show enough digits to compare. */
export function formatRunCost(usd: number | null | undefined): string {
  if (usd == null || isNaN(usd)) return "Unavailable"
  if (usd === 0) return "$0"
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`
  return "<$0.0001"
}

export const BASIS_LABEL: Record<CostBasis, string> = {
  measured: "measured",
  exact: "exact tokens",
  declared: "declared",
  heuristic: "estimate",
  unavailable: "input only",
}

export const BASIS_HELP: Record<CostBasis, string> = {
  measured: "Output length measured from QA runs of this prompt.",
  exact: "Counted with the provider's own tokenizer.",
  declared: "Uses the output length you declared. Run QA to measure it.",
  heuristic: "Input estimated at ~4 characters per token. Exact counts need the provider tokenizer.",
  unavailable: "No output length yet, so this is the input cost only. Declare an expected output length or run QA.",
}

/** The headline cost for a prompt: the cheapest priced model. */
export function headlineCost(cost: CostSummary | null | undefined): CostRow | null {
  if (!cost) return null
  const priced = cost.models.filter((m) => m.available && m.usd_per_run != null)
  return priced.find((m) => m.model_key === cost.cheapest_model) ?? priced[0] ?? null
}

export interface QaResult {
  kind: "test" | "probe"
  model: string
  case?: string
  probe_type?: "injection" | "leak" | "hijack"
  variable?: string
  passed: boolean
  output?: string
  input_tokens?: number
  output_tokens?: number
  latency_ms?: number
  usd?: number
  error?: string
  checks?: { type: string; value: string | null; passed: boolean; note: string | null }[]
}

export interface QaRunResponse {
  run_group: string
  reliability: number | null
  measured_output_tokens: Record<string, number>
  probe: { attempted: number; succeeded: number; findings: string[] } | null
  results: QaResult[]
  usd_total: number
  cost: CostSummary
  danger: DangerSummary
}

export interface QaHistoryRun {
  kind: "test" | "probe"
  probe_type: string | null
  model: string
  input_label: string | null
  output: string | null
  output_tokens: number | null
  usd: number | null
  passed: boolean | null
  checks: QaResult["checks"] | null
  error: string | null
  created_at: string
}

export const saveQaSuite = (id: string, suite: QaSuite) =>
  apiFetch<{ tests: QaSuite }>(`/api/prompts/${encodeURIComponent(id)}/tests`, { method: "PUT", body: JSON.stringify(suite) })

export const runQa = (id: string) =>
  apiFetch<QaRunResponse>(`/api/prompts/${encodeURIComponent(id)}/qa`, { method: "POST", timeoutMs: 180_000 })

export const getQaHistory = (id: string) =>
  apiFetch<{ runs: { run_group: string; at: string; runs: QaHistoryRun[] }[] }>(`/api/prompts/${encodeURIComponent(id)}/qa`)
