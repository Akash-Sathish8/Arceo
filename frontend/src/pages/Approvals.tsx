import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Check, X, CheckCircle2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/components/shared/Toast'
import { timeAgo, riskLabelBg, riskLabelColor, riskLabelName } from '@/lib/utils'
import type { RiskLabel } from '@/lib/types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import ErrorState from '@/components/shared/ErrorState'
import PageHeader from '@/components/shared/PageHeader'

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

// Sources whose decisions only update the record — no paused agent executes.
const SIMULATION_SOURCES = ['sandbox', 'boundary_test', 'replay']

// How long an armed live decision waits before its POST(s) fire.
const UNDO_WINDOW_S = 5

interface PendingDecision {
  ids: string[]
  verb: 'approve' | 'reject'
  bulk: boolean
  secondsLeft: number
}

interface ApprovalsResponse {
  approvals: ApprovalItem[]
}

type DecisionMap = Record<string, 'approve' | 'reject'>
type NotesMap = Record<string, string>

function formatAction(s: string | null | undefined): string {
  // A malformed item without an action must not crash the whole queue.
  if (typeof s !== 'string' || s === '') return 'Unknown action'
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
  if (v === null || v === undefined) return '—'
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

  const actionPhrase = typeof a.action === 'string' ? a.action.replace(/_/g, ' ') : 'take an unknown action'
  let post = ''
  if (targetKey) post += ` for ${String(p[targetKey])}`
  if (reasonKey) post += ` — “${String(p[reasonKey])}”`
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
  // Two-step inline confirm for bulk decisions (same pattern as policy delete).
  const [bulkConfirm, setBulkConfirm] = useState<'approve' | 'reject' | null>(null)
  // Undo window: a LIVE decision arms a short countdown and the POST(s) fire
  // only when it expires — Undo disarms it. One window at a time; arming a new
  // one flushes the previous immediately. Simulation decisions stay instant
  // (nothing real executes). Singles arm directly (the window replaces the
  // old confirm step); bulk arms after its confirm.
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null)
  const pendingRef = useRef<PendingDecision | null>(null)
  pendingRef.current = pendingDecision
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
        toast('Approved — action executed')
      } else if (res.replay?.status === 'replay_failed') {
        toast(`Approved, but the action failed: ${res.replay.detail ?? 'unknown'}`, 'error')
      } else if (res.replay?.status === 'skipped') {
        toast('Approved — will execute when live replay is enabled')
      } else {
        toast('Approved — agent resumed')
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

  const executeDecision = (p: PendingDecision) => {
    if (p.bulk) void bulkDecide(p.verb, p.ids)
    else void decide(p.ids[0], p.verb)
  }
  const executeRef = useRef(executeDecision)
  executeRef.current = executeDecision

  const armDecision = (ids: string[], verb: 'approve' | 'reject', bulk: boolean) => {
    // Arming a new window flushes the previous one — nothing is ever dropped.
    if (pendingRef.current) executeRef.current(pendingRef.current)
    setPendingDecision({ ids, verb, bulk, secondsLeft: UNDO_WINDOW_S })
  }

  // Countdown tick; at zero the decision executes for real.
  useEffect(() => {
    if (!pendingDecision) return
    if (pendingDecision.secondsLeft <= 0) {
      setPendingDecision(null)
      executeRef.current(pendingDecision)
      return
    }
    const t = setTimeout(() => {
      setPendingDecision((p) => (p ? { ...p, secondsLeft: p.secondsLeft - 1 } : null))
    }, 1000)
    return () => clearTimeout(t)
  }, [pendingDecision])

  // Leaving the page must not silently drop an armed decision — flush it.
  useEffect(() => () => {
    if (pendingRef.current) executeRef.current(pendingRef.current)
  }, [])

  // Live items get an undo window; simulation decisions are record-keeping.
  const requestDecide = (a: ApprovalItem, verb: 'approve' | 'reject') => {
    if (SIMULATION_SOURCES.includes(a.source ?? '')) {
      void decide(a.id, verb)
      return
    }
    armDecision([a.id], verb, false)
  }

  const toggleSelected = (id: string) => {
    // Any change to the selection invalidates a pending bulk confirmation.
    setBulkConfirm(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    setBulkConfirm(null)
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

  const bulkDecide = async (decision: 'approve' | 'reject', idsToDecide?: string[]) => {
    if (bulkRunning != null) return
    const ids = (idsToDecide ?? [...selected]).filter((id) => !(id in deciding))
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
    else toast(`${okIds.length} ${verb}, ${failed} failed — still in the queue`, 'error')

    setTimeout(() => {
      setApprovals((prev) => prev.filter((a) => !okIds.includes(a.id)))
      setDecided((prev) => {
        const next = { ...prev }
        okIds.forEach((id) => delete next[id])
        return next
      })
    }, 2000)
  }

  // How many selected items are real, live actions — simulations only update a record.
  const liveSelectedCount = approvals.filter(
    (a) => selected.has(a.id) && !SIMULATION_SOURCES.includes(a.source ?? '')
  ).length

  if (loading) {
    return (
      <div style={{ padding: "var(--page-pad)", maxWidth: 768, margin: "0 auto" }} aria-busy="true" aria-label="Loading approvals">
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
    <div className="max-w-4xl mx-auto" style={{ padding: 'var(--page-pad)' }}>
      {/* Page header */}
      <PageHeader
        title="Approval Queue"
        description="Actions your agents flagged for human review before proceeding."
        actions={approvals.length > 0 ? (
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold" style={{ background: 'var(--caution-bg)', color: 'var(--caution)', border: '1px solid var(--caution-line)' }}>
            {approvals.length} pending
          </span>
        ) : undefined}
      />

      {/* Load error — must win over the "all caught up" empty state */}
      {loadError && approvals.length === 0 ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : approvals.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", paddingTop: 64, paddingBottom: 64 }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--severity-safe-bg)", border: "1px solid var(--severity-safe-border)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
            <CheckCircle2 size={32} style={{ color: "var(--severity-safe)" }} />
          </div>
          <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>You're all caught up</p>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", maxWidth: 340 }}>
            No actions are waiting for your review right now.
            <br />
            When an agent triggers a "require approval" policy, it will pause here until you decide.
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
                {pendingDecision?.bulk ? (
                  <>
                    <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }} aria-live="polite">
                      {pendingDecision.verb === 'approve' ? 'Approving' : 'Rejecting'}{' '}
                      {pendingDecision.ids.length} in {pendingDecision.secondsLeft}s
                    </span>
                    <Button variant="secondary" size="sm" onClick={() => setPendingDecision(null)}>
                      Undo
                    </Button>
                  </>
                ) : bulkConfirm != null ? (
                  <>
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {bulkConfirm === 'approve' && liveSelectedCount > 0
                        ? `Executes ${liveSelectedCount} real agent action${liveSelectedCount !== 1 ? 's' : ''}.`
                        : "This can't be undone once it runs."}
                    </span>
                    <Button
                      size="sm"
                      variant={bulkConfirm === 'reject' ? 'destructive' : undefined}
                      onClick={() => {
                        const ids = [...selected].filter((id) => !(id in deciding))
                        setBulkConfirm(null)
                        if (ids.length > 0) armDecision(ids, bulkConfirm, true)
                      }}
                      disabled={bulkRunning != null}
                      loading={bulkRunning === bulkConfirm}
                      icon={bulkConfirm === 'approve' ? <Check size={14} /> : <X size={14} />}
                    >
                      {bulkRunning === bulkConfirm
                        ? (bulkConfirm === 'approve' ? 'Approving…' : 'Rejecting…')
                        : `Confirm ${bulkConfirm} ${selected.size}`}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setBulkConfirm(null)} disabled={bulkRunning != null}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      onClick={() => setBulkConfirm('approve')}
                      disabled={bulkRunning != null}
                      icon={<Check size={14} />}
                    >
                      {`Approve ${selected.size}`}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setBulkConfirm('reject')}
                      disabled={bulkRunning != null}
                      icon={<X size={14} />}
                    >
                      {`Reject ${selected.size}`}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={bulkRunning != null}>
                      Clear
                    </Button>
                  </>
                )}
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

                {/* Card header: select checkbox + agent name + timestamp */}
                <div className="flex items-center gap-2.5 text-sm mb-3">
                  <input
                    type="checkbox"
                    className="w-4 h-4 cursor-pointer flex-shrink-0"
                    style={{ accentColor: 'var(--text-primary)' }}
                    checked={selected.has(a.id)}
                    onChange={() => toggleSelected(a.id)}
                    disabled={isBusy || bulkRunning != null}
                    aria-label={`Select ${a.agent_name || a.agent_id}: ${a.tool} ${a.action}`}
                  />
                  <div className="flex items-center gap-1.5 flex-wrap">
                  <Link
                    to={`/agent/${a.agent_id}`}
                    style={{ fontWeight: 600, color: "var(--text-primary)", textDecoration: "none" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-link)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                  >
                    {a.agent_name || a.agent_id}
                  </Link>
                  <span className="text-gray-300">·</span>
                  <span className="text-gray-400 text-xs">{timeAgo(a.timestamp)}</span>
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
                </div>

                {/* Tool chip → action name + why-it-paused risk labels */}
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span style={{ background: 'var(--bg-sunken)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-full)', padding: '2px 10px', fontSize: 12, fontWeight: 500 }}>
                    {a.tool}
                  </span>
                  <span className="text-gray-400 text-sm">→</span>
                  <span className="text-sm font-medium text-gray-800">
                    {formatAction(a.action)}
                  </span>
                  {(a.risk_labels ?? []).map((label) => (
                    <span
                      key={label}
                      className="text-xs px-1.5 py-0.5 rounded font-medium"
                      style={{ backgroundColor: riskLabelBg(label as RiskLabel), color: riskLabelColor(label as RiskLabel) }}
                    >
                      {riskLabelName(label)}
                    </span>
                  ))}
                </div>

                {/* Scenario line — what is this agent about to do, in one claim */}
                {(() => {
                  const line = scenarioLine(a)
                  return line ? (
                    <p className="text-sm text-gray-800 mb-2">
                      {line.pre}
                      {line.money && <strong className="font-semibold">{line.money}</strong>}
                      {line.post}
                    </p>
                  ) : null
                })()}

                {/* Why this is in front of you: the policy that paused it */}
                {a.policy && (
                  <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
                    Paused by a policy requiring sign-off on <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-sunken)', fontSize: 11 }}>{a.policy.action_pattern}</code>
                    {a.policy.reason ? <> — “{a.policy.reason}”</> : null}
                    {a.policy.created_by ? <> · set by {a.policy.created_by}</> : null}
                    {a.policy.created_at ? <> on {new Date(a.policy.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</> : null}
                  </p>
                )}

                {/* Optional detail */}
                {a.detail != null && a.detail !== '' && (
                  <p className="text-sm text-gray-600 mb-3">{a.detail}</p>
                )}

                {/* Params grid — formatted for scanning; raw JSON is the contract */}
                {hasParams && (
                  <div className="rounded-xl p-3 mb-4" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)' }}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-gray-500">Parameters</p>
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
                      <pre className="text-xs font-mono break-all whitespace-pre-wrap m-0" style={{ color: 'var(--text-primary)' }}>
                        {JSON.stringify(a.params, null, 2)}
                      </pre>
                    ) : (
                      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                        {Object.entries(a.params!).map(([k, v]) => (
                          <div key={k} className="contents">
                            <span className="text-xs text-gray-500 font-medium whitespace-nowrap">
                              {k.replace(/_/g, ' ')}
                            </span>
                            <span className="text-xs text-gray-800 font-mono break-all">
                              {formatParamValue(k, v)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {Object.entries(a.params!).some(([k, v]) => isMoneyParam(k, v)) && (
                      <p className="text-[11px] mt-2 mb-0" style={{ color: 'var(--text-muted)' }}>
                        Amounts shown as sent by the agent — no unit conversion applied.
                      </p>
                    )}
                  </div>
                )}

                {/* Action buttons + optional note */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {pendingDecision && !pendingDecision.bulk && pendingDecision.ids[0] === a.id ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }} aria-live="polite">
                      <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {pendingDecision.verb === 'approve'
                          ? `Approving in ${pendingDecision.secondsLeft}s — the real action executes.`
                          : `Rejecting in ${pendingDecision.secondsLeft}s — the action is blocked.`}
                      </span>
                      <Button variant="secondary" size="sm" onClick={() => setPendingDecision(null)}>
                        Undo
                      </Button>
                    </div>
                  ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Button
                      size="sm"
                      onClick={() => requestDecide(a, 'approve')}
                      disabled={isBusy}
                      loading={deciding[a.id] === 'approve'}
                      icon={<Check size={14} />}
                    >
                      {deciding[a.id] === 'approve' ? 'Approving…' : 'Approve'}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => requestDecide(a, 'reject')}
                      disabled={isBusy}
                      loading={deciding[a.id] === 'reject'}
                      icon={<X size={14} />}
                    >
                      {deciding[a.id] === 'reject' ? 'Rejecting…' : 'Reject'}
                    </Button>
                    <div style={{ flex: 1 }}>
                      <Input
                        type="text"
                        aria-label="Decision note (optional)"
                        placeholder="Add a note (optional)…"
                        value={notes[a.id] ?? ''}
                        onChange={(e) => handleNoteChange(a.id, e.target.value)}
                        disabled={isBusy}
                        style={{ height: 36, fontSize: 13 }}
                      />
                    </div>
                  </div>
                  )}
                  <p className="text-[11px] m-0" style={{ color: 'var(--text-muted)' }}>
                    {SIMULATION_SOURCES.includes(a.source ?? '')
                      ? 'This came from a simulation — deciding updates the record for reporting; no agent is waiting to execute.'
                      : 'Approving marks this action allowed — the paused agent proceeds with exactly the arguments shown. Rejecting records it as blocked.'}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
