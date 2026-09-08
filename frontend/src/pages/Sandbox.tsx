import { useState, useEffect, useRef, useMemo } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import {
  ChevronRight, ChevronDown, X, AlertTriangle, Play, Cpu, Zap,
  Plus, RotateCcw, ArrowRight, Search, Check,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/components/shared/Toast'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { scoreToColor, timeAgo } from '@/lib/utils'
import { chainShortLabel } from '@/lib/chainLabels'
import NewSimulationModal, { CUSTOM_SCENARIO_ID, type RunPurpose } from '@/components/sandbox/NewSimulationModal'
import ScenarioLibrary from '@/components/sandbox/ScenarioLibrary'
import SimulationCanvas, { type CanvasRun } from '@/components/sandbox/SimulationCanvas'

// ─── Types ────────────────────────────────────────────────────────────────────

interface BlastRadius {
  score: number
}

// /api/authority/agents returns tools as plain service-name strings
// ("tools": [t["service"] for t in agent["tools"]]), not objects.
interface AgentListItem {
  id: string
  name: string
  tools: string[]
  blast_radius: BlastRadius
}

type ScenarioCategory = 'normal' | 'edge_case' | 'adversarial' | 'chain_exploit'
type ScenarioSeverity = 'critical' | 'high' | 'medium' | 'info'

interface Scenario {
  id: string
  name: string
  description: string
  category: ScenarioCategory
  severity: ScenarioSeverity
}

interface Violation {
  severity: ScenarioSeverity
  title: string
  description: string
}

interface ChainTriggered {
  severity: ScenarioSeverity
  chain_name: string
  description: string
  step_indices: number[]
}

interface Recommendation {
  message?: string
  actionable: boolean
  action_pattern?: string
  effect?: string
  reason?: string
}

interface TraceStep {
  tool: string
  action: string
  enforce_decision: 'ALLOW' | 'BLOCK' | 'REQUIRE_APPROVAL'
}

interface SimulationReport {
  risk_score: number
  total_steps: number
  actions_executed: number
  actions_blocked: number
  actions_pending: number
  violations: Violation[]
  chains_triggered: ChainTriggered[]
  recommendations: (Recommendation | string)[]
}

interface SimulationResult {
  simulation_id: string
  report: SimulationReport
  trace: { steps: TraceStep[] }
}

interface SimulationListItem {
  id: string
  agent_id: string
  scenario_id: string
  risk_score: number | null
  violations: number | null
  actions_blocked: number | null
  total_steps: number | null
  created_at: string
}


// ─── Constants ────────────────────────────────────────────────────────────────

// Past Runs pages through /api/sandbox/simulations; the backend caps limit at 500.
const SIM_PAGE_SIZE = 50

const CATEGORY_TOOLTIPS: Partial<Record<ScenarioCategory, string>> = {
  edge_case:
    'Unusual or edge situations the agent might hit, to test whether it still behaves safely.',
  adversarial:
    'Scenarios designed to trick or manipulate the agent into taking unauthorized or harmful actions.',
  chain_exploit:
    'Tests multi-step sequences where combining two actions raises the risk, such as reading customer data and then sending it outside your system.',
}

const SEVERITY_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  /* Filled, not tinted — critical must read differently from high at a glance. */
  critical: { bg: 'var(--critical)', color: '#fff', border: 'var(--critical)' },
  high:     { bg: 'var(--high-bg)', color: 'var(--high)', border: 'var(--high-line)' },
  medium:   { bg: 'var(--caution-bg)', color: 'var(--on-caution)', border: 'var(--caution-line)' },
  info:     { bg: 'var(--accent-soft)', color: 'var(--accent-ink)', border: 'var(--accent-line)' },
}

const CATEGORY_COLORS: Record<string, { bg: string; color: string }> = {
  normal:       { bg: 'var(--safe-bg)', color: 'var(--safe)' },
  edge_case:    { bg: 'var(--high-bg)', color: 'var(--high)' },
  adversarial:  { bg: 'var(--critical-bg)', color: 'var(--critical)' },
  chain_exploit:{ bg: '#f5f3ff', color: '#7c3aed' },
}

const CATEGORY_LABELS: Record<string, string> = {
  normal:       'Normal',
  edge_case:    'Edge Case',
  adversarial:  'Adversarial',
  chain_exploit:'Chain Exploit',
}

const CATEGORY_FILTERS = [
  { value: 'all',          label: 'All Categories' },
  { value: 'normal',       label: 'Normal' },
  { value: 'edge_case',    label: 'Edge Case' },
  { value: 'adversarial',  label: 'Adversarial' },
  { value: 'chain_exploit',label: 'Chain Exploit' },
]

/**
 * Policy-override switch. The canvas draws a 36×20 track with a 16px knob;
 * `disabled` renders the same shape for a state the sandbox does not let you
 * change, rather than a switch that silently does nothing.
 */
function Toggle({
  label, checked, onChange, disabled = false, hint,
}: {
  label: string
  checked: boolean
  onChange?: (v: boolean) => void
  disabled?: boolean
  hint?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3" title={hint}>
      <span className={`font-monospace-data text-monospace-data ${disabled ? 'text-neutral-muted' : 'text-on-surface'}`}>
        {label}
      </span>
      <label className={`relative inline-flex items-center shrink-0 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          className="sr-only peer"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.checked)}
        />
        <span
          className="w-9 h-5 rounded-full relative transition-colors"
          style={{ background: checked ? 'var(--accent)' : 'var(--surface-variant, #e2e2e9)', opacity: disabled ? 0.55 : 1 }}
        >
          <span
            className="absolute top-[2px] h-4 w-4 rounded-full border transition-all"
            style={{
              left: checked ? 18 : 2,
              background: 'var(--card)',
              borderColor: 'var(--line)',
            }}
          />
        </span>
      </label>
    </div>
  )
}

/** One pre-flight row: aquamarine tick when the condition holds, amber when not. */
function PreflightCheck({ ok, okLabel, failLabel }: { ok: boolean; okLabel: string; failLabel: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
        style={{ background: ok ? 'var(--aqua-soft)' : 'var(--caution-bg)' }}
      >
        {ok
          ? <Check size={14} strokeWidth={2.6} style={{ color: 'var(--aqua-deep)' }} />
          : <AlertTriangle size={13} strokeWidth={2.4} style={{ color: 'var(--amber-ink)' }} />}
      </span>
      <span className="font-monospace-data text-monospace-data text-on-surface">{ok ? okLabel : failLabel}</span>
    </div>
  )
}

const DECISION_STYLE: Record<string, { bg: string; color: string }> = {
  ALLOW:            { bg: 'var(--status-executed-bg)', color: 'var(--status-executed)' },
  BLOCK:            { bg: 'var(--status-blocked-bg)',  color: 'var(--status-blocked)' },
  REQUIRE_APPROVAL: { bg: 'var(--status-pending-bg)',  color: 'var(--on-caution)' },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const formatDesc = (desc: string): string => {
  const noJargon = desc
    .replace(/blast radius/gi, 'risk scope')
    .replace(/dry.?run/gi, 'simulation')
  const cleaned = noJargon.replace(/\.{2,}$/, '').replace(/…$/, '').trimEnd()
  const withServices = cleaned
    .replace(/\bstripe\b/gi, 'Stripe')
    .replace(/\bzendesk\b/gi, 'Zendesk')
    .replace(/\bsalesforce\b/gi, 'Salesforce')
    .replace(/\bsendgrid\b/gi, 'SendGrid')
    .replace(/\bgithub\b/gi, 'GitHub')
    .replace(/\bslack\b/gi, 'Slack')
    .replace(/\baws\b/gi, 'AWS')
    .replace(/\bhubspot\b/gi, 'HubSpot')
    .replace(/\bpagerduty\b/gi, 'PagerDuty')
  return withServices.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (match) =>
    match.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  )
}

// ─── Session persistence ──────────────────────────────────────────────────────
// React unmounts this page on navigation, wiping the in-progress setup (agent,
// scenario picks, queued prompts, active tab). Persist it for the browser
// session so tab-hopping doesn't read as "my work disappeared". Results
// themselves live server-side at /sandbox/:id — this only preserves setup.

const SANDBOX_STATE_KEY = 'arceo:sandbox-setup'

interface SavedSandboxState {
  agent?: string
  scenarioIds?: string[]
  categoryFilter?: string
  customPrompt?: string
  queuedCustomPrompts?: string[]
  tab?: 'run' | 'past' | 'library'
  runMode?: 'dry' | 'llm'
}

function loadSavedSandboxState(): SavedSandboxState {
  try {
    return JSON.parse(sessionStorage.getItem(SANDBOX_STATE_KEY) ?? '{}') as SavedSandboxState
  } catch {
    return {}
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Sandbox() {
  const [searchParams] = useSearchParams()
  const preselectedAgent = searchParams.get('agent')
  const calibrateParam = searchParams.get('purpose') === 'calibrate'
  // ?agents=a,b,c — the bulk calibration queued from the fleet spend page.
  const queuedAgentIds = (searchParams.get('agents') ?? '')
    .split(',').map((x) => x.trim()).filter(Boolean)
  const worstCase = searchParams.get('worst_case') === '1'
  const navigate = useNavigate()
  const [saved] = useState(loadSavedSandboxState)

  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [agents, setAgents] = useState<AgentListItem[]>([])
  const [simulations, setSimulations] = useState<SimulationListItem[]>([])
  const [simTotal, setSimTotal] = useState(0)
  const [loadingMoreSims, setLoadingMoreSims] = useState(false)
  const [simSearch, setSimSearch] = useState('')
  const [simSort, setSimSort] = useState('newest')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Selection state (scalars rehydrate from the saved session; agent/scenarios
  // restore async once their lists load, validated against what still exists)
  const [selectedScenarios, setSelectedScenarios] = useState<Scenario[]>([])
  const [selectedAgent, setSelectedAgent] = useState('')
  const [categoryFilter, setCategoryFilter] = useState(saved.categoryFilter ?? 'all')
  const [customPrompt, setCustomPrompt] = useState(saved.customPrompt ?? '')
  const [queuedCustomPrompts, setQueuedCustomPrompts] = useState<string[]>(saved.queuedCustomPrompts ?? [])
  const pendingScenarioIdsRef = useRef<string[] | null>(saved.scenarioIds?.length ? saved.scenarioIds : null)

  const [agentOpen, setAgentOpen] = useState(false)
  const agentSelectorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!agentOpen) return
    const handler = (e: MouseEvent) => {
      if (!agentSelectorRef.current?.contains(e.target as Node)) setAgentOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [agentOpen])

  // Simulation state
  const [running, setRunning] = useState(false)
  const [runProgress, setRunProgress] = useState<{ current: number; total: number } | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [lastRunMode, setLastRunMode] = useState('')
  const [sweeping, setSweeping] = useState(false)
  const [sandboxTab, setSandboxTab] = useState<'run' | 'past' | 'library'>(saved.tab ?? 'run')
  const [runMode, setRunMode] = useState<'dry' | 'llm'>(saved.runMode ?? 'dry')
  const [showAddAllConfirm, setShowAddAllConfirm] = useState(false)

  // "Configure Simulation" dialog (Sandbox header → New Simulation).
  const [lastRun, setLastRun] = useState<CanvasRun | null>(null)
  const [newSimOpen, setNewSimOpen] = useState(false)
  const [modalScenarioId, setModalScenarioId] = useState('')
  const [runPurpose, setRunPurpose] = useState<RunPurpose>('explore')
  // The forecast tier the calibrate path is trying to move, so the dialog can
  // say what this run will actually change. Null until the forecast lands.
  const [forecastConfidence, setForecastConfidence] = useState<'low' | 'medium' | 'high' | null>(null)
  const [strictMode, setStrictMode] = useState(true)
  const [debugLogging, setDebugLogging] = useState(false)

  useEffect(() => {
    Promise.all([
      apiFetch<{ agents: AgentListItem[] }>('/api/authority/agents'),
      apiFetch<{ simulations: SimulationListItem[]; total: number }>(
        `/api/sandbox/simulations?limit=${SIM_PAGE_SIZE}&offset=0`,
      ),
    ])
      .then(([agentData, simData]) => {
        setAgents(agentData.agents)
        setSimulations(simData.simulations)
        setSimTotal(simData.total)
        // URL intent beats the saved session beats the first agent.
        const defaultAgent =
          preselectedAgent && agentData.agents.find((a) => a.id === preselectedAgent)
            ? preselectedAgent
            : saved.agent && agentData.agents.find((a) => a.id === saved.agent)
              ? saved.agent
              : agentData.agents[0]?.id || ''
        setSelectedAgent(defaultAgent)
        // ?purpose=calibrate lands here from the agent's forecast page, so the
        // dialog opens already set to the run that page was asking for.
        if (calibrateParam && (defaultAgent || queuedAgentIds.length > 0)) {
          setRunPurpose('calibrate')
          setNewSimOpen(true)
        }
        setLoading(false)
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  // Normal-path scenarios only: the forecast wants the agent's TYPICAL turn
  // count and token usage, and an adversarial run that gets blocked on turn two
  // measures the policy, not the agent. Three runs, so turns_per_run averages
  // over more than one sample. Falls back to whatever exists for an agent whose
  // catalogue has no normal scenarios.
  const queuedAgents = useMemo(
    () => queuedAgentIds
      .map((id) => agents.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a)),
    [queuedAgentIds.join(','), agents],
  )

  const calibrationScenarios = useMemo(() => {
    const normal = scenarios.filter((sc) => sc.category === 'normal')
    return (normal.length > 0 ? normal : scenarios).slice(0, 3)
  }, [scenarios])

  // The tier the calibrate path is trying to move. Read from the same endpoint
  // the Cost portfolio reads, so the dialog and that page never disagree.
  useEffect(() => {
    if (!selectedAgent) { setForecastConfidence(null); return }
    let cancelled = false
    apiFetch<{ confidence?: 'low' | 'medium' | 'high' }>(
      `/api/agents/${selectedAgent}/spend-forecast`,
    )
      .then((d) => { if (!cancelled) setForecastConfidence(d?.confidence ?? null) })
      .catch(() => { if (!cancelled) setForecastConfidence(null) })
    return () => { cancelled = true }
  }, [selectedAgent])

  const loadMoreSims = () => {
    setLoadingMoreSims(true)
    apiFetch<{ simulations: SimulationListItem[]; total: number }>(
      `/api/sandbox/simulations?limit=${SIM_PAGE_SIZE}&offset=${simulations.length}`,
    )
      .then((d) => {
        // De-dupe: a run recorded since the first page shifts the offset window.
        setSimulations((prev) => {
          const seen = new Set(prev.map((s) => s.id))
          return [...prev, ...d.simulations.filter((s) => !seen.has(s.id))]
        })
        setSimTotal(d.total)
      })
      .catch((err: Error) => toast(err.message, 'error'))
      .finally(() => setLoadingMoreSims(false))
  }

  const [loadingScenarios, setLoadingScenarios] = useState(false)
  const [generatingScenarios, setGeneratingScenarios] = useState(false)

  // Claude-written scenarios tailored to this agent's tools + detected chains.
  const generateScenarios = async () => {
    if (!selectedAgent || generatingScenarios) return
    setGeneratingScenarios(true)
    try {
      const d = await apiFetch<{ scenarios: Scenario[] }>(
        `/api/sandbox/agent/${selectedAgent}/generate-scenarios`,
        { method: 'POST' },
      )
      const fresh = d.scenarios || []
      setScenarios((prev) => [...prev.filter((s) => !s.id.includes('-gen-')), ...fresh])
      toast(`Claude wrote ${fresh.length} scenario${fresh.length !== 1 ? 's' : ''} for this agent`)
    } catch (err: unknown) {
      // The server's detail is already a complete sentence and now carries a
      // correlation ref (MED-016) — prefixing it here printed the failure twice
      // and pushed the ref, the one thing worth quoting in a bug report, to the
      // end of a doubled message.
      toast(err instanceof Error ? err.message : 'Scenario generation failed', 'error')
    }
    setGeneratingScenarios(false)
  }
  useEffect(() => {
    if (!selectedAgent) {
      setScenarios([])
      return
    }
    setLoadingScenarios(true)
    setSelectedScenarios([])
    apiFetch<{ scenarios: Scenario[] }>(`/api/sandbox/agent/${selectedAgent}/scenarios`)
      .then((d) => {
        setScenarios(d.scenarios)
        // One-shot restore of the saved selection — only ids that still exist
        // for this agent survive (auto-scenario ids are agent-prefixed, so a
        // stale save for another agent simply matches nothing).
        const pendingIds = pendingScenarioIdsRef.current
        pendingScenarioIdsRef.current = null
        const restored = !worstCase && pendingIds
          ? d.scenarios.filter((s) => pendingIds.includes(s.id))
          : []
        if (restored.length > 0) {
          setSelectedScenarios(restored)
        } else if (worstCase && d.scenarios?.length > 0) {
          const adversarial = d.scenarios.filter(
            (s) => s.category === 'adversarial' || s.category === 'chain_exploit',
          )
          const toSelect = adversarial.length > 0 ? adversarial : [d.scenarios[d.scenarios.length - 1]]
          setSelectedScenarios(toSelect)
          // Keep the filter on 'all' — the selection spans adversarial AND
          // chain_exploit, and an 'adversarial' filter would hide the queued
          // chain-exploit scenarios.
          setCategoryFilter('all')
        } else if (d.scenarios?.length > 0) {
          const defaultScenario =
            d.scenarios.find((s) => s.name === 'Standard Lookup') ??
            d.scenarios.find((s) => s.category === 'normal') ??
            d.scenarios[0]
          setSelectedScenarios([defaultScenario])
        }
        setLoadingScenarios(false)
      })
      .catch(() => {
        setScenarios([])
        setLoadingScenarios(false)
      })
  }, [selectedAgent])

  // Persist the working setup for this browser session (best-effort).
  useEffect(() => {
    if (loading) return
    try {
      sessionStorage.setItem(SANDBOX_STATE_KEY, JSON.stringify({
        agent: selectedAgent,
        scenarioIds: selectedScenarios.map((s) => s.id),
        categoryFilter,
        customPrompt,
        queuedCustomPrompts,
        tab: sandboxTab,
        runMode,
      } satisfies SavedSandboxState))
    } catch {
      // Storage unavailable/full — persistence is a convenience, never an error.
    }
  }, [loading, selectedAgent, selectedScenarios, categoryFilter, customPrompt, queuedCustomPrompts, sandboxTab, runMode])

  const filteredScenarios = useMemo(() => {
    let result = [...scenarios]
    if (categoryFilter !== 'all') result = result.filter((s) => s.category === categoryFilter)
    return result
  }, [scenarios, categoryFilter])

  const toggleScenario = (s: Scenario) => {
    setSelectedScenarios((prev) => {
      const exists = prev.some((x) => x.id === s.id)
      return exists ? prev.filter((x) => x.id !== s.id) : [...prev, s]
    })
    setCustomPrompt('')
  }

  const addAllToQueue = () => {
    setSelectedScenarios((prev) => {
      const existing = new Set(prev.map((x) => x.id))
      const toAdd = filteredScenarios.filter((s) => !existing.has(s.id))
      return [...prev, ...toAdd]
    })
  }

  // Pull the newest recorded trace for the selected agent so the canvas can
  // show where that agent actually got stopped, and replay it step by step.
  useEffect(() => {
    const latest = simulations.find((x) => x.agent_id === selectedAgent)
    if (!latest) { setLastRun(null); return }
    let cancelled = false
    apiFetch<Record<string, unknown>>(`/api/sandbox/simulation/${latest.id}`)
      .then((raw) => {
        if (cancelled) return
        const trace = (raw.trace ?? {}) as Record<string, unknown>
        const rawSteps = (trace.steps ?? []) as Record<string, unknown>[]
        setLastRun({
          id: latest.id,
          scenario: formatDesc(latest.scenario_id),
          steps: rawSteps.map((st) => ({
            tool: String(st.tool ?? ''),
            action: String(st.action ?? ''),
            decision: String(st.enforce_decision ?? (st.allowed === false ? 'BLOCK' : 'ALLOW')),
          })),
        })
      })
      .catch(() => { if (!cancelled) setLastRun(null) })
    return () => { cancelled = true }
  }, [simulations, selectedAgent])

  const handleRun = async (
    dryRun = true,
    override?: { agentId?: string; agentIds?: string[]; scenarios?: Scenario[] },
  ) => {
    // `agentIds` is the bulk-calibration path: the same scenario list run once
    // per agent, so one queue produces one progress bar instead of N.
    const agentIds = override?.agentIds?.length
      ? override.agentIds
      : [override?.agentId ?? selectedAgent]
    const scenarioList = override?.scenarios ?? selectedScenarios
    const customList = override?.scenarios ? [] : queuedCustomPrompts
    if ((scenarioList.length === 0 && customList.length === 0) || !agentIds[0]) return
    setRunning(true)
    setRunError(null)
    setLastRunMode(dryRun ? 'dry-run' : 'llm')

    type RunItem = { agentId: string } & (
      | { type: 'scenario'; scenario: Scenario }
      | { type: 'custom'; prompt: string }
    )
    const toRun: RunItem[] = agentIds.flatMap((aid) => [
      ...scenarioList.map((s) => ({ agentId: aid, type: 'scenario' as const, scenario: s })),
      ...customList.map((p) => ({ agentId: aid, type: 'custom' as const, prompt: p })),
    ])
    if (toRun.length === 0) { setRunning(false); return }

    const completed: SimulationResult[] = []
    let failedCount = 0

    for (let i = 0; i < toRun.length; i++) {
      // current = how many are done; the bar reads 0% at start and 100% at end.
      setRunProgress({ current: i, total: toRun.length })
      try {
        const item = toRun[i]
        const body: Record<string, unknown> = { agent_id: item.agentId, dry_run: dryRun }
        if (item.type === 'scenario') {
          body.scenario_id = item.scenario.id
        } else {
          body.custom_prompt = item.prompt
          body.scenario_id = ''
        }
        const data = await apiFetch<SimulationResult>('/api/sandbox/simulate', {
          method: 'POST',
          body: JSON.stringify(body),
        })
        completed.push(data)
      } catch {
        failedCount++
      }
    }

    setRunProgress(null)

    if (completed.length > 0) {
      const lastData = completed[completed.length - 1]
      // Batch summary — the multi-scenario overview lives on the detail page now.
      if (toRun.length > 1) {
        toast(
          `${completed.length} of ${toRun.length} scenarios finished${failedCount > 0 ? ` (${failedCount} failed)` : ''}. Opening the latest.`,
          failedCount > 0 ? 'error' : 'success',
        )
      } else if (failedCount > 0) {
        toast("That scenario didn't run. Check the agent is set up correctly.", 'error')
      }
      setRunning(false)
      // A fleet-wide calibration ends where it was asked for: the spend page,
      // where the confidence tiers it just moved are on screen.
      if (agentIds.length > 1) {
        navigate('/spend')
        return
      }
      navigate(`/sandbox/${lastData.simulation_id}`)
    } else {
      setRunError(
        `All ${toRun.length} simulation${toRun.length > 1 ? 's' : ''} failed. Check the agent is set up correctly.`,
      )
      toast('All simulations failed', 'error')
      setRunning(false)
    }
  }

  const handleSweep = async (dryRun = true) => {
    if (!selectedAgent) return
    setSweeping(true)
    setRunError(null)
    try {
      const data = await apiFetch<{ total_scenarios: number; overall_risk_score: number; sweep_id: string }>(
        '/api/sandbox/sweep',
        {
          method: 'POST',
          body: JSON.stringify({ agent_id: selectedAgent, dry_run: dryRun }),
        },
      )
      toast(`Sweep finished. ${data.total_scenarios} scenarios, risk score ${Math.round(data.overall_risk_score)}.`)
      navigate(`/sweep/${data.sweep_id}`)
    } catch (err) {
      toast('Sweep failed: ' + (err as Error).message, 'error')
    }
    setSweeping(false)
  }

  // ─── Loading / error ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-500">
          <div className="w-6 h-6 border-2 border-gray-200 border-t-gray-700 rounded-full animate-spin" />
          <p className="text-sm">Loading sandbox...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
          <AlertTriangle size={32} className="text-red-500" />
          <h2 className="font-semibold text-gray-900">Failed to load sandbox</h2>
          <p className="text-sm text-gray-500">{error}</p>
          <Button onClick={() => window.location.reload()}>Retry</Button>
        </div>
      </div>
    )
  }

  const sel = agents.find((a) => a.id === selectedAgent)
  const queueCount = selectedScenarios.length + queuedCustomPrompts.length

  return (
    <div className="space-y-8" style={{ padding: '34px 40px 64px', maxWidth: 1140, margin: '0 auto', fontFamily: 'var(--font-sans)' }}>
      {/* ── Header ─────────────────────────────────────────────────── */}
      {sandboxTab !== 'library' && (
      <div className="flex flex-row items-end justify-between w-full">
        <div className="flex flex-col">
          <h1 className="font-page-title text-page-title text-on-surface m-0">Sandbox</h1>
          <p className="font-body text-body text-neutral-secondary mt-1 mb-0">
            Test agent behavior and policy enforcement in a safe, isolated environment.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSandboxTab(sandboxTab === 'run' ? 'past' : 'run')}
            className="font-monospace-label text-monospace-label px-4 py-2 rounded border border-neutral-border bg-surface-container-lowest text-neutral-secondary hover:text-on-surface transition-colors cursor-pointer"
          >
            {sandboxTab === 'run' ? `Past runs${simTotal > 0 ? ` (${simTotal})` : ''}` : 'Back to setup'}
          </button>
          <button
            type="button"
            onClick={() => {
              setSandboxTab('run')
              setRunError(null)
              setModalScenarioId(selectedScenarios[0]?.id ?? scenarios[0]?.id ?? '')
              setNewSimOpen(true)
            }}
            className="btn btn--primary"
          >
            <Plus size={16} strokeWidth={2.2} />
            New Simulation
          </button>
        </div>
      </div>
      )}

      {sandboxTab === 'library' && (
        <ScenarioLibrary
          scenarios={scenarios.map((sc) => ({
            id: sc.id,
            name: sc.name,
            description: formatDesc(sc.description),
            category: sc.category,
            severity: sc.severity,
          }))}
          selectedIds={selectedScenarios.map((sc) => sc.id)}
          onToggle={(id) => {
            const sc = scenarios.find((x) => x.id === id)
            if (sc) toggleScenario(sc)
          }}
          customPrompt={customPrompt}
          onCustomPromptChange={setCustomPrompt}
          onGenerate={generateScenarios}
          generating={generatingScenarios}
          requestPreview={JSON.stringify(
            {
              agent_id: selectedAgent,
              dry_run: runMode === 'dry',
              scenario_id: selectedScenarios[0]?.id ?? '',
              ...(customPrompt.trim() ? { custom_prompt: customPrompt.trim() } : {}),
            },
            null,
            2,
          )}
          onCancel={() => setSandboxTab('run')}
          onApply={() => {
            if (customPrompt.trim()) {
              setQueuedCustomPrompts((prev) => [...prev, customPrompt.trim()])
              setCustomPrompt('')
            }
            setSandboxTab('run')
          }}
        />
      )}

      {sandboxTab === 'run' && (
      <div className="flex flex-col lg:flex-row gap-stack-gap items-start">

        {/* ── Left: configuration ──────────────────────────────────── */}
        <div
          id="run-section"
          className="w-full lg:w-80 shrink-0 flex flex-col gap-stack-gap bg-surface-container-lowest rounded-lg p-container-padding"
        >
          {/* Agent selection */}
          <div className="flex flex-col gap-2" ref={agentSelectorRef}>
            <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase">Agent selection</span>
            {agents.length === 0 ? (
              <div className="text-body text-neutral-secondary">
                No agents yet. <a href="/" className="text-on-surface underline">Create one</a> to get started.
              </div>
            ) : (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setAgentOpen((v) => !v)}
                  className="w-full bg-surface border border-neutral-border text-on-surface font-body text-body px-3 py-2.5 rounded shadow-sm flex items-center justify-between hover:bg-surface-container-low transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: scoreToColor(sel?.blast_radius?.score ?? 0) }}
                    />
                    <span className="truncate">{sel?.name ?? 'Select an agent'}</span>
                  </div>
                  <ChevronDown size={18} className="text-neutral-muted shrink-0" />
                </button>
                {agentOpen && (
                  <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-surface-container-lowest rounded-lg overflow-hidden max-h-72 overflow-y-auto">
                    {agents.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => { setSelectedAgent(a.id); setAgentOpen(false) }}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left bg-transparent border-0 cursor-pointer hover:bg-surface-container-low transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ background: scoreToColor(a.blast_radius?.score ?? 0) }}
                          />
                          <span className="font-body text-body text-on-surface truncate">{a.name}</span>
                        </div>
                        <span
                          className="font-monospace-label text-monospace-label shrink-0"
                          style={{ color: scoreToColor(a.blast_radius?.score ?? 0) }}
                        >
                          {a.blast_radius?.score ?? 0}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="h-px w-full bg-neutral-border" />

          {/* Scenario template */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase">Scenario template</span>
              {filteredScenarios.length > 0 && (
                <button
                  type="button"
                  onClick={() => { if (runMode === 'llm') { setShowAddAllConfirm(true) } else { addAllToQueue() } }}
                  className="font-meta text-meta text-neutral-secondary hover:text-on-surface bg-transparent border-0 p-0 cursor-pointer underline underline-offset-2"
                >
                  Queue all {filteredScenarios.length}
                </button>
              )}
            </div>

            {/* Category filter + Claude-generated scenarios */}
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={generateScenarios}
                disabled={!selectedAgent || generatingScenarios}
                className="font-meta text-meta px-2 py-1 rounded border border-neutral-border bg-surface text-neutral-secondary hover:text-on-surface transition-colors cursor-pointer disabled:opacity-50"
              >
                {generatingScenarios ? 'Generating…' : 'Generate with Claude'}
              </button>
              {CATEGORY_FILTERS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCategoryFilter(c.value)}
                  className={`font-meta text-meta px-2 py-1 rounded border transition-colors cursor-pointer ${
                    categoryFilter === c.value
                      ? 'bg-primary-container text-on-primary-container border-transparent'
                      : 'bg-surface text-neutral-secondary border-neutral-border hover:text-on-surface'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-2 max-h-[420px] overflow-y-auto -mr-2 pr-2">
              {filteredScenarios.length === 0 && (
                <p className="font-meta text-meta text-neutral-muted m-0">No scenarios in this category.</p>
              )}
              {filteredScenarios.map((sc) => {
                const isSelected = selectedScenarios.some((x) => x.id === sc.id)
                return (
                  <label
                    key={sc.id}
                    className="cursor-pointer relative flex items-start p-3 bg-surface hover:bg-surface-container-low rounded-lg transition-colors border border-neutral-border"
                  >
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      checked={isSelected}
                      onChange={() => toggleScenario(sc)}
                    />
                    {/* Ring fills when queued — the canvas control, kept as a
                        checkbox so batch runs still work. */}
                    <span
                      className="w-4 h-4 mt-0.5 rounded-full flex items-center justify-center shrink-0 mr-3 transition-all"
                      style={{
                        boxShadow: isSelected
                          ? '0 0 0 4px var(--accent) inset'
                          : '0 0 0 1px var(--line) inset',
                      }}
                    />
                    <span className="flex flex-col min-w-0">
                      <span className="font-monospace-data text-monospace-data text-on-surface">{sc.name}</span>
                      <span className="font-meta text-meta text-neutral-secondary mt-1">
                        {formatDesc(sc.description)}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

          <div className="h-px w-full bg-neutral-border" />

          {/* Custom scenario */}
          <div className="flex flex-col gap-2">
            <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase">Custom scenario</span>
            <textarea
              id="sandbox-custom-scenario"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="e.g. 'A customer wants a refund for a $200 charge they don't recognize'"
              rows={3}
              className="w-full bg-surface border border-neutral-border rounded font-body text-body text-on-surface p-3 resize-y focus:outline-none focus:border-primary"
            />
            {customPrompt.trim() && (
              <button
                type="button"
                onClick={() => { setQueuedCustomPrompts((prev) => [...prev, customPrompt.trim()]); setCustomPrompt('') }}
                className="self-start font-meta text-meta text-neutral-secondary hover:text-on-surface bg-transparent border-0 p-0 cursor-pointer underline underline-offset-2"
              >
                Add to queue
              </button>
            )}
            {queuedCustomPrompts.length > 0 && (
              <div className="flex flex-col gap-1">
                {queuedCustomPrompts.map((q, qi) => (
                  <div key={qi} className="flex items-start gap-2 font-meta text-meta text-neutral-secondary">
                    <span className="truncate flex-1">{q}</span>
                    <button
                      type="button"
                      aria-label="Remove queued prompt"
                      onClick={() => setQueuedCustomPrompts((prev) => prev.filter((_, k) => k !== qi))}
                      className="bg-transparent border-0 p-0 cursor-pointer text-neutral-muted hover:text-on-surface"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="h-px w-full bg-neutral-border" />

          {/* Policy override */}
          <div className="flex flex-col gap-3">
            <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase">Policy override</span>
            <div className="flex flex-col gap-3">
              {/* Sandbox always enforces the agent's policies — the executor has
                  no bypass — so this reads its true state rather than offering a
                  switch that would do nothing. */}
              <Toggle label="Strict mode" checked disabled hint="Policy enforcement is always on in the sandbox." />
              <Toggle
                label="Mock external APIs"
                checked={runMode === 'dry'}
                onChange={(v) => setRunMode(v ? 'dry' : 'llm')}
                hint="Runs against mock services and skips the live model."
              />
              <Toggle
                label="Allow side effects"
                checked={runMode === 'llm'}
                onChange={(v) => setRunMode(v ? 'llm' : 'dry')}
                hint="Runs the agent's real model loop. Tool calls still hit mocks."
              />
            </div>
          </div>
        </div>

        {/* ── Right: canvas + pre-flight ───────────────────────────── */}
        <div className="flex flex-col flex-1 gap-stack-gap min-w-0 w-full">
          <div className="relative bg-surface-container-lowest rounded-lg p-container-padding flex flex-col overflow-hidden" style={{ minHeight: 520 }}>
            <div className="flex items-center justify-between mb-4 z-10 relative">
              <span className="font-card-title text-card-title text-on-surface">Simulation canvas</span>
              <span className="font-monospace-label text-monospace-label text-neutral-muted">
                {sel ? `${sel.tools?.filter(Boolean).length ?? 0} tools` : 'None'}
              </span>
            </div>

            <SimulationCanvas
              tools={(sel?.tools ?? []).filter(Boolean)}
              running={running}
              progress={runProgress}
              lastRun={lastRun}
            />

            {/* Run control */}
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full px-6 py-3 shadow-xl z-20 flex items-center gap-4 backdrop-blur-md"
                 style={{ background: 'rgba(30, 40, 54, 0.92)' }}>
              <span className="font-monospace-label text-monospace-label tracking-wider whitespace-nowrap" style={{ color: 'var(--surface-container-highest, #e2e2e9)' }}>
                {running
                  ? runProgress && runProgress.total > 1
                    ? `RUNNING ${Math.min(runProgress.current + 1, runProgress.total)}/${runProgress.total}`
                    : 'RUNNING'
                  : !selectedAgent
                    ? 'SELECT AN AGENT'
                    : queueCount === 0
                      ? 'SELECT A SCENARIO'
                      : 'READY FOR EXECUTION'}
              </span>
              <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.22)' }} />
              <button
                type="button"
                onClick={() => handleRun(runMode === 'dry')}
                disabled={running || sweeping || !selectedAgent || queueCount === 0}
                className="font-body font-semibold text-body flex items-center gap-1 uppercase tracking-wide whitespace-nowrap bg-transparent border-0 cursor-pointer transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ color: 'var(--aqua)' }}
              >
                <Play size={16} strokeWidth={2.4} />
                Run simulation
              </button>
            </div>

            {runError && (
              <div className="absolute top-16 left-6 right-6 z-20 flex items-center gap-2 rounded-lg px-3 py-2 font-meta text-meta"
                   style={{ background: 'var(--critical-bg)', border: '1px solid var(--critical-line)', color: 'var(--critical)' }}>
                <AlertTriangle size={14} className="flex-shrink-0" />
                <span><strong>Simulation failed:</strong> {runError}</span>
              </div>
            )}
          </div>

          {/* Pre-flight checks */}
          <div className="bg-surface-container-lowest rounded-lg p-container-padding shrink-0 flex flex-col sm:flex-row sm:items-center gap-6">
            <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase sm:min-w-[120px]">Pre-flight checks</span>
            <div className="flex-1 flex flex-wrap items-center gap-x-8 gap-y-4">
              <PreflightCheck
                ok={!!sel && (sel.tools?.filter(Boolean).length ?? 0) > 0}
                okLabel="Agent connectivity OK"
                failLabel="Agent has no tools"
              />
              <PreflightCheck ok okLabel="Sandbox isolation ACTIVE" failLabel="Sandbox isolation OFF" />
              <PreflightCheck ok okLabel="Audit logging ENABLED" failLabel="Audit logging OFF" />
            </div>
          </div>
        </div>
      </div>
      )}

      {sandboxTab === 'past' && (
      <section>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Past Runs</h2>
            <p className="text-sm text-gray-500 mt-1">
              {simulations.length < simTotal
                ? `Showing ${simulations.length} of ${simTotal} simulations`
                : `${simTotal} simulation${simTotal !== 1 ? 's' : ''} recorded`}
            </p>
          </div>
        </div>

          <div className="flex flex-wrap gap-2 mb-3">
            <div style={{ flex: 1, minWidth: 200 }}>
              <Input
                placeholder="Search by scenario or agent..."
                value={simSearch}
                onChange={(e) => setSimSearch(e.target.value)}
                icon={<Search size={13} />}
                style={{ height: 42 }}
              />
            </div>
            <select
              className="text-sm focus:outline-none"
              style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', padding: '0 16px', height: '42px', fontFamily: 'inherit', cursor: 'pointer' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'transparent' }}
              value={simSort}
              onChange={(e) => setSimSort(e.target.value)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="highest-risk">Highest risk</option>
              <option value="lowest-risk">Lowest risk</option>
              <option value="most-violations">Most violations</option>
            </select>
          </div>

          <div className="space-y-2">
            {[...simulations]
              .filter((sim) => {
                if (!simSearch.trim()) return true
                const q = simSearch.toLowerCase()
                const agentName = agents.find((a) => a.id === sim.agent_id)?.name || ''
                return sim.scenario_id?.toLowerCase().includes(q) || agentName.toLowerCase().includes(q)
              })
              .sort((a, b) => {
                if (simSort === 'oldest') return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
                if (simSort === 'highest-risk') return (b.risk_score ?? 0) - (a.risk_score ?? 0)
                if (simSort === 'lowest-risk') return (a.risk_score ?? 0) - (b.risk_score ?? 0)
                if (simSort === 'most-violations') return (b.violations ?? 0) - (a.violations ?? 0)
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
              })
              .map((sim) => {
                const score = sim.risk_score ?? 0
                const scoreColor = scoreToColor(score)
                const agentName =
                  agents.find((a) => a.id === sim.agent_id)?.name ||
                  sim.agent_id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
                const scenarioLabel =
                  sim.scenario_id
                    .replace(new RegExp('^' + sim.agent_id + '-?'), '')
                    .replace(/-/g, ' ')
                    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Custom Prompt'
                const isClean = !sim.violations && !sim.actions_blocked

                return (
                  <div
                    key={sim.id}
                    className="bg-white rounded-xl p-3 flex items-center gap-3"
                    style={{ borderLeftWidth: 3, borderLeftColor: scoreColor }}
                  >
                    <div className="flex flex-col items-center flex-shrink-0 w-10">
                      <span className="text-lg font-bold leading-none" style={{ color: scoreColor }}>
                        {score}
                      </span>
                      <span className="text-[9px] text-gray-400 uppercase font-semibold tracking-wide">Risk</span>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-semibold text-gray-900 truncate">{scenarioLabel}</span>
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {agentName} · {timeAgo(sim.created_at)}
                        {sim.total_steps ? ` · ${sim.total_steps} steps` : ''}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 flex-wrap flex-shrink-0">
                      {isClean ? (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-green-100 text-green-700">
                          Clean
                        </span>
                      ) : (
                        <>
                          {(sim.violations ?? 0) > 0 && (
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-red-100 text-red-700">
                              {sim.violations} violation{sim.violations !== 1 ? 's' : ''}
                            </span>
                          )}
                          {(sim.actions_blocked ?? 0) > 0 && (
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-orange-100 text-orange-700">
                              {sim.actions_blocked} blocked
                            </span>
                          )}
                        </>
                      )}
                    </div>

                    <Link
                      to={`/sandbox/${sim.id}`}
                      className="text-xs font-medium text-gray-500 hover:text-gray-900 flex-shrink-0"
                    >
                      View <ArrowRight size={11} className="inline" />
                    </Link>
                  </div>
                )
              })}
          </div>

          {simulations.length < simTotal && (
            <div className="flex flex-col items-center gap-1.5 mt-4">
              <Button variant="secondary" onClick={loadMoreSims} disabled={loadingMoreSims}>
                {loadingMoreSims ? 'Loading…' : `Load ${Math.min(SIM_PAGE_SIZE, simTotal - simulations.length)} more`}
              </Button>
              <p className="text-xs text-gray-400">
                Search and sort apply to the {simulations.length} runs loaded so far
              </p>
            </div>
          )}
        </section>
      )}

      <NewSimulationModal
        open={newSimOpen}
        onClose={() => setNewSimOpen(false)}
        agents={agents.map((a) => ({ id: a.id, name: a.name }))}
        agentId={selectedAgent}
        onAgentChange={setSelectedAgent}
        scenarios={scenarios.map((sc) => ({
          id: sc.id,
          name: sc.name,
          description: formatDesc(sc.description),
          category: sc.category,
          severity: sc.severity,
        }))}
        purpose={runPurpose}
        onPurposeChange={setRunPurpose}
        calibrationScenarios={calibrationScenarios.map((sc) => ({
          id: sc.id, name: sc.name, description: formatDesc(sc.description),
          category: sc.category, severity: sc.severity,
        }))}
        currentConfidence={forecastConfidence}
        queuedAgents={queuedAgents.map((a) => ({ id: a.id, name: a.name }))}
        scenarioId={modalScenarioId}
        onScenarioChange={setModalScenarioId}
        strictMode={strictMode}
        onStrictModeChange={setStrictMode}
        mockExternal={runMode === 'dry'}
        onMockExternalChange={(v) => setRunMode(v ? 'dry' : 'llm')}
        debugLogging={debugLogging}
        onDebugLoggingChange={setDebugLogging}
        creating={running}
        onCreate={() => {
          setNewSimOpen(false)
          if (runPurpose === 'calibrate') {
            if (calibrationScenarios.length === 0) return
            setSelectedScenarios(calibrationScenarios)
            setQueuedCustomPrompts([])
            // dryRun=false is not a default the user can override here: a dry
            // run writes no turn_usage, so it would leave the tier untouched.
            setRunMode('llm')
            void handleRun(false, {
              scenarios: calibrationScenarios,
              ...(queuedAgents.length > 1
                ? { agentIds: queuedAgents.map((a) => a.id) }
                : {}),
            })
            return
          }
          if (modalScenarioId === CUSTOM_SCENARIO_ID) {
            // The full catalogue and the free-text prompt both live in the
            // library view.
            setSandboxTab('library')
            return
          }
          const picked = scenarios.find((sc) => sc.id === modalScenarioId)
          if (!picked) return
          setSelectedScenarios([picked])
          setQueuedCustomPrompts([])
          void handleRun(runMode === 'dry', { scenarios: [picked] })
        }}
      />
    </div>
  )
}
