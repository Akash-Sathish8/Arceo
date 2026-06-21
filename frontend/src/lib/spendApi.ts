/**
 * Spend forecast API client.
 *
 * Maps to /api/agents/{id}/spend-forecast and /api/agents/spend-forecasts.
 * Response shape matches the MockSpend interface — frontend can use either.
 */

import { apiFetch } from "@/lib/api"
import type { MockSpend } from "@/lib/mockSpend"

export interface SpendOverrides {
  calls_per_day?: number     // legacy alias = runs/day
  runs_per_day?: number
  turns_per_run?: number
  runtime?: number
  model?: string
  cache_hit?: number
  retry_rate?: number
}

/** Declare expected volume/turns/model so the forecast leaves the "unavailable" state. */
export async function setForecastInputs(
  agentId: string,
  body: { expected_calls_per_day?: number; expected_turns_per_run?: number; simulation_model?: string },
): Promise<boolean> {
  try {
    await apiFetch(`/api/authority/agent/${agentId}/forecast-inputs`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    return true
  } catch {
    return false
  }
}

/** Run a full sandbox sweep — measures real token + turn usage across every
 * scenario and lifts the forecast to the medium-confidence tier. Synchronous
 * and slow (real LLM calls): expect ~30s–2min. */
export async function runSweep(agentId: string): Promise<boolean> {
  try {
    await apiFetch(`/api/sandbox/sweep`, {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId }),
    })
    return true
  } catch {
    return false
  }
}

export async function fetchSpendForecast(
  agentId: string,
  overrides?: SpendOverrides,
): Promise<MockSpend | null> {
  const params = new URLSearchParams()
  if (overrides?.calls_per_day !== undefined) params.set("calls_per_day", String(overrides.calls_per_day))
  if (overrides?.runs_per_day !== undefined) params.set("runs_per_day", String(overrides.runs_per_day))
  if (overrides?.turns_per_run !== undefined) params.set("turns_per_run", String(overrides.turns_per_run))
  if (overrides?.runtime !== undefined) params.set("runtime", String(overrides.runtime))
  if (overrides?.model) params.set("model", overrides.model)
  if (overrides?.cache_hit !== undefined) params.set("cache_hit", String(overrides.cache_hit))
  if (overrides?.retry_rate !== undefined) params.set("retry_rate", String(overrides.retry_rate))
  const qs = params.toString() ? `?${params.toString()}` : ""
  try {
    return await apiFetch<MockSpend>(`/api/agents/${agentId}/spend-forecast${qs}`)
  } catch {
    return null
  }
}

export interface SpendTimeseriesPoint {
  date: string
  usd: number
  calls: number
}

export interface SpendTimeseries {
  timeseries: SpendTimeseriesPoint[]
  hasData: boolean
  totalCalls: number
  projection: { dailyPoint: number; dailyLow: number; dailyHigh: number; days: number }
}

export async function fetchSpendTimeseries(agentId: string): Promise<SpendTimeseries | null> {
  try {
    return await apiFetch<SpendTimeseries>(`/api/agents/${agentId}/spend-timeseries`)
  } catch {
    return null
  }
}

export interface BudgetRecommendation {
  lever: "model" | "cache" | "volume" | "gate"
  label: string
  projectedSaving: number
  newPoint: number
  tradeoff: string
  riskReductionUsd?: number
}

export interface BudgetFit {
  budget: number
  forecastPoint: number
  gap: number
  status: "under" | "over"
  currentModel: string
  recommendations: BudgetRecommendation[]
}

export async function fetchBudgetFit(agentId: string, budget: number): Promise<BudgetFit | null> {
  try {
    return await apiFetch<BudgetFit>(`/api/agents/${agentId}/budget-fit?budget=${budget}`)
  } catch {
    return null
  }
}

export interface SavedBudget {
  budget: number | null
  alertThresholdPct: number | null
  monthToDateUsd: number
  pctUsed: number | null
}

export async function fetchSavedBudget(agentId: string): Promise<SavedBudget | null> {
  try {
    return await apiFetch<SavedBudget>(`/api/agents/${agentId}/budget`)
  } catch {
    return null
  }
}

export async function saveBudget(agentId: string, budget: number, alertThresholdPct = 80): Promise<boolean> {
  try {
    await apiFetch(`/api/agents/${agentId}/budget`, {
      method: "PUT",
      body: JSON.stringify({ monthly_budget_usd: budget, alert_threshold_pct: alertThresholdPct }),
    })
    return true
  } catch {
    return false
  }
}

/** Apply a budget-fit "gate" recommendation by creating the REQUIRE_APPROVAL
 * policy for that action. action_pattern is the rec's "tool.action". */
export async function applyGatePolicy(agentId: string, actionPattern: string): Promise<boolean> {
  try {
    await apiFetch(`/api/authority/agent/${agentId}/policies`, {
      method: "POST",
      body: JSON.stringify({
        action_pattern: actionPattern,
        effect: "REQUIRE_APPROVAL",
        reason: "Applied from budget-fit recommendation",
      }),
    })
    return true
  } catch {
    return false
  }
}

export interface SpendAnomaly {
  agentId: string
  agentName: string
  ratio: number
  last24hUsd: number
  baselineDailyUsd: number
  last24hCalls: number
  drivers: string[]
}

export async function fetchSpendAnomalies(): Promise<SpendAnomaly[]> {
  try {
    const res = await apiFetch<{ anomalies: SpendAnomaly[]; checkedAgents: number }>(
      "/api/spend-anomalies",
    )
    return res.anomalies ?? []
  } catch {
    return []
  }
}

export async function fetchBatchSpendForecasts(): Promise<Record<string, MockSpend | null>> {
  try {
    const res = await apiFetch<{ forecasts: Record<string, MockSpend | null> }>(
      "/api/agents/spend-forecasts",
    )
    return res.forecasts ?? {}
  } catch {
    return {}
  }
}
