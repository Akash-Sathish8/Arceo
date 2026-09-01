import { useState, useEffect, useRef } from 'react'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom'
import { recordAgentView } from '@/lib/recentViews'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  X,
  Lock,
  Clock,
  ChevronDown,
  ChevronRight,
  Copy,
  Plus,
  MoreHorizontal,
  Link2,
} from 'lucide-react'
import { apiFetch, getToken } from '@/lib/api'
import { toast } from '@/components/shared/Toast'
import { bandDescription, riskLabelBg, riskLabelColor, riskLabelName, scoreBand, scoreToColor } from '@/lib/utils'
import type { RiskLabel } from '@/lib/types'
import Tooltip from '@/components/shared/Tooltip'
import ErrorState from '@/components/shared/ErrorState'
import CodeTabs, { type CodeTab } from '@/components/shared/CodeTabs'
import Tabs from '@/components/shared/Tabs'
import { RISK_SCORE_METHODOLOGY } from '@/lib/methodology'

// ── Local types ───────────────────────────────────────────────────────────────

interface AgentAction {
  action: string
  description: string
  risk_labels: string[]
  reversible: boolean
}

interface AgentTool {
  name: string
  service: string
  description: string
  actions: AgentAction[]
}

interface AgentDetailAgent {
  id: string
  name: string
  description: string
  agent_type: string
  default_effect?: 'ALLOW' | 'DENY'
  tools: AgentTool[]
}

interface GraphNode {
  id: string
  label: string
  type: string
  reversible?: boolean
  risk_labels?: string[]
}

interface GraphEdge {
  source: string
  target: string
  relation: string
}

interface BlastRadius {
  score: number  // INHERENT — capability ceiling
  total_actions: number
  irreversible_actions: number
  moves_money: number
  touches_pii: number
  deletes_data: number
  sends_external: number
  changes_production: number
  changes_access?: number
  reads_secrets?: number
  evades_detection?: number
  bulk_export?: number
  executes_code?: number
  /** How much of the risk picture came from the deterministic catalog vs
   * heuristic classification of unknown tools. Drives the "may understate" note. */
  coverage?: {
    recognizedActions: number
    totalActions: number
    unrecognizedTools: string[]
    unclassifiedActions?: number
    unclassifiedList?: string[]
    llmClassified?: number
  }
  /** Backend-authoritative band: low | medium | high | critical. */
  band?: string
  // ── two-number danger model ──
  residual_score?: number       // exposed now, after the agent's policies
  contextual_score?: number     // inherent × deployment-context multiplier
  magnitude_usd?: number        // worst-case per-incident $ across actions
  chain_risk?: number
  confidence?: 'low' | 'medium' | 'high'
  evidence?: { hasSim?: boolean; simRiskScore?: number; confirmed?: boolean; dryRunOnly?: boolean }
  exposure_context?: {
    environment?: string | null
    trigger_source?: string | null
    human_in_loop?: boolean | null
    multiplier?: number
  }
  top_contributors?: { action: string; usd: number; score: number; why: string }[]
}

interface Chain {
  id: string
  name: string
  severity: 'critical' | 'high' | 'medium'
  description: string
  steps: string[]
  matching_actions: string[][]
  from_label?: string
  to_label?: string
  chain_name?: string
  demonstrated?: boolean   // fired in the latest sandbox run
  data_linked?: boolean    // data actually flowed between the steps
}

interface Recommendation {
  title: string
  description: string
  severity: 'critical' | 'high' | 'medium'
}

interface PolicyCondition {
  field?: string
  op: string
  value: string
}

interface Policy {
  id: string
  action_pattern: string
  effect: 'BLOCK' | 'REQUIRE_APPROVAL' | 'ALLOW'
  reason: string
  priority: number
  conditions?: PolicyCondition[]
}

interface Execution {
  id: string
  tool: string
  action: string
  status: string
  timestamp: string
  detail?: string
}

interface AgentDetailResponse {
  agent: AgentDetailAgent
  graph: {
    nodes: GraphNode[]
    edges: GraphEdge[]
  }
  blast_radius: BlastRadius
  chains: Chain[]
  recommendations: Recommendation[]
  policies: Policy[]
  executions: Execution[]
}

// Backend shape: {policy_a, policy_b, overlap, winner: {id, effect}} — the
// winner/loser policies are derived by matching winner.id.
interface PolicyConflict {
  policy_a?: { id: number; pattern: string; effect: string; priority: number }
  policy_b?: { id: number; pattern: string; effect: string; priority: number }
  winner?: { id: number; effect: string }
  overlap?: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SEV_STYLE: Record<string, { bg: string; color: string }> = {
  critical: { bg: 'var(--critical-bg)', color: 'var(--critical)' },
  high: { bg: 'var(--high-bg)', color: 'var(--high)' },
  medium: { bg: 'var(--caution-bg)', color: 'var(--caution)' },
}

const EFFECT_STYLE: Record<string, { bg: string; color: string }> = {
  BLOCK: { bg: 'var(--critical-bg)', color: 'var(--critical)' },
  REQUIRE_APPROVAL: { bg: 'var(--high-bg)', color: 'var(--high)' },
  ALLOW: { bg: 'var(--safe-bg)', color: 'var(--safe)' },
}

const EXEC_STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  EXECUTED:         { bg: 'var(--status-executed-bg)', color: 'var(--status-executed)' },
  BLOCKED:          { bg: 'var(--status-blocked-bg)',  color: 'var(--status-blocked)' },
  PENDING_APPROVAL: { bg: 'var(--status-pending-bg)',  color: 'var(--status-pending)' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const formatAction = (action: string) =>
  action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

const parsePolicyPattern = (pattern: string) => {
  const dot = pattern.indexOf('.')
  if (dot === -1) return { service: '', action: formatAction(pattern) }
  return {
    service: pattern.slice(0, dot).charAt(0).toUpperCase() + pattern.slice(0, dot).slice(1),
    action: formatAction(pattern.slice(dot + 1)),
  }
}

const formatDescription = (text: string) =>
  text.replace(/\b([a-z]+(?:_[a-z]+)+)\b/g, (m) =>
    m
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  )

const actionRiskDot = (tool: string, action: string): string => {
  const s = `${tool}.${action}`.toLowerCase()
  if (/delete|terminate|drop|destroy|remove|cancel/.test(s)) return 'var(--critical)'
  if (/charge|transfer|pay|refund|create_charge/.test(s)) return riskLabelColor('moves_money')
  if (/send|email|message|notify/.test(s)) return riskLabelColor('sends_external')
  return 'var(--ink-400)'
}

const blastLabel = (score: number): string => bandDescription(scoreBand(score).key)

const fmtUsd = (usd: number): string => {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}k`
  return `$${Math.round(usd)}`
}

// Confidence is trust in the NUMBER, not risk level — so high = reassuring
// green, not alarming red (the old styling made the best state look worst).
const CONF_STYLE: Record<string, { background: string; color: string; label: string }> = {
  high: { background: 'var(--safe-bg)', color: 'var(--safe)', label: 'Confirmed by simulation' },
  medium: { background: 'var(--accent-soft)', color: 'var(--accent-ink)', label: 'Simulated' },
  low: { background: 'var(--paper-2)', color: 'var(--ink-500)', label: 'Static estimate' },
}

const formatExecTime = (ts: string): string => {
  const d = new Date(ts)
  const now = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ` ${time}`
}


// ── Authority Map ─────────────────────────────────────────────────────────────

interface AuthorityMapProps {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  serviceFilter?: string | null
}

function AuthorityMap({ graph, serviceFilter }: AuthorityMapProps) {
  const nodeById: Record<string, GraphNode> = {}
  graph.nodes.forEach((n) => {
    nodeById[n.id] = n
  })

  const toolActionIds: Record<string, string[]> = {}
  graph.edges
    .filter((e) => e.relation === 'exposes')
    .forEach((e) => {
      if (!toolActionIds[e.source]) toolActionIds[e.source] = []
      toolActionIds[e.source].push(e.target)
    })

  const toolIds = graph.edges.filter((e) => e.relation === 'has_tool').map((e) => e.target)
  const tools = toolIds.map((id) => nodeById[id]).filter(Boolean) as GraphNode[]

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    tools.forEach((tool) => {
      const acts = (toolActionIds[tool.id] || []).map((id) => nodeById[id]).filter(Boolean)
      const hasDanger = acts.some((a) => a.reversible === false || (a.risk_labels?.length ?? 0) > 0)
      if (!hasDanger) init[tool.id] = true
    })
    return init
  })

  const toggle = (id: string) => setCollapsed((p) => ({ ...p, [id]: !p[id] }))
  const [graphSearch, setGraphSearch] = useState('')
  const [riskFilter, setRiskFilter] = useState<'all' | 'irreversible' | 'risky' | 'safe'>('all')
  const searchLower = graphSearch.toLowerCase()

  return (
    <div className="space-y-2">
      <div className="flex gap-2 mb-3 flex-wrap">
        <input
          style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 16px', height: '36px', fontSize: 13, flex: 1, minWidth: 0, fontFamily: 'inherit' }}
          onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
          onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
          aria-label="Search actions"
          placeholder="Search actions…"
          value={graphSearch}
          onChange={(e) => setGraphSearch(e.target.value)}
        />
        <div className="flex gap-1">
          {(['all', 'irreversible', 'risky', 'safe'] as const).map((f) => (
            <button
              key={f}
              style={riskFilter === f
                ? { background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '4px 12px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }
                : { background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '4px 12px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}
              className="hover:opacity-80 transition-opacity"
              onClick={() => setRiskFilter(f)}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {tools.map((tool) => {
        if (serviceFilter && tool.label?.toLowerCase() !== serviceFilter.toLowerCase()) return null

        const allActions = (toolActionIds[tool.id] || [])
          .map((id) => nodeById[id])
          .filter(Boolean)
          .sort((a, b) => {
            const rank = (x: GraphNode) =>
              x.reversible === false ? 0 : (x.risk_labels?.length ?? 0) > 0 ? 1 : 2
            return rank(a) - rank(b)
          }) as GraphNode[]

        const actions = allActions.filter((a) => {
          if (searchLower && !a.label?.toLowerCase().includes(searchLower)) return false
          if (riskFilter === 'irreversible' && a.reversible !== false) return false
          if (riskFilter === 'risky' && (a.reversible === false || !(a.risk_labels?.length ?? 0)))
            return false
          if (riskFilter === 'safe' && (a.reversible === false || (a.risk_labels?.length ?? 0) > 0))
            return false
          return true
        })

        if (actions.length === 0) return null

        const nIrrev = allActions.filter((a) => a.reversible === false).length
        const nRisky = allActions.filter(
          (a) => a.reversible !== false && (a.risk_labels?.length ?? 0) > 0
        ).length
        const nSafe = allActions.filter(
          (a) => a.reversible !== false && !(a.risk_labels?.length ?? 0)
        ).length
        const isOpen = !collapsed[tool.id] || !!searchLower || riskFilter !== 'all'
        const accentColor = nIrrev > 0 ? 'var(--critical)' : nRisky > 0 ? 'var(--caution)' : 'var(--ink-300)'

        return (
          <div
            key={tool.id}
            className="border border-gray-200 rounded-lg overflow-hidden"
            style={{ borderLeftWidth: 3, borderLeftColor: accentColor }}
          >
            <div
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              className="flex items-center justify-between px-4 py-2.5 cursor-pointer hover:bg-gray-50 transition-colors"
              onClick={() => toggle(tool.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  if (e.key === ' ') e.preventDefault()
                  toggle(tool.id)
                }
              }}
            >
              <span className="font-medium text-sm text-gray-800">{tool.label}</span>
              <div className="flex items-center gap-2">
                <div className="flex gap-1.5">
                  {nIrrev > 0 && (
                    <span className="px-1.5 py-0.5 text-xs rounded-full font-medium bg-red-50 text-red-600 border border-red-200">
                      {nIrrev} irreversible
                    </span>
                  )}
                  {nRisky > 0 && (
                    <span className="px-1.5 py-0.5 text-xs rounded-full font-medium bg-amber-50 text-amber-600 border border-amber-200">
                      {nRisky} risky
                    </span>
                  )}
                  {nSafe > 0 && (
                    <span className="px-1.5 py-0.5 text-xs rounded-full font-medium bg-gray-100 text-gray-500 border border-gray-200">
                      {nSafe} safe
                    </span>
                  )}
                </div>
                {isOpen ? (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                )}
              </div>
            </div>

            {isOpen && (
              <div className="divide-y divide-gray-100 border-t border-gray-100">
                {actions.map((action) => {
                  const isIrrev = action.reversible === false
                  const hasRisk = (action.risk_labels?.length ?? 0) > 0
                  return (
                    <div
                      key={action.id}
                      className={`flex items-center gap-2.5 px-4 py-2 ${
                        isIrrev ? 'bg-red-50/40' : hasRisk ? 'bg-amber-50/30' : ''
                      }`}
                    >
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{
                          background: isIrrev ? 'var(--critical)' : hasRisk ? 'var(--caution)' : 'var(--ink-300)',
                        }}
                      />
                      <span className="text-sm text-gray-700 flex-1">
                        {formatAction(action.label)}
                      </span>
                      <div className="flex gap-1 flex-wrap">
                        {action.risk_labels?.map((r) => (
                          <span
                            key={r}
                            className="px-1.5 py-0.5 text-xs rounded border font-medium"
                            style={{
                              background: riskLabelBg(r as RiskLabel),
                              color: riskLabelColor(r as RiskLabel),
                              borderColor: riskLabelColor(r as RiskLabel),
                            }}
                          >
                            {riskLabelName(r)}
                          </span>
                        ))}
                        {isIrrev && (
                          <span className="px-1.5 py-0.5 text-xs rounded border font-medium bg-red-50 text-red-600 border-red-200">
                            Irreversible
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Worst Case Panel ──────────────────────────────────────────────────────────

function DeploymentContextEditor({
  agentId,
  context,
  onSaved,
}: {
  agentId: string
  context?: BlastRadius['exposure_context']
  onSaved: () => void
}) {
  const [env, setEnv] = useState(context?.environment ?? '')
  const [trigger, setTrigger] = useState(context?.trigger_source ?? '')
  const [hitl, setHitl] = useState(context?.human_in_loop == null ? '' : context.human_in_loop ? 'yes' : 'no')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await apiFetch(`/api/authority/agent/${agentId}/context`, {
        method: 'POST',
        body: JSON.stringify({
          environment: env || null,
          trigger_source: trigger || null,
          human_in_loop: hitl === '' ? null : hitl === 'yes',
        }),
      })
      toast('Deployment context saved')
      onSaved()
    } catch {
      toast('Could not save deployment context', 'error')
    } finally {
      setSaving(false)
    }
  }

  const sel = 'text-xs border border-gray-200 rounded px-2 py-1 bg-white'
  return (
    <div className="flex items-center gap-2 flex-wrap mb-4 -mt-1">
      <span className="font-semibold text-gray-500 uppercase tracking-wide" style={{ fontSize: 'var(--fs-micro)' }}>Deployment context</span>
      <select className={sel} value={env} onChange={(e) => setEnv(e.target.value)} aria-label="environment">
        <option value="">environment…</option>
        <option value="prod">prod</option>
        <option value="staging">staging</option>
        <option value="dev">dev</option>
      </select>
      <select className={sel} value={trigger} onChange={(e) => setTrigger(e.target.value)} aria-label="trigger source">
        <option value="">trigger…</option>
        <option value="untrusted">untrusted input</option>
        <option value="internal">internal</option>
        <option value="scheduled">scheduled</option>
      </select>
      <select className={sel} value={hitl} onChange={(e) => setHitl(e.target.value)} aria-label="human in loop">
        <option value="">human-in-loop…</option>
        <option value="yes">yes</option>
        <option value="no">no</option>
      </select>
      <button
        onClick={save}
        disabled={saving}
        className="text-xs px-2.5 py-1 rounded-full text-white disabled:opacity-50"
        style={{ background: 'var(--color-cta)', border: 'none', cursor: 'pointer' }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <span className="text-[11px] text-gray-400">scales the in-context score</span>
    </div>
  )
}

interface WorstCasePanelProps {
  br: BlastRadius
  chains: Chain[]
  policies: Policy[]
  onScrollToPolicies: () => void
  agentId: string
}

function WorstCasePanel({
  br,
  chains,
  policies,
  onScrollToPolicies,
  agentId,
}: WorstCasePanelProps) {
  if (!br || (br.score < 30 && chains.length === 0)) return null

  const topChain =
    chains.find((c) => c.severity === 'critical') ||
    chains.find((c) => c.severity === 'high') ||
    chains[0]
  const irreversibleCount = br.irreversible_actions || 0
  const hasCoveringPolicy = (policies || []).some(
    (p) => p.effect === 'BLOCK' || p.effect === 'REQUIRE_APPROVAL'
  )
  // Backend agent-detail chains carry `description` (a plain-English sentence)
  // and `name` (a short title) — not the legacy `chain_name`/`from_label`.
  const chainText = topChain ? (topChain.description || topChain.name) : null

  const scoreColor = scoreToColor(br.score)
  const criticalUnreviewed = chains.some((c) => c.severity === 'critical') && !hasCoveringPolicy
  const dynamicScoreLabel = criticalUnreviewed
    ? 'Critical chain detected — no policy set'
    : irreversibleCount > 0
    ? `${irreversibleCount} irreversible action${irreversibleCount !== 1 ? 's' : ''} — cannot be undone once triggered`
    : blastLabel(br.score)

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-4 h-4 text-amber-600" />
        <strong className="text-sm text-amber-900">Worst Case Scenario</strong>
        {hasCoveringPolicy && (
          <span className="ml-auto text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded-full border border-green-200">
            Partially covered by policies
          </span>
        )}
      </div>

      {chainText && (
        <div
          className="flex gap-3 mb-3 p-3 rounded-lg border"
          style={
            topChain?.severity === 'critical' && !hasCoveringPolicy
              ? { background: 'var(--critical-bg)', borderColor: 'var(--critical-line)' }
              : { background: 'var(--paper)', borderColor: 'var(--caution-line)' }
          }
        >
          <Link2 size={15} className="mt-0.5 flex-shrink-0" />

          <div className="space-y-1 flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-800">{chainText}</div>
            <div className="flex items-center gap-2 flex-wrap">
              {topChain && (
                <span
                  className="text-xs px-1.5 py-0.5 rounded font-medium"
                  style={{
                    background: SEV_STYLE[topChain.severity]?.bg ?? 'var(--high-bg)',
                    color: SEV_STYLE[topChain.severity]?.color ?? 'var(--high)',
                  }}
                >
                  {topChain.severity.toUpperCase()}
                </span>
              )}
              {topChain?.name && (
                <span className="text-xs text-gray-500">{topChain.name}</span>
              )}
              {!hasCoveringPolicy && (
                <>
                  <span className="text-xs text-red-500 font-medium">No policy</span>
                  <button
                    type="button"
                    className="text-xs font-semibold text-red-600 underline underline-offset-2 hover:text-red-800"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    onClick={onScrollToPolicies}
                  >
                    Add Policy
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {irreversibleCount > 0 && (
        <div className="flex items-center gap-2 mb-3 text-sm text-gray-700">
          <Lock className="w-4 h-4 text-gray-500 flex-shrink-0" />
          <span>
            {irreversibleCount} irreversible action{irreversibleCount !== 1 ? 's' : ''} — cannot
            be undone once triggered
          </span>
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold mono" style={{ color: scoreColor }}>
            {br.score}
          </span>
          <span className="text-xs text-gray-600">Risk Score — {dynamicScoreLabel}</span>
        </div>
        <div className="flex gap-2">
          {!hasCoveringPolicy && (
            <button
              style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '5px 14px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}
              className="hover:opacity-70 transition-opacity"
              onClick={onScrollToPolicies}
            >
              Add Policies
            </button>
          )}
          {/* "Simulate Worst Case" removed — redundant with the header's single
              "Simulate in Sandbox" entry (same /sandbox route, just a preset). */}
        </div>
      </div>

      {br.residual_score !== undefined && (
        <div className="mt-3 pt-3 border-t border-amber-200 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold" style={{ color: scoreToColor(br.residual_score) }}>
                {br.residual_score}
              </span>
              <span className="text-xs text-gray-600">
                Exposed now (after your policies)
                {br.residual_score < br.score && (
                  <span className="text-green-700 font-medium"> · −{Math.round(br.score - br.residual_score)} from gates</span>
                )}
              </span>
            </div>
            {br.confidence && (
              <span
                className="text-xs px-2 py-0.5 rounded-full border"
                style={{
                  background: CONF_STYLE[br.confidence].background,
                  color: CONF_STYLE[br.confidence].color,
                  borderColor: 'transparent',
                }}
                title="How the score is graded: static estimate vs simulated vs confirmed by a simulation"
              >
                {br.evidence?.dryRunOnly
                  ? 'Static analysis only — run a live simulation to confirm'
                  : CONF_STYLE[br.confidence].label}
              </span>
            )}
          </div>

          {br.top_contributors && br.top_contributors.filter((c) => c.usd > 0).length > 0 && (
            <div className="space-y-1">
              <div className="font-semibold text-gray-500 uppercase tracking-wide" style={{ fontSize: 'var(--fs-micro)' }}>Top dollar exposure</div>
              {br.top_contributors
                .filter((c) => c.usd > 0)
                .slice(0, 3)
                .map((c) => (
                  <div key={c.action} className="flex items-center justify-between text-xs gap-2">
                    <span className="font-mono text-gray-700 truncate">{c.action}</span>
                    <span className="text-gray-500 flex-shrink-0">
                      {fmtUsd(c.usd)} · {c.why}
                    </span>
                  </div>
                ))}
            </div>
          )}

          {br.exposure_context?.multiplier !== undefined && br.exposure_context.multiplier !== 1 && (
            <div className="text-xs text-gray-600">
              In deployment context: <strong style={{ color: scoreToColor(br.contextual_score ?? br.score) }}>{br.contextual_score ?? br.score}</strong>
              {' ('}
              {[
                br.exposure_context.environment,
                br.exposure_context.trigger_source ? `${br.exposure_context.trigger_source}-triggered` : null,
                br.exposure_context.human_in_loop ? 'human-in-loop' : null,
              ]
                .filter(Boolean)
                .join(', ')}
              {')'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Action Picker ─────────────────────────────────────────────────────────────

interface ActionPickerProps {
  tools: AgentTool[]
  selectedPatterns: string[]
  onAdd: (pattern: string) => void
}

function ActionPicker({ tools, selectedPatterns, onAdd }: ActionPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const searchLow = search.toLowerCase()
  const filteredTools = tools
    .map((t) => ({
      ...t,
      filteredActions: t.actions.filter(
        (a) =>
          !searchLow ||
          a.action.toLowerCase().includes(searchLow) ||
          formatAction(a.action).toLowerCase().includes(searchLow)
      ),
      wildcardMatch:
        !searchLow ||
        (t.service || t.name).toLowerCase().includes(searchLow) ||
        'wildcard all actions'.includes(searchLow),
    }))
    .filter((t) => t.wildcardMatch || t.filteredActions.length > 0)

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        style={{ background: 'var(--bg-sunken)', border: open ? '2px solid var(--border-focus)' : '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 16px', height: '42px', width: '100%', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: 'inherit', cursor: 'pointer', transition: 'border-color 0.15s' }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ color: 'var(--text-secondary)' }}>
          {selectedPatterns.length === 0 ? 'Add an action…' : 'Add another action…'}
        </span>
        <ChevronDown
          className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
          style={{ color: 'var(--ink-400)' }}
        />
      </button>

      {open && (
        <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
          <div className="p-2 border-b border-gray-100">
            <input
              autoFocus
              style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 14px', height: '36px', width: '100%', fontSize: 13, fontFamily: 'inherit' }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
              aria-label="Search actions"
              placeholder="Search actions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {filteredTools.map((t) => (
              <div key={t.name}>
                <div className="px-3 py-1.5 font-semibold text-gray-500 uppercase tracking-wide bg-gray-50" style={{ fontSize: 'var(--fs-micro)' }}>
                  {t.service || t.name}
                </div>
                {t.wildcardMatch && (
                  <button
                    type="button"
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50 transition-colors ${
                      selectedPatterns.includes(`${t.name}.*`) ? 'bg-blue-50' : ''
                    }`}
                    onClick={() => {
                      onAdd(`${t.name}.*`)
                      setSearch('')
                      setOpen(false)
                    }}
                  >
                    <span className="w-4 text-blue-500 flex items-center">
                      {selectedPatterns.includes(`${t.name}.*`) ? (
                        <Check className="w-3 h-3" />
                      ) : null}
                    </span>
                    <span className="flex-1">All actions</span>
                    <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">
                      wildcard
                    </span>
                  </button>
                )}
                {t.filteredActions.map((a) => {
                  const isIrrev = a.reversible === false
                  const isRisky = (a.risk_labels?.length ?? 0) > 0
                  const key = `${t.name}.${a.action}`
                  const alreadySelected = selectedPatterns.includes(key)
                  return (
                    <button
                      key={a.action}
                      type="button"
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50 transition-colors ${
                        isIrrev ? 'bg-red-50/30' : isRisky ? 'bg-amber-50/30' : ''
                      } ${alreadySelected ? 'opacity-60' : ''}`}
                      onClick={() => {
                        onAdd(key)
                        setSearch('')
                        setOpen(false)
                      }}
                    >
                      <span className="w-4 flex items-center text-blue-500">
                        {alreadySelected ? <Check className="w-3 h-3" /> : null}
                      </span>
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{
                          background: isIrrev ? 'var(--critical)' : isRisky ? 'var(--caution)' : 'var(--ink-300)',
                        }}
                      />
                      <span className="flex-1">{formatAction(a.action)}</span>
                      <div className="flex gap-1">
                        {isIrrev && (
                          <span className="text-xs px-1.5 py-0.5 bg-red-50 text-red-600 rounded border border-red-200">
                            irreversible
                          </span>
                        )}
                        {a.risk_labels?.map((r) => (
                          <span
                            key={r}
                            className="text-xs px-1.5 py-0.5 rounded border"
                            style={{
                              background: riskLabelBg(r as RiskLabel),
                              color: riskLabelColor(r as RiskLabel),
                              borderColor: riskLabelColor(r as RiskLabel),
                            }}
                          >
                            {riskLabelName(r)}
                          </span>
                        ))}
                      </div>
                    </button>
                  )
                })}
              </div>
            ))}
            {filteredTools.length === 0 && (
              <div className="px-3 py-4 text-sm text-gray-400 text-center">
                No actions match &ldquo;{search}&rdquo;
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Condition Builder ─────────────────────────────────────────────────────────

interface ConditionBuilderProps {
  conditions: PolicyCondition[]
  onChange: (conditions: PolicyCondition[]) => void
}

function ConditionBuilder({ conditions, onChange }: ConditionBuilderProps) {
  const STANDARD_OPS = [
    { value: 'gt', label: '>' },
    { value: 'gte', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '≤' },
    { value: 'eq', label: '=' },
    { value: 'neq', label: '≠' },
  ]

  const add = () => onChange([...conditions, { field: '', op: 'gt', value: '' }])
  const addPrior = () => onChange([...conditions, { op: 'requires_prior', value: '' }])
  const remove = (i: number) => onChange(conditions.filter((_, j) => j !== i))
  const update = (i: number, key: keyof PolicyCondition, val: string) => {
    const next = [...conditions]
    next[i] = { ...next[i], [key]: val }
    onChange(next)
  }

  return (
    <div className="space-y-2">
      {conditions.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          {c.op === 'requires_prior' ? (
            <>
              <span className="text-xs text-gray-500 whitespace-nowrap">
                requires prior action
              </span>
              <input
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 14px', height: '36px', flex: 1, fontSize: 13, fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                aria-label="Required prior action"
                placeholder="e.g. pagerduty.get_incident"
                value={c.value}
                onChange={(e) => update(i, 'value', e.target.value)}
              />
            </>
          ) : (
            <>
              <input
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 14px', height: '36px', width: '8rem', fontSize: 13, fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                aria-label="Condition field"
                placeholder="field (e.g. amount)"
                value={c.field ?? ''}
                onChange={(e) => update(i, 'field', e.target.value)}
              />
              <select
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 12px', height: '36px', fontSize: 13, fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                aria-label="Condition operator"
                value={c.op}
                onChange={(e) => update(i, 'op', e.target.value)}
              >
                {STANDARD_OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 14px', height: '36px', width: '7rem', fontSize: 13, fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                aria-label="Condition value"
                placeholder="value (e.g. 100)"
                value={c.value}
                onChange={(e) => update(i, 'value', e.target.value)}
              />
            </>
          )}
          <button
            type="button"
            className="text-gray-400 hover:text-red-500 transition-colors"
            onClick={() => remove(i)}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '4px 12px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}
          className="hover:opacity-70 transition-opacity"
          onClick={add}
        >
          + Parameter condition
        </button>
        <button
          type="button"
          style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '4px 12px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}
          className="hover:opacity-70 transition-opacity"
          onClick={addPrior}
        >
          + Requires prior action
        </button>
      </div>
    </div>
  )
}

// ── Effect Toggle ─────────────────────────────────────────────────────────────

interface EffectToggleProps {
  value: 'BLOCK' | 'REQUIRE_APPROVAL' | 'ALLOW'
  onChange: (value: 'BLOCK' | 'REQUIRE_APPROVAL' | 'ALLOW') => void
}

function EffectToggle({ value, onChange }: EffectToggleProps) {
  const OPTIONS = [
    {
      value: 'BLOCK' as const,
      label: 'Block',
      desc: 'Agent is stopped — action never executes',
      Icon: X,
      color: 'var(--critical)',
      bg: 'var(--critical-bg)',
      border: 'var(--critical-line)',
    },
    {
      value: 'REQUIRE_APPROVAL' as const,
      label: 'Require Approval',
      desc: 'Pauses for a human to review and approve',
      Icon: Clock,
      color: 'var(--high)',
      bg: 'var(--high-bg)',
      border: 'var(--high-line)',
    },
    {
      value: 'ALLOW' as const,
      label: 'Allow',
      desc: 'Explicitly permitted — logged for audit',
      Icon: Check,
      color: 'var(--safe)',
      bg: 'var(--safe-bg)',
      border: 'var(--safe-line)',
    },
  ]

  return (
    <div className="grid grid-cols-3 gap-2">
      {OPTIONS.map((o) => {
        const isActive = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            className="flex flex-col items-center gap-1 p-3 border-2 rounded-xl text-center"
            style={{
              transition: 'border-color 0.15s, background-color 0.15s',
              ...(isActive
                ? { borderColor: o.border, background: o.bg }
                : { borderColor: 'var(--line)', background: 'var(--paper)' }),
            }}
            onClick={() => onChange(o.value)}
          >
            <o.Icon className="w-4 h-4" style={{ color: isActive ? o.color : 'var(--ink-400)' }} />
            <span
              className="text-xs font-semibold"
              style={{ color: isActive ? o.color : 'var(--ink-500)' }}
            >
              {o.label}
            </span>
            <span className="text-xs text-gray-400 leading-tight">{o.desc}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Integration Snippets ──────────────────────────────────────────────────────

interface IntegrationSnippetsProps {
  agentId: string
  token: string | null
}

function IntegrationSnippets({ agentId, token }: IntegrationSnippetsProps) {
  const shortToken = token ? token.slice(0, 20) + '...' : 'YOUR_TOKEN'

  const snippets: Record<'python' | 'curl' | 'node', string> = {
    python: `import requests

def enforce(tool: str, action: str, params: dict) -> str:
    resp = requests.post(
        "https://api.arceo.io/api/enforce",
        json={
            "agent_id": "${agentId}",
            "tool": tool,
            "action": action,
            "params": params
        },
        headers={"Authorization": "Bearer ${shortToken}"}
    )
    return resp.json()["decision"]  # "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL"

# Usage — call before every tool action:
decision = enforce("Stripe", "create_refund", {"amount": 500})
if decision == "ALLOW":
    stripe.create_refund(...)
elif decision == "BLOCK":
    raise Exception("Action blocked by policy")`,

    curl: `curl -X POST https://api.arceo.io/api/enforce \\
  -H "Authorization: Bearer ${shortToken}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "${agentId}",
    "tool": "Stripe",
    "action": "create_refund",
    "params": {"amount": 500}
  }'`,

    node: `const response = await fetch("https://api.arceo.io/api/enforce", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${shortToken}",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    agent_id: "${agentId}",
    tool: "Stripe",
    action: "create_refund",
    params: { amount: 500 }
  })
});
const { decision } = await response.json();
// decision: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL"`,
  }

  const tabs: CodeTab[] = [
    { label: 'python', code: snippets.python, lang: 'python' },
    { label: 'curl', code: snippets.curl, lang: 'bash' },
    { label: 'Node.js', code: snippets.node, lang: 'javascript' },
  ]

  return (
    <div className="mt-3">
      <CodeTabs tabs={tabs} />
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AgentDetail() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const policySectionRef = useRef<HTMLDivElement>(null)

  // Feed the Authority page's "Recently Viewed" sort.
  useEffect(() => {
    if (agentId) recordAgentView(agentId)
  }, [agentId])

  const [data, setData] = useState<AgentDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showIntegration, setShowIntegration] = useState(false)

  // Policy form state
  const [newPatterns, setNewPatterns] = useState<string[]>([])
  const [newEffect, setNewEffect] = useState<'BLOCK' | 'REQUIRE_APPROVAL' | 'ALLOW'>('BLOCK')
  const [newReason, setNewReason] = useState('')
  const [newConditions, setNewConditions] = useState<PolicyCondition[]>([])
  const [showConditions, setShowConditions] = useState(false)

  // Edit state
  const [editMode, setEditMode] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [defaultEffectSaving, setDefaultEffectSaving] = useState(false)

  // Delete state
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)

  // Close the header ⋯ menu on Escape while it is open
  useEffect(() => {
    if (!headerMenuOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHeaderMenuOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [headerMenuOpen])

  // Chain collapse
  const [collapsedChains, setCollapsedChains] = useState<Record<string, boolean>>({})
  const toggleChain = (id: string) => setCollapsedChains((p) => ({ ...p, [id]: !p[id] }))

  // Policy added banner
  const [policyAdded, setPolicyAdded] = useState(false)

  const [applyingRecs, setApplyingRecs] = useState(false)
  const [showRecsMenu, setShowRecsMenu] = useState(false)
  const [selectedRecs, setSelectedRecs] = useState<Set<number>>(new Set())
  const [appliedRecIndices, setAppliedRecIndices] = useState<Set<number>>(new Set())

  const [activeStatFilter, setActiveStatFilter] = useState<string | null>(null)
  // Collapsed by default: Total + top categories + Irreversible; "+N more" reveals the rest.
  const [statsExpanded, setStatsExpanded] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [changingEffectId, setChangingEffectId] = useState<string | null>(null)
  const [showAddPolicyForm, setShowAddPolicyForm] = useState(false)
  const [selectedGraphService, setSelectedGraphService] = useState<string | null>(null)

  // Policy conflicts
  const [policyConflicts, setPolicyConflicts] = useState<PolicyConflict[]>([])

  // Active tab
  const [activeTab, setActiveTab] = useState<'graph' | 'policies' | 'executions' | 'chains'>(
    () => {
      const p = searchParams.get('tab')
      if (p === 'policies' || p === 'executions' || p === 'chains') return p
      return 'graph'
    }
  )

  const addPattern = (p: string) => {
    if (!newPatterns.includes(p)) setNewPatterns((prev) => [...prev, p])
  }
  const removePattern = (p: string) => setNewPatterns((prev) => prev.filter((x) => x !== p))

  // soft=true refreshes data in place without the full-page spinner — used
  // after mutations so the user keeps their scroll position and tab.
  const loadData = (opts?: { soft?: boolean }) => {
    if (!agentId) return
    if (!opts?.soft) setLoading(true)
    setError(null)
    Promise.all([
      apiFetch<AgentDetailResponse>(`/api/authority/agent/${agentId}`),
      apiFetch<{ conflicts: PolicyConflict[] }>(
        `/api/authority/agent/${agentId}/policy-conflicts`
      ).catch(() => ({ conflicts: [] as PolicyConflict[] })),
    ])
      .then(([d, c]) => {
        setData(d)
        setPolicyConflicts(c.conflicts || [])
        setLoading(false)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Unknown error')
        setLoading(false)
      })
  }

  useEffect(() => {
    loadData()
  }, [agentId])

  // Auto-scroll to policies section when ?tab=policies
  useEffect(() => {
    if (searchParams.get('tab') === 'policies' && policySectionRef.current && data) {
      setActiveTab('policies')
      setTimeout(
        () =>
          policySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        200
      )
    }
  }, [searchParams, data])

  useEffect(() => {
    if (!showRecsMenu) return
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.apply-recs-wrapper')) setShowRecsMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showRecsMenu])

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    setEditSaving(true)
    try {
      await apiFetch(`/api/authority/agent/${agentId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName, description: editDesc }),
      })
      toast('Agent updated')
      setEditMode(false)
      loadData({ soft: true })
    } catch (err: unknown) {
      toast(
        'Failed to update: ' + (err instanceof Error ? err.message : 'Unknown error'),
        'error'
      )
    }
    setEditSaving(false)
  }

  const handleToggleDefaultEffect = async () => {
    if (!data) return
    const next = data.agent.default_effect === 'DENY' ? 'ALLOW' : 'DENY'
    setDefaultEffectSaving(true)
    try {
      await apiFetch(`/api/authority/agent/${agentId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: data.agent.name,
          description: data.agent.description,
          default_effect: next,
        }),
      })
      toast(
        next === 'DENY'
          ? 'Fail-closed on — actions with no matching policy are now blocked'
          : 'Fail-closed off — unmatched actions are allowed again'
      )
      loadData({ soft: true })
    } catch (err: unknown) {
      toast(
        'Failed to update: ' + (err instanceof Error ? err.message : 'Unknown error'),
        'error'
      )
    }
    setDefaultEffectSaving(false)
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    try {
      await apiFetch(`/api/authority/agent/${agentId}`, { method: 'DELETE' })
      toast('Agent deleted')
      navigate('/')
    } catch (err: unknown) {
      toast(
        'Failed to delete: ' + (err instanceof Error ? err.message : 'Unknown error'),
        'error'
      )
    }
  }

  const handleAddPolicy = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPatterns.length === 0) return
    const validConditions = newConditions.filter((c) =>
      c.op === 'requires_prior'
        ? c.value.trim()
        : (c.field?.trim() ?? '') && String(c.value).trim()
    )
    try {
      await Promise.all(
        newPatterns.map((pattern) =>
          apiFetch(`/api/authority/agent/${agentId}/policies`, {
            method: 'POST',
            body: JSON.stringify({
              action_pattern: pattern,
              effect: newEffect,
              reason: newReason,
              ...(validConditions.length > 0 && { conditions: validConditions }),
            }),
          })
        )
      )
      setNewPatterns([])
      setNewReason('')
      setNewConditions([])
      setShowConditions(false)
      setPolicyAdded(true)
      // Auto-dismiss the confirmation banner — it used to persist forever, even
      // after the policies were later deleted.
      window.setTimeout(() => setPolicyAdded(false), 4000)
      toast(`${newPatterns.length} polic${newPatterns.length !== 1 ? 'ies' : 'y'} added`)
      loadData({ soft: true })
    } catch (err: unknown) {
      toast(
        'Failed to add policy: ' + (err instanceof Error ? err.message : 'Unknown error'),
        'error'
      )
    }
  }

  const getPoliciesForRec = (rec: Recommendation, agentTools: AgentTool[]): string[] => {
    const desc = rec.description.toLowerCase()
    const tokens: string[] = rec.description.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []
    const fallbackRe = /delete|terminate|cancel|charge|refund|send_email|send_template/
    return agentTools.flatMap((t) =>
      t.actions
        .filter((a) => {
          // 1) exact snake_case token match; 2) action name mentioned verbatim
          //    (case-insensitive) — catches CamelCase delegation actions like
          //    "ToFlightBookingAssistant" that the snake_case regex misses;
          //    3) keyword fallback only when the description names no action.
          if (tokens.includes(a.action)) return true
          if (desc.includes(a.action.toLowerCase())) return true
          return tokens.length === 0 && fallbackRe.test(a.action)
        })
        .map((a) => `${t.name}.${a.action}`)
    )
  }

  const handleApplyAll = async (
    recs: Array<{ r: Recommendation; i: number }>,
    currentPolicies: Policy[],
    agentTools: AgentTool[]
  ) => {
    setApplyingRecs(true)
    const existingPatterns = new Set((currentPolicies || []).map((p) => p.action_pattern))
    const toCreate = new Set<string>()
    recs.forEach(({ r }) => {
      getPoliciesForRec(r, agentTools).forEach((p) => {
        if (!existingPatterns.has(p)) toCreate.add(p)
      })
    })
    if (toCreate.size === 0) {
      toast('All recommendations already applied')
      setAppliedRecIndices((prev) => new Set([...prev, ...recs.map(({ i }) => i)]))
      setApplyingRecs(false)
      return
    }
    try {
      await Promise.all(
        [...toCreate].map((pattern) =>
          apiFetch(`/api/authority/agent/${agentId}/policies`, {
            method: 'POST',
            body: JSON.stringify({
              action_pattern: pattern,
              effect: 'REQUIRE_APPROVAL',
              reason: 'Auto-applied from recommendations',
            }),
          })
        )
      )
      toast(`Applied ${toCreate.size} polic${toCreate.size !== 1 ? 'ies' : 'y'}`)
      setAppliedRecIndices((prev) => new Set([...prev, ...recs.map(({ i }) => i)]))
      loadData({ soft: true })
    } catch (err: unknown) {
      toast('Failed: ' + (err instanceof Error ? err.message : 'Unknown error'), 'error')
    }
    setApplyingRecs(false)
  }

  const handleApplySelected = async (
    recs: Array<{ r: Recommendation; i: number }>,
    currentPolicies: Policy[],
    agentTools: AgentTool[]
  ) => {
    setApplyingRecs(true)
    const existingPatterns = new Set((currentPolicies || []).map((p) => p.action_pattern))
    const toCreate = new Set<string>()
    recs.forEach(({ r, i }) => {
      if (selectedRecs.has(i)) {
        getPoliciesForRec(r, agentTools).forEach((p) => {
          if (!existingPatterns.has(p)) toCreate.add(p)
        })
      }
    })
    if (toCreate.size === 0) {
      toast('All selected policies are already applied')
      setAppliedRecIndices((prev) => new Set([...prev, ...selectedRecs]))
      setApplyingRecs(false)
      setShowRecsMenu(false)
      return
    }
    try {
      await Promise.all(
        [...toCreate].map((pattern) =>
          apiFetch(`/api/authority/agent/${agentId}/policies`, {
            method: 'POST',
            body: JSON.stringify({
              action_pattern: pattern,
              effect: 'REQUIRE_APPROVAL',
              reason: 'Auto-applied from recommendations',
            }),
          })
        )
      )
      toast(`Applied ${toCreate.size} polic${toCreate.size !== 1 ? 'ies' : 'y'}`)
      setAppliedRecIndices((prev) => new Set([...prev, ...selectedRecs]))
      loadData({ soft: true })
      setShowRecsMenu(false)
    } catch (err: unknown) {
      toast('Failed: ' + (err instanceof Error ? err.message : 'Unknown error'), 'error')
    }
    setApplyingRecs(false)
  }

  const handleDeletePolicy = async (policyId: string) => {
    try {
      await apiFetch(`/api/authority/policy/${policyId}`, { method: 'DELETE' })
      toast('Policy removed')
      loadData({ soft: true })
    } catch (err: unknown) {
      toast(
        'Failed to delete policy: ' + (err instanceof Error ? err.message : 'Unknown error'),
        'error'
      )
    }
  }

  const handleChangeEffect = async (policy: Policy, newEffect: 'BLOCK' | 'REQUIRE_APPROVAL' | 'ALLOW') => {
    if (newEffect === policy.effect) return
    setChangingEffectId(policy.id)
    try {
      // POST the replacement FIRST, then DELETE the old one. There is no policy
      // PUT on the backend, and DELETE-then-POST loses the policy entirely if the
      // POST fails. A brief duplicate window is acceptable; data loss is not.
      await apiFetch(`/api/authority/agent/${agentId}/policies`, {
        method: 'POST',
        body: JSON.stringify({
          action_pattern: policy.action_pattern,
          effect: newEffect,
          reason: policy.reason,
          conditions: policy.conditions,
        }),
      })
      try {
        await apiFetch(`/api/authority/policy/${policy.id}`, { method: 'DELETE' })
      } catch {
        toast('Effect changed, but the old policy could not be removed — delete it manually', 'error')
        loadData({ soft: true })
        setChangingEffectId(null)
        return
      }
      toast('Policy updated')
      loadData({ soft: true })
    } catch (err: unknown) {
      toast('Failed: ' + (err instanceof Error ? err.message : 'Unknown error'), 'error')
    }
    setChangingEffectId(null)
  }

  // ── Loading / Error states ───────────────────────────────────────────────

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto" style={{ padding: 'var(--page-pad)' }}>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          All Agents
        </Link>
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <div className="w-8 h-8 border-2 border-gray-300 border-t-gray-900 rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading agent data…</p>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="max-w-5xl mx-auto" style={{ padding: 'var(--page-pad)' }}>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          All Agents
        </Link>
        <ErrorState title="Couldn't load this agent" message={error ?? 'This agent could not be found.'} onRetry={loadData} />
      </div>
    )
  }

  // ── Derived data ─────────────────────────────────────────────────────────

  const { agent, graph, blast_radius: br, chains, recommendations, policies, executions } = data
  const hasCriticalChains = chains.some((c) => c.severity === 'critical')
  const hasCriticalUnreviewed = hasCriticalChains &&
    !(policies || []).some((p) => p.effect === 'BLOCK' || p.effect === 'REQUIRE_APPROVAL')
  // Label floor: critical chains never display below Warning, even when the
  // per-action score is low — the score rates actions individually, chains
  // rate combinations.
  const scoreLevel = br.score < 40 && hasCriticalUnreviewed
    ? 'Action Required'
    : scoreBand(br.score, hasCriticalChains ? 1 : 0, br.band).label
  const scoreColor = br.score < 40 && hasCriticalChains ? 'var(--caution)' : scoreToColor(br.score)
  const ringR = 44
  const ringC = 2 * Math.PI * ringR
  const ringOffset = ringC * (1 - br.score / 100)

  const statItems = [
    {
      label: 'Total Actions',
      tooltip: 'Every individual API call or operation this agent can perform across all its connected tools.',
      value: br.total_actions,
      color: null as string | null,
      bg: null as string | null,
      riskKey: 'all',
    },
    {
      label: 'Move Money',
      tooltip: 'Charges, refunds, transfers, and subscription changes — any action that moves funds.',
      value: br.moves_money,
      color: riskLabelColor('moves_money'),
      bg: riskLabelBg('moves_money'),
      riskKey: 'moves_money',
    },
    {
      label: 'Touch PII',
      tooltip: 'Reads or writes personal data — names, emails, addresses, payment info, or any customer record.',
      value: br.touches_pii,
      color: riskLabelColor('touches_pii'),
      bg: riskLabelBg('touches_pii'),
      riskKey: 'touches_pii',
    },
    {
      label: 'Delete Data',
      tooltip: 'Permanently removes records, files, or data. Cannot be undone.',
      value: br.deletes_data,
      color: riskLabelColor('deletes_data'),
      bg: riskLabelBg('deletes_data'),
      riskKey: 'deletes_data',
    },
    {
      label: 'Send External',
      tooltip: 'Emails, messages, or webhooks sent to customers or third-party services outside your system.',
      value: br.sends_external,
      color: riskLabelColor('sends_external'),
      bg: riskLabelBg('sends_external'),
      riskKey: 'sends_external',
    },
    {
      label: 'Change Prod',
      tooltip: 'Edits to live configuration, infrastructure, or deployment settings.',
      value: br.changes_production,
      color: riskLabelColor('changes_production'),
      bg: riskLabelBg('changes_production'),
      riskKey: 'changes_production',
    },
    {
      label: 'Access control',
      tooltip: 'Can hand out or change who has access — grant roles, promote to admin, reset passwords, or issue API keys.',
      value: br.changes_access ?? 0,
      color: riskLabelColor('changes_access'),
      bg: riskLabelBg('changes_access'),
      riskKey: 'changes_access',
    },
    {
      label: 'Secrets',
      tooltip: 'Can read secrets, credentials, API keys, or environment variables.',
      value: br.reads_secrets ?? 0,
      color: riskLabelColor('reads_secrets'),
      bg: riskLabelBg('reads_secrets'),
      riskKey: 'reads_secrets',
    },
    {
      label: 'Log tampering',
      tooltip: 'Can turn off or delete logging, audit trails, or alerts — so its own actions go unrecorded.',
      value: br.evades_detection ?? 0,
      color: riskLabelColor('evades_detection'),
      bg: riskLabelBg('evades_detection'),
      riskKey: 'evades_detection',
    },
    {
      label: 'Bulk export',
      tooltip: 'Can pull data out in bulk — full exports or whole-table dumps, not one record at a time.',
      value: br.bulk_export ?? 0,
      color: riskLabelColor('bulk_export'),
      bg: riskLabelBg('bulk_export'),
      riskKey: 'bulk_export',
    },
    {
      label: 'Code exec',
      tooltip: 'Can run arbitrary code, shell commands, or SQL — effectively unlimited reach.',
      value: br.executes_code ?? 0,
      color: riskLabelColor('executes_code'),
      bg: riskLabelBg('executes_code'),
      riskKey: 'executes_code',
    },
    {
      label: 'Irreversible',
      tooltip: 'Actions that cannot be undone — includes permanent deletions, charges, and outbound sends.',
      value: br.irreversible_actions,
      color: null as string | null,
      bg: null as string | null,
      riskKey: 'irreversible',
    },
  ]
  // Anchors (Total, Irreversible) always show. Categories cap at the top 4 by
  // value until expanded — a 10-column rainbow row is unscannable. The active
  // filter is never hidden by the cap.
  const MAX_COLLAPSED_CATEGORIES = 4
  const categoryStats = statItems.slice(1, -1).filter((s) => s.value > 0)
  const shownCategories = (() => {
    if (statsExpanded || categoryStats.length <= MAX_COLLAPSED_CATEGORIES) return categoryStats
    const top = [...categoryStats].sort((a, b) => b.value - a.value).slice(0, MAX_COLLAPSED_CATEGORIES)
    const keep = new Set(top.map((s) => s.riskKey))
    if (activeStatFilter) keep.add(activeStatFilter)
    return categoryStats.filter((s) => keep.has(s.riskKey))
  })()
  const hiddenStatCount = categoryStats.length - shownCategories.length
  const showStatsToggle = statsExpanded || hiddenStatCount > 0
  const visibleStats = [statItems[0], ...shownCategories, statItems[statItems.length - 1]]

  const noPolicyCount =
    executions?.filter((e) => e.detail === 'No matching policy').length || 0
  const allUnpolicied = executions?.length > 0 && noPolicyCount === executions.length

  const EFFECT_ORDER: Record<string, number> = { BLOCK: 0, REQUIRE_APPROVAL: 1, ALLOW: 2 }
  const sortedPolicies = [...(policies || [])].sort(
    (a, b) => (EFFECT_ORDER[a.effect] ?? 3) - (EFFECT_ORDER[b.effect] ?? 3)
  )
  const policyEffectCounts = sortedPolicies.reduce<Record<string, number>>((acc, p) => {
    acc[p.effect] = (acc[p.effect] || 0) + 1
    return acc
  }, {})
  const allSamePolicyReason =
    sortedPolicies.length > 1 &&
    sortedPolicies.every((p) => p.reason === sortedPolicies[0]?.reason)
      ? sortedPolicies[0]?.reason
      : null

  const existingPolicyPatterns = new Set((policies || []).map((p) => p.action_pattern))
  const visibleRecs = recommendations
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => {
      if (appliedRecIndices.has(i)) return false
      const tokens: string[] = r.description.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []
      const fallbackRe = /delete|terminate|cancel|charge|refund|send_email|send_template/
      const needed = agent.tools.flatMap((t) =>
        t.actions
          .filter((a) =>
            tokens.length > 0 ? tokens.includes(a.action) : fallbackRe.test(a.action)
          )
          .map((a) => `${t.name}.${a.action}`)
      )
      if (needed.length === 0) return true
      return !needed.every((p) => existingPolicyPatterns.has(p))
    })
    .sort(
      (a, b) =>
        (a.r.severity === 'critical' ? -1 : 1) - (b.r.severity === 'critical' ? -1 : 1)
    )

  const hasCriticalChain = chains.some((c) => c.severity === 'critical')

  const TABS = [
    { id: 'graph' as const, label: 'Tool Map', dot: false },
    { id: 'policies' as const, label: 'Policies', count: sortedPolicies.length, dot: false },
    { id: 'executions' as const, label: 'Executions', count: executions?.length ?? 0, dot: false },
    { id: 'chains' as const, label: 'Chains', count: chains.length, dot: hasCriticalChain },
  ]

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto" style={{ padding: 'var(--page-pad)' }}>
      {/* Top bar */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          All Agents
        </Link>
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to={`/sandbox?agent=${agentId}`}
            className="inline-flex items-center gap-1.5 hover:opacity-80 transition-opacity"
            style={{ background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '8px 20px', fontWeight: 600, fontSize: 13 }}
          >
            Simulate in Sandbox
          </Link>
          {confirmDelete && (
            <>
              <span className="text-xs text-gray-500">Are you sure?</span>
              <button
                style={{ background: 'var(--severity-critical)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '7px 16px', fontWeight: 600, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
                className="hover:opacity-80 transition-opacity"
                onClick={handleDelete}
              >
                Yes, delete
              </button>
              <button
                style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '7px 16px', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
                className="hover:opacity-70 transition-opacity"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
            </>
          )}
          {!editMode && !confirmDelete && (
            <div className="relative">
              <button
                type="button"
                aria-label="More actions"
                onClick={() => setHeaderMenuOpen((v) => !v)}
                style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-full)', width: 34, height: 34, fontFamily: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                className="hover:opacity-70 transition-opacity"
              >
                <MoreHorizontal size={16} />
              </button>
              {headerMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setHeaderMenuOpen(false)} />
                  <div
                    className="absolute right-0 top-full mt-2 z-50"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', minWidth: 160, padding: 4 }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setEditName(agent.name)
                        setEditDesc(agent.description)
                        setEditMode(true)
                        setHeaderMenuOpen(false)
                      }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 13, color: 'var(--text-primary)', background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-sm)', fontFamily: 'inherit' }}
                      className="hover:bg-gray-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMenuOpen(false)
                        handleDelete()
                      }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 13, color: 'var(--severity-critical)', background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-sm)', fontFamily: 'inherit' }}
                      className="hover:bg-red-50"
                    >
                      Delete agent
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Header card */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          {editMode ? (
            <form className="flex-1 space-y-2" onSubmit={handleEdit}>
              <input
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 16px', height: '42px', width: '100%', fontSize: 16, fontWeight: 600, fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                aria-label="Agent name"
                placeholder="Agent name"
                required
              />
              <input
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 16px', height: '42px', width: '100%', fontSize: 13, fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                aria-label="Description"
                placeholder="Description"
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  style={{ background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '8px 20px', fontWeight: 600, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
                  className="hover:opacity-80 transition-opacity disabled:opacity-50"
                  disabled={editSaving || !editName.trim()}
                >
                  {editSaving ? 'Saving…' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '7px 16px', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
                  className="hover:opacity-70 transition-opacity"
                  onClick={() => setEditMode(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="flex-1 min-w-0">
              <h1 className="mb-1" style={{ fontSize: 'var(--fs-page)', fontWeight: 600, color: 'var(--ink-900)' }}>{agent.name}</h1>
              <p className="text-sm text-gray-500 mb-3">{agent.description}</p>
              <div className="flex flex-wrap gap-1.5">
                {agent.tools.map((t) => {
                  const isActive = selectedGraphService === t.name
                  return (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => {
                        const next = isActive ? null : t.name
                        setSelectedGraphService(next)
                        setActiveTab('graph')
                      }}
                      style={{
                        padding: '4px 10px', fontSize: 12, fontWeight: isActive ? 600 : 500,
                        fontFamily: 'inherit', borderRadius: 999, cursor: 'pointer',
                        border: isActive ? '1.5px solid var(--text-primary)' : '1px solid var(--border)',
                        background: isActive ? 'var(--text-primary)' : 'var(--bg-sunken)',
                        color: isActive ? 'white' : 'var(--text-secondary)',
                        transition: 'background 120ms, color 120ms, border-color 120ms',
                      }}
                    >
                      {t.service}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <Tooltip content={RISK_SCORE_METHODOLOGY}>
            <div
              className="flex flex-col items-center flex-shrink-0 cursor-help"
              style={{ color: scoreColor }}
            >
              <div className="relative w-24 h-24">
                <svg viewBox="0 0 110 110" className="w-full h-full">
                  <circle
                    cx="55"
                    cy="55"
                    r={ringR}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="7"
                    opacity="0.12"
                  />
                  <circle
                    cx="55"
                    cy="55"
                    r={ringR}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="7"
                    strokeDasharray={ringC}
                    strokeDashoffset={ringOffset}
                    strokeLinecap="round"
                    transform="rotate(-90 55 55)"
                    style={{
                      transition: 'stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-2xl font-bold leading-none mono">{br.score}</span>
                </div>
              </div>
              <div className="text-xs font-medium mt-1">Risk Score</div>
              <div className="text-xs opacity-80">{scoreLevel}</div>
            </div>
          </Tooltip>
        </div>

        <div
          className="grid mt-6"
          style={{ gridTemplateColumns: `repeat(${visibleStats.length + (showStatsToggle ? 1 : 0)}, 1fr)` }}
        >
          {visibleStats.map((s) => {
            const clickable = s.value > 0
            const isActive = activeStatFilter === s.riskKey
            return (
              <div key={s.label} className="flex flex-col items-center gap-0.5 text-center">
                <button
                  type="button"
                  disabled={!clickable}
                  aria-pressed={clickable ? isActive : undefined}
                  onClick={() => setActiveStatFilter(isActive ? null : s.riskKey)}
                  style={{
                    background: isActive ? (s.bg ?? 'var(--paper-2)') : 'transparent',
                    border: isActive ? `1.5px solid ${s.color ?? 'var(--ink-700)'}` : '1.5px solid transparent',
                    borderRadius: 6, padding: '2px 8px',
                    cursor: clickable ? 'pointer' : 'default',
                    color: s.color ?? 'inherit',
                    transition: 'background 120ms, border-color 120ms',
                  }}
                  className="text-lg font-bold leading-snug hover:opacity-80"
                >
                  {s.value}
                </button>
                <span className="text-xs text-gray-500 flex items-center gap-0.5">
                  {s.label}
                  {s.tooltip && (
                    <Tooltip text={s.tooltip}>
                      <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-xs bg-gray-200 text-gray-600 rounded-full cursor-help ml-0.5">
                        ?
                      </span>
                    </Tooltip>
                  )}
                </span>
              </div>
            )
          })}
          {showStatsToggle && (
            <div className="flex flex-col items-center justify-center">
              <button
                type="button"
                onClick={() => setStatsExpanded(!statsExpanded)}
                aria-expanded={statsExpanded}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent-ink)',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: '4px 8px',
                  borderRadius: 6,
                  fontFamily: 'var(--font-sans)',
                }}
              >
                {statsExpanded ? 'Show less' : `+${hiddenStatCount} more`}
              </button>
            </div>
          )}
        </div>

        {/* Coverage caveat — the score is only as good as our catalog coverage */}
        {br.coverage && br.coverage.totalActions > 0 && br.coverage.recognizedActions < br.coverage.totalActions && (
          <div className="mt-4 text-xs flex items-start gap-1.5 opacity-90" style={{ lineHeight: 1.45 }}>
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              {br.coverage.totalActions - br.coverage.recognizedActions} of {br.coverage.totalActions} actions run on tools outside our risk catalog
              {br.coverage.unrecognizedTools.length > 0 ? ` (${br.coverage.unrecognizedTools.join(', ')})` : ''} and were classified heuristically — this score may understate true exposure.
            </span>
          </div>
        )}

        {/* Unclassifiable actions — vague names the classifier had NO signal for.
            They contribute 0 to the score while their true risk is unknown:
            surfacing them is the honest alternative to silently scoring them safe. */}
        {br.coverage && (br.coverage.unclassifiedActions ?? 0) > 0 && (
          <div className="mt-2 text-xs flex items-start gap-1.5" style={{ lineHeight: 1.45, color: 'var(--high)' }}>
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              {br.coverage.unclassifiedActions} {(br.coverage.unclassifiedActions ?? 0) === 1 ? 'action' : 'actions'} could not be classified at all
              {(br.coverage.unclassifiedList?.length ?? 0) > 0 ? ` (${br.coverage.unclassifiedList!.slice(0, 3).join(', ')}${br.coverage.unclassifiedList!.length > 3 ? ', …' : ''})` : ''} — the name and description carry no risk signal, so these score 0 while their true risk is unknown. Verify them manually.
            </span>
          </div>
        )}

        {/* Stat drill-down panel */}
        {activeStatFilter && (() => {
          const stat = visibleStats.find((s) => s.riskKey === activeStatFilter)
          const matchingActions = agent.tools.flatMap((t) =>
            t.actions
              .filter((a) =>
                activeStatFilter === 'all'
                  ? true
                  : activeStatFilter === 'irreversible'
                  ? a.reversible === false
                  : a.risk_labels.includes(activeStatFilter)
              )
              .map((a) => ({ service: t.service || t.name, toolName: t.name, action: a.action, labels: a.risk_labels, reversible: a.reversible }))
          )
          const byService = matchingActions.reduce<Record<string, typeof matchingActions>>((acc, a) => {
            if (!acc[a.service]) acc[a.service] = []
            acc[a.service].push(a)
            return acc
          }, {})
          return (
            <div className="mt-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold" style={{ color: stat?.color ?? 'var(--text-primary)' }}>
                  {stat?.label} — {matchingActions.length} action{matchingActions.length !== 1 ? 's' : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setActiveStatFilter(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, lineHeight: 1 }}
                  className="hover:opacity-70"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="space-y-2">
                {Object.entries(byService).map(([service, actions]) => (
                  <div key={service}>
                    <div className="font-semibold text-gray-400 uppercase tracking-wide mb-1" style={{ fontSize: 'var(--fs-micro)' }}>{service}</div>
                    <div className="flex flex-wrap gap-1">
                      {actions.map((a) => (
                        <span
                          key={a.toolName + '.' + a.action}
                          style={{
                            fontSize: 11,
                            background: stat?.bg ?? 'var(--bg-sunken)',
                            color: stat?.color ?? 'var(--text-primary)',
                            border: `1px solid ${stat?.color ?? 'var(--border)'}`,
                            borderRadius: 4, padding: '2px 7px',
                          }}
                        >
                          {formatAction(a.action)}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })()}
      </div>

      {/* Worst Case Panel */}
      <WorstCasePanel
        br={br}
        chains={chains}
        policies={policies}
        agentId={agentId ?? ''}
        onScrollToPolicies={() => {
          setActiveTab('policies')
          setShowAddPolicyForm(true) // open the add-policy form so the click isn't a no-op
          setTimeout(
            () =>
              policySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
            50
          )
        }}
      />

      {agentId && (
        <details className="mb-4">
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 'var(--fs-small)',
              color: 'var(--ink-500)',
              width: 'fit-content',
              borderRadius: 6,
              padding: '2px 4px',
            }}
          >
            Deployment context — tune the score to where this agent actually runs
          </summary>
          <div style={{ marginTop: 8 }}>
            <DeploymentContextEditor
              agentId={agentId}
              context={br.exposure_context}
              onSaved={loadData}
            />
          </div>
        </details>
      )}

      {/* Tab bar */}
      <Tabs
        tabs={TABS}
        active={activeTab}
        onChange={(id) => {
          setActiveTab(id)
          if (id !== 'graph') setSelectedGraphService(null)
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev)
              next.set('tab', id)
              return next
            },
            { replace: true }
          )
        }}
        style={{ margin: '0 0 16px' }}
      />

      {activeTab === 'graph' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800 flex items-center gap-1.5" style={{ fontSize: 'var(--fs-title)' }}>
              Tool Map
              <Tooltip text="A complete map of every tool and action this agent has access to, grouped by service and color-coded by risk level.">
                <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-xs bg-gray-200 text-gray-600 rounded-full cursor-help">
                  ?
                </span>
              </Tooltip>
            </h2>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-gray-300 inline-block" /> Safe
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Risky
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Irreversible
              </span>
            </div>
          </div>
          <AuthorityMap graph={graph} serviceFilter={selectedGraphService} />
        </div>
      )}

      {/* ── Tab: Policies ── */}
      {activeTab === 'policies' && (
        <div
          className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6 relative z-10"
          ref={policySectionRef}
        >
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-semibold text-gray-800 flex items-center gap-1.5" style={{ fontSize: 'var(--fs-title)' }}>
              Enforcement Policies ({sortedPolicies.length})
              <Tooltip text="Rules that tell Arceo what to do when this agent attempts specific actions — block them outright, require a human to approve first, or explicitly allow them.">
                <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-xs bg-gray-200 text-gray-600 rounded-full cursor-help">
                  ?
                </span>
              </Tooltip>
            </h2>
            <div className="flex items-center gap-3">
              {/* Opt-in fail-closed posture: unmatched actions BLOCK instead of
                  the implicit allow. Off by default so no agent goes dark. */}
              <label
                className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none"
                title="With this on, any action no policy matches is blocked instead of implicitly allowed."
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={data.agent.default_effect === 'DENY'}
                  disabled={defaultEffectSaving}
                  onClick={handleToggleDefaultEffect}
                  className="relative inline-flex flex-shrink-0 rounded-full transition-colors border-0 cursor-pointer"
                  style={{
                    background: data.agent.default_effect === 'DENY' ? 'var(--accent)' : 'var(--ink-300)',
                    height: 18,
                    width: 32,
                    opacity: defaultEffectSaving ? 0.6 : 1,
                  }}
                >
                  <span
                    className="absolute top-0.5 rounded-full bg-white"
                    style={{
                      width: 14,
                      height: 14,
                      left: data.agent.default_effect === 'DENY' ? 16 : 2,
                      transition: 'left 0.15s',
                    }}
                  />
                </button>
                Deny unmatched actions (fail closed)
              </label>
              <div className="flex gap-1.5">
              {policyEffectCounts['BLOCK'] > 0 && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{ background: 'var(--critical-bg)', color: 'var(--critical)' }}
                >
                  {policyEffectCounts['BLOCK']} Block
                </span>
              )}
              {policyEffectCounts['REQUIRE_APPROVAL'] > 0 && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{ background: 'var(--high-bg)', color: 'var(--high)' }}
                >
                  {policyEffectCounts['REQUIRE_APPROVAL']} Require approval
                </span>
              )}
              {policyEffectCounts['ALLOW'] > 0 && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{ background: 'var(--safe-bg)', color: 'var(--safe)' }}
                >
                  {policyEffectCounts['ALLOW']} Allow
                </span>
              )}
              </div>
            </div>
          </div>

          {allSamePolicyReason && (
            <p className="text-xs text-gray-500 mb-2 italic">
              Auto-applied from scan — review and adjust below.
            </p>
          )}

          {/* Policy conflict banner */}
          {policyConflicts.length > 0 && (
            <div className="flex gap-3 p-3 mb-3 bg-amber-50 border border-amber-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="space-y-1 min-w-0">
                <div className="text-sm font-medium text-amber-900">
                  {policyConflicts.length} policy conflict
                  {policyConflicts.length !== 1 ? 's' : ''} detected
                </div>
                <div className="text-xs text-amber-700">
                  Overlapping rules — only the highest-priority policy applies per action.
                </div>
                <div className="space-y-1 mt-1">
                  {policyConflicts.slice(0, 3).map((c, i) => {
                    const aWins = c.policy_a?.id === c.winner?.id
                    const winnerPattern = (aWins ? c.policy_a : c.policy_b)?.pattern
                    const loserPattern = (aWins ? c.policy_b : c.policy_a)?.pattern
                    return (
                    <div key={i} className="flex items-center gap-2 text-xs flex-wrap">
                      <code className="px-1.5 py-0.5 bg-white border border-amber-200 rounded text-amber-800">
                        {winnerPattern || '—'}
                      </code>
                      <span className="text-amber-500">overrides</span>
                      <code className="px-1.5 py-0.5 bg-white border border-amber-200 rounded text-amber-800">
                        {loserPattern || '—'}
                      </code>
                    </div>
                    )
                  })}
                  {policyConflicts.length > 3 && (
                    <span className="text-xs text-amber-600">
                      +{policyConflicts.length - 3} more
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Zero policies callout */}
          {sortedPolicies.length === 0 && (
            <div className="flex gap-3 p-3 mb-3 bg-amber-50 border border-amber-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-medium text-amber-900">
                  No enforcement rules set
                </div>
                <div className="text-xs text-amber-700 mt-0.5">
                  This agent runs with no restrictions. Add a policy below to block or require
                  approval for risky actions.
                </div>
              </div>
            </div>
          )}

          {/* Policies list */}
          <div className="space-y-2 mb-4">
            {sortedPolicies.map((p) => {
              const es = EFFECT_STYLE[p.effect] || EFFECT_STYLE['BLOCK']
              const { service, action } = parsePolicyPattern(p.action_pattern)
              return (
                <div
                  key={p.id}
                  className="flex items-start gap-3 p-3 border border-gray-100 rounded-lg"
                  style={{ borderLeftWidth: 3, borderLeftColor: es.color }}
                >
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        {service && (
                          <span className="text-xs text-gray-400 font-medium">{service}</span>
                        )}
                        {service && <span className="text-gray-300">›</span>}
                        <span className="text-sm font-medium text-gray-800">{action}</span>
                      </div>
                      <select
                        value={p.effect}
                        disabled={changingEffectId === p.id}
                        onChange={(e) => handleChangeEffect(p, e.target.value as 'BLOCK' | 'REQUIRE_APPROVAL' | 'ALLOW')}
                        style={{
                          background: es.bg, color: es.color,
                          border: `1px solid ${es.color}40`,
                          borderRadius: 999, padding: '2px 8px',
                          fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                          cursor: changingEffectId === p.id ? 'not-allowed' : 'pointer',
                          opacity: changingEffectId === p.id ? 0.6 : 1,
                          appearance: 'none', WebkitAppearance: 'none',
                          paddingRight: 20, backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='${encodeURIComponent(es.color)}' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
                          backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center',
                          flexShrink: 0,
                        }}
                      >
                        <option value="BLOCK">Block</option>
                        <option value="REQUIRE_APPROVAL">Approval</option>
                        <option value="ALLOW">Allow</option>
                      </select>
                    </div>
                    {!allSamePolicyReason && p.reason && (
                      <p className="text-xs text-gray-500">{p.reason}</p>
                    )}
                    {p.conditions && p.conditions.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {p.conditions.map((c, ci) => (
                          <span
                            key={ci}
                            className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded border border-gray-200"
                          >
                            {c.op === 'requires_prior'
                              ? `if prior: ${c.value}`
                              : `${c.field} ${c.op} ${c.value}`}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {confirmDeleteId === p.id ? (
                    <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                      <button
                        className="text-xs font-semibold text-red-600 hover:text-red-800 transition-colors"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        onClick={() => { setConfirmDeleteId(null); handleDeletePolicy(p.id) }}
                      >
                        Confirm
                      </button>
                      <span className="text-gray-300">·</span>
                      <button
                        className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      className="text-xs text-red-400 hover:text-red-600 transition-colors flex-shrink-0 mt-0.5 font-medium"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                      onClick={() => setConfirmDeleteId(p.id)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {/* Add policy form */}
          <div className="border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={() => setShowAddPolicyForm((v) => !v)}
              style={{ background: 'none', border: '1.5px dashed var(--border)', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontFamily: 'inherit', color: 'var(--text-secondary)', cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: showAddPolicyForm ? 16 : 0 }}
              className="hover:border-gray-400 hover:text-gray-700 transition-colors"
            >
              {showAddPolicyForm ? <X size={14} /> : <Plus size={14} />}
              {showAddPolicyForm ? 'Cancel' : '+ Add Policy'}
            </button>
            {showAddPolicyForm && <form className="space-y-3" onSubmit={handleAddPolicy}>
              <div>
                <div className="font-semibold text-gray-500 uppercase tracking-wide mb-1.5" style={{ fontSize: 'var(--fs-micro)' }}>
                  1. Choose actions
                </div>
                <ActionPicker
                  tools={agent.tools}
                  selectedPatterns={newPatterns}
                  onAdd={addPattern}
                />
              </div>

              {newPatterns.length > 0 && (
                <div className="flex flex-wrap gap-1.5 items-center">
                  {newPatterns.map((p) => {
                    const isWildcard = p.endsWith('.*')
                    const { service, action } = parsePolicyPattern(p)
                    const dot = p.indexOf('.')
                    const toolName = dot !== -1 ? p.slice(0, dot) : p
                    const actionName = dot !== -1 ? p.slice(dot + 1) : ''
                    const tool = agent.tools.find((t) => t.name === toolName)
                    const actionObj = isWildcard
                      ? null
                      : tool?.actions.find((a) => a.action === actionName)
                    const isIrrev = actionObj?.reversible === false
                    const riskLabels = actionObj?.risk_labels || []
                    return (
                      <span
                        key={p}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 border border-blue-200 rounded-lg text-sm"
                      >
                        {service && (
                          <span className="text-xs text-blue-400 font-medium">{service}</span>
                        )}
                        {service && <span className="text-blue-300">›</span>}
                        <span className="text-blue-700 font-medium">{action}</span>
                        {isWildcard && (
                          <span className="text-xs px-1 bg-gray-100 text-gray-500 rounded">
                            wildcard
                          </span>
                        )}
                        {isIrrev && (
                          <span className="text-xs px-1 bg-red-100 text-red-600 rounded">
                            irreversible
                          </span>
                        )}
                        {!isIrrev && !isWildcard && riskLabels.length > 0 && (
                          <span className="text-xs px-1 bg-amber-100 text-amber-600 rounded">
                            risky
                          </span>
                        )}
                        <button
                          type="button"
                          className="text-blue-400 hover:text-red-500 transition-colors ml-0.5"
                          onClick={() => removePattern(p)}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    )
                  })}
                  {newPatterns.length > 1 && (
                    <button
                      type="button"
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                      onClick={() => setNewPatterns([])}
                    >
                      Clear all
                    </button>
                  )}
                </div>
              )}

              {newPatterns.some((p) => p.endsWith('.*')) && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Wildcard patterns apply to <strong>all actions</strong> in that service.
                </p>
              )}

              <div>
                <div className="font-semibold text-gray-500 uppercase tracking-wide mb-1.5" style={{ fontSize: 'var(--fs-micro)' }}>
                  2. Set enforcement
                </div>
                <EffectToggle value={newEffect} onChange={setNewEffect} />
              </div>

              <input
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 16px', height: '42px', width: '100%', fontSize: 13, fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                aria-label="Reason"
                placeholder={
                  newEffect === 'BLOCK'
                    ? 'Why should this be blocked? (e.g. No refunds over $500 without manager sign-off)'
                    : newEffect === 'REQUIRE_APPROVAL'
                    ? 'When should this require approval? (e.g. Any charge over $100 or from a new customer)'
                    : 'Reason (optional)'
                }
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
                required={newEffect !== 'ALLOW'}
              />

              <div>
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                  onClick={() => setShowConditions((v) => !v)}
                >
                  {showConditions ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                  Conditions (optional)
                  {newConditions.length > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded-full text-xs font-medium">
                      {newConditions.length}
                    </span>
                  )}
                </button>
                {showConditions && (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-gray-500">
                      Only trigger this policy when specific parameters match — e.g. only block
                      charges over $500, or only require approval for new customers.
                    </p>
                    <ConditionBuilder
                      conditions={newConditions}
                      onChange={setNewConditions}
                    />
                  </div>
                )}
              </div>

              <button
                type="submit"
                style={{ background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '10px 20px', fontWeight: 600, fontSize: 13, width: '100%', fontFamily: 'inherit', cursor: 'pointer' }}
                className="hover:opacity-80 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={
                  newPatterns.length === 0 || (newEffect !== 'ALLOW' && !newReason.trim())
                }
              >
                {newPatterns.length > 1
                  ? `Add ${newPatterns.length} Policies`
                  : 'Add Policy'}
              </button>
            </form>}

            {policyAdded && (
              <div className="flex items-center gap-2 mt-3 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                <Check className="w-4 h-4 text-green-600 flex-shrink-0" />
                <span>
                  Policies saved — they&apos;ll be enforced on your next simulation run.
                </span>
                <Link
                  to="/sandbox"
                  className="ml-auto text-xs font-medium text-green-700 hover:underline flex-shrink-0"
                >
                  Run in Sandbox
                </Link>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Tab: Executions ── */}
      {activeTab === 'executions' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6">
          <h2 className="font-semibold text-gray-800 mb-3" style={{ fontSize: 'var(--fs-title)' }}>
            Recent Executions ({executions?.length ?? 0})
          </h2>

          {(!executions || executions.length === 0) && (
            <div className="text-sm text-gray-400 text-center py-8">No executions yet.</div>
          )}

          {allUnpolicied && executions && (
            <div className="flex gap-2 p-3 mb-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
              <div>
                None of these {executions.length} executions matched a policy — this agent runs
                with no enforcement rules.
                <span className="block text-xs text-amber-600 mt-0.5">
                  Use the Policies tab above to block or require approval for risky actions.
                </span>
              </div>
            </div>
          )}

          <div className="space-y-1">
            {executions?.slice(0, 20).map((e) => {
              const st = EXEC_STATUS_STYLE[e.status] ?? {}
              const dot = actionRiskDot(e.tool, e.action)
              const statusLabel =
                e.status === 'PENDING_APPROVAL'
                  ? 'Pending'
                  : e.status.charAt(0) + e.status.slice(1).toLowerCase()
              return (
                <div
                  key={e.id}
                  className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <span className="text-xs text-gray-400 w-24 flex-shrink-0">
                    {formatExecTime(e.timestamp)}
                  </span>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: dot }}
                    />
                    <span className="text-sm font-medium text-gray-700 flex-shrink-0">
                      {e.tool.charAt(0).toUpperCase() + e.tool.slice(1)}
                    </span>
                    <span className="text-sm text-gray-500 truncate">
                      {formatAction(e.action)}
                    </span>
                  </div>
                  <span
                    className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0"
                    style={{ background: (st as { bg?: string }).bg, color: (st as { color?: string }).color }}
                  >
                    {statusLabel}
                  </span>
                  {!allUnpolicied && e.detail && (
                    <span className="text-xs text-gray-400 flex-shrink-0 max-w-[8rem] truncate">
                      {e.detail}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Tab: Chains ── */}
      {activeTab === 'chains' && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-semibold text-gray-800 flex items-center gap-1.5" style={{ fontSize: 'var(--fs-title)' }}>
              Dangerous Chains ({chains.length})
              <Tooltip text="Multi-step sequences where two or more of this agent's capabilities combine to create elevated risk — e.g. accessing customer PII then emailing it externally.">
                <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-xs bg-gray-200 text-gray-600 rounded-full cursor-help">
                  ?
                </span>
              </Tooltip>
            </h2>
            <div className="flex gap-1.5">
              {chains.filter((c) => c.severity === 'critical').length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-600">
                  {chains.filter((c) => c.severity === 'critical').length} Critical
                </span>
              )}
              {chains.filter((c) => c.severity === 'high').length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-orange-50 text-orange-600">
                  {chains.filter((c) => c.severity === 'high').length} High
                </span>
              )}
            </div>
          </div>

          {chains.length === 0 && (
            <div className="text-sm text-gray-400 text-center py-8">
              No dangerous chains detected.
            </div>
          )}

          <div className="space-y-2">
            {chains.map((c) => {
              const sev = SEV_STYLE[c.severity] || SEV_STYLE['high']
              const isOpen = !collapsedChains[c.id]
              return (
                <div
                  key={c.id}
                  className="border border-gray-200 rounded-xl overflow-hidden"
                  style={{ borderLeftWidth: 3, borderLeftColor: sev.color }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
                    onClick={() => toggleChain(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        if (e.key === ' ') e.preventDefault()
                        toggleChain(c.id)
                      }
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="text-xs px-1.5 py-0.5 rounded font-medium capitalize"
                        style={{ background: sev.bg, color: sev.color }}
                      >
                        {c.severity}
                      </span>
                      <strong className="text-sm text-gray-800">{c.name}</strong>
                      {c.demonstrated ? (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-medium"
                          style={{ background: 'var(--safe-bg)', color: 'var(--safe)' }}
                          title="Confirmed in a sandbox run — data flowed between the steps."
                        >
                          Demonstrated
                        </span>
                      ) : br.evidence?.hasSim ? (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-medium"
                          style={{ background: 'var(--paper-2)', color: 'var(--ink-500)' }}
                          title="Not observed in the last sandbox run; flagged because the capability exists."
                        >
                          Possible
                        </span>
                      ) : (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-medium"
                          style={{ background: 'var(--paper-2)', color: 'var(--ink-500)' }}
                          title="Run a sandbox to confirm whether this chain actually fires."
                        >
                          Unverified
                        </span>
                      )}
                    </div>
                    {isOpen ? (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    )}
                  </div>

                  {isOpen && (
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-sm text-gray-600">{c.description}</p>

                      {!c.demonstrated && !br.evidence?.hasSim && (
                        <Link
                          to={`/sandbox?agent=${agentId ?? ''}`}
                          className="inline-block text-xs underline underline-offset-2 text-gray-700 hover:text-gray-900"
                        >
                          Run sandbox to confirm →
                        </Link>
                      )}

                      {/* Steps */}
                      <div className="flex items-center flex-wrap gap-1">
                        {c.steps.map((step, j) => (
                          <span key={j} className="flex items-center gap-1">
                            <span
                              className="text-xs px-2 py-0.5 rounded border font-medium"
                              style={{
                                borderColor: riskLabelColor(step as RiskLabel),
                                color: riskLabelColor(step as RiskLabel),
                                background: riskLabelBg(step as RiskLabel),
                              }}
                            >
                              {riskLabelName(step)}
                            </span>
                            {j < c.steps.length - 1 && (
                              <span className="text-gray-400 text-xs">→</span>
                            )}
                          </span>
                        ))}
                      </div>

                      {/* Matching actions */}
                      <div className="flex flex-wrap gap-2">
                        {c.matching_actions.map((group, gi) => {
                          const byService: Record<string, string[]> = {}
                          const order: string[] = []
                          group.forEach((a) => {
                            const dot = a.indexOf('.')
                            const svc = dot > -1 ? a.slice(0, dot) : a
                            const act = dot > -1 ? a.slice(dot + 1) : a
                            if (!byService[svc]) {
                              byService[svc] = []
                              order.push(svc)
                            }
                            byService[svc].push(act)
                          })
                          return (
                            <div
                              key={gi}
                              className="flex-1 min-w-0 p-2 bg-gray-50 rounded-lg border border-gray-100"
                            >
                              <div className="font-semibold text-gray-400 uppercase tracking-wide mb-1" style={{ fontSize: 'var(--fs-micro)' }}>
                                Step {gi + 1}
                              </div>
                              {order.map((svc) => (
                                <div
                                  key={svc}
                                  className="flex items-center flex-wrap gap-1 mt-1"
                                >
                                  <span className="text-xs font-medium text-gray-600">
                                    {svc.charAt(0).toUpperCase() + svc.slice(1)}
                                  </span>
                                  {byService[svc].map((a) => {
                                    const isDanger =
                                      /delete|terminate|drop|destroy|cancel|charge|refund/.test(
                                        a.toLowerCase()
                                      )
                                    return (
                                      <span
                                        key={a}
                                        className={`text-xs px-1.5 py-0.5 rounded ${
                                          isDanger
                                            ? 'bg-red-50 text-red-600 border border-red-200'
                                            : 'bg-gray-100 text-gray-600 border border-gray-200'
                                        }`}
                                      >
                                        {formatAction(a)}
                                      </span>
                                    )
                                  })}
                                </div>
                              ))}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Recommendations (always visible below tabs) ── */}
      {visibleRecs.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-semibold text-gray-800 flex items-center gap-1.5" style={{ fontSize: 'var(--fs-title)' }}>
              Recommendations ({visibleRecs.length})
              <Tooltip text="Policy suggestions auto-generated based on this agent's risk profile. Applying them adds enforcement rules to reduce your exposure.">
                <span className="inline-flex items-center justify-center w-3.5 h-3.5 text-xs bg-gray-200 text-gray-600 rounded-full cursor-help">
                  ?
                </span>
              </Tooltip>
            </h2>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex gap-1.5">
                {visibleRecs.filter(({ r }) => r.severity === 'critical').length > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-600">
                    {visibleRecs.filter(({ r }) => r.severity === 'critical').length} Critical
                  </span>
                )}
                {visibleRecs.filter(({ r }) => r.severity === 'high').length > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-orange-50 text-orange-600">
                    {visibleRecs.filter(({ r }) => r.severity === 'high').length} High
                  </span>
                )}
              </div>
              <div className="apply-recs-wrapper relative flex items-center gap-2">
                <button
                  style={{ background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '7px 18px', fontWeight: 600, fontSize: 13, fontFamily: 'inherit', cursor: applyingRecs ? 'not-allowed' : 'pointer', opacity: applyingRecs ? 0.7 : 1 }}
                  className="hover:opacity-80 transition-opacity"
                  disabled={applyingRecs}
                  onClick={() => handleApplyAll(visibleRecs, policies, agent.tools)}
                >
                  {applyingRecs ? 'Applying…' : 'Apply All'}
                </button>
                <button
                  style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '7px 14px', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
                  className="flex items-center gap-1 hover:opacity-70 transition-opacity"
                  onClick={() => {
                    // Open with nothing pre-checked — the user opts in per rec
                    // (pre-checking read as "already applied/approved"). "Select
                    // all" below is available if they want everything.
                    if (!showRecsMenu) setSelectedRecs(new Set())
                    setShowRecsMenu((v) => !v)
                  }}
                >
                  Choose which ones
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showRecsMenu ? 'rotate-180' : ''}`} />
                </button>
                {showRecsMenu && (
                  <div className="absolute right-0 top-full mt-1 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-20">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
                      <span className="text-xs font-medium text-gray-600">Select to apply</span>
                      <button
                        className="text-xs text-gray-700 hover:underline"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        onClick={() =>
                          setSelectedRecs(
                            selectedRecs.size === visibleRecs.length
                              ? new Set()
                              : new Set(visibleRecs.map(({ i }) => i))
                          )
                        }
                      >
                        {selectedRecs.size === visibleRecs.length ? 'Deselect all' : 'Select all'}
                      </button>
                    </div>
                    <div className="max-h-52 overflow-y-auto">
                      {visibleRecs.map(({ r, i }) => {
                        const sev = SEV_STYLE[r.severity] || SEV_STYLE['high']
                        const checked = selectedRecs.has(i)
                        return (
                          <label key={i} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                            <input
                              type="checkbox"
                              className="rounded"
                              checked={checked}
                              onChange={() => {
                                const next = new Set(selectedRecs)
                                if (checked) next.delete(i)
                                else next.add(i)
                                setSelectedRecs(next)
                              }}
                            />
                            <span
                              className="text-xs px-1.5 py-0.5 rounded font-medium capitalize flex-shrink-0"
                              style={{ background: sev.bg, color: sev.color }}
                            >
                              {r.severity}
                            </span>
                            <span className="text-xs text-gray-700 flex-1">{r.title}</span>
                          </label>
                        )
                      })}
                    </div>
                    <div className="flex gap-2 px-3 py-2 border-t border-gray-100">
                      <button
                        style={{ background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '6px 14px', fontWeight: 600, fontSize: 12, flex: 1, fontFamily: 'inherit', cursor: 'pointer' }}
                        className="hover:opacity-80 transition-opacity disabled:opacity-50"
                        disabled={applyingRecs || selectedRecs.size === 0}
                        onClick={() => handleApplySelected(visibleRecs, policies, agent.tools)}
                      >
                        {applyingRecs ? 'Applying…' : `Apply ${selectedRecs.size} selected`}
                      </button>
                      <button
                        style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', borderRadius: 'var(--radius-full)', padding: '6px 12px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}
                        className="hover:opacity-70 transition-opacity"
                        onClick={() => setShowRecsMenu(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            {visibleRecs.map(({ r, i }) => {
              const sev = SEV_STYLE[r.severity] || SEV_STYLE['high']
              return (
                <div
                  key={i}
                  className="p-3 border border-gray-100 rounded-lg"
                  style={{ borderLeftWidth: 3, borderLeftColor: sev.color }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="text-xs px-1.5 py-0.5 rounded font-medium capitalize"
                      style={{ background: sev.bg, color: sev.color }}
                    >
                      {r.severity}
                    </span>
                    <strong className="text-sm text-gray-800">{r.title}</strong>
                  </div>
                  <p className="text-xs text-gray-500">{formatDescription(r.description)}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Integration Guide ── */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm mb-4 overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-5 py-4 text-sm text-gray-900 hover:bg-gray-50 transition-colors"
          onClick={() => setShowIntegration((v) => !v)}
        >
          <span className="font-medium">How to enforce policies for this agent</span>
          <ChevronDown
            className={`w-4 h-4 text-gray-500 transition-transform ${showIntegration ? 'rotate-180' : ''}`}
          />
        </button>

        {showIntegration && (
          <div className="px-5 pb-5 border-t border-gray-100">
            <p className="text-sm text-gray-500 mt-4 mb-3">
              Call{' '}
              <code className="px-1.5 py-0.5 bg-gray-100 rounded text-xs font-mono">
                POST /api/enforce
              </code>{' '}
              before every tool action this agent takes. Use the agent ID below — Arceo checks
              your policies and returns a decision in &lt;10ms.
            </p>
            <div className="flex items-center gap-3 p-2.5 bg-gray-50 border border-gray-200 rounded-lg mb-3">
              <span className="font-semibold text-gray-500 uppercase tracking-wide" style={{ fontSize: 'var(--fs-micro)' }}>
                Agent ID
              </span>
              <code className="flex-1 text-xs font-mono text-gray-800 truncate">{agentId}</code>
              <button
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors flex-shrink-0"
                onClick={() => agentId && navigator.clipboard.writeText(agentId)}
              >
                <Copy className="w-3.5 h-3.5" />
                Copy
              </button>
            </div>
            <IntegrationSnippets agentId={agentId ?? ''} token={getToken()} />
          </div>
        )}
      </div>
    </div>
  )
}
