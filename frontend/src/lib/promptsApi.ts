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
  untrusted?: boolean | null
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

export { formatRunCost, BASIS_LABEL, BASIS_HELP, headlineCost, rowBasis } from "./promptFormat"

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

// ── Workflows (phase 4) ──────────────────────────────────────────────────
export type StepSource = { from: "input"; name: string } | { from: "step"; step: number }

export interface WorkflowStep {
  prompt_id: string
  input_map: Record<string, StepSource>
}

export interface WorkflowInput {
  name: string
  untrusted?: boolean | null
  expected_tokens?: number
}

export interface WorkflowSpec {
  steps: WorkflowStep[]
  inputs: WorkflowInput[]
}

export interface WorkflowCostRow {
  model: string
  model_key?: string
  available: boolean
  usd_per_run?: number
  usd_per_1k_runs?: number
  basis?: CostBasis
  is_floor?: boolean
  steps?: { step: number; usd_per_run: number; basis: CostBasis; input_tokens: number; output_tokens: number | null }[]
}

export interface WorkflowScore {
  cost: { models: WorkflowCostRow[]; cheapest_model: string | null }
  danger: Omit<DangerSummary, "reasons"> & { steps: { step: number; title: string; score: number; band: DangerSummary["band"] }[]; reasons: (DangerReason & { step: number })[] }
}

export interface PromptWorkflow {
  id: string
  author_name: string | null
  title: string
  description: string | null
  steps: WorkflowSpec | null
  visibility: "private" | "org" | "public"
  status: "draft" | "published"
  cost_summary: WorkflowScore["cost"] | null
  danger_summary: WorkflowScore["danger"] | null
  owned: boolean
  updated_at: string
  step_count?: number
}

const wf = (id: string) => `/api/prompt-workflows/${encodeURIComponent(id)}`

export const scoreWorkflow = (spec: WorkflowSpec) =>
  apiFetch<WorkflowScore>("/api/prompt-workflows/score", { method: "POST", body: JSON.stringify(spec) })
export const listWorkflows = (scope: "all" | "mine" | "public" = "all") =>
  apiFetch<{ workflows: PromptWorkflow[] }>(`/api/prompt-workflows?scope=${scope}`)
export const getWorkflow = (id: string) => apiFetch<PromptWorkflow>(wf(id))
export const createWorkflow = (body: WorkflowSpec & { title: string; description: string }) =>
  apiFetch<PromptWorkflow>("/api/prompt-workflows", { method: "POST", body: JSON.stringify(body) })
export const updateWorkflow = (id: string, body: WorkflowSpec & { title: string; description: string }) =>
  apiFetch<PromptWorkflow>(wf(id), { method: "PUT", body: JSON.stringify(body) })
export const deleteWorkflow = (id: string) => apiFetch<{ deleted: string }>(wf(id), { method: "DELETE" })
export const publishWorkflow = (id: string, visibility: "org" | "public") =>
  apiFetch<PromptWorkflow>(`${wf(id)}/publish`, { method: "POST", body: JSON.stringify({ visibility }) })

// ── Battles (phase 5) ────────────────────────────────────────────────────
export interface BattleInput { label: string; values: Record<string, string> }

export interface LeaderRow {
  id: string
  rank: number
  author_id?: string
  author_name: string | null
  elo: number
  wins: number
  losses: number
  ties: number
  votes: number
  cost: { model_key: string; usd_per_run: number; output_tokens: number; basis: CostBasis } | null
  danger: DangerSummary | null
  body: string | null
  mine?: boolean
}

export interface Battle {
  id: string
  title: string
  task: string
  model: string
  status: "open" | "closed"
  created_at: string
  is_creator: boolean
  variables: string[]
  input_count: number
  inputs: BattleInput[] | null
  entry_count: number
  vote_count: number
  leaderboard: LeaderRow[]
}

export interface BattleSummary {
  id: string; title: string; task: string; model: string; status: "open" | "closed"
  created_at: string; entry_count: number; vote_count: number
}

export interface Matchup {
  input_index: number
  input: BattleInput
  left: { id: string; output: string }
  right: { id: string; output: string }
}

export type BattleSort = "best" | "cheapest_good" | "safest"

const bt = (id: string) => `/api/battles/${encodeURIComponent(id)}`

export const listBattles = () => apiFetch<{ battles: BattleSummary[] }>("/api/battles")
export const createBattle = (body: { title: string; task: string; model: string; inputs: BattleInput[] }) =>
  apiFetch<Battle>("/api/battles", { method: "POST", body: JSON.stringify(body) })
export const getBattle = (id: string, sort: BattleSort = "best") => apiFetch<Battle>(`${bt(id)}?sort=${sort}`)
export const enterBattle = (id: string, body: string) =>
  apiFetch<{ id: string }>(`${bt(id)}/entries`, { method: "POST", body: JSON.stringify({ body }), timeoutMs: 120_000 })
export const getMatchup = (id: string) => apiFetch<{ matchup: Matchup | null }>(`${bt(id)}/matchup`)
export const castVote = (id: string, v: { entry_a: string; entry_b: string; input_index: number; winner: string }) =>
  apiFetch<{ ok: boolean }>(`${bt(id)}/votes`, { method: "POST", body: JSON.stringify(v) })
export const closeBattle = (id: string) => apiFetch<Battle>(`${bt(id)}/close`, { method: "POST" })
export const getPublicBattle = (id: string, sort: BattleSort = "best") =>
  apiFetch<Battle>(`/api/public/battles/${encodeURIComponent(id)}?sort=${sort}`, { skipLogoutOn401: true })
