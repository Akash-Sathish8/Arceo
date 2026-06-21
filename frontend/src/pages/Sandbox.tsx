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
import Tooltip from '@/components/shared/Tooltip'

// ─── Types ────────────────────────────────────────────────────────────────────

interface BlastRadius {
  score: number
}

interface AgentTool {
  service?: string
  name?: string
}

interface AgentListItem {
  id: string
  name: string
  tools: AgentTool[]
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

interface QueueResult {
  scenario: Scenario | null
  data: SimulationResult
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_TOOLTIPS: Partial<Record<ScenarioCategory, string>> = {
  edge_case:
    'Unusual or boundary situations the agent might encounter — tests whether it behaves safely in uncommon scenarios.',
  adversarial:
    'Scenarios designed to trick or manipulate the agent into taking unauthorized or harmful actions.',
  chain_exploit:
    'Tests multi-step sequences where combining two actions creates elevated risk — e.g. reading customer data then sending it outside your system.',
}

const SEVERITY_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  critical: { bg: '#fef2f2', color: '#dc2626', border: '#fca5a5' },
  high:     { bg: '#fff7ed', color: '#ea580c', border: '#fdba74' },
  medium:   { bg: '#fefce8', color: '#ca8a04', border: '#fde68a' },
  info:     { bg: '#edf5fb', color: '#4B9CD3', border: '#7DB8E0' },
}

const CATEGORY_COLORS: Record<string, { bg: string; color: string }> = {
  normal:       { bg: '#f0fdf4', color: '#16a34a' },
  edge_case:    { bg: '#fff7ed', color: '#ea580c' },
  adversarial:  { bg: '#fef2f2', color: '#dc2626' },
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function Sandbox() {
  const [searchParams] = useSearchParams()
  const preselectedAgent = searchParams.get('agent')
  const worstCase = searchParams.get('worst_case') === '1'
  const navigate = useNavigate()

  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [agents, setAgents] = useState<AgentListItem[]>([])
  const [simulations, setSimulations] = useState<SimulationListItem[]>([])
  const [simSearch, setSimSearch] = useState('')
  const [simSort, setSimSort] = useState('newest')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Selection state
  const [selectedScenarios, setSelectedScenarios] = useState<Scenario[]>([])
  const [selectedAgent, setSelectedAgent] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [customPrompt, setCustomPrompt] = useState('')
  const [queuedCustomPrompts, setQueuedCustomPrompts] = useState<string[]>([])

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
  const [result, setResult] = useState<SimulationResult | null>(null)
  const [queueResults, setQueueResults] = useState<QueueResult[]>([])
  const [previousResult, setPreviousResult] = useState<SimulationResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [lastRunMode, setLastRunMode] = useState('')
  const [sweeping, setSweeping] = useState(false)
  const [sandboxTab, setSandboxTab] = useState<'run' | 'past'>('run')
  const [runMode, setRunMode] = useState<'dry' | 'llm'>('dry')
  const [showAddAllConfirm, setShowAddAllConfirm] = useState(false)

  useEffect(() => {
    Promise.all([
      apiFetch<{ agents: AgentListItem[] }>('/api/authority/agents'),
      apiFetch<{ simulations: SimulationListItem[] }>('/api/sandbox/simulations'),
    ])
      .then(([agentData, simData]) => {
        setAgents(agentData.agents)
        setSimulations(simData.simulations)
        const defaultAgent =
          preselectedAgent && agentData.agents.find((a) => a.id === preselectedAgent)
            ? preselectedAgent
            : agentData.agents[0]?.id || ''
        setSelectedAgent(defaultAgent)
        setLoading(false)
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

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
      toast(
        'Scenario generation failed: ' + (err instanceof Error ? err.message : 'Unknown error'),
        'error',
      )
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
        if (worstCase && d.scenarios?.length > 0) {
          const adversarial = d.scenarios.filter(
            (s) => s.category === 'adversarial' || s.category === 'chain_exploit',
          )
          const toSelect = adversarial.length > 0 ? adversarial : [d.scenarios[d.scenarios.length - 1]]
          setSelectedScenarios(toSelect)
          setCategoryFilter('adversarial')
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
    if (result) setPreviousResult(result)
    setResult(null)
    setQueueResults([])

    const toRun: ({ type: 'scenario'; scenario: Scenario } | { type: 'custom'; prompt: string })[] = [
      ...selectedScenarios.map((s) => ({ type: 'scenario' as const, scenario: s })),
      ...queuedCustomPrompts.map((p) => ({ type: 'custom' as const, prompt: p })),
    ]
    if (toRun.length === 0) return

    const allResults: QueueResult[] = []
    let failedCount = 0

    for (let i = 0; i < toRun.length; i++) {
      setRunProgress({ current: i + 1, total: toRun.length })
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
        allResults.push({
          scenario: toRun[i].type === 'scenario' ? (toRun[i] as { type: 'scenario'; scenario: Scenario }).scenario : null,
          data,
        })
      } catch {
        failedCount++
      }
    }

    setRunProgress(null)
    setQueueResults(allResults)

    if (allResults.length > 0) {
      const lastData = allResults[allResults.length - 1].data
      if (failedCount > 0) {
        toast(
          `${failedCount} scenario${failedCount > 1 ? 's' : ''} failed — showing last successful result`,
          'error',
        )
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

  return (
    <div className="p-10 space-y-8">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Sandbox</h1>
        <p className="text-sm text-gray-500 mt-2">
          Run agents against mock APIs to test how they behave before they touch real systems.
        </p>
        <div className="flex mt-6">
          {([
            { id: 'run' as const, label: 'Run Simulation' },
            { id: 'past' as const, label: `Past Runs${simulations.length > 0 ? ` (${simulations.length})` : ''}` },
          ]).map((t) => (
            <button
              key={t.id}
              onClick={() => setSandboxTab(t.id)}
              style={{
                background: 'transparent',
                border: 'none',
                padding: '8px 16px 10px',
                fontSize: 13,
                fontWeight: sandboxTab === t.id ? 600 : 400,
                color: sandboxTab === t.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                borderBottom: sandboxTab === t.id ? '2px solid var(--text-primary)' : '2px solid transparent',
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
                        {sel.tools?.filter((t) => t.service).length > 0 && (
                          <div className="text-[11px] text-gray-400 truncate">
                            {sel.tools
                              .filter((t) => t.service)
                              .map((t) => t.service)
                              .join(' · ')}
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
                    <span className="text-gray-400">Select an agent...</span>
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
                            {a.tools?.filter((t) => t.service).length > 0 && (
                              <div className="text-[11px] text-gray-400 truncate">
                                {a.tools.filter((t) => t.service).map((t) => t.service).join(' · ')}
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
            className="flex flex-col items-start text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{ background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '8px 20px', fontFamily: 'inherit', cursor: 'pointer' }}
            onClick={() => { setRunMode('dry'); handleRun(true) }}
            disabled={(selectedScenarios.length === 0 && queuedCustomPrompts.length === 0) || !selectedAgent || running || sweeping}
            title="Mocked APIs · enforces policies · no LLM call (free)"
          >
            <span className="flex items-center gap-1.5">
              <Play size={13} />
              {running && lastRunMode === 'dry-run'
                ? runProgress && runProgress.total > 1
                  ? `Running ${runProgress.current} of ${runProgress.total}...`
                  : 'Running...'
                : selectedScenarios.length > 1
                ? `Test (mock APIs) · ${selectedScenarios.length}`
                : 'Test (mock APIs)'}
            </span>
            <span className="text-[11px] opacity-70 mt-0.5">No LLM call · free</span>
          </button>

          <button
            className="flex flex-col items-start text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '7px 16px', fontFamily: 'inherit', cursor: 'pointer' }}
            onClick={() => { setRunMode('llm'); handleRun(false) }}
            disabled={(selectedScenarios.length === 0 && queuedCustomPrompts.length === 0) || !selectedAgent || running || sweeping}
            title="Mocked APIs · enforces policies · uses a real LLM (~$0.05 per run)"
          >
            <span className="flex items-center gap-1.5">
              <Cpu size={13} />
              {running && lastRunMode === 'llm'
                ? runProgress && runProgress.total > 1
                  ? `Running ${runProgress.current} of ${runProgress.total}...`
                  : 'Running...'
                : selectedScenarios.length > 1
                ? `Test (real LLM) · ${selectedScenarios.length}`
                : 'Test (real LLM)'}
            </span>
            <span className="text-[11px] opacity-60 mt-0.5">Uses an LLM · ~$0.05 per run</span>
          </button>

          <button
            className="flex flex-col items-start text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '7px 16px', fontFamily: 'inherit', cursor: 'pointer' }}
            onClick={() => handleSweep(true)}
            disabled={!selectedAgent || running || sweeping}
            title="Run every scenario for this agent — full risk coverage report"
          >
            <span className="flex items-center gap-1.5">
              <Zap size={13} />
              {sweeping ? 'Sweeping... (30–60 seconds)' : 'Sweep all scenarios'}
            </span>
            <span className="text-[11px] opacity-70 mt-0.5">
              {sweeping ? 'running all scenarios' : 'Every scenario · mock APIs · free'}
            </span>
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
                    Running scenario <strong>{runProgress.current}</strong> of{' '}
                    <strong>{runProgress.total}</strong>
                  </span>
                  <span>{Math.round(((runProgress.current - 1) / runProgress.total) * 100)}%</span>
                </div>
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ background: 'var(--color-cta)', width: `${((runProgress.current - 1) / runProgress.total) * 100}%` }}
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
                  No scenarios selected — click a scenario below or add a custom prompt
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
                  className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700"
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0 bg-indigo-500" />
                  Custom prompt {queuedCustomPrompts.length > 1 ? i + 1 : ''}
                  <button
                    className="ml-0.5 text-indigo-400 hover:text-indigo-700"
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
                >
                  {f.label}
                  {f.value === 'normal' && (
                    <span style={{ fontSize: 10, fontWeight: 700, background: '#16a34a', color: '#fff', borderRadius: 4, padding: '1px 6px', letterSpacing: '0.02em', lineHeight: 1.6 }}>Start here</span>
                  )}
                  {CATEGORY_TOOLTIPS[f.value as ScenarioCategory] && (
                    <Tooltip text={CATEGORY_TOOLTIPS[f.value as ScenarioCategory]!}>
                      <span className="w-3.5 h-3.5 rounded-full bg-gray-300 text-gray-700 text-[9px] flex items-center justify-center font-bold cursor-default">
                        ?
                      </span>
                    </Tooltip>
                  )}
                  <span className={`text-[10px] ${categoryFilter === f.value ? 'opacity-70' : 'text-gray-400'}`}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Scenario grid */}
          {loadingScenarios ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-6 h-6 border-2 border-gray-200 border-t-gray-700 rounded-full animate-spin" />
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
                const borderColor =
                  s.severity === 'critical' ? '#dc2626'
                  : s.severity === 'high'     ? '#ea580c'
                  : s.category === 'normal'   ? '#16a34a'
                  : s.category === 'chain_exploit' ? '#7c3aed'
                  : s.category === 'adversarial'   ? '#dc2626'
                  : undefined

                return (
                  <div
                    key={s.id}
                    className={`bg-white border border-gray-200 rounded-xl shadow-sm p-5 cursor-pointer hover:border-gray-300 hover:shadow-md transition-all ${
                      isSelected ? 'ring-2 ring-gray-900 ring-offset-1' : ''
                    }`}
                    style={borderColor ? { borderLeftWidth: 3, borderLeftColor: borderColor } : undefined}
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

      {/* Inline results */}
      {result && (
        <section className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              {queueResults.length > 1 ? `Results — ${queueResults.length} Scenarios` : 'Results'}
              <span
                className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                  lastRunMode === 'llm'
                    ? 'bg-purple-100 text-purple-700'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {lastRunMode === 'llm' ? 'Real LLM' : 'Mock APIs'}
              </span>
            </h2>
            <Link
              to={`/sandbox/${result.simulation_id}`}
              className="text-xs font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1"
            >
              View Full Report <ArrowRight size={12} />
            </Link>
          </div>

          {/* Batch summary */}
          {queueResults.length > 1 && (() => {
            const scores = queueResults.map((r) => r.data.report?.risk_score ?? 0)
            const peak = Math.max(...scores)
            const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
            const totalViol = queueResults.reduce((s, r) => s + r.data.report.violations.length, 0)
            const peakColor = scoreToColor(peak)
            return (
              <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-semibold text-gray-900">Batch Run</span>
                  <div className="flex items-center gap-4 text-xs text-gray-500">
                    <span>
                      Peak <strong style={{ color: peakColor }}>{peak}</strong>
                    </span>
                    <span>
                      Avg <strong className="text-gray-900">{avg}</strong>
                    </span>
                    <span>
                      Violations{' '}
                      <strong style={{ color: totalViol > 0 ? '#dc2626' : undefined }}>{totalViol}</strong>
                    </span>
                  </div>
                </div>
                <div className="divide-y divide-gray-50">
                  {queueResults.map(({ scenario, data: d }, i) => {
                    const sc = d.report?.risk_score ?? 0
                    const col = scoreToColor(sc)
                    const isActive = d === result
                    return (
                      <div
                        key={i}
                        className={`flex items-center gap-3 py-2 px-2 rounded-lg cursor-pointer hover:bg-gray-50 text-xs transition-colors ${
                          isActive ? 'bg-gray-50 font-medium' : ''
                        }`}
                        onClick={() => setResult(d)}
                      >
                        <span className="text-gray-400 flex-shrink-0 w-5 text-right">{i + 1}</span>
                        <span className="flex-1 text-gray-700 truncate">{scenario?.name || 'Custom'}</span>
                        <span className="font-bold flex-shrink-0" style={{ color: col }}>{sc}</span>
                        <span className="text-gray-400 flex-shrink-0">
                          {d.report.violations.length} violations · {d.report.actions_blocked} blocked
                        </span>
                        <Link
                          to={`/sandbox/${d.simulation_id}`}
                          className="text-gray-500 hover:text-gray-900 flex-shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Full Report <ArrowRight size={11} className="inline" />
                        </Link>
                      </div>
                    )
                  })}
                </div>
                <p className="text-[11px] text-gray-400 mt-2">
                  Showing detail for highlighted scenario — click a row to switch
                </p>
              </div>
            )
          })()}

          {/* Before/After comparison */}
          {previousResult && (
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
              <h3 className="text-xs font-semibold text-gray-500 mb-3">Before → After</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  {
                    label: 'Risk Score',
                    before: previousResult.report.risk_score,
                    after: result.report.risk_score,
                    improved: result.report.risk_score < previousResult.report.risk_score,
                  },
                  {
                    label: 'Violations',
                    before: previousResult.report.violations.length,
                    after: result.report.violations.length,
                    improved: result.report.violations.length < previousResult.report.violations.length,
                  },
                  {
                    label: 'Blocked',
                    before: previousResult.report.actions_blocked,
                    after: result.report.actions_blocked,
                    improved: result.report.actions_blocked > previousResult.report.actions_blocked,
                  },
                  {
                    label: 'Chains',
                    before: previousResult.report.chains_triggered.length,
                    after: result.report.chains_triggered.length,
                    improved: result.report.chains_triggered.length < previousResult.report.chains_triggered.length,
                  },
                ].map(({ label, before, after, improved }) => (
                  <div key={label} className="text-xs">
                    <div className="text-gray-400 mb-1">{label}</div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-gray-500">{before}</span>
                      <ArrowRight size={10} className="text-gray-300" />
                      <span className={improved ? 'text-green-600 font-semibold' : 'text-gray-900 font-semibold'}>
                        {after}
                      </span>
                      {improved && (
                        <span className="text-green-600">-{before - after}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Re-run button */}
          <div>
            <Button
              variant="secondary"
              size="sm"
              icon={<RotateCcw size={13} />}
              onClick={() => handleRun(true)}
              disabled={running}
            >
              Re-run Simulation (test policies)
            </Button>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
            {[
              { value: result.report.risk_score, label: 'Risk Score', color: scoreToColor(result.report.risk_score) },
              { value: result.report.total_steps, label: 'Total Steps', color: undefined },
              { value: result.report.actions_executed, label: 'Executed', color: result.report.actions_executed > 0 ? 'var(--status-executed)' : undefined },
              { value: result.report.actions_blocked, label: 'Blocked', color: result.report.actions_blocked > 0 ? 'var(--status-blocked)' : undefined },
              { value: result.report.actions_pending, label: 'Pending', color: result.report.actions_pending > 0 ? 'var(--status-pending)' : undefined },
              { value: result.report.violations.length, label: 'Violations', color: result.report.violations.length > 0 ? '#dc2626' : undefined },
              { value: result.report.chains_triggered.length, label: 'Chains', color: result.report.chains_triggered.length > 0 ? '#7c3aed' : undefined },
            ].map(({ value, label, color }) => (
              <div key={label} className="bg-white border border-gray-200 rounded-xl shadow-sm p-3 text-center">
                <div className="text-xl font-bold" style={{ color }}>{value}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">{label}</div>
              </div>
            ))}
          </div>

          {/* Quick trace */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Trace</h3>
            <div className="space-y-1">
              {result.trace.steps.map((step, i) => {
                const ds = DECISION_STYLE[step.enforce_decision] ?? DECISION_STYLE.ALLOW
                return (
                  <div key={i} className="flex items-center gap-2 py-1">
                    <span className="flex-1 text-xs text-gray-700">
                      <span className="font-medium">
                        {step.tool.charAt(0).toUpperCase() + step.tool.slice(1)}
                      </span>
                      <span className="text-gray-400 mx-1">·</span>
                      {step.action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                    <span
                      className="text-[10px] font-semibold px-2 py-0.5 rounded flex-shrink-0"
                      style={{ background: ds.bg, color: ds.color }}
                    >
                      {step.enforce_decision}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Violations */}
          {result.report.violations.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">
                Violations ({result.report.violations.length})
              </h3>
              <div className="space-y-2">
                {result.report.violations.map((v, i) => {
                  const sev = SEVERITY_COLORS[v.severity] ?? SEVERITY_COLORS.medium
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-2 p-3 rounded-lg border-l-4 text-xs"
                      style={{ background: sev.bg, borderLeftColor: sev.border }}
                    >
                      <span
                        className="font-semibold px-1.5 py-0.5 rounded capitalize flex-shrink-0"
                        style={{ background: sev.bg, color: sev.color }}
                      >
                        {v.severity}
                      </span>
                      <strong className="text-gray-900 flex-shrink-0">{v.title}</strong>
                      <span className="text-gray-500">{v.description}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Chains */}
          {result.report.chains_triggered.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">
                Chains Triggered ({result.report.chains_triggered.length})
              </h3>
              <div className="space-y-2">
                {result.report.chains_triggered.map((c, i) => {
                  const sev = SEVERITY_COLORS[c.severity] ?? SEVERITY_COLORS.high
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-2 p-3 rounded-lg border-l-4 text-xs"
                      style={{ background: sev.bg, borderLeftColor: sev.border }}
                    >
                      <span
                        className="font-semibold px-1.5 py-0.5 rounded capitalize flex-shrink-0"
                        style={{ background: sev.bg, color: sev.color }}
                      >
                        {c.severity}
                      </span>
                      <div className="min-w-0">
                        <strong className="text-gray-900 block">{chainShortLabel(c.chain_name)}</strong>
                        <span className="text-gray-500">{c.description}</span>
                        <div className="text-gray-400 mt-0.5">Steps: {c.step_indices.join(' → ')}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Recommendations */}
          {result.report.recommendations.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900">Recommendations</h3>
                {result.report.recommendations.some(
                  (r) => typeof r !== 'string' && (r as Recommendation).actionable,
                ) && (
                  <Button
                    size="sm"
                    onClick={async () => {
                      const actionable = result.report.recommendations.filter(
                        (r) => typeof r !== 'string' && (r as Recommendation).actionable,
                      ) as Recommendation[]
                      try {
                        const data = await apiFetch<{ created: number; skipped: number }>(
                          '/api/sandbox/apply-all-policies',
                          {
                            method: 'POST',
                            body: JSON.stringify({
                              agent_id: selectedAgent,
                              policies: actionable.map((r) => ({
                                agent_id: selectedAgent,
                                action_pattern: r.action_pattern,
                                effect: r.effect,
                                reason: r.reason,
                              })),
                            }),
                          },
                        )
                        toast(
                          `Applied ${data.created} polic${data.created !== 1 ? 'ies' : 'y'}${
                            data.skipped ? ` · ${data.skipped} already existed` : ''
                          }`,
                        )
                      } catch (err) {
                        toast('Failed: ' + (err as Error).message, 'error')
                      }
                    }}
                  >
                    Apply All Policies
                  </Button>
                )}
              </div>
              <div className="space-y-2">
                {result.report.recommendations.map((r, i) => {
                  const rec: Recommendation =
                    typeof r === 'string' ? { message: r, actionable: false } : (r as Recommendation)
                  return (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className="flex-1 text-gray-600">{rec.message}</span>
                      {rec.actionable && (
                        <button
                          className="flex-shrink-0 text-xs font-medium border px-2 py-1 rounded hover:bg-gray-50 transition-colors"
                          style={{
                            color: rec.effect === 'BLOCK' ? '#dc2626' : '#ca8a04',
                            borderColor: rec.effect === 'BLOCK' ? '#fca5a5' : '#fde68a',
                          }}
                          onClick={async () => {
                            try {
                              const data = await apiFetch<{ already_exists: boolean }>(
                                '/api/sandbox/apply-policy',
                                {
                                  method: 'POST',
                                  body: JSON.stringify({
                                    agent_id: selectedAgent,
                                    action_pattern: rec.action_pattern,
                                    effect: rec.effect,
                                    reason: rec.reason,
                                  }),
                                },
                              )
                              toast(data.already_exists ? 'Policy already exists' : 'Policy created')
                            } catch (err) {
                              toast('Failed: ' + (err as Error).message, 'error')
                            }
                          }}
                        >
                          {rec.effect === 'BLOCK' ? 'Block' : 'Require Approval'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Compare runs banner */}
      {result && previousResult && (
        <div className="flex items-center justify-between gap-4 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
          <div className="text-sm text-gray-700">
            <strong>You've run 2 simulations.</strong> Compare them to see the impact of your policies.
          </div>
          <a
            href={`/compare?before=${previousResult.simulation_id}&after=${result.simulation_id}`}
            className="flex-shrink-0 inline-flex items-center gap-1"
            style={{ background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '8px 20px', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}
          >
            Compare Runs <ArrowRight size={13} className="inline ml-1" />
          </a>
        </div>
      )}

      </>)}

      {sandboxTab === 'past' && (
      <section>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Past Runs</h2>
            <p className="text-sm text-gray-500 mt-1">{simulations.length} simulation{simulations.length !== 1 ? 's' : ''} recorded</p>
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
                const isCurrent = result && sim.id === result.simulation_id

                return (
                  <div
                    key={sim.id}
                    className={`bg-white border border-gray-200 rounded-xl shadow-sm p-3 flex items-center gap-3 ${
                      isCurrent ? 'ring-2 ring-gray-900' : ''
                    }`}
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
                        {isCurrent && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-900 text-white">
                            Latest Run
                          </span>
                        )}
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
        </section>
      )}

    </div>
  )
}
