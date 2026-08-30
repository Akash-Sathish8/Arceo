import { useState, useEffect, useRef, useMemo } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import {
  ChevronRight, ChevronDown, X, AlertTriangle, Play, Cpu, Zap,
  Plus, RotateCcw, ArrowRight, Search,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/components/shared/Toast'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { scoreToColor, timeAgo } from '@/lib/utils'
import { chainShortLabel } from '@/lib/chainLabels'

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
    'Unusual or boundary situations the agent might encounter — tests whether it behaves safely in uncommon scenarios.',
  adversarial:
    'Scenarios designed to trick or manipulate the agent into taking unauthorized or harmful actions.',
  chain_exploit:
    'Tests multi-step sequences where combining two actions creates elevated risk — e.g. reading customer data then sending it outside your system.',
}

const SEVERITY_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  /* Filled, not tinted — critical must read differently from high at a glance. */
  critical: { bg: 'var(--critical)', color: '#fff', border: 'var(--critical)' },
  high:     { bg: 'var(--high-bg)', color: 'var(--high)', border: 'var(--high-line)' },
  medium:   { bg: 'var(--caution-bg)', color: 'var(--caution)', border: 'var(--caution-line)' },
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

const DECISION_STYLE: Record<string, { bg: string; color: string }> = {
  ALLOW:            { bg: 'var(--status-executed-bg)', color: 'var(--status-executed)' },
  BLOCK:            { bg: 'var(--status-blocked-bg)',  color: 'var(--status-blocked)' },
  REQUIRE_APPROVAL: { bg: 'var(--status-pending-bg)',  color: 'var(--status-pending)' },
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
  tab?: 'run' | 'past'
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
  const [sandboxTab, setSandboxTab] = useState<'run' | 'past'>(saved.tab ?? 'run')
  const [runMode, setRunMode] = useState<'dry' | 'llm'>(saved.runMode ?? 'dry')
  const [showAddAllConfirm, setShowAddAllConfirm] = useState(false)

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
        setLoading(false)
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

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

  const handleRun = async (dryRun = true) => {
    if ((selectedScenarios.length === 0 && queuedCustomPrompts.length === 0) || !selectedAgent) return
    setRunning(true)
    setRunError(null)
    setLastRunMode(dryRun ? 'dry-run' : 'llm')

    const toRun: ({ type: 'scenario'; scenario: Scenario } | { type: 'custom'; prompt: string })[] = [
      ...selectedScenarios.map((s) => ({ type: 'scenario' as const, scenario: s })),
      ...queuedCustomPrompts.map((p) => ({ type: 'custom' as const, prompt: p })),
    ]
    if (toRun.length === 0) { setRunning(false); return }

    const completed: SimulationResult[] = []
    let failedCount = 0

    for (let i = 0; i < toRun.length; i++) {
      // current = how many are done; the bar reads 0% at start and 100% at end.
      setRunProgress({ current: i, total: toRun.length })
      try {
        const body: Record<string, unknown> = { agent_id: selectedAgent, dry_run: dryRun }
        if (toRun[i].type === 'scenario') {
          body.scenario_id = (toRun[i] as { type: 'scenario'; scenario: Scenario }).scenario.id
        } else {
          body.custom_prompt = (toRun[i] as { type: 'custom'; prompt: string }).prompt
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
          `${completed.length} of ${toRun.length} scenarios completed${failedCount > 0 ? ` (${failedCount} failed)` : ''} — opening the latest`,
          failedCount > 0 ? 'error' : 'success',
        )
      } else if (failedCount > 0) {
        toast('Scenario failed — check the agent is configured correctly', 'error')
      }
      setRunning(false)
      navigate(`/sandbox/${lastData.simulation_id}`)
    } else {
      setRunError(
        `All ${toRun.length} simulation${toRun.length > 1 ? 's' : ''} failed — check the agent is configured correctly`,
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
      toast(`Full sweep complete — ${data.total_scenarios} scenarios, risk score ${Math.round(data.overall_risk_score)}`)
      navigate(`/sweep/${data.sweep_id}`)
    } catch (err) {
      toast('Sweep failed: ' + (err as Error).message, 'error')
    }
    setSweeping(false)
  }

  // ─── Loading / error ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: 'var(--page-pad)' }}>
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-500">
          <div className="w-6 h-6 border-2 border-gray-200 border-t-gray-700 rounded-full animate-spin" />
          <p className="text-sm">Loading sandbox…</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 'var(--page-pad)' }}>
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

  return (
    <div className="space-y-8" style={{ padding: 'var(--page-pad)', maxWidth: 1140, margin: '0 auto', fontFamily: 'var(--font-sans)' }}>
      {/* Page header */}
      <div>
        <h1 style={{ fontSize: 'var(--fs-page)', fontWeight: 600, color: 'var(--ink-900)', letterSpacing: -0.3, margin: 0 }}>Sandbox</h1>
        <p className="text-sm text-gray-500 mt-2" style={{ marginBottom: 0 }}>
          Test agents against mock APIs before they touch real systems.
        </p>
        <div className="flex mt-6" style={{ borderBottom: '1px solid var(--line)' }}>
          {([
            { id: 'run' as const, label: 'Run Simulation' },
            { id: 'past' as const, label: `Past Runs${simTotal > 0 ? ` (${simTotal})` : ''}` },
          ]).map((t) => (
            <button
              key={t.id}
              onClick={() => setSandboxTab(t.id)}
              style={{
                background: 'transparent',
                border: 'none',
                padding: '8px 16px 10px',
                fontSize: 13,
                fontWeight: sandboxTab === t.id ? 600 : 500,
                color: sandboxTab === t.id ? 'var(--accent)' : 'var(--ink-500)',
                borderBottom: sandboxTab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {sandboxTab === 'run' && (<>
      {simulations.length > 0 && (
        <button
          onClick={() => navigate(`/sandbox/${simulations[0].id}`)}
          className="w-full flex items-center justify-between gap-3 bg-white border border-gray-200 rounded-xl shadow-sm px-4 py-3 text-left transition-colors hover:bg-gray-50 cursor-pointer"
        >
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <RotateCcw size={14} style={{ color: 'var(--text-secondary)' }} className="flex-shrink-0" />
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Latest run</span>
            <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
              {formatDesc(simulations[0].scenario_id)}
            </span>
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {agents.find((a) => a.id === simulations[0].agent_id)?.name ?? simulations[0].agent_id} · {timeAgo(simulations[0].created_at)}
            </span>
          </div>
          <span className="flex items-center gap-1 text-xs font-medium flex-shrink-0" style={{ color: 'var(--text-primary)' }}>
            View results <ArrowRight size={12} />
          </span>
        </button>
      )}
      <section className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-6" id="run-section">
        {/* Agent selector + mode explainer row */}
        <div className="flex flex-wrap gap-4 items-start">
          {/* Agent picker */}
          <div className="flex-1 min-w-[200px]" ref={agentSelectorRef}>
            <p className="text-xs font-semibold text-gray-500 mb-1">Agent</p>
            {agents.length === 0 ? (
              <div className="text-sm text-gray-500">
                No agents yet —{' '}
                <a href="/" className="text-gray-900 underline">
                  create one
                </a>{' '}
                first
              </div>
            ) : (
              <div className="relative">
                <button
                  className="w-full flex items-center justify-between gap-3 text-sm hover:border-gray-400 transition-colors"
                  style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-md)', padding: '0 16px', height: '42px', fontFamily: 'inherit', cursor: 'pointer' }}
                  onClick={() => setAgentOpen((v) => !v)}
                >
                  {sel ? (
                    <>
                      <div className="text-left min-w-0">
                        <div className="font-semibold text-gray-900 truncate">{sel.name}</div>
                        {(sel.tools?.length ?? 0) > 0 && (
                          <div className="text-[11px] text-gray-400 truncate">
                            {sel.tools.filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <div className="text-right">
                          <div className="text-[10px] text-gray-400 font-semibold">Risk Score</div>
                          <div className="text-sm font-bold" style={{ color: scoreToColor(sel.blast_radius?.score ?? 0) }}>
                            {sel.blast_radius?.score ?? 0}
                          </div>
                        </div>
                        {agentOpen ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                      </div>
                    </>
                  ) : (
                    <span className="text-gray-400">Select an agent…</span>
                  )}
                </button>
                {agentOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-30 overflow-hidden">
                    {agents.map((a) => {
                      const sc = a.blast_radius?.score ?? 0
                      const c = scoreToColor(sc)
                      return (
                        <button
                          key={a.id}
                          className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-sm text-left transition-colors border-b border-gray-100 last:border-0 ${a.id === selectedAgent ? 'bg-gray-100' : 'hover:bg-gray-50'}`}
                          onClick={() => { setSelectedAgent(a.id); setAgentOpen(false) }}
                        >
                          <div className="min-w-0">
                            <div className="font-semibold text-gray-900 truncate">{a.name}</div>
                            {(a.tools?.length ?? 0) > 0 && (
                              <div className="text-[11px] text-gray-400 truncate">
                                {a.tools.filter(Boolean).join(' · ')}
                              </div>
                            )}
                          </div>
                          <div className="text-right flex-shrink-0">
                            <div className="text-sm font-bold" style={{ color: c }}>{sc}</div>
                            <div className="text-[10px] text-gray-400 uppercase font-semibold tracking-wide">Risk</div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

        </div>

        {/* Run buttons */}
        <div className="flex flex-wrap gap-2">
          <button
            className="inline-flex items-center gap-1.5 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{ background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '9px 20px', fontFamily: 'inherit', cursor: 'pointer' }}
            onClick={() => { setRunMode('dry'); handleRun(true) }}
            disabled={(selectedScenarios.length === 0 && queuedCustomPrompts.length === 0) || !selectedAgent || running || sweeping}
            title="Mocked APIs · enforces policies · no LLM call — free"
          >
            <Play size={13} />
            {running && lastRunMode === 'dry-run'
              ? runProgress && runProgress.total > 1
                ? `Running ${runProgress.current} of ${runProgress.total}…`
                : 'Running…'
              : selectedScenarios.length > 1
              ? `Test (mock APIs) · ${selectedScenarios.length}`
              : 'Test (mock APIs)'}
          </button>

          <button
            className="inline-flex items-center gap-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '8px 16px', fontFamily: 'inherit', cursor: 'pointer' }}
            onClick={() => { setRunMode('llm'); handleRun(false) }}
            disabled={(selectedScenarios.length === 0 && queuedCustomPrompts.length === 0) || !selectedAgent || running || sweeping}
            title="Mocked APIs · enforces policies · uses a real LLM — about $0.05 per run"
          >
            <Cpu size={13} />
            {running && lastRunMode === 'llm'
              ? runProgress && runProgress.total > 1
                ? `Running ${runProgress.current} of ${runProgress.total}…`
                : 'Running…'
              : selectedScenarios.length > 1
              ? `Test (real LLM) · ${selectedScenarios.length}`
              : 'Test (real LLM)'}
          </button>

          <button
            className="inline-flex items-center gap-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '8px 16px', fontFamily: 'inherit', cursor: 'pointer' }}
            onClick={() => handleSweep(true)}
            disabled={!selectedAgent || running || sweeping}
            title="Run every scenario against mock APIs — free, takes 30–60 seconds"
          >
            <Zap size={13} />
            {sweeping ? 'Sweeping… (30–60 seconds)' : 'Sweep all scenarios'}
          </button>
        </div>

        {/* Custom prompt input */}
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-1.5">Or describe your own scenario</p>
          <textarea
            className="w-full text-sm resize-none focus:outline-none placeholder-gray-400"
            style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', padding: '10px 16px', fontFamily: 'inherit' }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)' }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'transparent' }}
            value={customPrompt}
            onChange={(e) => { setCustomPrompt(e.target.value); if (e.target.value.trim()) setSelectedScenarios([]) }}
            placeholder="e.g. 'A customer wants a refund for a $200 charge they don't recognize'"
            rows={2}
          />
          {customPrompt.trim() && (
            <div className="mt-1">
              <Button
                variant="ghost"
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => {
                  setQueuedCustomPrompts((prev) => [...prev, customPrompt.trim()])
                  setCustomPrompt('')
                }}
              >
                Add to queue
              </Button>
            </div>
          )}
        </div>

        {/* Progress bar */}
        {running && (
          <div>
            {runProgress && runProgress.total > 1 ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>
                    Running scenario <strong>{Math.min(runProgress.current + 1, runProgress.total)}</strong> of{' '}
                    <strong>{runProgress.total}</strong>
                  </span>
                  <span>{Math.round((runProgress.current / runProgress.total) * 100)}%</span>
                </div>
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-[width]"
                    style={{ background: 'var(--color-cta)', width: `${(runProgress.current / runProgress.total) * 100}%` }}
                  />
                </div>
                <p className="text-xs text-gray-400">Enforcing policies · calling mock APIs · capturing trace</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full rounded-full w-1/3 animate-pulse" style={{ background: 'var(--color-cta)' }} />
                </div>
                <p className="text-xs text-gray-400">Enforcing policies · calling mock APIs · capturing trace</p>
              </div>
            )}
          </div>
        )}

        {/* Run error */}
        {runError && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
            <AlertTriangle size={14} className="flex-shrink-0" />
            <span><strong>Simulation failed:</strong> {runError}</span>
          </div>
        )}
      </section>

      {/* Scenario picker */}
      {selectedAgent && (
        <section>
          {/* Queue bar */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-3 mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 flex-shrink-0">
              {selectedScenarios.length + queuedCustomPrompts.length} queued
            </span>
            <div className="flex-1 flex flex-wrap items-center gap-1.5 min-w-0">
              {selectedScenarios.length === 0 && queuedCustomPrompts.length === 0 && (
                <span className="text-xs text-gray-400 italic">
                  Click scenarios below to queue them
                </span>
              )}
              {selectedScenarios.map((s) => {
                const cat = CATEGORY_COLORS[s.category] ?? CATEGORY_COLORS.normal
                return (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border border-gray-200 bg-gray-50 text-gray-700"
                  >
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: cat.color }} />
                    {s.name}
                    <button
                      className="ml-0.5 text-gray-400 hover:text-gray-700"
                      onClick={() => toggleScenario(s)}
                      title="Remove"
                    >
                      <X size={11} />
                    </button>
                  </span>
                )
              })}
              {queuedCustomPrompts.map((_p, i) => (
                <span
                  key={`custom-${i}`}
                  className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700"
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0 bg-blue-500" />
                  Custom prompt {queuedCustomPrompts.length > 1 ? i + 1 : ''}
                  <button
                    className="ml-0.5 text-blue-400 hover:text-blue-700"
                    onClick={() => setQueuedCustomPrompts((prev) => prev.filter((_, j) => j !== i))}
                    title="Remove"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
            {(selectedScenarios.length > 0 || queuedCustomPrompts.length > 0) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setSelectedScenarios([]); setQueuedCustomPrompts([]) }}
              >
                Clear all
              </Button>
            )}
          </div>

          {/* Section header */}
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Pick a scenario</h2>
              <p className="text-xs text-gray-400">Click to add to queue — select multiple to batch run</p>
            </div>
            {filteredScenarios.length > 0 && (
              showAddAllConfirm ? (
                <div className="flex items-center gap-2 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                  <span className="text-amber-800">Running all {filteredScenarios.length} with LLM will cost ~${(filteredScenarios.length * 0.05).toFixed(2)} and take several minutes.</span>
                  <button
                    className="font-semibold text-amber-900 hover:text-red-700 transition-colors"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    onClick={() => { setShowAddAllConfirm(false); addAllToQueue() }}
                  >
                    Continue
                  </button>
                  <span className="text-amber-400">·</span>
                  <button
                    className="text-amber-700 hover:text-amber-900 transition-colors"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    onClick={() => setShowAddAllConfirm(false)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Plus size={12} />}
                  onClick={() => {
                    if (runMode === 'llm') { setShowAddAllConfirm(true) } else { addAllToQueue() }
                  }}
                >
                  Add all {filteredScenarios.length} to queue
                </Button>
              )
            )}
          </div>

          {/* Category filter pills */}
          <div className="flex flex-wrap items-center gap-1.5 mb-4">
            <button
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1 font-medium transition-colors"
              style={{
                background: 'var(--accent-soft)',
                color: 'var(--accent-ink)',
                border: '1px solid var(--accent-line)',
                borderRadius: 'var(--radius-full)',
                fontFamily: 'inherit',
                cursor: generatingScenarios || !selectedAgent ? 'wait' : 'pointer',
                opacity: generatingScenarios ? 0.6 : 1,
              }}
              disabled={generatingScenarios || !selectedAgent}
              onClick={generateScenarios}
            >
              {generatingScenarios ? 'Claude is writing scenarios…' : 'Generate with Claude'}
            </button>
            {CATEGORY_FILTERS.map((f) => {
              const count = f.value === 'all' ? scenarios.length : scenarios.filter((s) => s.category === f.value).length
              if (f.value !== 'all' && count === 0) return null
              return (
                <button
                  key={f.value}
                  className="inline-flex items-center gap-1 text-xs px-3 py-1 font-medium transition-colors"
                  style={categoryFilter === f.value
                    ? { background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', fontFamily: 'inherit', cursor: 'pointer' }
                    : { background: 'var(--bg-sunken)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-full)', border: 'none', fontFamily: 'inherit', cursor: 'pointer' }}
                  onClick={() => setCategoryFilter(f.value)}
                  title={CATEGORY_TOOLTIPS[f.value as ScenarioCategory]}
                >
                  {f.label}
                  <span className={`text-[10px] ${categoryFilter === f.value ? 'opacity-70' : 'text-gray-400'}`}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Scenario grid */}
          {loadingScenarios ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5" aria-busy="true" aria-label="Loading scenarios">
              {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton" style={{ height: 120 }} />)}
            </div>
          ) : filteredScenarios.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-sm text-gray-400">
              No scenarios available for this agent.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredScenarios.map((s) => {
                const cat = CATEGORY_COLORS[s.category] ?? CATEGORY_COLORS.normal
                const sev = SEVERITY_COLORS[s.severity] ?? SEVERITY_COLORS.info
                const isSelected = selectedScenarios.some((x) => x.id === s.id)

                return (
                  <div
                    key={s.id}
                    className={`bg-white border border-gray-200 rounded-xl shadow-sm p-5 cursor-pointer hover:border-gray-300 hover:shadow-md transition-[border-color,box-shadow] ${
                      isSelected ? 'ring-2 ring-gray-900 ring-offset-1' : ''
                    }`}
                    onClick={() => toggleScenario(s)}
                  >
                    <div className="flex flex-wrap items-center gap-1.5 mb-2">
                      <span
                        className="text-[10px] font-semibold px-2 py-0.5 rounded"
                        style={{ background: cat.bg, color: cat.color }}
                      >
                        {CATEGORY_LABELS[s.category] || s.category}
                      </span>
                      {s.severity !== 'info' && (
                        <span
                          className="text-[10px] font-semibold px-2 py-0.5 rounded capitalize"
                          style={{ background: sev.bg, color: sev.color }}
                        >
                          {s.severity}
                        </span>
                      )}
                      {isSelected && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-gray-900 text-white ml-auto">
                          Queued
                        </span>
                      )}
                    </div>
                    <h3 className="text-sm font-semibold text-gray-900 mb-1">{s.name}</h3>
                    <p className="text-xs text-gray-500 leading-relaxed">{formatDesc(s.description)}</p>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}


      </>)}

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
                placeholder="Search by scenario or agent…"
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
                    className="bg-white border border-gray-200 rounded-xl shadow-sm p-3 flex items-center gap-3"
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

    </div>
  )
}
