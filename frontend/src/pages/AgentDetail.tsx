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
  FlaskConical,
} from 'lucide-react'
import { apiFetch, getToken } from '@/lib/api'
import { toast } from '@/components/shared/Toast'
import { bandDescription, scoreBand, scoreToColor, riskLabelBg, riskLabelColor, riskLabelName } from '@/lib/utils'
import type { RiskLabel } from '@/lib/types'
import Tooltip from '@/components/shared/Tooltip'
import ErrorState from '@/components/shared/ErrorState'
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
  /** Declared at registration. Kept beside the observed state below, never used as it. */
  environment?: string | null
  live_calls_7d?: number
  deployment_state?: 'deployed' | 'pre_deployment'
  /** `stalled` = declared prod but never ran; `ungoverned` = declared dev/staging
   *  but carrying live traffic. Either way the declaration and the traffic
   *  disagree, and that disagreement is the finding. */
  deployment_mismatch?: 'stalled' | 'ungoverned' | null
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
  inherent_score?: number       // tools only — the starting point `score` adjusts from
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

const RISK_COLORS: Record<string, string> = {
  moves_money: 'var(--critical)',
  touches_pii: '#7c3aed',
  deletes_data: 'var(--high)',
  sends_external: '#2563eb',
  changes_production: '#0d9488',
  changes_access: '#b91c1c',
  reads_secrets: '#a21caf',
  evades_detection: '#4338ca',
  bulk_export: '#15803d',
  executes_code: '#334155',
}

const RISK_LABELS: Record<string, string> = {
  moves_money: 'Moves Money',
  touches_pii: 'Touches PII',
  deletes_data: 'Deletes Data',
  sends_external: 'Sends External',
  changes_production: 'Changes Prod',
  changes_access: 'Access control',
  reads_secrets: 'Secrets',
  evades_detection: 'Log tampering',
  bulk_export: 'Bulk export',
  executes_code: 'Code exec',
}

const SEV_STYLE: Record<string, { bg: string; color: string }> = {
  critical: { bg: 'var(--critical-bg)', color: 'var(--critical)' },
  high: { bg: 'var(--high-bg)', color: 'var(--high)' },
  medium: { bg: 'var(--caution-bg)', color: 'var(--on-caution)' },
}

const EFFECT_STYLE: Record<string, { bg: string; color: string }> = {
  BLOCK: { bg: 'var(--critical-bg)', color: 'var(--critical)' },
  REQUIRE_APPROVAL: { bg: 'var(--high-bg)', color: 'var(--high)' },
  ALLOW: { bg: 'var(--safe-bg)', color: 'var(--safe)' },
}

const EXEC_STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  EXECUTED:         { bg: 'var(--status-executed-bg)', color: 'var(--status-executed)' },
  BLOCKED:          { bg: 'var(--status-blocked-bg)',  color: 'var(--status-blocked)' },
  PENDING_APPROVAL: { bg: 'var(--status-pending-bg)',  color: 'var(--on-caution)' },
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
  if (/charge|transfer|pay|refund|create_charge/.test(s)) return '#2563eb'
  if (/send|email|message|notify/.test(s)) return '#7c3aed'
  return '#9ca3af'
}

const blastLabel = (score: number): string => bandDescription(scoreBand(score).key)

// Logos copied from the marketing site (website/public/brand/integrations);
// salesforce.svg has its wordmark knocked out so it survives as a mask.
const TOOL_LOGOS = new Set([
  'aws', 'calendly', 'github', 'gmail', 'hubspot', 'pagerduty',
  'salesforce', 'sendgrid', 'slack', 'stripe', 'zendesk',
])
const toolLogoUrl = (name: string): string | null => {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return TOOL_LOGOS.has(key) ? `/brand/integrations/${key}.svg` : null
}

/** Grey logo for a tool, or a letter tile when we have no mark for it.
 *  Grey on purpose: colour on this page means a risk label, so a brand
 *  colour (Stripe purple, SendGrid blue) would read as one. The logo is a
 *  mask over a flat grey, so multi-colour marks come out one even tone. */
function ToolLogo({ tool }: { tool: AgentTool }) {
  const url = toolLogoUrl(tool.name) ?? toolLogoUrl(tool.service || '')
  const color = 'var(--ink-500)'
  if (url) {
    const mask = `url(${url}) center / contain no-repeat`
    return (
      <span
        aria-hidden="true"
        style={{ width: 14, height: 14, flexShrink: 0, background: color, WebkitMask: mask, mask }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: 14, height: 14, borderRadius: 3, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: color, color: 'var(--white, #fff)', fontSize: 9, fontWeight: 700, lineHeight: 1,
      }}
    >
      {(tool.service || tool.name).charAt(0).toUpperCase()}
    </span>
  )
}

// One colour per risk label, shared by the header's legend
// and the stat drill-down.
const LABEL_COLOR: Record<string, string> = {
  moves_money: 'var(--critical)',
  touches_pii: '#7c3aed',
  deletes_data: 'var(--high)',
  sends_external: '#2563eb',
  changes_production: '#0d9488',
  changes_access: '#b91c1c',
  reads_secrets: '#a21caf',
  evades_detection: '#4338ca',
  bulk_export: '#15803d',
  executes_code: '#334155',
}


const LEGEND_TEXT: Record<string, [one: string, many: string]> = {
  moves_money: ['moves money', 'move money'],
  touches_pii: ['touches personal data', 'touch personal data'],
  deletes_data: ['deletes data', 'delete data'],
  sends_external: ['sends outside the company', 'send outside the company'],
  changes_production: ['changes production', 'change production'],
  changes_access: ['changes who has access', 'change who has access'],
  reads_secrets: ['reads secrets', 'read secrets'],
  evades_detection: ['can hide its tracks', 'can hide its tracks'],
  bulk_export: ['exports data in bulk', 'export data in bulk'],
  executes_code: ['runs code', 'run code'],
  irreversible: ["can't be undone", "can't be undone"],
}
const legendText = (key: string, n: number) => {
  const t = LEGEND_TEXT[key]
  return t ? t[n === 1 ? 0 : 1] : key
}

const fmtUsd = (usd: number): string => {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}k`
  return `$${Math.round(usd)}`
}

// Per-incident $ ceilings are one flat figure per risk category from
// cost_defaults.yaml, not derived from the agent — hidden until they are,
// for the same reason the CFO report retired them (lib/cfoReport.ts).
const SHOW_INCIDENT_USD = false

// Plain-language reasons behind the deployment-context score. Mirrors the
// multiplier tables in backend/authority/graph.py (ENV_MULT / TRIGGER_MULT /
// HITL_MULT) — keep the up/down directions in sync with them.
// `short` is the clause used in the one-line summary; `text` is the full line.
type ContextReason = { text: string; short?: string; effect: 'up' | 'down' | 'none' }
function deploymentReasons(ctx: NonNullable<BlastRadius['exposure_context']>): ContextReason[] {
  const out: ContextReason[] = []
  const env = (ctx.environment ?? '').toLowerCase()
  if (env === 'prod' || env === 'production')
    out.push({ text: 'It runs in production, where mistakes reach real customers and data', short: 'it runs in production', effect: 'up' })
  else if (env === 'dev' || env === 'development')
    out.push({ text: 'It runs in a development environment, away from real customers and data', short: 'it runs in development', effect: 'down' })
  else if (env === 'staging')
    out.push({ text: 'It runs in staging', effect: 'none' })

  const trig = (ctx.trigger_source ?? '').toLowerCase()
  if (trig === 'untrusted' || trig === 'external')
    out.push({ text: 'People outside your company can start it, so someone could try to trick it', short: 'outsiders can start it', effect: 'up' })
  else if (trig === 'internal')
    out.push({ text: 'Only people inside your company can start it', effect: 'none' })
  else if (trig === 'scheduled')
    out.push({ text: 'It runs on a schedule, not on request', effect: 'none' })

  if (ctx.human_in_loop === true)
    out.push({ text: 'A person approves its actions before they happen', short: 'a person approves its actions', effect: 'down' })
  else if (ctx.human_in_loop === false)
    out.push({ text: 'Nobody approves its actions before they happen', effect: 'none' })
  return out
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
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` ${time}`
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
          style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 16px', height: '36px', fontSize: 13, outline: 'none', flex: 1, minWidth: 0, fontFamily: 'inherit' }}
          onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
          onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
          placeholder="Search actions..."
          value={graphSearch}
          onChange={(e) => setGraphSearch(e.target.value)}
        />
        <div className="flex gap-1">
          {(['all', 'irreversible', 'risky', 'safe'] as const).map((f) => (
            <button
              key={f}
              /* Graphite, not the accent: this selects a view, it doesn't
                 make a claim — the deep blue stays reserved for actions. */
              style={riskFilter === f
                ? { background: 'var(--graphite)', color: '#ffffff', borderRadius: 'var(--radius-full)', border: 'none', padding: '5px 14px', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-num)', cursor: 'pointer' }
                : { background: 'var(--card)', border: '1px solid var(--line)', color: 'var(--ink-700)', borderRadius: 'var(--radius-full)', padding: '5px 14px', fontSize: 12, fontFamily: 'var(--font-num)', cursor: 'pointer' }}
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
        const accentColor = nIrrev > 0 ? 'var(--critical)' : nRisky > 0 ? '#f59e0b' : '#d1d5db'

        return (
          <div
            key={tool.id}
            className="border border-gray-200 rounded-lg overflow-hidden"
            style={{ borderLeftWidth: 3, borderLeftColor: accentColor }}
          >
            <div
              className="flex items-center justify-between px-4 py-2.5 cursor-pointer hover:bg-gray-50 transition-colors"
              onClick={() => toggle(tool.id)}
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
                          background: isIrrev ? 'var(--critical)' : hasRisk ? '#f59e0b' : '#d1d5db',
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
                              background: (RISK_COLORS[r] ?? '#9ca3af') + '18',
                              color: RISK_COLORS[r] ?? '#6b7280',
                              borderColor: (RISK_COLORS[r] ?? '#9ca3af') + '50',
                            }}
                          >
                            {RISK_LABELS[r] ?? r}
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
  onCancel,
}: {
  agentId: string
  context?: BlastRadius['exposure_context']
  onSaved: () => void
  onCancel?: () => void
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
  const label = 'flex flex-col gap-1 text-xs'
  return (
    <div className="flex items-end gap-3 flex-wrap">
      <label className={label} style={{ color: 'var(--ink-600)' }}>
        Where does it run?
        <select className={sel} value={env} onChange={(e) => setEnv(e.target.value)}>
          <option value="">Not set</option>
          <option value="prod">Production</option>
          <option value="staging">Staging</option>
          <option value="dev">Development</option>
        </select>
      </label>
      <label className={label} style={{ color: 'var(--ink-600)' }}>
        Who can start it?
        <select className={sel} value={trigger} onChange={(e) => setTrigger(e.target.value)}>
          <option value="">Not set</option>
          <option value="untrusted">People outside the company</option>
          <option value="internal">Only people inside the company</option>
          <option value="scheduled">Runs on a schedule</option>
        </select>
      </label>
      <label className={label} style={{ color: 'var(--ink-600)' }}>
        Does a person approve its actions first?
        <select className={sel} value={hitl} onChange={(e) => setHitl(e.target.value)}>
          <option value="">Not set</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
      <button
        onClick={save}
        disabled={saving}
        className="text-xs px-2.5 py-1 rounded-full text-white disabled:opacity-50"
        style={{ background: 'var(--color-cta)', border: 'none', cursor: 'pointer' }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="text-xs py-1"
          style={{ color: 'var(--ink-500)', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          Cancel
        </button>
      )}
    </div>
  )
}

interface WorstCasePanelProps {
  br: BlastRadius
  chains: Chain[]
  policies: Policy[]
  onScrollToPolicies: () => void
  agentId: string
  onContextSaved: () => void
}

// The panel only renders for agents worth a worst-case readout; the page
// shows the deployment-settings editor on its own when it doesn't.
const showsWorstCase = (br: BlastRadius | null | undefined, chains: Chain[]) =>
  !!br && !(br.score < 30 && chains.length === 0)

function WorstCasePanel({
  br,
  chains,
  policies,
  onScrollToPolicies,
  agentId,
  onContextSaved,
}: WorstCasePanelProps) {
  const [editingContext, setEditingContext] = useState(false)
  if (!showsWorstCase(br, chains)) return null

  const topChain =
    chains.find((c) => c.severity === 'critical') ||
    chains.find((c) => c.severity === 'high') ||
    chains[0]
  const hasCoveringPolicy = (policies || []).some(
    (p) => p.effect === 'BLOCK' || p.effect === 'REQUIRE_APPROVAL'
  )
  const chainText = topChain ? topChain.description || topChain.name : null

  // Per-action worst-case dollars, keyed the same way the chain's
  // matching_actions are (`tool.action`), so the two join.
  const priced = new Map(
    (br.top_contributors ?? []).filter((c) => c.usd > 0).map((c) => [c.action, c])
  )

  // The chain as its own steps: each risk label paired with the actions that
  // satisfy it. `steps` is [from_label, to_label] and `matching_actions` is the
  // matching action list per step, so they index together.
  // One action can carry both of a chain's labels (terminate_instance is both
  // changes_production and deletes_data), so the naive "worst action per step"
  // names the same action twice and the chain stops looking like a sequence.
  // Prefer a distinct action for the later step whenever the agent has one.
  const usedActions = new Set<string>()
  const steps = (topChain?.steps ?? []).map((label, i) => {
    const actions = topChain?.matching_actions?.[i] ?? []
    const hits = (actions.map((a) => priced.get(a)).filter(Boolean) as NonNullable<
      BlastRadius['top_contributors']
    >).sort((a, b) => b.usd - a.usd)
    const worst = hits.find((h) => !usedActions.has(h.action)) ?? hits[0]
    const fallback = actions.find((a) => !usedActions.has(a)) ?? actions[0]
    const action = worst?.action ?? fallback
    if (action) usedActions.add(action)
    return {
      label,
      action,
      usd: worst?.usd ?? null,
      irreversible: worst ? worst.why.includes('irreversible') : false,
      alternatives: Math.max(0, actions.length - 1),
    }
  })

  // The engine's own worst case is the largest SINGLE per-incident ceiling
  // (graph.py: `magnitude_usd = max(...)`). It never totals a chain, so this
  // panel must not either.
  //
  // Prefer the peak across the chain's own steps: `magnitude_usd` is the max
  // over EVERY action the agent has, so under a heading about this chain it
  // could quote a figure from an action the chain never touches.
  const stepUsds = steps.map((st) => st.usd).filter((u): u is number => u != null)
  const chainPeak = stepUsds.length > 0 ? Math.max(...stepUsds) : null
  const peakUsd =
    chainPeak ??
    br.magnitude_usd ??
    Math.max(0, ...(br.top_contributors ?? []).map((c) => c.usd || 0))

  const scoreBandLabel = scoreBand(br.score).label
  // Everything that moved the score off its tools-only starting point.
  const scoreReasons: ContextReason[] = [
    ...(br.exposure_context ? deploymentReasons(br.exposure_context) : []),
    hasCoveringPolicy
      ? { text: 'Your policies block or require approval for some of its risky actions', short: 'your policies gate some risky actions', effect: 'down' as const }
      : { text: 'No policies limit what it can do yet', effect: 'none' as const },
  ]
  // One line: "Up from 40 because it runs in production and outsiders can start it."
  const joinClauses = (xs: string[]) =>
    xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
  const ups = scoreReasons.filter((r) => r.effect === 'up' && r.short).map((r) => r.short!)
  const downs = scoreReasons.filter((r) => r.effect === 'down' && r.short).map((r) => r.short!)
  const base = br.inherent_score ?? br.score
  const raised = br.score > base
  const main = raised ? ups : downs
  const offset = raised ? downs : ups
  const scoreSummary =
    br.score === base || main.length === 0
      ? 'Based on what its tools can do.'
      : `${raised ? 'Up' : 'Down'} from ${base} because ${joinClauses(main)}` +
        (offset.length ? `, partly offset because ${joinClauses(offset)}.` : '.')

  const sevStyle = topChain
    ? SEV_STYLE[topChain.severity] ?? { bg: 'var(--high-bg)', color: 'var(--high)' }
    : null

  const rule = { borderTop: '1px solid var(--line)' }
  const eyebrow: React.CSSProperties = {
    fontSize: 'var(--fs-micro)',
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: 'var(--ink-500)',
  }

  return (
    <div
      className="rounded-xl mb-4 overflow-hidden"
      style={{
        background: 'var(--card)',
        boxShadow: 'var(--shadow-card-new)',
      }}
    >
      {/* Header band. Amber marks the section as a warning; it no longer floods
          the whole card, where it collided with a green score and a green
          coverage pill. */}
      <div
        className="flex items-center gap-2 flex-wrap px-5 py-3"
        style={{ background: 'var(--caution-bg)', borderBottom: '1px solid var(--caution-line)' }}
      >
        <AlertTriangle size={14} style={{ color: 'var(--on-caution)' }} />
        <span className="font-semibold uppercase" style={{ ...eyebrow, color: 'var(--on-caution)' }}>
          Worst case
        </span>
        {topChain && sevStyle && (
          // Spelled out, because a bare "HIGH" beside a "Low blast radius"
          // score reads as the card contradicting itself. They are two
          // different scales: this one rates the sequence.
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider"
            style={{ background: sevStyle.bg, color: sevStyle.color }}
          >
            {topChain.severity}-severity chain
          </span>
        )}
        {/* On the amber fill, the safe/critical text tones drop to ~2:1. The
            coverage state is carried by the words, which the band still needs
            to be readable. */}
        <span className="ml-auto text-xs" style={{ color: 'var(--on-caution)', opacity: 0.85 }}>
          {hasCoveringPolicy ? 'Some steps are gated by your policies' : 'Nothing is gating this yet'}
        </span>
      </div>

      <div className="px-5 py-4">
        {/* 1 — what could happen, in one sentence then as steps. */}
        <div style={eyebrow}>What could happen</div>
        {chainText && (
          <p className="mt-2 mb-4" style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--ink-900)' }}>
            {chainText}
          </p>
        )}

        {steps.length > 0 && (
          <div className="space-y-1.5 mb-4">
            {steps.map((st, i) => (
              <div key={`${st.label}-${i}`} className="flex items-center gap-3 flex-wrap">
                <span
                  className="mono flex-shrink-0 flex items-center justify-center"
                  style={{
                    width: 20, height: 20, borderRadius: 999,
                    background: 'var(--paper-2)', color: 'var(--ink-500)',
                    fontSize: 11, fontWeight: 600,
                  }}
                >
                  {i + 1}
                </span>
                <span
                  className="text-xs px-2 py-0.5 rounded flex-shrink-0"
                  style={{
                    background: riskLabelBg(st.label as RiskLabel),
                    color: riskLabelColor(st.label as RiskLabel),
                    fontWeight: 600,
                  }}
                >
                  {riskLabelName(st.label)}
                </span>
                <span className="mono text-xs truncate" style={{ color: 'var(--ink-700)' }}>
                  {st.action}
                </span>
                {st.alternatives > 0 && (
                  <span className="text-xs" style={{ color: 'var(--ink-400)' }}>
                    +{st.alternatives} other{st.alternatives !== 1 ? 's' : ''}
                  </span>
                )}
                {st.irreversible && (
                  <span
                    className="text-xs inline-flex items-center gap-1 flex-shrink-0"
                    style={{ color: 'var(--critical)' }}
                  >
                    <Lock className="w-3 h-3" />
                    can&rsquo;t be undone
                  </span>
                )}
                {SHOW_INCIDENT_USD && st.usd !== null && (
                  <span className="mono text-xs ml-auto flex-shrink-0" style={{ color: 'var(--ink-600)' }}>
                    up to {fmtUsd(st.usd)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 2 — the money, stated as what it is: a ceiling, never a total. */}
        {SHOW_INCIDENT_USD && peakUsd > 0 && (
          <div className="pt-4 mb-4" style={rule}>
            <div style={eyebrow}>What one incident could cost</div>
            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-xs" style={{ color: 'var(--ink-500)' }}>up to</span>
              <span className="mono text-2xl font-bold" style={{ color: 'var(--ink-900)' }}>
                {fmtUsd(peakUsd)}
              </span>
              <span className="text-xs" style={{ color: 'var(--ink-500)' }}>per incident</span>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--ink-500)', lineHeight: 1.6, maxWidth: '86ch' }}>
              {chainPeak !== null && steps.length > 1
                ? 'The costlier of the two steps above. They are separate incident types, so the model does not add them together.'
                : 'The largest single-incident ceiling across this agent\u2019s actions.'}
              {' '}Each figure is the ceiling for that action&rsquo;s risk category, not an estimate for
              the specific action, and it is not weighted by how likely the incident is.
            </p>
          </div>
        )}

        {/* 3 — the one score, with the reasons it sits where it does. */}
        <div className="pt-4 flex items-start justify-between gap-4 flex-wrap" style={rule}>
          <div>
            <div style={eyebrow}>Risk score</div>
            <div className="flex items-baseline gap-2 mt-2 flex-wrap">
              <span className="mono text-2xl font-bold" style={{ color: scoreToColor(br.score) }}>
                {br.score}
              </span>
              <span className="text-xs" style={{ color: 'var(--ink-600)' }}>
                {scoreBandLabel.toLowerCase()}, out of 100
              </span>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--ink-600)' }}>{scoreSummary}</p>
            <details className="text-xs mt-1">
              <summary className="cursor-pointer select-none" style={{ color: 'var(--ink-500)' }}>Show details</summary>
              <p className="mt-2" style={{ color: 'var(--ink-600)' }}>
                Starts at <strong className="mono">{base}</strong> from what its tools can do, then:
              </p>
              <ul className="mt-1 space-y-1" style={{ color: 'var(--ink-600)', listStyle: 'none', padding: 0 }}>
                {scoreReasons.map((r) => (
                  <li key={r.text} className="flex items-start gap-2">
                    <span
                      className="mono flex-shrink-0"
                      style={{
                        width: 12,
                        color: r.effect === 'up' ? 'var(--critical)' : r.effect === 'down' ? 'var(--safe)' : 'var(--ink-400)',
                      }}
                    >
                      {r.effect === 'up' ? '↑' : r.effect === 'down' ? '↓' : '–'}
                    </span>
                    <span>
                      {r.text}
                      <span style={{ color: 'var(--ink-400)' }}>
                        {r.effect === 'up' ? ' (raises risk)' : r.effect === 'down' ? ' (lowers risk)' : ' (no change)'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {agentId && (
                editingContext ? (
                  <div className="mt-3">
                    <DeploymentContextEditor
                      agentId={agentId}
                      context={br.exposure_context}
                      onSaved={() => { setEditingContext(false); onContextSaved() }}
                      onCancel={() => setEditingContext(false)}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="mt-2 text-xs underline"
                    style={{ color: 'var(--accent-ink)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                    onClick={() => setEditingContext(true)}
                  >
                    Edit deployment settings
                  </button>
                )
              )}
              <p className="mt-2" style={{ color: 'var(--ink-400)', lineHeight: 1.6, maxWidth: '86ch' }}>
                {br.evidence?.dryRunOnly || br.confidence === 'low'
                  ? 'Based on what the agent can do and the deployment details entered for it, not on watching it run. Run a simulation to confirm it.'
                  : CONF_STYLE[br.confidence ?? 'low'].label + ', graded against a simulation run.'}
              </p>
            </details>
          </div>
          {!hasCoveringPolicy && (
            <button className="btn btn--primary hover:opacity-90 transition-opacity" onClick={onScrollToPolicies} >
              Add a policy
            </button>
          )}
        </div>
      </div>
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
        style={{ background: 'var(--bg-sunken)', border: open ? '2px solid var(--border-focus)' : '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 16px', height: '42px', width: '100%', fontSize: 13, outline: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: 'inherit', cursor: 'pointer' }}
        className="transition-all"
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ color: 'var(--text-secondary)' }}>
          {selectedPatterns.length === 0 ? 'Add an action…' : 'Add another action…'}
        </span>
        <ChevronDown
          className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
          style={{ color: '#9ca3af' }}
        />
      </button>

      {open && (
        <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-white rounded-xl overflow-hidden">
          <div className="p-2 border-b border-gray-100">
            <input
              autoFocus
              style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 14px', height: '36px', width: '100%', fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
              placeholder="Search actions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {filteredTools.map((t) => (
              <div key={t.name}>
                <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide bg-gray-50">
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
                          background: isIrrev ? 'var(--critical)' : isRisky ? '#f59e0b' : '#d1d5db',
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
                              background: (RISK_COLORS[r] ?? '#9ca3af') + '22',
                              color: RISK_COLORS[r] ?? '#6b7280',
                              borderColor: (RISK_COLORS[r] ?? '#9ca3af') + '55',
                            }}
                          >
                            {RISK_LABELS[r] ?? r}
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
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 14px', height: '36px', flex: 1, fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                placeholder="e.g. pagerduty.get_incident"
                value={c.value}
                onChange={(e) => update(i, 'value', e.target.value)}
              />
            </>
          ) : (
            <>
              <input
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 14px', height: '36px', width: '8rem', fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                placeholder="field (e.g. amount)"
                value={c.field ?? ''}
                onChange={(e) => update(i, 'field', e.target.value)}
              />
              <select
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 12px', height: '36px', fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
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
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 14px', height: '36px', width: '7rem', fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
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
        <button type="button" className="btn btn--secondary hover:opacity-70 transition-opacity" onClick={add} >
          + Parameter condition
        </button>
        <button type="button" className="btn btn--secondary hover:opacity-70 transition-opacity" onClick={addPrior} >
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
      desc: 'The agent is stopped and the action never runs',
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
      desc: 'Explicitly allowed, and logged for audit',
      Icon: Check,
      color: 'var(--safe)',
      bg: 'var(--safe-bg)',
      border: '#86efac',
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
            className="flex flex-col items-center gap-1 p-3 border-2 rounded-xl text-center transition-all"
            style={
              isActive
                ? { borderColor: o.border, background: o.bg }
                : { borderColor: '#e5e7eb', background: '#fff' }
            }
            onClick={() => onChange(o.value)}
          >
            <o.Icon className="w-4 h-4" style={{ color: isActive ? o.color : '#9ca3af' }} />
            <span
              className="text-xs font-semibold"
              style={{ color: isActive ? o.color : '#6b7280' }}
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
  const [tab, setTab] = useState<'python' | 'curl' | 'node'>('python')
  const [copied, setCopied] = useState(false)
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

# Call this before every tool action:
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

  const copy = () => {
    navigator.clipboard.writeText(snippets[tab])
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="mt-3 border border-gray-200 rounded-xl overflow-hidden">
      <div className="flex items-center border-b border-gray-200 bg-gray-50">
        {(['python', 'curl', 'node'] as const).map((t) => (
          <button
            key={t}
            className={`px-4 py-2 text-sm transition-colors ${
              tab === t
                ? 'bg-white border-b-2 border-gray-900 text-gray-900 font-medium'
                : 'text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setTab(t)}
          >
            {t === 'node' ? 'Node.js' : t}
          </button>
        ))}
        <button
          className="ml-auto flex items-center gap-1.5 px-3 py-2 text-xs text-gray-500 hover:text-gray-700 transition-colors"
          onClick={copy}
        >
          <Copy className="w-3.5 h-3.5" />
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="p-4 text-xs bg-gray-900 overflow-x-auto">
        <code className="text-green-400">{snippets[tab]}</code>
      </pre>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AgentDetail() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
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

  // Chain collapse
  const [collapsedChains, setCollapsedChains] = useState<Record<string, boolean>>({})
  const toggleChain = (id: string) => setCollapsedChains((p) => ({ ...p, [id]: !p[id] }))

  // Policy added banner
  const [policyAdded, setPolicyAdded] = useState(false)

  const [applyingRecs, setApplyingRecs] = useState(false)
  const [selectedRecs, setSelectedRecs] = useState<Set<number>>(new Set())
  const [appliedRecIndices, setAppliedRecIndices] = useState<Set<number>>(new Set())

  const [activeStatFilter, setActiveStatFilter] = useState<string | null>(null)
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
          ? 'Fail-closed is on. Actions with no matching policy are now blocked.'
          : 'Fail-closed is off. Unmatched actions are allowed again.'
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
      setSelectedRecs(new Set())
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
      setSelectedRecs(new Set())
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
        toast('The effect changed, but we could not remove the old policy. Please delete it manually.', 'error')
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
      <div className="p-8 max-w-5xl mx-auto">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          All Agents
        </Link>
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <div className="w-8 h-8 border-2 border-gray-300 border-t-gray-900 rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading agent data...</p>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
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
  const scoreColor = br.score < 40 && hasCriticalChains ? '#d97706' : scoreToColor(br.score)

  const ringR = 44
  const ringC = 2 * Math.PI * ringR
  const ringOffset = ringC * (1 - br.score / 100)

  const statItems = [
    {
      label: 'Total Actions',
      tooltip: 'Every individual API call or operation this agent can perform across all its connected tools.',
      value: br.total_actions,
      color: null as string | null,
      riskKey: 'all',
    },
    {
      label: 'Move Money',
      tooltip: 'Charges, refunds, transfers, and subscription changes. Anything that moves funds.',
      value: br.moves_money,
      color: LABEL_COLOR.moves_money,
      riskKey: 'moves_money',
    },
    {
      label: 'Touch PII',
      tooltip: 'Reads or writes personal data such as names, emails, addresses, payment info, or any customer record.',
      value: br.touches_pii,
      color: LABEL_COLOR.touches_pii,
      riskKey: 'touches_pii',
    },
    {
      label: 'Delete Data',
      tooltip: 'Permanently removes records, files, or data. Cannot be undone.',
      value: br.deletes_data,
      color: LABEL_COLOR.deletes_data,
      riskKey: 'deletes_data',
    },
    {
      label: 'Send External',
      tooltip: 'Emails, messages, or webhooks sent to customers or third-party services outside your system.',
      value: br.sends_external,
      color: LABEL_COLOR.sends_external,
      riskKey: 'sends_external',
    },
    {
      label: 'Change Prod',
      tooltip: 'Edits to live configuration, infrastructure, or deployment settings.',
      value: br.changes_production,
      color: LABEL_COLOR.changes_production,
      riskKey: 'changes_production',
    },
    {
      label: 'Access control',
      tooltip: 'Can hand out or change who has access, so it can grant roles, promote to admin, reset passwords, or issue API keys.',
      value: br.changes_access ?? 0,
      color: LABEL_COLOR.changes_access,
      riskKey: 'changes_access',
    },
    {
      label: 'Secrets',
      tooltip: 'Can read secrets, credentials, API keys, or environment variables.',
      value: br.reads_secrets ?? 0,
      color: LABEL_COLOR.reads_secrets,
      riskKey: 'reads_secrets',
    },
    {
      label: 'Log tampering',
      tooltip: 'Can turn off or delete logging, audit trails, or alerts, so its own actions go unrecorded.',
      value: br.evades_detection ?? 0,
      color: LABEL_COLOR.evades_detection,
      riskKey: 'evades_detection',
    },
    {
      label: 'Bulk export',
      tooltip: 'Can pull data out in bulk, meaning full exports or whole-table dumps rather than one record at a time.',
      value: br.bulk_export ?? 0,
      color: LABEL_COLOR.bulk_export,
      riskKey: 'bulk_export',
    },
    {
      label: 'Code exec',
      tooltip: 'Can run arbitrary code, shell commands, or SQL, which gives it effectively unlimited reach.',
      value: br.executes_code ?? 0,
      color: LABEL_COLOR.executes_code,
      riskKey: 'executes_code',
    },
    {
      label: 'Irreversible',
      tooltip: 'Actions that cannot be undone, including permanent deletions, charges, and outbound sends.',
      value: br.irreversible_actions,
      color: null as string | null,
      riskKey: 'irreversible',
    },
  ]
  const caveatCount =
    (agent.deployment_mismatch === 'stalled' || agent.deployment_mismatch === 'ungoverned' ? 1 : 0) +
    (br.coverage && br.coverage.totalActions > 0 && br.coverage.recognizedActions < br.coverage.totalActions ? 1 : 0) +
    ((br.coverage?.unclassifiedActions ?? 0) > 0 ? 1 : 0)
  const visibleStats = statItems.filter(
    (s, i) => i === 0 || i === statItems.length - 1 || s.value > 0
  )

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
    { id: 'graph' as const, label: `Tool Map (${br.coverage?.totalActions ?? agent.tools.reduce((n, t) => n + t.actions.length, 0)})`, dot: false },
    { id: 'policies' as const, label: `Policies (${sortedPolicies.length})`, dot: false },
    { id: 'executions' as const, label: `Executions (${executions?.length ?? 0})`, dot: false },
    { id: 'chains' as const, label: `Chains (${chains.length})`, dot: hasCriticalChain },
  ]

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="px-container-padding py-stack-gap w-full">
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
          {confirmDelete && (
            <>
              <span className="text-xs text-gray-500">Are you sure?</span>
              <button className="btn btn--danger hover:opacity-80 transition-opacity" onClick={handleDelete} >
                Yes, delete
              </button>
              <button className="btn btn--secondary hover:opacity-70 transition-opacity" onClick={() => setConfirmDelete(false)} >
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
                    style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', minWidth: 160, padding: 4 }}
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
      <div className="bg-white rounded-xl p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          {editMode ? (
            <form className="flex-1 space-y-2" onSubmit={handleEdit}>
              <input
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 16px', height: '42px', width: '100%', fontSize: 16, fontWeight: 600, outline: 'none', fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Agent name"
                required
              />
              <input
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 16px', height: '42px', width: '100%', fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Description"
              />
              <div className="flex gap-2">
                <button type="submit" className="btn btn--primary hover:opacity-80 transition-opacity disabled:opacity-50" disabled={editSaving || !editName.trim()} >
                  {editSaving ? 'Saving...' : 'Save Changes'}
                </button>
                <button type="button" className="btn btn--secondary hover:opacity-70 transition-opacity" onClick={() => setEditMode(false)} >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">{agent.name}</h1>
              <p className="text-sm text-gray-500 mb-3">{agent.description}</p>
              <div className="flex flex-wrap gap-1.5">
                {agent.tools.map((t) => (
                  <span
                    key={t.name}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 7,
                      padding: '5px 11px', fontSize: 12.5, fontWeight: 500,
                      fontFamily: 'var(--font-num)', borderRadius: 6,
                      border: '1px solid var(--line)',
                      background: 'var(--paper-2)',
                      color: 'var(--ink-700)',
                    }}
                  >
                    <ToolLogo tool={t} />
                    {t.service}
                  </span>
                ))}
              </div>

              {/* What it can do, in words. Each item opens the matching
                  actions (the drill-down the old stat columns provided). */}
              <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 mt-4 text-xs" style={{ color: 'var(--ink-600)' }}>
                <span className="mr-1">
                  Of its <strong>{br.total_actions}</strong> {br.total_actions === 1 ? 'action' : 'actions'}:
                </span>
                {visibleStats.filter((s) => s.riskKey !== 'all' && s.value > 0).map((s) => {
                  const isActive = activeStatFilter === s.riskKey
                  return (
                    <button
                      key={s.riskKey}
                      type="button"
                      title={s.tooltip}
                      onClick={() => setActiveStatFilter(isActive ? null : s.riskKey)}
                      className="inline-flex items-center gap-1.5 text-xs"
                      style={{
                        background: isActive ? 'var(--paper-2)' : 'transparent',
                        border: isActive ? '1px solid var(--line)' : '1px solid transparent',
                        borderRadius: 4, padding: '2px 6px',
                        color: 'var(--ink-700)', cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      <span
                        style={{
                          width: 8, height: 8, borderRadius: 999, flexShrink: 0,
                          background: s.color ?? 'var(--ink-700)',
                        }}
                      />
                      <strong>{s.value}</strong> {legendText(s.riskKey, s.value)}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div className="flex flex-col items-center flex-shrink-0 pl-6" style={{ borderLeft: '1px solid var(--line)' }}>
            <Tooltip content={RISK_SCORE_METHODOLOGY}>
              <div className="flex flex-col items-center cursor-help" style={{ color: scoreColor }}>
                <div className="relative w-24 h-24">
                  <svg viewBox="0 0 110 110" className="w-full h-full">
                    <circle cx="55" cy="55" r={ringR} fill="none" stroke="currentColor" strokeWidth="7" opacity="0.12" />
                    <circle
                      cx="55" cy="55" r={ringR} fill="none" stroke="currentColor" strokeWidth="7"
                      strokeDasharray={ringC} strokeDashoffset={ringOffset} strokeLinecap="round"
                      transform="rotate(-90 55 55)"
                      style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1)' }}
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-2xl font-bold leading-none mono">{br.score}</span>
                  </div>
                </div>
                <div className="text-xs font-medium mt-1">
                  {scoreLevel === 'Action Required' ? scoreLevel : `${scoreLevel} risk`}
                </div>
              </div>
            </Tooltip>
            <Link
              to={`/sandbox?agent=${agentId}`}
              className="inline-flex items-center justify-center gap-1.5 hover:opacity-90 transition-opacity mt-3 no-underline"
              style={{ background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-md)', padding: '8px 14px', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}
            >
              <FlaskConical size={15} strokeWidth={1.9} />
              Simulate in sandbox
            </Link>
          </div>
        </div>

        {/* Classification caveats — the score is only as good as our catalog
            coverage, so both notes sit together on one quiet surface. */}
        {((br.coverage && (
          (br.coverage.totalActions > 0 && br.coverage.recognizedActions < br.coverage.totalActions) ||
          (br.coverage.unclassifiedActions ?? 0) > 0
        )) || !!agent.deployment_mismatch) && (
        <details
          className="mt-5 rounded-lg px-3.5 py-2"
          style={{ background: 'var(--paper-2)', border: '1px solid var(--line)' }}
        >
        <summary className="text-xs cursor-pointer select-none flex items-center gap-1.5" style={{ color: 'var(--ink-600)' }}>
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {caveatCount} {caveatCount === 1 ? 'thing' : 'things'} to check about this score
        </summary>
        <div className="space-y-2 mt-2">
        {/* Declared environment vs observed traffic. Sits with the other
            caveats because it is the same kind of statement: something about
            this agent is not what it was written down to be. */}
        {agent.deployment_mismatch === 'ungoverned' && (
          <div className="text-xs flex items-start gap-1.5" style={{ lineHeight: 1.45, color: 'var(--severity-high, #b45309)' }}>
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              Marked as <strong>{agent.environment}</strong>, but it&rsquo;s handling real traffic
              {agent.live_calls_7d ? ` (${agent.live_calls_7d.toLocaleString()} calls this week)` : ' this week'}.
              Nobody approved it for production.
            </span>
          </div>
        )}
        {agent.deployment_mismatch === 'stalled' && (
          <div className="text-xs flex items-start gap-1.5" style={{ lineHeight: 1.45, color: 'var(--ink-600)' }}>
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              Marked as <strong>production</strong>, but it hasn&rsquo;t run in the last 7 days. It may
              not be live yet, or it may be broken.
            </span>
          </div>
        )}
        {br.coverage && br.coverage.totalActions > 0 && br.coverage.recognizedActions < br.coverage.totalActions && (
          <div className="text-xs flex items-start gap-1.5" style={{ lineHeight: 1.45, color: 'var(--ink-600)' }}>
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              {br.coverage.totalActions - br.coverage.recognizedActions} of {br.coverage.totalActions} actions use tools we don&rsquo;t know well
              {br.coverage.unrecognizedTools.length > 0 ? ` (${br.coverage.unrecognizedTools.join(', ')})` : ''}, so their risk is estimated and the score may be too low.
            </span>
          </div>
        )}

        {/* Unclassifiable actions — vague names the classifier had NO signal for.
            They contribute 0 to the score while their true risk is unknown:
            surfacing them is the honest alternative to silently scoring them safe. */}
        {br.coverage && (br.coverage.unclassifiedActions ?? 0) > 0 && (
          <div className="text-xs flex items-start gap-1.5" style={{ lineHeight: 1.45, color: 'var(--severity-high, #b45309)' }}>
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              We couldn&rsquo;t tell how risky {(br.coverage.unclassifiedActions ?? 0) === 1 ? '1 action is' : `${br.coverage.unclassifiedActions} actions are`}
              {(br.coverage.unclassifiedList?.length ?? 0) > 0 ? ` (${br.coverage.unclassifiedList!.slice(0, 3).join(', ')}${br.coverage.unclassifiedList!.length > 3 ? ', …' : ''})` : ''}, so {(br.coverage.unclassifiedActions ?? 0) === 1 ? 'it counts' : 'they count'} as zero in the score. Worth checking by hand.
            </span>
          </div>
        )}
        </div>
        </details>
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
                  {activeStatFilter === 'all'
                    ? `All ${matchingActions.length} actions`
                    : `${matchingActions.length} ${matchingActions.length === 1 ? 'action' : 'actions'} ${legendText(activeStatFilter, matchingActions.length)}`}
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
                    <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">{service}</div>
                    <div className="flex flex-wrap gap-1">
                      {actions.map((a) => (
                        <span
                          key={a.toolName + '.' + a.action}
                          style={{
                            fontSize: 11,
                            background: stat?.color ? stat.color + '12' : 'var(--bg-sunken)',
                            color: stat?.color ?? 'var(--text-primary)',
                            border: `1px solid ${stat?.color ? stat.color + '30' : 'var(--border)'}`,
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
        onContextSaved={loadData}
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

      {agentId && !showsWorstCase(br, chains) && (
        <div className="mb-4">
          <DeploymentContextEditor
            agentId={agentId}
            context={br.exposure_context}
            onSaved={loadData}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      <div className="lg:col-span-8 min-w-0">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
              activeTab === t.id
                ? 'border-gray-900 text-gray-900 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => { setActiveTab(t.id); if (t.id !== 'graph') setSelectedGraphService(null) }}
          >
            {t.label}
            {t.dot && (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--critical)', flexShrink: 0, display: 'inline-block' }} />
            )}
          </button>
        ))}
      </div>

      {activeTab === 'graph' && (
        <div className="bg-white rounded-xl p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800 flex items-center gap-1.5">
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
          className="bg-white rounded-xl p-6 mb-6 relative z-10"
          ref={policySectionRef}
        >
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-semibold text-gray-800 flex items-center gap-1.5">
              Enforcement Policies ({sortedPolicies.length})
              <Tooltip text="Rules that tell Arceo what to do when this agent attempts specific actions. You can block them outright, require a human to approve first, or explicitly allow them.">
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
                    background: data.agent.default_effect === 'DENY' ? 'var(--accent)' : '#d1d5db',
                    height: 18,
                    width: 32,
                    opacity: defaultEffectSaving ? 0.6 : 1,
                  }}
                >
                  <span
                    className="absolute top-0.5 rounded-full bg-white transition-all"
                    style={{
                      width: 14,
                      height: 14,
                      left: data.agent.default_effect === 'DENY' ? 16 : 2,
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
              Applied automatically from the scan. Review and adjust them below.
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
                  These rules overlap. Only the highest-priority policy applies to each action.
                </div>
                <div className="space-y-1 mt-1">
                  {policyConflicts.slice(0, 3).map((c, i) => {
                    const aWins = c.policy_a?.id === c.winner?.id
                    const winnerPattern = (aWins ? c.policy_a : c.policy_b)?.pattern
                    const loserPattern = (aWins ? c.policy_b : c.policy_a)?.pattern
                    return (
                    <div key={i} className="flex items-center gap-2 text-xs flex-wrap">
                      <code className="px-1.5 py-0.5 bg-white border border-amber-200 rounded text-amber-800">
                        {winnerPattern || 'None'}
                      </code>
                      <span className="text-amber-500">overrides</span>
                      <code className="px-1.5 py-0.5 bg-white border border-amber-200 rounded text-amber-800">
                        {loserPattern || 'None'}
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
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
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
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                  2. Set enforcement
                </div>
                <EffectToggle value={newEffect} onChange={setNewEffect} />
              </div>

              <input
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-full)', color: 'var(--text-primary)', padding: '0 16px', height: '42px', width: '100%', fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
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
                      Only trigger this policy when specific parameters match. For example, only block
                      charges over $500, or only require approval for new customers.
                    </p>
                    <ConditionBuilder
                      conditions={newConditions}
                      onChange={setNewConditions}
                    />
                  </div>
                )}
              </div>

              <button type="submit" className="btn btn--primary hover:opacity-80 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed" disabled={ newPatterns.length === 0 || (newEffect !== 'ALLOW' && !newReason.trim()) } >
                {newPatterns.length > 1
                  ? `Add ${newPatterns.length} Policies`
                  : 'Add Policy'}
              </button>
            </form>}

            {policyAdded && (
              <div className="flex items-center gap-2 mt-3 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                <Check className="w-4 h-4 text-green-600 flex-shrink-0" />
                <span>
                  Policies saved. They&apos;ll be enforced on your next simulation run.
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
        <div className="bg-white rounded-xl p-6 mb-6">
          <h2 className="font-semibold text-gray-800 mb-3">
            Recent Executions ({executions?.length ?? 0})
          </h2>

          {(!executions || executions.length === 0) && (
            <div className="text-sm text-gray-400 text-center py-8">No executions yet.</div>
          )}

          {allUnpolicied && executions && (
            <div className="flex gap-2 p-3 mb-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
              <div>
                None of these {executions.length} executions matched a policy, so this agent runs
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
        <div className="bg-white rounded-xl p-6 mb-6">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-semibold text-gray-800 flex items-center gap-1.5">
              Dangerous Chains ({chains.length})
              <Tooltip text="Multi-step sequences where two or more of this agent's capabilities combine to create elevated risk. For example, reading customer data and then emailing it outside your org.">
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
                    className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
                    onClick={() => toggleChain(c.id)}
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
                          style={{ background: '#dcfce7', color: '#15803d' }}
                          title="Confirmed in a sandbox run. Data actually flowed between the steps."
                        >
                          Demonstrated
                        </span>
                      ) : br.evidence?.hasSim ? (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-medium"
                          style={{ background: '#f3f4f6', color: '#6b7280' }}
                          title="Not observed in the last sandbox run; flagged because the capability exists."
                        >
                          Possible
                        </span>
                      ) : (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-medium"
                          style={{ background: '#f3f4f6', color: '#6b7280' }}
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
                                borderColor: RISK_COLORS[step] ?? '#ccc',
                                color: RISK_COLORS[step] ?? '#555',
                                background: (RISK_COLORS[step] ?? '#ccc') + '12',
                              }}
                            >
                              {RISK_LABELS[step] ?? step}
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
                              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
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

      </div>

      {/* ── Recommendations rail ── */}
      <div className="lg:col-span-4 min-w-0">
      {visibleRecs.length > 0 && (
        <div className="bg-white rounded-xl p-6 mb-6">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-semibold text-gray-800 flex items-center gap-1.5">
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
              <div className="flex items-center gap-2">
                {selectedRecs.size > 0 ? (
                  <>
                    <button className="btn btn--primary hover:opacity-80 transition-opacity disabled:opacity-50" disabled={applyingRecs} onClick={() => handleApplySelected(visibleRecs, policies, agent.tools)} >
                      {applyingRecs ? 'Applying…' : `Apply ${selectedRecs.size} selected`}
                    </button>
                    <button className="btn btn--secondary hover:opacity-70 transition-opacity" onClick={() => setSelectedRecs(new Set())} >
                      Clear
                    </button>
                  </>
                ) : (
                  <button className="btn btn--primary hover:opacity-80 transition-opacity" disabled={applyingRecs} onClick={() => handleApplyAll(visibleRecs, policies, agent.tools)} >
                    {applyingRecs ? 'Applying…' : 'Apply all'}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            {visibleRecs.map(({ r, i }) => {
              const sev = SEV_STYLE[r.severity] || SEV_STYLE['high']
              // Title only by default; the explanation opens on click.
              return (
                <details
                  key={i}
                  className="group border border-gray-100 rounded-lg"
                  style={{ borderLeftWidth: 3, borderLeftColor: sev.color }}
                >
                  <summary className="flex items-center gap-2 p-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                    <input
                      type="checkbox"
                      className="rounded flex-shrink-0 cursor-pointer"
                      aria-label={`Select: ${r.title}`}
                      checked={selectedRecs.has(i)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => {
                        const next = new Set(selectedRecs)
                        if (next.has(i)) next.delete(i)
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
                    <strong className="text-sm text-gray-800 flex-1 min-w-0">{r.title}</strong>
                    <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0 transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="text-xs text-gray-500 px-3 pb-3 -mt-1">{formatDescription(r.description)}</p>
                </details>
              )
            })}
          </div>
        </div>
      )}

      </div>
      </div>

      {/* ── Integration Guide ── */}
      <div className="bg-white rounded-xl mb-4 overflow-hidden">
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
              before every tool action this agent takes. Use the agent ID below, and Arceo checks
              your policies and returns a decision in &lt;10ms.
            </p>
            <div className="flex items-center gap-3 p-2.5 bg-gray-50 border border-gray-200 rounded-lg mb-3">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
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
