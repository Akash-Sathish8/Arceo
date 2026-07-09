import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Check, X, CheckCircle2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/components/shared/Toast'
import { timeAgo } from '@/lib/utils'
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
  timestamp: string
  status: string
}

interface ApprovalsResponse {
  approvals: ApprovalItem[]
}

type DecisionMap = Record<string, 'approve' | 'reject'>
type NotesMap = Record<string, string>

function formatAction(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatParamValue(v: unknown): string {
  if (typeof v === 'object' && v !== null) return JSON.stringify(v)
  return String(v)
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
      await apiFetch(`/api/approvals/${id}`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason: notes[id] ?? '' }),
      })
      toast(decision === 'approve' ? 'Agent resumed' : 'Agent blocked')
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

  if (loading) {
    return (
      <div style={{ padding: 40, maxWidth: 768, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 13 }}>
          <div style={{ width: 16, height: 16, border: "2px solid var(--border-strong)", borderTopColor: "var(--text-secondary)", borderRadius: "50%", animation: "btn-spin 0.7s linear infinite" }} />
          Loading...
        </div>
      </div>
    )
  }

  return (
    <div className="p-10 max-w-4xl mx-auto">
      {/* Page header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Approval Queue</h1>
          <p className="mt-2 text-sm text-gray-500">
            Actions your agents flagged for human review before proceeding.
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
                  <div className="flex items-center gap-1.5">
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
                  </div>
                </div>

                {/* Tool chip → action name */}
                <div className="flex items-center gap-2 mb-3">
                  <span style={{ background: 'var(--bg-sunken)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-full)', padding: '2px 10px', fontSize: 12, fontWeight: 500 }}>
                    {a.tool}
                  </span>
                  <span className="text-gray-400 text-sm">→</span>
                  <span className="text-sm font-medium text-gray-800">
                    {formatAction(a.action)}
                  </span>
                </div>

                {/* Optional detail */}
                {a.detail != null && a.detail !== '' && (
                  <p className="text-sm text-gray-600 mb-3">{a.detail}</p>
                )}

                {/* Params grid */}
                {hasParams && (
                  <div className="rounded-xl p-3 mb-4" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)' }}>
                    <p className="text-xs font-semibold text-gray-500 mb-2">
                      Parameters
                    </p>
                    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                      {Object.entries(a.params!).map(([k, v]) => (
                        <div key={k} className="contents">
                          <span className="text-xs text-gray-500 font-medium whitespace-nowrap">
                            {k.replace(/_/g, ' ')}
                          </span>
                          <span className="text-xs text-gray-800 font-mono break-all">
                            {formatParamValue(v)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Action buttons + optional note */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Button
                      size="sm"
                      onClick={() => decide(a.id, 'approve')}
                      disabled={isBusy}
                      loading={deciding[a.id] === 'approve'}
                      icon={<Check size={14} />}
                    >
                      {deciding[a.id] === 'approve' ? 'Approving...' : 'Approve'}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => decide(a.id, 'reject')}
                      disabled={isBusy}
                      loading={deciding[a.id] === 'reject'}
                      icon={<X size={14} />}
                    >
                      {deciding[a.id] === 'reject' ? 'Rejecting...' : 'Reject'}
                    </Button>
                    <div style={{ flex: 1 }}>
                      <Input
                        type="text"
                        placeholder="Add a note (optional)..."
                        value={notes[a.id] ?? ''}
                        onChange={(e) => handleNoteChange(a.id, e.target.value)}
                        disabled={isBusy}
                        style={{ height: 36, fontSize: 13 }}
                      />
                    </div>
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
