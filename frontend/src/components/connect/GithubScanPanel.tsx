import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle, ArrowRight, Check, ChevronDown, ChevronRight, ExternalLink,
  FileCode2, GitBranch, Lock, RotateCcw, Search, X,
} from 'lucide-react'
import { apiFetch, ApiError, streamNdjson } from '@/lib/api'
import { scoreBand } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/shared/Toast'
import './githubScan.css'

// ── Types ────────────────────────────────────────────────────────────────────

type Stage = 'resolving' | 'listing' | 'fetching' | 'extracting'

type FileResult = {
  path: string
  status: 'queued' | 'registered' | 'skipped' | 'failed'
  agent_id?: string
  agent_name?: string
  tools_count?: number
  actions_count?: number
  model?: string
  blast_radius?: number | null
  risk_band?: string | null
  created?: boolean
  error?: string
}

type Summary = {
  owner: string; repo: string; branch: string; private?: boolean; subpath?: string | null
  files_scanned: number; candidates_total: number; candidates_scanned: number
  agents_detected: number; agents_registered: number
  truncated: boolean; scan_notes: string[]; elapsed_ms?: number
  results: FileResult[]
}

type ScanEvent =
  | { type: 'stage'; stage: Stage }
  | { type: 'repo'; owner: string; repo: string; branch: string; private: boolean; subpath: string | null }
  | { type: 'listed'; candidates_total: number; candidates_scanned: number }
  | { type: 'progress'; done: number; total: number; agent_files: number }
  | ({ type: 'file' } & FileResult)
  | ({ type: 'done' } & Summary)
  | { type: 'error'; status: number; code: string; detail: string }

type GithubStatus = {
  configured: boolean; connected: boolean; account: string; account_type: string
  manage_url: string; install_url: string
}

type Repo = { full_name: string; private: boolean; default_branch: string; pushed_at: string; description: string }

type ScanError = { status: number; code?: string; detail: string }

type Phase = 'idle' | 'scanning' | 'done' | 'error'

// Public repos known to contain agents, so a first scan never starts blank.
const EXAMPLES = [
  { label: 'openai/openai-cs-agents-demo', url: 'https://github.com/openai/openai-cs-agents-demo' },
  { label: 'anthropics/anthropic-quickstarts', url: 'https://github.com/anthropics/anthropic-quickstarts' },
]

const STAGES: { key: Stage; label: string }[] = [
  { key: 'resolving', label: 'Finding repo' },
  { key: 'listing', label: 'Listing files' },
  { key: 'fetching', label: 'Reading code' },
  { key: 'extracting', label: 'Extracting agents' },
]

const PRIVATE_CODES = new Set(['not_found_or_private', 'private_needs_connect', 'not_in_installation'])

// Mirrors backend github_scan.parse_github_url, so the form can say "that's not
// a repo" before a round trip and show what it understood from a /tree/ link.
export function parseGithubUrl(raw: string): { owner: string; repo: string; ref?: string; subpath?: string } | null {
  let s = raw.trim()
  if (!s) return null
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s)
  if (ssh) return { owner: ssh[1], repo: ssh[2] }
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '')
  if (!s.toLowerCase().startsWith('github.com/')) return null
  s = s.slice('github.com/'.length).split(/[?#]/)[0]
  const parts = s.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/, '')
  const ok = /^[A-Za-z0-9_.-]{1,100}$/
  if (!ok.test(owner) || !ok.test(repo)) return null
  if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    return { owner, repo, ref: parts[3], subpath: parts.slice(4).join('/') || undefined }
  }
  return { owner, repo }
}

export function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

// ── Connection (shared with Settings) ────────────────────────────────────────

export function useGithubConnection() {
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const refresh = useCallback(async () => {
    try {
      setStatus(await apiFetch<GithubStatus>('/api/integrations/github'))
    } catch {
      setStatus(null)
    }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const connect = useCallback(async () => {
    try {
      const { url } = await apiFetch<{ url: string }>('/api/integrations/github/connect', { method: 'POST' })
      const base = (import.meta as ImportMeta & { env: Record<string, string> }).env.VITE_API_URL ?? ''
      window.location.href = `${base}${url}`
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }, [])

  const disconnect = useCallback(async () => {
    try {
      await apiFetch('/api/integrations/github', { method: 'DELETE' })
      toast('GitHub disconnected')
      refresh()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }, [refresh])

  return { status, refresh, connect, disconnect }
}

function ConnectionStrip({ status, onConnect, onDisconnect }: {
  status: GithubStatus; onConnect: () => void; onDisconnect: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  if (!status.connected) {
    return (
      <div className="gh-strip">
        <span className="gh-strip-icon"><Lock size={14} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Scanning a private repo?</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Connect GitHub and choose which repos Arceo can read. Read-only, and you can revoke it anytime.
          </div>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onConnect} icon={<GithubMark size={14} />}>
          Connect GitHub
        </Button>
      </div>
    )
  }
  return (
    <div className="gh-strip">
      <span className="gh-strip-icon gh-strip-icon--ok"><GithubMark size={14} /></span>
      <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-primary)' }}>
        Connected to <strong>@{status.account}</strong>
        <span style={{ color: 'var(--text-secondary)' }}> · private repos you granted appear below</span>
      </div>
      {confirming ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Disconnect?</span>
          <Button type="button" variant="destructive" size="sm" onClick={() => { setConfirming(false); onDisconnect() }}>Yes</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>No</Button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <a className="gh-link" href={status.manage_url} target="_blank" rel="noreferrer">
            Manage repos <ExternalLink size={11} />
          </a>
          <button type="button" className="gh-link" onClick={() => setConfirming(true)}>Disconnect</button>
        </div>
      )}
    </div>
  )
}

// ── Panel ────────────────────────────────────────────────────────────────────

export default function GithubScanPanel({ onScanned, onClose, onBusyChange, justConnected }: {
  onScanned: () => void
  onClose: () => void
  onBusyChange?: (busy: boolean) => void
  justConnected?: boolean
}) {
  const navigate = useNavigate()
  const { status, refresh, connect, disconnect } = useGithubConnection()

  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [showOptions, setShowOptions] = useState(false)
  const [touched, setTouched] = useState(false)
  const [repos, setRepos] = useState<Repo[] | null>(null)

  const [phase, setPhase] = useState<Phase>('idle')
  const [stage, setStage] = useState<Stage>('resolving')
  const [repoInfo, setRepoInfo] = useState<{ owner: string; repo: string; branch: string; private: boolean; subpath: string | null } | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [files, setFiles] = useState<FileResult[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<ScanError | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  const parsed = useMemo(() => parseGithubUrl(url), [url])
  const invalid = touched && url.trim() !== '' && !parsed

  useEffect(() => { onBusyChange?.(phase === 'scanning') }, [phase, onBusyChange])
  // Closing the dialog doesn't cancel a scan: it finishes server-side and the
  // agents land in the list. Only an explicit Cancel aborts.
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  useEffect(() => { if (justConnected) refresh() }, [justConnected, refresh])

  useEffect(() => {
    if (!status?.connected) { setRepos(null); return }
    apiFetch<{ connected: boolean; repos: Repo[] }>('/api/integrations/github/repos')
      .then((r) => { setRepos(r.repos); if (!r.connected) refresh() })
      .catch(() => setRepos([]))
  }, [status?.connected, refresh])

  useEffect(() => {
    if (phase !== 'scanning') return
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500)
    return () => clearInterval(id)
  }, [phase])

  const start = useCallback(async (target?: string) => {
    const scanUrl = (target ?? url).trim()
    setTouched(true)
    if (!parseGithubUrl(scanUrl)) return
    if (target) setUrl(target)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase('scanning'); setStage('resolving'); setRepoInfo(null); setProgress(null)
    setFiles([]); setError(null); setElapsed(0)
    let finished = false
    try {
      await streamNdjson<ScanEvent>('/api/authority/agents/extract-github/stream',
        { url: scanUrl, branch: branch.trim() || undefined }, (ev) => {
          switch (ev.type) {
            case 'stage': setStage(ev.stage); break
            case 'repo': setRepoInfo(ev); break
            case 'progress': setProgress({ done: ev.done, total: ev.total }); break
            case 'file': {
              const { type: _t, ...f } = ev
              void _t
              setFiles((prev) => {
                const i = prev.findIndex((p) => p.path === f.path)
                if (i < 0) return [...prev, f]
                const next = prev.slice(); next[i] = f; return next
              })
              break
            }
            case 'done': {
              const { type: _t, ...s } = ev
              void _t
              finished = true
              setSummary(s); setPhase('done'); onScanned()
              if (!mountedRef.current) {
                const n = s.results.filter((r) => r.status === 'registered').length
                toast(n ? `Found ${n} agent${n === 1 ? '' : 's'} in ${s.owner}/${s.repo}` : `No agents found in ${s.owner}/${s.repo}`)
              }
              break
            }
            case 'error':
              finished = true
              setError({ status: ev.status, code: ev.code, detail: ev.detail }); setPhase('error')
              break
          }
        }, ctrl.signal)
      if (!finished) {
        setError({ status: 0, detail: 'The connection closed before the scan finished. Agents found so far were saved; scan again to finish.' })
        setPhase('error'); onScanned()
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setPhase('idle'); onScanned()
        return
      }
      setError({ status: err instanceof ApiError ? err.status : 0, detail: (err as Error).message })
      setPhase('error')
    }
  }, [url, branch, onScanned])

  const cancel = () => abortRef.current?.abort()
  const reset = () => { setPhase('idle'); setSummary(null); setError(null); setFiles([]) }

  // ── Scanning / done / error views ──
  if (phase === 'scanning') {
    return (
      <ScanProgress
        target={repoInfo ? `${repoInfo.owner}/${repoInfo.repo}` : parsed ? `${parsed.owner}/${parsed.repo}` : url}
        repoInfo={repoInfo} stage={stage} progress={progress} files={files} elapsed={elapsed} onCancel={cancel}
      />
    )
  }
  if (phase === 'done' && summary) {
    return (
      <ScanResult
        summary={summary}
        onOpen={(id) => navigate(`/agent/${id}`)}
        onViewAll={onClose}
        onAgain={reset}
      />
    )
  }

  const repoMatches = repos && url.trim() && !parsed
    ? repos.filter((r) => r.full_name.toLowerCase().includes(url.trim().toLowerCase()))
    : repos

  return (
    <div className="space-y-4">
      {status?.configured && (
        <ConnectionStrip status={status} onConnect={connect} onDisconnect={disconnect} />
      )}

      {phase === 'error' && error && (
        <ErrorCard
          error={error}
          canConnect={Boolean(status?.configured && !status.connected)}
          manageUrl={status?.connected ? status.manage_url : ''}
          onConnect={connect}
          onRetry={() => start()}
          onDismiss={reset}
        />
      )}

      <form onSubmit={(e) => { e.preventDefault(); start() }} noValidate>
        <label htmlFor="gh-url" style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
          Repository
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className={`gh-input${invalid ? ' gh-input--invalid' : ''}`} style={{ flex: 1 }}>
            <span className="gh-input-icon">{status?.connected ? <Search size={15} /> : <GithubMark size={15} />}</span>
            <input
              id="gh-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder={status?.connected ? 'Search your repos, or paste any GitHub URL' : 'https://github.com/owner/repo'}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={invalid}
              aria-describedby="gh-url-hint"
            />
          </div>
          <Button type="submit" disabled={!parsed} icon={<ArrowRight size={14} />} style={{ flexShrink: 0 }}>
            Scan repo
          </Button>
        </div>

        <div id="gh-url-hint" style={{ minHeight: 20, marginTop: 6, fontSize: 12 }}>
          {invalid ? (
            <span style={{ color: 'var(--critical)' }}>That isn&rsquo;t a GitHub repo link. Try https://github.com/owner/repo</span>
          ) : parsed ? (
            <span className="gh-understood">
              <GithubMark size={11} /> {parsed.owner}/{parsed.repo}
              {(branch.trim() || parsed.ref) && <><GitBranch size={11} style={{ marginLeft: 6 }} /> {branch.trim() || parsed.ref}</>}
              {parsed.subpath && <span style={{ marginLeft: 6 }}>in {parsed.subpath}/</span>}
            </span>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>
              Paste a repo, branch or folder link. Branch and folder links scan only that part.
            </span>
          )}
        </div>

        <button type="button" className="gh-link" style={{ marginTop: 2, paddingLeft: 0 }} onClick={() => setShowOptions((v) => !v)}>
          {showOptions ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Branch
        </button>
        {showOptions && (
          <div style={{ marginTop: 8, maxWidth: 260 }}>
            <div className="gh-input">
              <span className="gh-input-icon"><GitBranch size={14} /></span>
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Default branch" spellCheck={false} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Use this for branch names with a slash, like release/1.2.
            </div>
          </div>
        )}
      </form>

      {status?.connected && repoMatches && repoMatches.length > 0 && (
        <div>
          <div className="gh-section-label">Your repositories</div>
          <div className="gh-repo-list">
            {repoMatches.slice(0, 8).map((r) => (
              <button key={r.full_name} type="button" className="gh-repo" onClick={() => start(`https://github.com/${r.full_name}`)}>
                {r.private ? <Lock size={13} style={{ color: 'var(--text-secondary)' }} /> : <GithubMark size={13} />}
                <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{r.full_name}</span>
                {r.description && <span className="gh-repo-desc">{r.description}</span>}
                <span className="gh-repo-go">Scan <ArrowRight size={12} /></span>
              </button>
            ))}
          </div>
        </div>
      )}
      {status?.connected && repos && repos.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Arceo can&rsquo;t see any repos yet. <a className="gh-link" style={{ padding: 0 }} href={status.manage_url} target="_blank" rel="noreferrer">Choose repos on GitHub</a>
        </div>
      )}

      {!url.trim() && (
        <div>
          <div className="gh-section-label">Or try a public example</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {EXAMPLES.map((ex) => (
              <button key={ex.url} type="button" className="gh-chip" onClick={() => start(ex.url)}>
                <GithubMark size={12} /> {ex.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
        Arceo reads files that call an LLM or define tools (Anthropic, OpenAI, LangChain, MCP and more),
        registers each agent it finds, and scores what it can do. Code is read, never stored. Up to 25 agents per scan.
      </p>
    </div>
  )
}

// ── Progress ─────────────────────────────────────────────────────────────────

function ScanProgress({ target, repoInfo, stage, progress, files, elapsed, onCancel }: {
  target: string
  repoInfo: { branch: string; private: boolean; subpath: string | null } | null
  stage: Stage
  progress: { done: number; total: number } | null
  files: FileResult[]
  elapsed: number
  onCancel: () => void
}) {
  const stageIdx = STAGES.findIndex((s) => s.key === stage)
  const doneFiles = files.filter((f) => f.status !== 'queued').length
  // One bar across the whole scan: reading is the first 40%, extraction the rest.
  const pct = stage === 'extracting'
    ? 40 + (files.length ? (doneFiles / files.length) * 60 : 60)
    : stage === 'fetching' && progress?.total
      ? (progress.done / progress.total) * 40
      : stageIdx * 4
  const mins = Math.floor(elapsed / 60)
  const secs = String(elapsed % 60).padStart(2, '0')

  return (
    <div className="space-y-5" aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span className="gh-avatar"><GithubMark size={18} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {target} {repoInfo?.private && <Lock size={13} style={{ color: 'var(--text-secondary)' }} />}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
            {repoInfo ? <><GitBranch size={11} /> {repoInfo.branch}{repoInfo.subpath ? ` · ${repoInfo.subpath}/` : ''}</> : 'Connecting to GitHub'}
            <span style={{ marginLeft: 8, fontVariantNumeric: 'tabular-nums' }}>{mins}:{secs}</span>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} icon={<X size={13} />}>Cancel</Button>
      </div>

      <div>
        <div className="gh-bar"><motion.div className="gh-bar-fill" animate={{ width: `${Math.max(3, Math.min(100, pct))}%` }} transition={{ ease: 'easeOut', duration: 0.4 }} /></div>
        <ol className="gh-steps">
          {STAGES.map((s, i) => {
            const state = i < stageIdx ? 'done' : i === stageIdx ? 'active' : 'todo'
            return (
              <li key={s.key} className={`gh-step gh-step--${state}`}>
                <span className="gh-step-dot">{state === 'done' ? <Check size={10} strokeWidth={3} /> : null}</span>
                {s.label}
                {s.key === 'fetching' && state === 'active' && progress && (
                  <span className="gh-step-count">{progress.done}/{progress.total}</span>
                )}
                {s.key === 'extracting' && state === 'active' && files.length > 0 && (
                  <span className="gh-step-count">{doneFiles}/{files.length}</span>
                )}
              </li>
            )
          })}
        </ol>
      </div>

      <div>
        <div className="gh-section-label">
          {files.length ? `${files.length} likely agent file${files.length === 1 ? '' : 's'}` : 'Looking for agent code'}
        </div>
        <div className="gh-files">
          {files.length === 0 && [0, 1, 2].map((i) => <div key={i} className="gh-file gh-file--skeleton"><span /><span /></div>)}
          <AnimatePresence initial={false}>
            {files.map((f) => (
              <motion.div key={f.path} className="gh-file" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
                <FileStatusDot status={f.status} />
                <code className="gh-file-path" title={f.path}>{f.path}</code>
                <span className="gh-file-meta">
                  {f.status === 'queued' && 'Waiting'}
                  {f.status === 'registered' && <><strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{f.agent_name}</strong> · {f.tools_count} tool{f.tools_count === 1 ? '' : 's'}</>}
                  {f.status === 'skipped' && 'Not an agent'}
                  {f.status === 'failed' && <span style={{ color: 'var(--critical)' }}>Couldn&rsquo;t extract</span>}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

function FileStatusDot({ status }: { status: FileResult['status'] }) {
  if (status === 'queued') return <span className="gh-dot gh-dot--pending" />
  if (status === 'registered') return <span className="gh-dot" style={{ background: 'var(--safe-ring)' }} />
  if (status === 'failed') return <span className="gh-dot" style={{ background: 'var(--critical-ring)' }} />
  return <span className="gh-dot" style={{ background: 'var(--ink-300)' }} />
}

// ── Result ───────────────────────────────────────────────────────────────────

function ScanResult({ summary, onOpen, onViewAll, onAgain }: {
  summary: Summary
  onOpen: (agentId: string) => void
  onViewAll: () => void
  onAgain: () => void
}) {
  const registered = summary.results.filter((r) => r.status === 'registered')
  const other = summary.results.filter((r) => r.status !== 'registered')
  const failed = other.filter((r) => r.status === 'failed')
  const repoLabel = `${summary.owner}/${summary.repo}`
  const secs = summary.elapsed_ms ? Math.max(1, Math.round(summary.elapsed_ms / 1000)) : null

  if (registered.length === 0) {
    const detectedButFailed = summary.agents_detected > 0 && failed.length > 0
    return (
      <div className="space-y-4">
        <div className="gh-empty">
          <span className="gh-avatar" style={{ margin: '0 auto 12px' }}><FileCode2 size={18} /></span>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
            {detectedButFailed ? `We couldn't extract the agents in ${repoLabel}` : `No agents found in ${repoLabel}`}
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '6px auto 0', maxWidth: 440, lineHeight: 1.5 }}>
            {detectedButFailed
              ? 'Arceo found files that look like agents but couldn’t read tool definitions from them. The details are below.'
              : `Arceo read ${summary.files_scanned} code file${summary.files_scanned === 1 ? '' : 's'} on ${summary.branch} and none defined tools for an LLM. If the agent lives on another branch or in a subfolder, paste that link. You can also upload the file directly.`}
          </p>
        </div>
        {summary.scan_notes.length > 0 && <Notes notes={summary.scan_notes} />}
        {other.length > 0 && <OtherFiles files={other} defaultOpen={detectedButFailed} />}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="secondary" onClick={onAgain} icon={<RotateCcw size={13} />}>Scan another repo</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span className="gh-avatar gh-avatar--ok"><Check size={18} strokeWidth={2.5} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
            Found {registered.length} agent{registered.length === 1 ? '' : 's'} in {repoLabel}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <GitBranch size={11} /> {summary.branch}{summary.subpath ? ` · ${summary.subpath}/` : ''}
            <span>· {summary.files_scanned} files read{secs ? ` in ${secs}s` : ''}</span>
            {failed.length > 0 && <span style={{ color: 'var(--critical)' }}>· {failed.length} couldn&rsquo;t be extracted</span>}
          </div>
        </div>
      </div>

      <div className="gh-agents">
        {registered.map((r) => {
          const band = scoreBand(Math.round(r.blast_radius ?? 0), 0, r.risk_band ?? undefined)
          return (
            <button key={r.path} type="button" className="gh-agent" onClick={() => r.agent_id && onOpen(r.agent_id)}>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{r.agent_name ?? r.agent_id}</span>
                  {r.created === false && <span className="gh-tag">Updated</span>}
                </div>
                <div className="gh-agent-sub">
                  <code>{r.path}</code>
                  <span>· {r.tools_count} tool{r.tools_count === 1 ? '' : 's'}, {r.actions_count} action{r.actions_count === 1 ? '' : 's'}</span>
                  {r.model && <span>· {r.model}</span>}
                </div>
              </div>
              {typeof r.blast_radius === 'number' && (
                <span className="gh-risk" style={{ color: band.color, background: band.bg, borderColor: band.line }}>
                  {band.label} risk · {Math.round(r.blast_radius)}
                </span>
              )}
              <ChevronRight size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            </button>
          )
        })}
      </div>

      {summary.scan_notes.length > 0 && <Notes notes={summary.scan_notes} />}
      {other.length > 0 && <OtherFiles files={other} />}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
        <Button type="button" variant="secondary" onClick={onAgain} icon={<RotateCcw size={13} />}>Scan another repo</Button>
        <Button type="button" onClick={onViewAll}>View agents</Button>
      </div>
    </div>
  )
}

function Notes({ notes }: { notes: string[] }) {
  return (
    <div className="gh-notes">
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
      <div>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>Partial coverage</div>
        {notes.map((n, i) => <div key={i}>{n}.</div>)}
      </div>
    </div>
  )
}

function OtherFiles({ files, defaultOpen = false }: { files: FileResult[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button type="button" className="gh-link" style={{ paddingLeft: 0 }} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {files.length} other file{files.length === 1 ? '' : 's'} checked
      </button>
      {open && (
        <div className="gh-files" style={{ marginTop: 6 }}>
          {files.map((f) => (
            <div key={f.path} className="gh-file">
              <FileStatusDot status={f.status} />
              <code className="gh-file-path" title={f.path}>{f.path}</code>
              <span className="gh-file-meta" style={f.status === 'failed' ? { color: 'var(--critical)' } : undefined}>{f.error}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ErrorCard({ error, canConnect, manageUrl, onConnect, onRetry, onDismiss }: {
  error: ScanError
  canConnect: boolean
  manageUrl: string
  onConnect: () => void
  onRetry: () => void
  onDismiss: () => void
}) {
  const privateIssue = error.code ? PRIVATE_CODES.has(error.code) : false
  const rateLimited = error.status === 429
  const title = privateIssue ? 'Repo not found, or it’s private'
    : rateLimited ? 'GitHub rate limit reached'
    : error.status === 400 ? 'Check the link'
    : 'The scan didn’t finish'
  return (
    <div className="gh-error" role="alert">
      <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1, color: 'var(--critical)' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.5 }}>{error.detail}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {privateIssue && canConnect && (
            <Button type="button" size="sm" onClick={onConnect} icon={<GithubMark size={13} />}>Connect GitHub</Button>
          )}
          {privateIssue && manageUrl && (
            <a className="btn btn--secondary btn--sm" href={manageUrl} target="_blank" rel="noreferrer">
              Choose repos on GitHub <ExternalLink size={12} />
            </a>
          )}
          {error.status !== 400 && (
            <Button type="button" size="sm" variant="secondary" onClick={onRetry} icon={<RotateCcw size={12} />}>Try again</Button>
          )}
        </div>
      </div>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="gh-icon-btn"><X size={14} /></button>
    </div>
  )
}

// ── Settings card ────────────────────────────────────────────────────────────

export function GithubIntegrationCard() {
  const { status, connect, disconnect } = useGithubConnection()
  const [confirming, setConfirming] = useState(false)
  if (!status?.configured) return null
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span className="gh-avatar"><GithubMark size={18} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>GitHub</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            {status.connected
              ? <>Connected to <strong style={{ color: 'var(--text-primary)' }}>@{status.account}</strong>. Repo scans can read the private repos you granted, read-only.</>
              : 'Connect GitHub so repo scans can read your private repos. You choose which repos, access is read-only, and you can revoke it anytime.'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {!status.connected && (
            <Button type="button" variant="secondary" size="sm" onClick={connect} icon={<GithubMark size={13} />}>Connect GitHub</Button>
          )}
          {status.connected && !confirming && (
            <>
              <a className="btn btn--secondary btn--sm" href={status.manage_url} target="_blank" rel="noreferrer">Manage repos <ExternalLink size={12} /></a>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>Disconnect</Button>
            </>
          )}
          {status.connected && confirming && (
            <>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Disconnect GitHub?</span>
              <Button type="button" variant="destructive" size="sm" onClick={() => { setConfirming(false); disconnect() }}>Disconnect</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
