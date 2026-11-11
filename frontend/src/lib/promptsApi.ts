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
  id: string
  dismissable: boolean
  dismissed: boolean
  fixable?: boolean
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
  ai_checked?: boolean
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
  runs_per_day: number | null
  model: string | null
  dismissed: string[] | null
  use_count: number
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
  runs_per_day: number | null
  model: string | null
  dismissed: string[]
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

export const scorePrompt = (
  draft: Pick<PromptDraft, "body" | "variables" | "tools" | "expected_output_tokens"> & { dismissed?: string[] },
  promptId?: string,
) =>
  apiFetch<ScoreResult>("/api/prompts/score", {
    method: "POST",
    body: JSON.stringify({
      body: draft.body, variables: draft.variables, tools: draft.tools,
      expected_output_tokens: draft.expected_output_tokens ?? undefined,
      dismissed: draft.dismissed ?? [], prompt_id: promptId,
    }),
  })

export interface FixResult {
  body: string
  variables: Record<string, VariableSpec>
  changes: string[]
  before: { score: number; band: DangerSummary["band"] }
  after: DangerSummary
  unchanged: boolean
}

export const fixPrompt = (draft: Pick<PromptDraft, "body" | "variables" | "tools">) =>
  apiFetch<FixResult>("/api/prompts/fix", {
    method: "POST", body: JSON.stringify({ body: draft.body, variables: draft.variables, tools: draft.tools }),
  })

export const dismissReason = (id: string, reason_id: string, dismissed: boolean) =>
  apiFetch<Prompt>(`/api/prompts/${encodeURIComponent(id)}/dismiss`, {
    method: "POST", body: JSON.stringify({ reason_id, dismissed }),
  })

export interface QaBudget {
  free_runs: number
  used: number
  remaining: number
  own_keys: { anthropic: boolean; openai: boolean }
  free_providers: string[]
}

export const getQaBudget = () => apiFetch<QaBudget>("/api/prompts/qa-budget")

export interface CompareResult {
  model: string
  cases: QaCase[]
  variants: { label: string; body: string; outputs: string[]; danger: DangerSummary;
              cost: { model_key: string; usd_per_run: number; output_tokens: number; basis: CostBasis } }[]
  usd_total: number
  runs_per_day: number | null
}

export const compareVersions = (id: string, variants: { label: string; body: string }[], model?: string) =>
  apiFetch<CompareResult>(`/api/prompts/${encodeURIComponent(id)}/compare`, {
    method: "POST", body: JSON.stringify({ variants, model }), timeoutMs: 180_000,
  })

/** Count a use. Fire-and-forget: a failed count must never block the person copying. */
export const recordUse = (id: string, signedIn: boolean) =>
  apiFetch(signedIn ? `/api/prompts/${encodeURIComponent(id)}/use` : `/api/public/prompts/${encodeURIComponent(id)}/use`,
    { method: "POST", skipLogoutOn401: true }).catch(() => {})

export interface CreatorProfile {
  author_id: string
  author_name: string | null
  prompts: PromptListItem[]
  total_forks: number
  total_uses: number
  comparison_wins: number
}

export const getCreator = (id: string) =>
  apiFetch<CreatorProfile>(`/api/public/creators/${encodeURIComponent(id)}`, { skipLogoutOn401: true })

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

export { formatRunCost, BASIS_LABEL, BASIS_HELP, headlineCost, rowBasis, monthlyCost, formatMonthly, OUTPUT_PRESETS, wordsToTokens, tokensToWords, modelName, blankName } from "./promptFormat"

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
  summary: string
  generated_suite: QaSuite | null
  key_source: "server" | "own"
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

export const runQa = (id: string): Promise<QaRunResponse> =>
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
  last_run?: WorkflowRunResult | null
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

export interface WorkflowRunResult {
  model: string
  steps: { step: number; title: string; output: string; input_tokens: number; output_tokens: number; usd: number }[]
  usd_total: number
  at: string
  key_source: "server" | "own"
}

export const runWorkflow = (id: string, inputs: Record<string, string>, model: string) =>
  apiFetch<WorkflowRunResult>(`${wf(id)}/run`, { method: "POST", body: JSON.stringify({ inputs, model }), timeoutMs: 180_000 })
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

// ── Try on my agent ────────────────────────────────────────────────────────

export type AgentTryMode = "instructions" | "task"

export interface AgentTryRequest {
  agent_id: string
  mode: AgentTryMode
  task?: string
  values?: Record<string, string>
  body?: string
}

export interface AgentTryAction { tool: string; action: string; decision: string }
export interface AgentTryChain { name: string; severity: string }
export interface AgentTryRadius { score: number; residual_score: number; band: string; magnitude_usd: number }

export interface AgentTryEstimate {
  mode: AgentTryMode
  basis: "estimate"
  agent: { id: string; name: string; model: string }
  system_prompt: string | null
  user_message: string
  blast_radius: {
    reachable: AgentTryRadius
    ceiling: AgentTryRadius
    likely_actions: AgentTryAction[]
    chains: AgentTryChain[]
    ceiling_chains: AgentTryChain[]
    overlaps: { severity: string; title: string; actions: string[] }[]
  }
  efficiency: {
    available: boolean
    model_key?: string
    usd_per_run?: number
    usd_per_month?: number
    baseline_usd_per_run?: number
    baseline_usd_per_month?: number
    delta_pct?: number
    turns: number
    tool_calls: number
    runs_per_day: number | null
  }
}

export interface AgentTryRun {
  mode: AgentTryMode
  basis: "measured"
  agent: { id: string; name: string; model: string }
  simulation_id: string
  status: string
  error: string | null
  blast_radius: {
    risk_score: number
    actions: AgentTryAction[]
    executed: number
    blocked: number
    pending: number
    chains: AgentTryChain[]
    violations: { title: string; severity: string }[]
    summary: string
  }
  efficiency: {
    model_key: string
    turns: number
    max_turns: number
    tool_calls: number
    input_tokens: number
    output_tokens: number
    latency_ms: number
    latency_ms_per_turn: number | null
    usd_per_run: number
    usd_per_month: number | null
    runs_per_day: number | null
  }
  key_source: "server" | "org"
}

export interface MyAgent { id: string; name: string }

export const listMyAgents = () =>
  apiFetch<{ agents: MyAgent[] }>("/api/authority/agents").then((r) => r.agents.map((a) => ({ id: a.id, name: a.name })))

export const estimateAgentTry = (promptId: string, req: AgentTryRequest) =>
  apiFetch<AgentTryEstimate>(`/api/prompts/${encodeURIComponent(promptId)}/agent-try/estimate`, {
    method: "POST", body: JSON.stringify(req),
  })

export const runAgentTry = (promptId: string, req: AgentTryRequest) =>
  apiFetch<AgentTryRun>(`/api/prompts/${encodeURIComponent(promptId)}/agent-try/run`, {
    method: "POST", body: JSON.stringify(req), timeoutMs: 300_000,
  })
