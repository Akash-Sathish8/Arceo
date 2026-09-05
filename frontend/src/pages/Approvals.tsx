import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Check, X, Clock, ShieldAlert, Inbox } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/components/shared/Toast'
import { riskLabelBg, riskLabelColor, riskLabelName } from '@/lib/utils'
import type { RiskLabel } from '@/lib/types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import ErrorState from '@/components/shared/ErrorState'

interface ApprovalItem {
  id: string
  agent_id: string
  agent_name: string
  tool: string
  action: string
  detail?: string
  params?: Record<string, unknown>
  risk_labels?: string[]
  source?: string | null
  policy?: {
    action_pattern: string
    reason?: string
    created_by?: string
    created_at?: string
  } | null
  timestamp: string
  status: string
}

// Provenance: every row answers "where did this come from?" so a reviewer can
// tell live agent traffic from simulations and seeded test data at a glance.
const SOURCE_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  runtime:       { label: 'Live traffic',        bg: 'var(--severity-safe-bg)',     color: 'var(--severity-safe)' },
  sandbox:       { label: 'Sandbox simulation',  bg: '#f5f3ff',                     color: '#7c3aed' },
  boundary_test: { label: 'Boundary test',       bg: '#f5f3ff',                     color: '#7c3aed' },
  replay:        { label: 'Trace replay',        bg: '#f5f3ff',                     color: '#7c3aed' },
  test:          { label: 'Test data (seeded)',  bg: 'var(--status-pending-bg)',    color: 'var(--status-pending)' },
}
const UNKNOWN_SOURCE_BADGE = { label: 'Unlabeled (recorded before source tracking)', bg: 'var(--bg-sunken)', color: 'var(--text-muted)' }

interface ApprovalsResponse {
  approvals: ApprovalItem[]
}

type DecisionMap = Record<string, 'approve' | 'reject'>
type NotesMap = Record<string, string>

/** How long this action has been held. A reviewer's question is "how long has
 *  this been sitting?", which "3 hours ago" answers only indirectly. */
function waitingFor(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime()
  if (!isFinite(ms) || ms < 0) return 'moments'
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m`
  const days = Math.floor(hrs / 24)
  return `${days}d ${hrs % 24}h`
}

function formatAction(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ── Readable parameters ───────────────────────────────────────────────────────
// Format values by what they represent so a reviewer scans instead of parsing.
// The formatted view never replaces the contract: the raw JSON the agent sent
// stays one click away, and currency formatting is labeled as no-conversion
// (an integration passing cents would otherwise read 100× too large).

const MONEY_KEY = /(^|_)(amount|price|total|cost|fee|refund|charge|value_usd|usd)($|_)/i
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function isMoneyParam(key: string, v: unknown): boolean {
  return MONEY_KEY.test(key) && typeof v === 'number'
}

function formatParamValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return 'Not set'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') {
    return isMoneyParam(key, v) ? `$${v.toLocaleString()}` : v.toLocaleString()
  }
  if (typeof v === 'string' && ISO_TS.test(v)) {
    const d = new Date(v)
    if (!isNaN(d.getTime())) {
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    }
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// Who/what the action is aimed at, in priority order.
const TARGET_KEYS = ['customer', 'recipient', 'to', 'email', 'user', 'account', 'target', 'resource', 'instance', 'repo', 'id']
const REASON_KEYS = ['reason', 'note', 'message', 'description', 'subject']

// One deterministic sentence answering "what is this agent about to do?" —
// interpolates only the actual values, so it cannot drift from the contract.
function scenarioLine(a: ApprovalItem): { pre: string; money: string | null; post: string } | null {
  const p = a.params
  if (!p || Object.keys(p).length === 0) return null
  const moneyKey = Object.keys(p).find((k) => isMoneyParam(k, p[k]))
  const targetKey = TARGET_KEYS.find((k) => k in p && p[k] != null && String(p[k]) !== '')
  const reasonKey = REASON_KEYS.find((k) => k in p && typeof p[k] === 'string' && p[k] !== '')
  if (!moneyKey && !targetKey && !reasonKey) return null

  const actionPhrase = a.action.replace(/_/g, ' ')
  let post = ''
  if (targetKey) post += ` for ${String(p[targetKey])}`
  if (reasonKey) post += `: “${String(p[reasonKey])}”`
  return {
    pre: `Wants to ${actionPhrase}${moneyKey ? ': ' : ''}`,
    money: moneyKey ? formatParamValue(moneyKey, p[moneyKey]) : null,
    post,
  }
}

export default function Approvals() {
  const [approvals, setApprovals] = useState<ApprovalItem[]>([])
  const [loading, setLoading] = useState(true)
  const [deciding, setDeciding] = useState<DecisionMap>({})
  const [notes, setNotes] = useState<NotesMap>({})
  const [decided, setDecided] = useState<DecisionMap>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkRunning, setBulkRunning] = useState<'approve' | 'reject' | null>(null)
  const [rawOpen, setRawOpen] = useState<Set<string>>(new Set())
  const selectAllRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    setLoadError(null)
    apiFetch<ApprovalsResponse>('/api/approvals')
      .then((d) => {
        const items = d.approvals ?? []
        setApprovals(items)
        // The 10s poll can remove items decided elsewhere — never keep a
        // selection pointing at rows that are no longer in the queue.
        setSelected((prev) => {
          const alive = new Set(items.map((a) => a.id))
          return new Set([...prev].filter((id) => alive.has(id)))
        })
        setLoading(false)
      })
      // An outage must NOT render the green "all caught up" state — that reads
      // as a clean queue when the truth is we couldn't reach the server.
      .catch((e: Error) => { setLoadError(e.message); setLoading(false) })
  }, [])

  useEffect(() => {
    load()
    const iv = setInterval(load, 10_000)
    return () => clearInterval(iv)
  }, [load])

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setDeciding((prev) => ({ ...prev, [id]: decision }))
    try {
      const res = await apiFetch<{ status: string; replay?: { status: string; detail?: string } | null }>(
        `/api/approvals/${id}`,
        {
          method: 'POST',
          body: JSON.stringify({ decision, reason: notes[id] ?? '' }),
        },
      )
      // Honest outcome: say whether the real action actually ran on approve.
      if (decision === 'reject') {
        toast('Agent blocked')
      } else if (res.replay?.status === 'replayed') {
        toast('Approved. The action ran.')
      } else if (res.replay?.status === 'replay_failed') {
        toast(`Approved, but the action failed: ${res.replay.detail ?? 'unknown'}`, 'error')
      } else if (res.replay?.status === 'skipped') {
        toast('Approved. It will run once live replay is enabled.')
      } else {
        toast('Approved. The agent has resumed.')
      }
      setDecided((prev) => ({ ...prev, [id]: decision }))
      setTimeout(() => {
        setApprovals((prev) => prev.filter((a) => a.id !== id))
        setDecided((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }, 2000)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      toast('Failed: ' + msg, 'error')
    } finally {
      setDeciding((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }

  const handleNoteChange = (id: string, value: string) => {
    setNotes((prev) => ({ ...prev, [id]: value }))
  }

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected((prev) =>
      prev.size === approvals.length ? new Set() : new Set(approvals.map((a) => a.id))
    )
  }

  // Native indeterminate state is only settable via the DOM property.
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selected.size > 0 && selected.size < approvals.length
    }
  }, [selected, approvals])

  const bulkDecide = async (decision: 'approve' | 'reject') => {
    const ids = [...selected].filter((id) => !(id in deciding))
    if (ids.length === 0) return
    setBulkRunning(decision)
    setDeciding((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, decision])) }))

    const results = await Promise.allSettled(
      ids.map((id) =>
        apiFetch(`/api/approvals/${id}`, {
          method: 'POST',
          body: JSON.stringify({ decision, reason: notes[id] ?? '' }),
        })
      )
    )
    const okIds = ids.filter((_, i) => results[i].status === 'fulfilled')
    const failed = ids.length - okIds.length

    setDecided((prev) => ({ ...prev, ...Object.fromEntries(okIds.map((id) => [id, decision])) }))
    setSelected((prev) => new Set([...prev].filter((id) => !okIds.includes(id))))
    setDeciding((prev) => {
      const next = { ...prev }
      ids.forEach((id) => delete next[id])
      return next
    })
    setBulkRunning(null)

    const verb = decision === 'approve' ? 'resumed' : 'blocked'
    if (failed === 0) toast(`${okIds.length} agent action${okIds.length !== 1 ? 's' : ''} ${verb}`)
    else toast(`${okIds.length} ${verb}, ${failed} failed and are still in the queue`, 'error')

    setTimeout(() => {
      setApprovals((prev) => prev.filter((a) => !okIds.includes(a.id)))
      setDecided((prev) => {
        const next = { ...prev }
        okIds.forEach((id) => delete next[id])
        return next
      })
    }, 2000)
  }

  if (loading) {
    return (
      <div style={{ padding: 40, maxWidth: 768, margin: "0 auto" }} aria-busy="true" aria-label="Loading approvals">
        {/* Mirrors the page: title → pending-approval cards */}
        <div className="skeleton" style={{ height: 30, width: 240 }} />
        <div style={{ marginTop: 20 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 96, marginTop: 12 }} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-10 max-w-5xl mx-auto">
      {/* Page header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Approvals</h1>
          <p className="mt-2 text-sm text-gray-500">
            Actions held for a human decision before they run.
          </p>
        </div>
        {approvals.length > 0 && (
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold" style={{ background: 'var(--status-pending-bg)', color: 'var(--status-pending)', border: '1px solid var(--severity-medium-border)' }}>
            {approvals.length} pending
          </span>
        )}
      </div>

      {/* Load error — must win over the "all caught up" empty state */}
      {loadError && approvals.length === 0 ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : approvals.length === 0 ? (
        <div
          style={{
            display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center",
            padding: "56px 24px",
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
          }}
        >
          <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--bg-card)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
            <Inbox size={20} style={{ color: "var(--text-muted)" }} />
          </div>
          <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Nothing waiting</p>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", maxWidth: 360 }}>
            Actions held by a policy will appear here. When an agent triggers a
            "require approval" policy, it pauses until you decide.
          </p>
          <Link
            to="/"
            style={{ marginTop: 16, fontSize: 13, color: "var(--text-link)", fontWeight: 500, textDecoration: "none" }}
          >
            Set up a policy on an agent
          </Link>
        </div>
      ) : (
        <div>
          {/* Bulk selection toolbar */}
          <div
            className="flex items-center gap-3 rounded-xl border px-4 py-2.5 mb-4"
            style={{
              background: selected.size > 0 ? 'var(--bg-sunken)' : 'var(--bg-card)',
              borderColor: 'var(--border)',
            }}
          >
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                ref={selectAllRef}
                type="checkbox"
                className="w-4 h-4 cursor-pointer"
                style={{ accentColor: 'var(--text-primary)' }}
                checked={selected.size === approvals.length && approvals.length > 0}
                onChange={toggleSelectAll}
                disabled={bulkRunning != null}
              />
              <span className="text-sm font-medium text-gray-700">
                {selected.size > 0 ? `${selected.size} of ${approvals.length} selected` : 'Select all'}
              </span>
            </label>
            {selected.size > 0 && (
              <div className="flex items-center gap-2 ml-auto">
                <Button
                  size="sm"
                  onClick={() => bulkDecide('approve')}
                  disabled={bulkRunning != null}
                  loading={bulkRunning === 'approve'}
                  icon={<Check size={14} />}
                >
                  {bulkRunning === 'approve' ? 'Approving...' : `Approve ${selected.size}`}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => bulkDecide('reject')}
                  disabled={bulkRunning != null}
                  loading={bulkRunning === 'reject'}
                  icon={<X size={14} />}
                >
                  {bulkRunning === 'reject' ? 'Rejecting...' : `Reject ${selected.size}`}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={bulkRunning != null}>
                  Clear
                </Button>
              </div>
            )}
          </div>

          {approvals.map((a) => {
            const isBusy = a.id in deciding
            const postDecision = decided[a.id]
            const hasParams = a.params != null && Object.keys(a.params).length > 0

            return (
              <div
                key={a.id}
                className="relative bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6 overflow-hidden"
              >
                {/* Post-decision flash overlay */}
                {postDecision != null && (
                  <div
                    style={{
                      position: "absolute", inset: 0, display: "flex", alignItems: "center",
                      justifyContent: "center", borderRadius: 12, fontSize: 13, fontWeight: 600, zIndex: 10,
                      ...(postDecision === 'approve'
                        ? { background: "var(--severity-safe-bg)", color: "var(--severity-safe)" }
                        : { background: "var(--severity-critical-bg)", color: "var(--severity-critical)" }),
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {postDecision === 'approve' ? <Check size={16} /> : <X size={16} />}
                      {postDecision === 'approve' ? 'Agent resumed' : 'Agent blocked'}
                    </span>
                  </div>
                )}

                <div className="flex gap-6">
                  <div className="flex-1 min-w-0">
                    {/* Who is asking */}
                    <div className="flex items-center gap-2.5 text-sm mb-4">
                      <input
                        type="checkbox"
                        className="w-4 h-4 cursor-pointer flex-shrink-0"
                        style={{ accentColor: 'var(--text-primary)' }}
                        checked={selected.has(a.id)}
                        onChange={() => toggleSelected(a.id)}
                        disabled={isBusy || bulkRunning != null}
                        aria-label={`Select ${a.agent_name || a.agent_id}: ${a.tool} ${a.action}`}
                      />
                      <Link
                        to={`/agent/${a.agent_id}`}
                        style={{ fontWeight: 600, color: 'var(--text-primary)', textDecoration: 'none' }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-link)')}
                        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
                      >
                        {a.agent_name || a.agent_id}
                      </Link>
                      {(() => {
                        const badge = SOURCE_BADGE[a.source ?? ''] ?? UNKNOWN_SOURCE_BADGE
                        return (
                          <span
                            className="text-[11px] px-2 py-0.5 rounded-full font-medium"
                            style={{ background: badge.bg, color: badge.color }}
                          >
                            {badge.label}
                          </span>
                        )
                      })()}
                    </div>

                    {/* What it wants to do, and what stopped it — the two
                        questions a reviewer must answer before deciding, side
                        by side so neither needs a click. */}
                    <div className="grid gap-5 mb-4" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
                      <div className="min-w-0">
                        <div className="stat-block__label">Action</div>
                        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                          <span className="tool-chip">{a.tool}.{a.action}</span>
                          {(a.risk_labels ?? []).map((label) => (
                            <span
                              key={label}
                              className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                              style={{ backgroundColor: riskLabelBg(label as RiskLabel), color: riskLabelColor(label as RiskLabel) }}
                            >
                              {riskLabelName(label)}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="stat-block__label">Held by policy</div>
                        {a.policy ? (
                          <>
                            <div className="mt-1.5 flex items-start gap-1.5 text-sm" style={{ color: 'var(--critical)' }}>
                              <ShieldAlert size={14} className="flex-shrink-0 mt-0.5" />
                              <span>
                                {a.policy.reason
                                  ? a.policy.reason
                                  : <>Sign-off required on <code className="mono text-[12px]">{a.policy.action_pattern}</code></>}
                              </span>
                            </div>
                            {(a.policy.created_by || a.policy.created_at) && (
                              <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                {a.policy.created_by ? `set by ${a.policy.created_by}` : 'set'}
                                {a.policy.created_at
                                  ? ` on ${new Date(a.policy.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                                  : ''}
                                {' · '}
                                <code className="mono text-[11px]">{a.policy.action_pattern}</code>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="mt-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>
                            Not recorded for this action.
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Scenario line — what this agent is about to do, in one claim */}
                    {(() => {
                      const line = scenarioLine(a)
                      return line ? (
                        <p className="text-sm text-gray-800 mb-3">
                          {line.pre}
                          {line.money && <strong className="font-semibold">{line.money}</strong>}
                          {line.post}
                        </p>
                      ) : null
                    })()}

                    {a.detail != null && a.detail !== '' && (
                      <p className="text-sm text-gray-600 mb-3">{a.detail}</p>
                    )}

                    {/* Params — formatted for scanning; raw JSON is the contract */}
                    {hasParams && (
                      <div className="rounded-lg p-3.5 mb-3" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)' }}>
                        <div className="flex items-center justify-between mb-2">
                          <p className="stat-block__label">Parameters</p>
                          <button
                            type="button"
                            onClick={() => setRawOpen((prev) => {
                              const next = new Set(prev)
                              if (next.has(a.id)) next.delete(a.id)
                              else next.add(a.id)
                              return next
                            })}
                            className="text-xs bg-transparent border-0 p-0 cursor-pointer underline underline-offset-2"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {rawOpen.has(a.id) ? 'formatted' : 'raw'}
                          </button>
                        </div>
                        {rawOpen.has(a.id) ? (
                          <pre className="text-xs mono break-all whitespace-pre-wrap m-0" style={{ color: 'var(--text-primary)' }}>
                            {JSON.stringify(a.params, null, 2)}
                          </pre>
                        ) : (
                          <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5">
                            {Object.entries(a.params!).map(([k, v]) => (
                              <div key={k} className="contents">
                                <span className="text-xs mono whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                                  {k}:
                                </span>
                                <span className="text-xs mono break-all" style={{ color: 'var(--text-primary)' }}>
                                  {formatParamValue(k, v)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {Object.entries(a.params!).some(([k, v]) => isMoneyParam(k, v)) && (
                          <p className="text-[11px] mt-2 mb-0" style={{ color: 'var(--text-muted)' }}>
                            Amounts are shown exactly as the agent sent them, with no unit conversion.
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1.5 text-xs flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                        <Clock size={12} /> Waiting {waitingFor(a.timestamp)}
                      </span>
                      <Input
                        type="text"
                        placeholder="Add a note (optional)…"
                        value={notes[a.id] ?? ''}
                        onChange={(e) => handleNoteChange(a.id, e.target.value)}
                        disabled={isBusy}
                        style={{ height: 34, fontSize: 13 }}
                      />
                    </div>
                    <p className="text-[11px] mt-2 mb-0" style={{ color: 'var(--text-muted)' }}>
                      {['sandbox', 'boundary_test', 'replay'].includes(a.source ?? '')
                        ? 'This came from a simulation. Your decision updates the record for reporting, and no agent is waiting on it.'
                        : 'Approving marks this action allowed, and the paused agent proceeds with exactly the arguments shown. Rejecting records it as blocked.'}
                    </p>
                  </div>

                  {/* Decision column. Reject is quiet on purpose: destructive
                      weight belongs on a confirmation, not on every row. */}
                  <div className="flex flex-col gap-2 flex-shrink-0" style={{ width: 150 }}>
                    <Button
                      size="sm"
                      onClick={() => decide(a.id, 'approve')}
                      disabled={isBusy}
                      loading={deciding[a.id] === 'approve'}
                      icon={<Check size={14} />}
                    >
                      {deciding[a.id] === 'approve' ? 'Approving…' : 'Approve'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => decide(a.id, 'reject')}
                      disabled={isBusy}
                      loading={deciding[a.id] === 'reject'}
                      icon={<X size={14} />}
                    >
                      {deciding[a.id] === 'reject' ? 'Rejecting…' : 'Reject'}
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
