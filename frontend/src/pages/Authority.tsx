import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bot, Headphones, Terminal, BarChart2, Settings2,
  AlertTriangle, Plus, X, ChevronRight, Info, Search, Upload,
  GalleryHorizontal, GalleryVertical, LayoutGrid,
} from 'lucide-react'
import { apiFetch, getUser } from '@/lib/api'
import { scoreBand, riskLabelName } from '@/lib/utils'
import { fetchBatchSpendForecasts } from '@/lib/spendApi'
import { recordAgentView, getAgentViewTimes } from '@/lib/recentViews'
import type { MockSpend } from '@/lib/mockSpend'
import { toast } from '@/components/shared/Toast'
import Tooltip from '@/components/shared/Tooltip'
import { RISK_SCORE_METHODOLOGY, MCP_GLOSSARY } from '@/lib/methodology'
import { chainShortLabel } from '@/lib/chainLabels'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import NewAgentCard, { type AgentCardData } from '@/components/agents/AgentCard'
import PageHeader from '@/components/shared/PageHeader'
import ErrorState from '@/components/shared/ErrorState'
import { pluralize } from '@/lib/strings'
import { formatMoney } from '@/lib/format'
import FleetStrip from '@/components/agents/FleetStrip'
import SpendTrendCard from '@/components/agents/SpendTrendCard'
import AgentDrawer from '@/components/agents/AgentDrawer'

// ─── Local interfaces ─────────────────────────────────────────────────────────

interface BlastRadius {
  score: number
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
  residual_score?: number
  confidence?: 'low' | 'medium' | 'high'
  magnitude_usd?: number
  band?: string
  coverage?: { unclassifiedActions?: number }
}

interface AgentListItem {
  id: string
  name: string
  description: string
  agent_type: string
  tools: string[]
  blast_radius: BlastRadius
  chain_count: number
  critical_chains: number
  policy_count: number
  policies_by_effect?: { BLOCK?: number; REQUIRE_APPROVAL?: number; ALLOW?: number }
  pending_count: number
  last_execution_at: string | null
  /** Declared at registration — kept beside the observed state, never used as it. */
  environment?: string | null
  live_calls_7d?: number
  deployment_state?: 'deployed' | 'pre_deployment'
  deployment_mismatch?: 'stalled' | 'ungoverned' | null
  /** ISO timestamp — compares chronologically as a plain string. */
  created_at: string
}

interface ChainItem {
  severity: 'critical' | 'high' | 'medium'
  chain_id?: string
  chain_name: string
  agent_id: string
  agent_name: string
  description: string
  steps: string[]
}

interface ExecutionEntry {
  id: string
  agent_id: string
  tool: string
  action: string
  status: string
  timestamp: string
}

interface SimulationRun {
  id: string
}

interface McpResult {
  tools_imported?: number
  tool_names?: string[]
  error?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { value: 'score-desc',   label: 'Highest Risk' },
  { value: 'score-asc',    label: 'Lowest Risk' },
  { value: 'actions-desc', label: 'Most Actions' },
  { value: 'chains-desc',  label: 'Most Chains' },
  { value: 'created-desc', label: 'Recently Added' },
  { value: 'viewed-desc',  label: 'Recently Viewed' },
  { value: 'name-asc',     label: 'Name A to Z' },
]

const TEMPLATES = [
  {
    name: 'Customer Support Agent',
    description: 'Handles tickets, refunds, account lookups, and customer emails',
    tools: 'Stripe: get_customer, list_payments, create_refund, create_charge, cancel_subscription\nZendesk: get_ticket, update_ticket, close_ticket, add_comment, delete_ticket\nSalesforce: query_contacts, get_account, update_record, delete_record\nSendGrid: send_email, send_template_email',
  },
  {
    name: 'DevOps Agent',
    description: 'Manages deployments, infrastructure, incidents, and team notifications',
    tools: 'GitHub: list_repos, get_pull_request, merge_pull_request, create_branch, delete_branch, trigger_workflow, create_release\nAWS: list_instances, start_instance, stop_instance, terminate_instance, scale_service, update_security_group, delete_snapshot\nSlack: send_message, send_channel_message\nPagerDuty: create_incident, acknowledge_incident, resolve_incident, escalate_incident',
  },
  {
    name: 'Sales Agent',
    description: 'Manages leads, outreach, deals, meetings, and pipeline updates',
    tools: 'HubSpot: get_contact, create_contact, update_contact, delete_contact, list_deals, update_deal, create_deal, query_contacts\nGmail: send_email, read_inbox, search_emails, create_draft, send_draft\nSlack: send_message, send_channel_message\nCalendly: list_events, create_invite_link, cancel_event, get_availability',
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseToolsText(toolsText: string) {
  return toolsText
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [toolPart, actionsPart] = line.split(':').map((s) => s.trim())
      const actions = (actionsPart || '').split(',').map((a) => a.trim()).filter(Boolean)
      return {
        name: toolPart.toLowerCase().replace(/\s+/g, '_'),
        service: toolPart,
        description: toolPart,
        actions: actions.map((a) => ({
          action: a.toLowerCase().replace(/\s+/g, '_'),
          description: a,
          risk_labels: [] as string[],
          reversible: true,
        })),
      }
    })
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Authority() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const [drawerAgent, setDrawerAgent] = useState<AgentCardData | null>(null)
  // Bumped on every agent view so the "Recently Viewed" sort re-reads localStorage.
  const [viewBump, setViewBump] = useState(0)
  const [agents, setAgents] = useState<AgentListItem[]>([])
  const [spendForecasts, setSpendForecasts] = useState<Record<string, MockSpend | null>>({})
  const [chains, setChains] = useState<ChainItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loadingRef = useRef(false)

  // Filters
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('score-desc')
  const [chainSeverityFilter, setChainSeverityFilter] = useState('all')

  // Agent catalog layout: horizontal rail / vertical scroll-in-box / open grid.
  // Persisted so the choice survives reloads. Defaults to the vertical stack:
  // the Stitch canvas lists agents as full-width rows, and the row form only
  // reads correctly at full width — a sideways rail crops the services line.
  const [agentView, setAgentView] = useState<'rail' | 'vscroll' | 'grid'>(() => {
    const saved = localStorage.getItem('agentCatalogView')
    return saved === 'rail' || saved === 'grid' ? saved : 'vscroll'
  })
  const changeAgentView = (v: 'rail' | 'vscroll' | 'grid') => {
    setAgentView(v)
    localStorage.setItem('agentCatalogView', v)
  }

  // Create agent form
  const [showCreate, setShowCreate] = useState(false)
  // One close path for the Connect dialog: the X, the footer button, the scrim
  // and Esc. Declared with the other hooks — this component returns early for
  // its loading and error states, so a hook below those runs conditionally.
  const closeConnect = useCallback(() => setShowCreate(false), [])
  useEffect(() => {
    if (!showCreate) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeConnect() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showCreate, closeConnect])
  // Default to 'agents' — Overview is the empty-state landing only.
  // On first load completion, this gets switched to 'overview' if there
  // are no agents connected (see initialTabRef effect below).
  const [agentTab, setAgentTab] = useState<'overview' | 'agents' | 'chains'>('agents')
  const initialTabRef = useRef(false)
  const [connectTab, setConnectTab] = useState<'upload' | 'github' | 'gha' | 'proxy' | 'mcp'>('upload')
  const [connectMenuOpen, setConnectMenuOpen] = useState<'github' | 'post' | null>(null)
  const [showConnectTabs, setShowConnectTabs] = useState(false)
  const [uploadFileContent, setUploadFileContent] = useState('')
  const [uploadFilename, setUploadFilename] = useState('')
  const [uploadSubmitting, setUploadSubmitting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadResult, setUploadResult] = useState<{ id: string; name: string; tools_count: number; actions_count: number; model: string; system_prompt: string } | null>(null)
  const [githubUrl, setGithubUrl] = useState('')
  const [githubScanning, setGithubScanning] = useState(false)
  const [githubResult, setGithubResult] = useState<{
    owner: string; repo: string; branch: string;
    files_scanned: number; agents_detected: number; agents_registered: number;
    results: { path: string; status: string; agent_id?: string; tools_count?: number; model?: string; error?: string }[]
    // Coverage disclosure the backend already sends (candidate cap, max_files
    // stop, rate-limited fetches, size skips) — apiFetch is a bare res.json(),
    // so these are in the response at runtime; the type just didn't admit it.
    truncated?: boolean; scan_notes?: string[]; fetch_errors?: number;
    candidates_total?: number; candidates_scanned?: number;
  } | null>(null)
  const [bundledFiles, setBundledFiles] = useState<{ path: string; chars: number; truncated?: boolean }[]>([])
  const [bundling, setBundling] = useState(false)
  const [proxyName, setProxyName] = useState('')
  const connectFormRef = useRef<HTMLDivElement>(null)
  const [creating, setCreating] = useState(false)
  // MCP connect
  const [, setShowMcpConnect] = useState(false)
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpAgentName, setMcpAgentName] = useState('')
  const [mcpConnecting, setMcpConnecting] = useState(false)
  const [mcpResult, setMcpResult] = useState<McpResult | null>(null)
  const animReadyRef = useRef(false)
  const [, setAnimReady] = useState(false)

  const loadData = () => {
    // In-flight guard: the 30s poll, form-submit refreshes and unmount can
    // otherwise interleave and let an older response overwrite a newer one.
    if (loadingRef.current) return
    loadingRef.current = true
    Promise.all([
      apiFetch<{ agents: AgentListItem[] }>('/api/authority/agents'),
      apiFetch<{ chains: ChainItem[] }>('/api/authority/chains'),
    ])
      .then(([agentData, chainData]) => {
        setAgents(agentData.agents)
        setChains(chainData.chains)
        setError(null)
        setLoading(false)
        // Fire spend-forecast batch fetch in the background (best-effort).
        fetchBatchSpendForecasts().then(setSpendForecasts).catch(() => { /* forecasts are optional */ })
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
      .finally(() => { loadingRef.current = false })
  }

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (searchParams.get('connect') === 'true') {
      setShowCreate(true)
      setAgentTab('agents')       // the connect form only renders on the Agents tab
      setConnectTab('upload')
      setSearchParams({}, { replace: true })
      setTimeout(
        () => connectFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        100,
      )
    }
  }, [searchParams])

  useEffect(() => {
    if (!loading && !animReadyRef.current) {
      animReadyRef.current = true
      setAnimReady(true)
    }
  }, [loading])

  // First-load tab decision: Overview when no agents (empty state); Agents
  // when at least one is connected. Runs once after the initial fetch
  // completes; user's manual tab switches afterwards stay sticky.
  useEffect(() => {
    if (loading || initialTabRef.current) return
    if (agents.length === 0) {
      // Land on Overview for a first-run account, but leave the connect form
      // CLOSED — otherwise the header CTA reads "Cancel" over a hidden form.
      // The user opens it via the "Connect agent" button (which switches tabs).
      setAgentTab('overview')
      setShowConnectTabs(false)
    } else {
      setAgentTab('agents')
    }
    initialTabRef.current = true
  }, [loading, agents.length])

  type PickedFile = { file: File; path: string }

  const BUNDLE_CODE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|txt|md)$/i
  const BUNDLE_SKIP_DIR = /(^|\/)(node_modules|\.git|__pycache__|dist|build|\.next|\.venv|venv|\.turbo|coverage|\.mypy_cache|\.pytest_cache)(\/|$)/
  const BUNDLE_SKIP_FILE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|\.min\.js)$/i
  const BUNDLE_MAX_CHARS = 200_000 // mirrors backend Field(max_length=200_000) (main.py extract endpoints)

  const handleFileUpload = async (file: File) => {
    setBundledFiles([])
    setUploadFilename(file.name)
    const text = await file.text()
    // The backend rejects >200K bodies outright (422); send what fits and say so.
    if (text.length > BUNDLE_MAX_CHARS) {
      setUploadFileContent(text.slice(0, BUNDLE_MAX_CHARS))
      toast(`${file.name} is over the 200KB limit, so we'll only read the first 200KB`, 'error')
      return
    }
    setUploadFileContent(text)
  }

  const filesFromInput = (files: FileList): PickedFile[] =>
    Array.from(files).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))

  // Recursively pull every File out of a dropped folder. The caller must
  // capture FileSystemEntry objects synchronously (see onDrop) — the
  // DataTransfer is gone by the time these promises resolve.
  const collectEntry = (entry: FileSystemEntry, prefix: string): Promise<PickedFile[]> =>
    new Promise((resolve) => {
      if (entry.isFile) {
        (entry as FileSystemFileEntry).file(
          (file) => resolve([{ file, path: prefix + file.name }]),
          () => resolve([]),
        )
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader()
        const all: PickedFile[] = []
        const readBatch = () => {
          reader.readEntries(
            (entries) => {
              if (entries.length === 0) { resolve(all); return }
              Promise.all(entries.map((e) => collectEntry(e, `${prefix}${entry.name}/`))).then((nested) => {
                nested.forEach((arr) => all.push(...arr))
                readBatch() // a directory can hand back its children across several batches
              })
            },
            () => resolve(all),
          )
        }
        readBatch()
      } else {
        resolve([])
      }
    })

  // Bundle several files (or a whole folder) into ONE agent: concatenate every
  // code/text file under a `# FILE:` header so the extractor sees the complete
  // agent in a single pass, instead of registering one agent per file.
  const bundlePickedFiles = async (picked: PickedFile[]) => {
    // No zip support exists (deliberately — it needs a binary endpoint plus a
    // dependency we pin out). The fix is the message, not the feature.
    const hasArchive = picked.some(({ path }) => /\.(zip|tar|tar\.gz|tgz|rar|7z)$/i.test(path))
    const usable = picked.filter(({ path }) =>
      BUNDLE_CODE_EXT.test(path) &&
      !BUNDLE_SKIP_DIR.test(path) &&
      !BUNDLE_SKIP_FILE.test(path),
    )
    if (usable.length === 0) {
      toast(hasArchive
        ? "We can't read zip archives yet. Unzip it and drag the folder in instead."
        : 'No code files found to bundle', 'error')
      return
    }
    if (usable.length === 1) {
      await handleFileUpload(usable[0].file)
      return
    }
    setBundling(true)
    try {
      usable.sort((a, b) => a.path.localeCompare(b.path))
      const parts: string[] = []
      const meta: { path: string; chars: number; truncated?: boolean }[] = []
      let total = 0
      let skipped = 0
      for (const { file, path } of usable) {
        const header = `# ===================================================================\n# FILE: ${path}\n# ===================================================================\n\n`
        // Check the budget BEFORE reading: the old loop tested after, so it
        // always overshot and then hard-sliced the last file mid-body while
        // recording its full length — a green "included" dot over truncated
        // source.
        const remaining = BUNDLE_MAX_CHARS - total - header.length - 2
        if (remaining <= 0) { skipped++; continue }
        const text = await file.text()
        const body = text.length > remaining ? text.slice(0, remaining) : text
        parts.push(header + body)
        meta.push({ path, chars: body.length, truncated: body.length < text.length })
        total += header.length + body.length + 2
      }
      const content = parts.join('\n\n')
      const top = usable[0].path.includes('/') ? usable[0].path.split('/')[0] : ''
      setUploadFilename(top ? `${top} (${meta.length} files bundled)` : `bundle (${meta.length} files)`)
      setUploadFileContent(content)
      setBundledFiles(meta)
      const truncatedCount = meta.filter((m) => m.truncated).length
      if (skipped > 0 || truncatedCount > 0) {
        const bits: string[] = []
        if (skipped > 0) bits.push(`${skipped} didn't fit`)
        if (truncatedCount > 0) bits.push(`${truncatedCount} truncated`)
        toast(`Bundled ${meta.length} files: ${bits.join(', ')}. The extractor reads up to 200KB.`, 'error')
      }
    } finally {
      setBundling(false)
    }
  }

  const handleGithubScan = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!githubUrl.trim()) {
      toast('Enter a GitHub URL', 'error')
      return
    }
    setGithubScanning(true)
    setGithubResult(null)
    try {
      const data: typeof githubResult = await apiFetch('/api/authority/agents/extract-github', {
        method: 'POST',
        body: JSON.stringify({ url: githubUrl }),
      })
      setGithubResult(data)
      // Branch on what was DETECTED, not what registered: 25 detected /
      // 25 failed used to read "no agent files detected" and blame the repo.
      if (data && data.agents_registered > 0) {
        toast(`Registered ${data.agents_registered} agent${data.agents_registered !== 1 ? 's' : ''} from ${data.owner}/${data.repo}`)
      } else if (data && data.agents_detected > 0) {
        toast(`Detected ${data.agents_detected} agent file${data.agents_detected !== 1 ? 's' : ''} but we couldn't register them. Check the per-file results below.`, 'error')
      } else {
        toast("Scan finished, but we didn't find any agent files", 'error')
      }
      loadData()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
    setGithubScanning(false)
  }

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!uploadFileContent.trim()) {
      toast('Upload a file or drop a folder first', 'error')
      return
    }
    setUploadSubmitting(true)
    setUploadResult(null)
    try {
      const data: typeof uploadResult = await apiFetch('/api/authority/agents/extract', {
        method: 'POST',
        body: JSON.stringify({ filename: uploadFilename, content: uploadFileContent }),
      })
      setUploadResult(data)
      toast(`Extracted ${data!.tools_count} tools, ${data!.actions_count} actions`)
      loadData()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
    setUploadSubmitting(false)
  }

  const handleMcpConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    setMcpConnecting(true)
    setMcpResult(null)
    try {
      const data: McpResult = await apiFetch('/api/authority/agents/connect/mcp', {
        method: 'POST',
        body: JSON.stringify({ url: mcpUrl, agent_name: mcpAgentName }),
      })
      setMcpResult(data)
      setMcpUrl('')
      setMcpAgentName('')
      setShowMcpConnect(false)
      toast(`Connected. We imported ${data.tools_imported} tool${data.tools_imported !== 1 ? 's' : ''}.`)
      loadData()
    } catch (err) {
      setMcpResult({ error: (err as Error).message })
      toast((err as Error).message, 'error')
    }
    setMcpConnecting(false)
  }

  const handleCreateFromTemplate = async (template: (typeof TEMPLATES)[0]) => {
    setCreating(true)
    try {
      await apiFetch('/api/authority/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: template.name,
          description: template.description,
          tools: parseToolsText(template.tools),
        }),
      })
      toast(`${template.name} created`)
      loadData()
    } catch (err) {
      toast('Failed: ' + (err as Error).message, 'error')
    }
    setCreating(false)
  }

  // Filtered + sorted agents
  const filteredAgents = useMemo(() => {
    let result = [...agents]
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(
        (a) =>
          (a.name ?? "").toLowerCase().includes(q) ||
          (a.description ?? "").toLowerCase().includes(q) ||
          (a.tools ?? []).some((t) => (t ?? "").toLowerCase().includes(q)),
      )
    }

    const viewTimes = getAgentViewTimes()
    const [field, dir] = sortBy.split('-')
    result.sort((a, b) => {
      let va: string | number
      let vb: string | number
      if (field === 'score')          { va = a.blast_radius.score;        vb = b.blast_radius.score }
      else if (field === 'actions')   { va = a.blast_radius.total_actions; vb = b.blast_radius.total_actions }
      else if (field === 'chains')    { va = a.chain_count;               vb = b.chain_count }
      else if (field === 'created')   { va = a.created_at ?? '';          vb = b.created_at ?? '' }
      else if (field === 'viewed')    { va = viewTimes[a.id] ?? '';       vb = viewTimes[b.id] ?? '' }
      else                            { va = a.name;                       vb = b.name }
      if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb as string) : (vb as string).localeCompare(va)
      return dir === 'asc' ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
    return result
  }, [agents, search, sortBy, viewBump])

  // ─── Loading / error ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: '34px 40px 64px' }} aria-busy="true" aria-label="Loading agents">
        {/* Mirrors the real page: header row → spend trend card → tabs → catalog grid */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="skeleton" style={{ height: 30, width: 220 }} />
          <div className="skeleton" style={{ height: 40, width: 150 }} />
        </div>
        <div className="skeleton" style={{ height: 208, marginTop: 24 }} />
        <div className="skeleton" style={{ height: 40, width: 320, marginTop: 24 }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16, marginTop: 26 }}>
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 180 }} />)}
        </div>
      </div>
    )
  }

  if (error) {
    return <div style={{ padding: 40 }}><ErrorState message={error} onRetry={loadData} /></div>
  }

  // ─── Main dashboard ─────────────────────────────────────────────────────────

  // Derive a clean first name from the signed-in email for the greeting.
  // "john.doe@acme.com" → "John"; "zeidanreza1@gmail.com" → "Zeidanreza".
  // Returns null when no usable name is parseable — caller renders a generic
  // "Welcome back" instead of "Welcome back, back".
  const greetingName: string | null = (() => {
    const email = getUser()?.email
    if (!email) return null
    const local = email.split('@')[0]
    const firstPart = local.split(/[._+-]/)[0]
    const clean = firstPart.replace(/\d+/g, '')
    if (!clean) return null
    return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase()
  })()

  // The form is only *visible* on the Agents tab — the CTA label must track
  // that, not the raw showCreate flag (which can be true on Overview).
  const formVisible = showCreate && agentTab === 'agents'

  return (
    <div style={{ padding: '34px 40px 64px', fontFamily: 'var(--font-sans)' }}>
      <PageHeader
        title="Agents"
        description="Every action your AI agents can take, scored and governed before they reach production."
        actions={
          <button
            type="button"
            onClick={() => {
              setShowCreate(true); setShowMcpConnect(false); setAgentTab('agents')
            }}
            className="btn btn--primary ag-btn"
          >
            <Plus size={16} strokeWidth={1.8} />
            Connect agent
          </button>
        }
      />

      <SpendTrendCard />

      <div style={{ display: 'flex', gap: 26, borderBottom: '1px solid var(--line)', margin: '24px 0 26px' }}>
        {(agents.length === 0
          ? [
              { id: 'overview' as const, label: 'Overview', count: undefined },
              { id: 'agents' as const,   label: 'Agents',     count: agents.length },
              { id: 'chains' as const,   label: 'Risk chains',count: chains.length },
            ]
          : [
              { id: 'agents' as const,   label: 'Agents',     count: agents.length },
              { id: 'chains' as const,   label: 'Risk chains',count: chains.length },
              { id: 'overview' as const, label: 'Overview',   count: undefined },
            ]
        ).map((t) => {
          const active = agentTab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setAgentTab(t.id)}
              className="ag-tab"
              style={{
                background: 'transparent', border: 'none', padding: '11px 2px',
                fontSize: 14.5, fontWeight: active ? 600 : 500,
                color: active ? 'var(--accent)' : 'var(--ink-500)',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
                display: 'inline-flex', alignItems: 'center', gap: 7,
              }}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="mono" style={{ fontSize: 12.5, color: active ? 'var(--accent-ink)' : 'var(--ink-400)' }}>
                  {t.count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Connect agent — the same centred-dialog shell as Configure Simulation,
          so every "start something new" flow in the product opens the same way.
          Every tab and form below is unchanged; only the container moved. */}
      {/* No enter animation, matching Configure Simulation exactly — the
          framer-motion fade stalled mid-transition here and left the dialog
          translucent over the page. */}
      {showCreate && agentTab === 'agents' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto"
          style={{ background: 'rgba(30, 40, 54, 0.5)', backdropFilter: 'blur(2px)' }}
          onClick={closeConnect}
        >
        <div
          ref={connectFormRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="connect-agent-title"
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-4xl bg-surface-container-lowest border border-neutral-border rounded-lg flex flex-col my-auto outline-none"
          style={{
            maxHeight: 'calc(100vh - 2rem)',
            boxShadow: '0 4px 24px rgba(30, 40, 54, 0.08), 0 1px 2px rgba(15,15,15,0.03)',
          }}
        >
          {/* Header band */}
          <div className="px-8 pt-8 pb-6 border-b border-neutral-border shrink-0 flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h2
                id="connect-agent-title"
                className="text-page-title font-page-title text-on-surface mb-2 tracking-tight m-0"
              >
                Connect an agent
              </h2>
              <p className="text-body font-body text-neutral-secondary leading-relaxed m-0">
                Point Arceo at an agent&rsquo;s tools, from a code file, a repo, a live MCP
                server, or by routing its calls through the proxy. Every route ends the same way: a
                scored map of every action it can take.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={closeConnect}
              className="shrink-0 text-neutral-secondary hover:text-on-surface transition-colors"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, lineHeight: 0 }}
            >
              <X size={20} strokeWidth={1.8} />
            </button>
          </div>

          {/* Body */}
          <div className="px-8 py-6 overflow-y-auto">

          {/* ── Empty-state template picker ── */}
          {agents.length === 0 && !showConnectTabs && (
            <div>
              {/* Primary: Create manually */}
              <button
                type="button"
                onClick={() => setShowConnectTabs(true)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 16,
                  padding: '20px 24px', borderRadius: 12, textAlign: 'left',
                  border: '1.5px solid var(--text-primary)', background: '#fff',
                  cursor: 'pointer', transition: 'box-shadow 120ms',
                  marginBottom: 20,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.10)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none' }}
              >
                <div style={{ width: 44, height: 44, borderRadius: 10, background: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Bot size={22} style={{ color: '#fff' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 3 }}>Create your agent</div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>Name it, describe what it does, and list its tools. Arceo scores the risk in seconds.</div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>Get started</div>
              </button>

              {/* Divider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Or start from a template</span>
                <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              </div>

              {/* Secondary: Template cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {([
                  { t: TEMPLATES[0], Icon: Headphones, label: 'Customer Support' },
                  { t: TEMPLATES[1], Icon: Terminal,   label: 'DevOps' },
                  { t: TEMPLATES[2], Icon: BarChart2,  label: 'Sales' },
                ] as const).map(({ t, Icon, label }) => (
                  <button
                    key={label}
                    type="button"
                    disabled={creating}
                    onClick={() => handleCreateFromTemplate(t)}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                      gap: 8, padding: '14px 16px', borderRadius: 10,
                      border: '1px solid var(--border)', background: 'var(--bg-sunken)',
                      cursor: creating ? 'not-allowed' : 'pointer', textAlign: 'left',
                      transition: 'border-color 120ms, box-shadow 120ms',
                      opacity: creating ? 0.6 : 1,
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--text-secondary)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 1px 6px rgba(0,0,0,0.06)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none' }}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon size={14} style={{ color: 'var(--text-muted)' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>{label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t.description}</div>
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)', marginTop: 'auto' }}>
                      {creating ? 'Creating…' : 'Use template'}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Manual setup tabs ── */}
          {(agents.length > 0 || showConnectTabs) && (<>
          <div style={{ display: 'flex', gap: 2, background: 'var(--bg-sunken)', borderRadius: 10, padding: 4, flexWrap: 'wrap', marginBottom: 20 }}>
            {(() => {
              type ConnectTabId = 'upload' | 'github' | 'gha' | 'proxy' | 'mcp'
              const tabStyle = (active: boolean): React.CSSProperties => ({
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 14px', borderRadius: 7, border: 'none',
                fontSize: 13, fontWeight: active ? 600 : 400,
                fontFamily: 'var(--font-sans)',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: active ? '#fff' : 'transparent',
                boxShadow: active ? '0 1px 3px rgba(0,0,0,0.10)' : 'none',
                cursor: 'pointer', transition: 'all 120ms',
              })
              const recommendedChip = (
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                  background: 'var(--severity-safe-bg)', color: 'var(--severity-safe)',
                  border: '1px solid var(--severity-safe-border)',
                  borderRadius: 4, padding: '1px 5px', lineHeight: 1.4,
                }}>RECOMMENDED</span>
              )
              const githubChildren: { id: ConnectTabId; label: string; sub: string }[] = [
                { id: 'github', label: 'GitHub repo',   sub: 'Scan an entire repo at once' },
                { id: 'gha',    label: 'GitHub Action', sub: 'Re-scan on every PR' },
              ]
              const postChildren: { id: ConnectTabId; label: string; sub: string }[] = [
                { id: 'proxy', label: 'Route through Arceo', sub: 'No code changes, just one env var' },
                { id: 'mcp',   label: 'Connect via MCP',     sub: 'Auto-discover an MCP server' },
              ]
              const dropdownMenu = (
                items: { id: ConnectTabId; label: string; sub: string }[],
                onPick: (id: ConnectTabId) => void,
              ) => (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                  background: '#fff',
                  borderRadius: 'var(--radius-lg)',
                  boxShadow: 'var(--shadow-md)',
                  minWidth: 240, zIndex: 50, padding: 4,
                }}>
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onPick(item.id)}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                        width: '100%', textAlign: 'left',
                        padding: '8px 12px', borderRadius: 6, border: 'none',
                        background: connectTab === item.id ? 'var(--color-accent-bg)' : 'transparent',
                        color: connectTab === item.id ? 'var(--color-accent)' : 'var(--text-primary)',
                        cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      }}
                      onMouseEnter={(e) => {
                        if (connectTab !== item.id) e.currentTarget.style.background = 'var(--bg-sunken)'
                      }}
                      onMouseLeave={(e) => {
                        if (connectTab !== item.id) e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{item.label}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{item.sub}</span>
                    </button>
                  ))}
                </div>
              )

              const isGithubActive = connectTab === 'github' || connectTab === 'gha'
              const isPostActive = connectTab === 'proxy' || connectTab === 'mcp'
              const githubLabel = connectTab === 'gha' ? 'GitHub Action' : 'GitHub'
              const postLabel = connectTab === 'mcp' ? 'Connect via MCP' : connectTab === 'proxy' ? 'Route through Arceo' : 'Post deployment'

              return (
                <>
                  <button type="button" onClick={() => setConnectTab('upload')} style={tabStyle(connectTab === 'upload')}>
                    Upload file
                    {recommendedChip}
                  </button>

                  <div
                    style={{ position: 'relative' }}
                    onMouseEnter={() => setConnectMenuOpen('github')}
                    onMouseLeave={() => setConnectMenuOpen(null)}
                  >
                    <button
                      type="button"
                      onClick={() => setConnectMenuOpen(connectMenuOpen === 'github' ? null : 'github')}
                      style={tabStyle(isGithubActive)}
                    >
                      {githubLabel}
                      <ChevronRight size={12} style={{ transform: 'rotate(90deg)', opacity: 0.6 }} />
                    </button>
                    {connectMenuOpen === 'github' && dropdownMenu(githubChildren, (id) => { setConnectTab(id); setConnectMenuOpen(null) })}
                  </div>

                  <div
                    style={{ position: 'relative' }}
                    onMouseEnter={() => setConnectMenuOpen('post')}
                    onMouseLeave={() => setConnectMenuOpen(null)}
                  >
                    <button
                      type="button"
                      onClick={() => setConnectMenuOpen(connectMenuOpen === 'post' ? null : 'post')}
                      style={tabStyle(isPostActive)}
                    >
                      {postLabel}
                      <ChevronRight size={12} style={{ transform: 'rotate(90deg)', opacity: 0.6 }} />
                    </button>
                    {connectMenuOpen === 'post' && dropdownMenu(postChildren, (id) => { setConnectTab(id); setConnectMenuOpen(null) })}
                  </div>
                </>
              )
            })()}
          </div>

          {connectTab === 'upload' && (
            <div className="space-y-4">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', background: 'var(--bg-sunken)', borderRadius: 8, padding: '10px 14px', margin: 0 }}>
                Drop in a file or folder of agent code. Arceo pulls out every action and scores the risk in about 30 seconds.
              </p>
              <form onSubmit={handleUploadSubmit} className="space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".py,.ts,.tsx,.js,.jsx,.json,.yaml,.yml,.txt,.md"
                  multiple
                  onChange={(e) => { if (e.target.files) bundlePickedFiles(filesFromInput(e.target.files)) }}
                  style={{ display: 'none' }}
                />
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOver(false)
                    // Capture FileSystemEntry objects synchronously — the
                    // DataTransfer is invalidated once this handler returns.
                    const dt = e.dataTransfer
                    const entries = dt.items && dt.items.length
                      ? Array.from(dt.items)
                          .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
                          .filter((x): x is FileSystemEntry => !!x)
                      : []
                    if (entries.length) {
                      Promise.all(entries.map((en) => collectEntry(en, ''))).then((nested) => bundlePickedFiles(nested.flat()))
                    } else if (dt.files) {
                      bundlePickedFiles(filesFromInput(dt.files))
                    }
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-xl text-center cursor-pointer transition-colors"
                  style={{
                    border: `2px dashed ${dragOver ? 'var(--text-primary)' : 'var(--border)'}`,
                    background: dragOver ? 'var(--bg-sunken)' : 'transparent',
                    padding: '40px 20px',
                  }}
                >
                  <Upload size={32} className="mx-auto mb-3" style={{ color: dragOver ? 'var(--text-primary)' : 'var(--text-muted)' }} />
                  {uploadFilename ? (
                    <>
                      <p className="text-sm font-medium text-gray-900">{uploadFilename}</p>
                      <p className="text-[11px] text-gray-500 mt-1">
                        {bundledFiles.length > 0
                          ? `${bundledFiles.length} files · ${uploadFileContent.length.toLocaleString()} chars bundled · click to replace`
                          : `${uploadFileContent.length.toLocaleString()} chars loaded · click to replace`}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-medium text-gray-900">
                        {bundling ? 'Bundling files…' : 'Drop a file or a whole folder here, or click to browse'}
                      </p>
                      {!bundling && (
                        <p className="text-[11px] text-gray-500 mt-1">A folder is bundled into one agent · drag it from Finder</p>
                      )}
                    </>
                  )}
                  <div className="flex items-center justify-center gap-1.5 mt-3 flex-wrap">
                    {['.py', '.ts', '.js', '.json', '.yaml'].map((ext) => (
                      <span key={ext} style={{
                        fontSize: 11, fontFamily: 'monospace', fontWeight: 500,
                        background: 'var(--bg-sunken)', color: 'var(--text-muted)',
                        border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px',
                      }}>{ext}</span>
                    ))}
                  </div>
                </div>
                {bundledFiles.length > 0 && (
                  <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-1.5 max-h-60 overflow-auto">
                    <div className="text-[11px] font-semibold text-gray-700 mb-1.5">
                      Bundled into one agent, {bundledFiles.length} files
                    </div>
                    {bundledFiles.map((b, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px]">
                        <span style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: b.truncated ? '#d97706' : 'var(--safe)' }} />
                        <code className="font-mono text-gray-700 truncate flex-1">{b.path}</code>
                        <span className="text-gray-500">{b.chars.toLocaleString()} chars{b.truncated ? ' (truncated to fit)' : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
                <Button
                  type="submit"
                  loading={uploadSubmitting}
                  disabled={uploadSubmitting || !uploadFileContent.trim()}
                  style={{ width: '100%', marginTop: 16 }}
                >
                  {uploadSubmitting ? 'Analyzing…' : 'Analyze this agent'}
                </Button>
                {uploadResult && (
                  <div className="mt-2 bg-green-50 border border-green-200 rounded-lg p-4 space-y-2 text-xs">
                    <div className="font-semibold text-green-900">✓ Extracted: {uploadResult.name}</div>
                    <div className="text-green-800"><strong>{uploadResult.tools_count}</strong> tools, <strong>{uploadResult.actions_count}</strong> actions registered.</div>
                    {uploadResult.model && <div className="text-green-800">Model: <code className="bg-white px-1 py-0.5 rounded">{uploadResult.model}</code></div>}
                    {uploadResult.system_prompt && (
                      <details className="text-green-800">
                        <summary className="cursor-pointer">System prompt ({uploadResult.system_prompt.length} chars)</summary>
                        <pre className="mt-2 bg-white p-2 rounded text-[11px] whitespace-pre-wrap max-h-40 overflow-auto">{uploadResult.system_prompt}</pre>
                      </details>
                    )}
                  </div>
                )}
              </form>
            </div>
          )}

          {connectTab === 'gha' && (
            <div className="space-y-6">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', background: 'var(--bg-sunken)', borderRadius: 8, padding: '22px 24px', margin: 0, lineHeight: 1.6 }}>
                Catch risky agents before they merge. Arceo runs on every pull request, posts a risk report as a comment, and can block the merge if anything looks dangerous.
              </p>
              <ol className="space-y-4 text-xs text-gray-700" style={{ marginTop: 16 }}>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-900 text-white text-[11px] font-semibold flex items-center justify-center">1</span>
                  <div><strong className="text-gray-900">Generate an API key.</strong>{' '}<a href="/settings" className="underline text-gray-900 hover:text-indigo-600">Settings → API &amp; Integration → API Keys</a>. Copy it once, because you won't see it again.</div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-900 text-white text-[11px] font-semibold flex items-center justify-center">2</span>
                  <div><strong className="text-gray-900">Add it as a repo secret.</strong> GitHub → Settings → Secrets → Actions → New secret. Name: <code className="text-[11px] bg-gray-100 px-1 rounded">ARCEO_API_KEY</code>.</div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-900 text-white text-[11px] font-semibold flex items-center justify-center">3</span>
                  <div><strong className="text-gray-900">Commit this workflow.</strong> Create <code className="text-[11px] bg-gray-100 px-1 rounded">.github/workflows/arceo.yml</code>:</div>
                </li>
              </ol>
              <div className="bg-gray-900 text-gray-100 rounded-lg p-4 font-mono text-[12px] leading-relaxed overflow-x-auto">
                <div><span className="text-amber-300">name</span>: Arceo Agent Security</div>
                <div className="mt-2"><span className="text-amber-300">on</span>:</div>
                <div>{'  '}push:</div>
                <div>{'  '}pull_request:</div>
                <div className="mt-2"><span className="text-amber-300">jobs</span>:</div>
                <div>{'  '}scan:</div>
                <div>{'    '}runs-on: ubuntu-latest</div>
                <div>{'    '}steps:</div>
                <div>{'      '}- uses: actions/checkout@v4</div>
                <div>{'      '}- uses: Akash-Sathish8/Arceo/.github/actions/scan@main</div>
                <div>{'        '}with:</div>
                <div>{'          '}api-key: <span className="text-amber-300">${'${{ secrets.ARCEO_API_KEY }}'}</span></div>
                <div>{'          '}threshold: <span className="text-amber-300">60</span></div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard.writeText(`name: Arceo Agent Security\n\non:\n  push:\n  pull_request:\n\njobs:\n  scan:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: Akash-Sathish8/Arceo/.github/actions/scan@main\n        with:\n          api-key: \${{ secrets.ARCEO_API_KEY }}\n          threshold: 60\n`); toast('Workflow YAML copied') }}>
                  Copy YAML
                </Button>
                <a href="https://github.com/Akash-Sathish8/Arceo/tree/main/.github/actions/scan" target="_blank" rel="noopener noreferrer" className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md hover:bg-gray-50">
                  Full docs
                </a>
              </div>
            </div>
          )}

          {connectTab === 'github' && (
            <div className="space-y-4">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', background: 'var(--bg-sunken)', borderRadius: 8, padding: '10px 14px', margin: 0 }}>
                Arceo scans the repo and registers every agent it finds. One scan covers your whole fleet.
              </p>
              <form onSubmit={handleGithubScan} className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">GitHub repository URL</label>
                  <Input
                    type="url"
                    value={githubUrl}
                    onChange={(e) => setGithubUrl(e.target.value)}
                    placeholder="https://github.com/your-company/your-agent-repo"
                    style={{ height: 40 }}
                  />
                  <p className="text-[11px] text-gray-500 mt-1">
                    Public repos only. Arceo picks files with LLM SDK calls (anthropic / openai / langchain) and runs Haiku extraction on each. Capped at 25 agents per scan.
                  </p>
                </div>
                <Button type="submit" loading={githubScanning} disabled={githubScanning || !githubUrl.trim()} style={{ width: '100%', marginTop: 16 }}>
                  {githubScanning ? 'Scanning repo…' : 'Scan and register all agents'}
                </Button>
                {githubResult && (() => {
                  // Tone follows the outcome. This panel used to be green with
                  // a hardcoded ✓ even when every detected file failed.
                  const failedCount = githubResult.results.filter((r) => r.status !== 'registered' && r.status !== 'skipped').length
                  const allFailed = githubResult.agents_detected > 0 && githubResult.agents_registered === 0
                  const tone = allFailed ? 'red' : failedCount > 0 ? 'amber' : 'green'
                  const paneClass = tone === 'red'
                    ? 'mt-2 bg-red-50 border border-red-200 rounded-lg p-4 space-y-2 text-xs'
                    : tone === 'amber'
                    ? 'mt-2 bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-2 text-xs'
                    : 'mt-2 bg-green-50 border border-green-200 rounded-lg p-4 space-y-2 text-xs'
                  const headClass = tone === 'red' ? 'font-semibold text-red-900' : tone === 'amber' ? 'font-semibold text-amber-900' : 'font-semibold text-green-900'
                  const bodyClass = tone === 'red' ? 'text-red-800' : tone === 'amber' ? 'text-amber-800' : 'text-green-800'
                  const scannedShort = (githubResult.candidates_scanned ?? 0) < (githubResult.candidates_total ?? 0)
                  const showCoverage = Boolean(githubResult.truncated || scannedShort || (githubResult.fetch_errors ?? 0) > 0)
                  return (
                  <div className={paneClass}>
                    <div className={headClass}>{allFailed ? '✗' : '✓'} {githubResult.owner}/{githubResult.repo} <span className="font-normal opacity-75">({githubResult.branch})</span></div>
                    <div className={bodyClass}>
                      Scanned <strong>{githubResult.files_scanned}</strong> files → detected <strong>{githubResult.agents_detected}</strong> with LLM SDK usage → registered <strong>{githubResult.agents_registered}</strong> agents.
                    </div>
                    {showCoverage && (
                      <div className="bg-amber-50 border border-amber-200 rounded p-2 text-amber-900">
                        Scanned {githubResult.candidates_scanned ?? githubResult.files_scanned} of {githubResult.candidates_total ?? githubResult.files_scanned} candidate files{(githubResult.fetch_errors ?? 0) > 0 ? `, ${githubResult.fetch_errors} fetches failed` : ''}. Results cover only what was scanned.
                        {(githubResult.scan_notes ?? []).map((n, i) => (
                          <div key={i} className="mt-1 text-[11px]">{n}</div>
                        ))}
                      </div>
                    )}
                    {githubResult.results.length > 0 && (
                      <details className={bodyClass}>
                        <summary className="cursor-pointer">Per-file results</summary>
                        <div className="mt-2 bg-white rounded p-2 max-h-60 overflow-auto space-y-1">
                          {githubResult.results.map((r, i) => (
                            <div key={i} className="flex items-center gap-2 text-[11px]">
                              <span style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: r.status === 'registered' ? 'var(--safe)' : r.status === 'skipped' ? '#9ca3af' : 'var(--critical)' }} />
                              <code className="font-mono text-gray-700 truncate flex-1">{r.path}</code>
                              <span className="text-gray-500">{r.status === 'registered' ? `→ ${r.agent_id} (${r.tools_count} tools${r.model ? `, ${r.model}` : ''})` : r.status === 'skipped' ? 'skipped' : `failed: ${r.error}`}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                  )
                })()}
              </form>
            </div>
          )}

          {connectTab === 'proxy' && (
            <div className="space-y-4">
              {/* Was "Point one environment variable at Arceo — no code changes,
                  no SDK install." Two env vars and a header, and the header is
                  not optional: _proxy_requires_key() defaults to ON outside dev
                  (main.py:523-532), so the old instructions produced a 401 on
                  every call in exactly the environment that matters. */}
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', background: 'var(--bg-sunken)', borderRadius: 8, padding: '10px 14px', margin: 0 }}>
                Point your SDK's base URL at Arceo and add two headers. There are no code changes beyond your client config, and nothing to install. Every LLM call flows through us and appears in the dashboard. <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>~2 minutes to set up.</span>
              </p>

              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">What do you call this agent? (used as <code className="text-[11px] bg-gray-100 px-1 rounded">X-Agent-ID</code> header)</label>
                <Input
                  type="text" value={proxyName} onChange={(e) => setProxyName(e.target.value)}
                  placeholder="e.g. production-support-agent"
                  style={{ height: 40 }}
                />
                {/* Was "No registration needed — Arceo auto-creates the agent on
                    the first call." True only WITH a key: the auto-create branch
                    is gated on key_info and 404s without it (main.py:812-816),
                    in dev too. The key is the registration. */}
                <p className="text-[11px] text-gray-500 mt-1">No need to create the agent first. Your API key registers it automatically on its first call.</p>
              </div>

              <div className="bg-gray-900 text-gray-100 rounded-lg p-4 font-mono text-[12px] leading-relaxed overflow-x-auto">
                <div className="text-gray-500"># Anthropic SDK (Python / JS / any language)</div>
                <div>export ANTHROPIC_BASE_URL=<span className="text-amber-300">"https://api.arceo.io/proxy/llm/anthropic"</span></div>
                <div className="mt-3 text-gray-500"># OpenAI SDK</div>
                <div>export OPENAI_BASE_URL=<span className="text-amber-300">"https://api.arceo.io/proxy/llm/openai"</span></div>
                <div className="mt-3 text-gray-500"># Default headers (set in your shared client config)</div>
                <div>X-Agent-ID: <span className="text-amber-300">"{proxyName || '<your-agent-name>'}"</span></div>
                {/* Not optional. _proxy_requires_key() is ON by default outside
                    dev (main.py:523-532), and the auto-create branch needs it
                    too (:812-816) — without this header the whole flow 401s. */}
                <div>X-API-Key: <span className="text-amber-300">"{'<your-arceo-api-key>'}"</span> <span className="text-gray-500">{'# Settings → API & Integration'}</span></div>
                <div className="mt-3 text-gray-500"># That's it. Nothing to install. Restart your service and</div>
                <div className="text-gray-500"># every messages.create() and chat.completions.create() now flows</div>
                <div className="text-gray-500"># through Arceo and appears in the dashboard.</div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const name = proxyName.trim() || '<your-agent-name>'
                    // The clipboard string is what actually gets pasted into a
                    // customer's config, so it has to carry the key too — it
                    // silently omitted X-API-Key while the proxy required it.
                    const snippet = `export ANTHROPIC_BASE_URL="https://api.arceo.io/proxy/llm/anthropic"\nexport OPENAI_BASE_URL="https://api.arceo.io/proxy/llm/openai"\n# Set on every outbound request from your agent:\n#   X-Agent-ID: ${name}\n#   X-API-Key:  <your-arceo-api-key>   # Settings -> API & Integration -> API Keys\n`
                    navigator.clipboard.writeText(snippet)
                    toast('Proxy config copied')
                  }}
                >
                  Copy instructions
                </Button>
              </div>

              <div className="text-xs text-gray-500 leading-relaxed">
                <strong>For 50 agents:</strong> set the env vars once in your shared infrastructure config (Helm chart, base Terraform module, ECS task family). Whole fleet onboarded in one PR. No per-agent code change. Replace <code className="text-[11px] bg-gray-100 px-1 rounded">api.arceo.io</code> with your tenant's endpoint (shown on the Settings page once you sign in).
              </div>
            </div>
          )}

          {connectTab === 'mcp' && (
            <form onSubmit={handleMcpConnect} className="space-y-4">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', background: 'var(--bg-sunken)', borderRadius: 8, padding: '10px 14px', margin: 0 }}>
                Point Arceo at your <Tooltip content={MCP_GLOSSARY}><span className="cursor-help underline decoration-dotted underline-offset-2">MCP</span></Tooltip> server and we call <code style={{ fontSize: 11, background: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 3 }}>tools/list</code> and import every tool your agent exposes automatically. <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>~1 minute to set up.</span>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">MCP Server URL</label>
                  <Input
                    type="url" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)}
                    placeholder="https://your-mcp-server.example.com" required
                    style={{ height: 40 }}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">Agent Name</label>
                  <Input
                    type="text" value={mcpAgentName} onChange={(e) => setMcpAgentName(e.target.value)}
                    placeholder="e.g. My Production Agent" required
                    style={{ height: 40 }}
                  />
                </div>
              </div>
              <Button
                type="submit"
                loading={mcpConnecting}
                disabled={mcpConnecting || !mcpUrl.trim() || !mcpAgentName.trim()}
                style={{ width: '100%', marginTop: 16 }}
              >
                {mcpConnecting ? 'Connecting…' : 'Connect and import tools'}
              </Button>
              {mcpResult?.error && (
                <p className="text-xs text-red-600"><strong>Failed:</strong> {mcpResult.error}</p>
              )}
              {mcpResult?.tools_imported != null && (
                <p className="text-xs text-green-700">
                  Imported {mcpResult.tools_imported} tools: {mcpResult.tool_names?.join(', ')}
                </p>
              )}
            </form>
          )}
          </>)}
          </div>

          {/* Footer band */}
          <div className="px-8 py-5 border-t border-neutral-border bg-neutral-sunken flex items-center justify-end gap-3 rounded-b-lg shrink-0">
            <button
              type="button"
              onClick={closeConnect}
              className="btn btn--secondary"
            >
              Close
            </button>
          </div>
        </div>
        </div>
      )}

      {agentTab === 'overview' && (() => {
        const sumSpend = Object.values(spendForecasts).reduce<number | null>((acc, f) => {
          if (f === null) return acc
          return (acc ?? 0) + f.point
        }, null)
        // Shared 4-band scale collapsed to 3 display buckets: high+critical /
        // medium / low (backend band preferred, chain floor applied).
        const bandKeyOf = (a: AgentListItem) =>
          scoreBand(a.blast_radius.score, a.critical_chains, a.blast_radius.band).key
        const criticalAgents = agents.filter((a) => { const k = bandKeyOf(a); return k === 'critical' || k === 'high' })
        const cautionAgents  = agents.filter((a) => bandKeyOf(a) === 'medium')
        const safeAgents     = agents.filter((a) => bandKeyOf(a) === 'safe')
        const totalAgents = agents.length
        const criticalChainsCount = chains.filter((c) => c.severity === 'critical').length
        const unguardedCount = agents.filter((a) => a.policy_count === 0).length

        type Tone = { label: string; color: string; bg: string }
        const TONE: Record<'critical' | 'caution' | 'safe', Tone> = {
          critical: { label: 'Critical', color: 'var(--critical)',     bg: 'var(--critical-ring)' },
          caution:  { label: 'Caution',  color: 'var(--caution)',      bg: 'var(--caution-ring)' },
          safe:     { label: 'Low',      color: 'var(--safe)',         bg: 'var(--safe-ring)' },
        }
        const distRows = [
          { key: 'critical' as const, count: criticalAgents.length },
          { key: 'caution'  as const, count: cautionAgents.length },
          { key: 'safe'     as const, count: safeAgents.length },
        ]

        // Forecast-by-agent: sort by spend desc, only agents that have a forecast.
        const forecastRows = agents
          .map((a) => ({ a, spend: spendForecasts[a.id]?.point ?? null }))
          .filter((r) => r.spend !== null && r.spend > 0)
          .sort((x, y) => (y.spend ?? 0) - (x.spend ?? 0))
          .slice(0, 8)
        const maxSpend = forecastRows.reduce((m, r) => Math.max(m, r.spend ?? 0), 1)

        // Needs attention: unguarded OR has critical chains. Sort by score desc.
        const needsAttention = agents
          .filter((a) => a.policy_count === 0 || a.critical_chains > 0)
          .sort((x, y) => y.blast_radius.score - x.blast_radius.score)
          .slice(0, 8)

        const openDrawer = (a: AgentListItem) => {
          const br = a.blast_radius
          setDrawerAgent({
            id: a.id,
            name: a.name,
            description: a.description,
            tools: a.tools,
            score: br.score,
            residual: br.residual_score,
            band: br.band,
            unclassified: br.coverage?.unclassifiedActions,
            caps: {
              money:    br.moves_money,
              pii:      br.touches_pii,
              delete:   br.deletes_data,
              external: br.sends_external,
              prod:     br.changes_production,
            },
            spend: spendForecasts[a.id]?.point ?? null,
            actions: br.total_actions,
            irreversible: br.irreversible_actions,
            chains: a.chain_count,
            critical: a.critical_chains,
            policies: a.policy_count,
            policiesByEffect: a.policies_by_effect,
          })
        }

        const tile = (
          label: string, value: React.ReactNode,
          opts?: { valueColor?: string; note?: string; onClick?: () => void }
        ) => (
          <button
            type="button"
            onClick={opts?.onClick}
            className={opts?.onClick ? 'ag-card' : undefined}
            style={{
              textAlign: 'left', width: '100%', font: 'inherit',
              background: 'var(--card)',
              borderRadius: 'var(--radius-lg)',
              padding: '18px 20px',
              boxShadow: 'var(--shadow-card-new)',
              cursor: opts?.onClick ? 'pointer' : 'default',
            }}
          >
            <div style={{ fontSize: 'var(--fs-micro)', fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--ink-400)' }}>
              {label}
            </div>
            <div
              className="mono"
              style={{ fontSize: 28, fontWeight: 600, color: opts?.valueColor ?? 'var(--ink-900)', letterSpacing: -0.6, marginTop: 8 }}
            >
              {value}
            </div>
            {opts?.note && (
              <div style={{ fontSize: 'var(--fs-small)', color: 'var(--ink-500)', marginTop: 6 }}>{opts.note}</div>
            )}
          </button>
        )

        return (
          <section>
            {/* 4 stat tiles — clickable, each routes to the relevant view */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
              {tile('Agents', totalAgents, {
                note: `${pluralize(totalAgents, 'agent')} governed`,
                onClick: () => setAgentTab('agents'),
              })}
              {tile('Forecast spend / mo', sumSpend !== null ? formatMoney(sumSpend) : 'No data', {
                valueColor: 'var(--accent)',
                note: sumSpend === null ? 'Awaiting forecasts' : `Across ${pluralize(forecastRows.length, 'agent')}`,
                onClick: () => navigate('/spend'),
              })}
              {tile('Critical chains', criticalChainsCount, {
                valueColor: criticalChainsCount > 0 ? 'var(--critical)' : 'var(--ink-900)',
                note: criticalChainsCount > 0 ? 'Review and add policies' : 'None outstanding',
                onClick: () => setAgentTab('chains'),
              })}
              {tile('Unguarded agents', unguardedCount, {
                valueColor: unguardedCount > 0 ? 'var(--caution)' : 'var(--ink-900)',
                note: unguardedCount > 0 ? 'No policy set' : 'All covered',
                onClick: () => setAgentTab('agents'),
              })}
            </div>

            {/* Two panels */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
              {/* Fleet risk distribution */}
              <div
                style={{
                  background: 'var(--card)',
                  borderRadius: 12,
                  padding: '18px 20px',
                  boxShadow: 'var(--shadow-card-new)',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)', marginBottom: 14 }}>
                  Fleet risk distribution
                </div>
                {totalAgents > 0 ? (
                  <>
                    <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', gap: 3, background: 'var(--paper-2)' }}>
                      {distRows.map((r) => (
                        <div
                          key={r.key}
                          style={{
                            flex: r.count,
                            background: TONE[r.key].bg,
                            minWidth: r.count > 0 ? 4 : 0,
                          }}
                        />
                      ))}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
                      {distRows.map((r) => {
                        const pct = totalAgents > 0 ? Math.round((r.count / totalAgents) * 100) : 0
                        return (
                          <div
                            key={r.key}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '14px 1fr auto',
                              alignItems: 'center',
                              gap: 10,
                              fontSize: 13,
                              color: 'var(--ink-700)',
                            }}
                          >
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: TONE[r.key].bg }} />
                            <span>{TONE[r.key].label}</span>
                            <span className="mono" style={{ color: 'var(--ink-500)', fontSize: 12.5 }}>
                              {r.count} ({pct}%)
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--ink-400)' }}>No agents to distribute yet.</div>
                )}
              </div>

              {/* Forecast by agent */}
              <div
                style={{
                  background: 'var(--card)',
                  borderRadius: 12,
                  padding: '18px 20px',
                  boxShadow: 'var(--shadow-card-new)',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)', marginBottom: 14 }}>
                  Forecast by agent
                </div>
                {forecastRows.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {forecastRows.map(({ a, spend }) => {
                      const sc = a.blast_radius.score
                      const bk = scoreBand(sc, a.critical_chains, a.blast_radius.band).key
                      const tone = bk === 'critical' || bk === 'high' ? TONE.critical : bk === 'medium' ? TONE.caution : TONE.safe
                      const pct = Math.round(((spend ?? 0) / maxSpend) * 100)
                      return (
                        <div
                          key={a.id}
                          className="ag-row"
                          onClick={() => navigate(`/agent/${a.id}/spend`)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/agent/${a.id}/spend`) } }}
                          title="View spend forecast"
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '160px 1fr 56px',
                            alignItems: 'center',
                            gap: 12,
                            padding: '4px 0',
                            cursor: 'pointer',
                          }}
                        >
                          <span
                            style={{
                              fontSize: 13,
                              color: 'var(--ink-800)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {a.name}
                          </span>
                          <div style={{ height: 6, borderRadius: 6, background: 'var(--line-soft)', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: tone.bg, borderRadius: 6 }} />
                          </div>
                          <span className="mono" style={{ fontSize: 12.5, color: 'var(--ink-700)', textAlign: 'right' }}>
                            ${(spend ?? 0).toLocaleString()}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--ink-400)' }}>
                    Run a sandbox simulation on an agent to generate a forecast.
                  </div>
                )}
              </div>
            </div>

            {/* Needs attention */}
            {needsAttention.length > 0 && (
              <div
                style={{
                  background: 'var(--card)',
                  borderRadius: 12,
                  padding: '4px 20px',
                  boxShadow: 'var(--shadow-card-new)',
                  marginTop: 16,
                }}
              >
                <div style={{ padding: '16px 0 10px', fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>
                  Needs attention
                </div>
                {needsAttention.map((a, i) => {
                  const sc = a.blast_radius.score
                  const bk = scoreBand(sc, a.critical_chains, a.blast_radius.band).key
                  const tone = bk === 'critical' || bk === 'high' ? TONE.critical : bk === 'medium' ? TONE.caution : TONE.safe
                  return (
                    <div
                      key={a.id}
                      className="ag-row"
                      onClick={() => openDrawer(a)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(a) } }}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '12px 1fr auto auto auto auto',
                        alignItems: 'center',
                        gap: 14,
                        padding: '12px 0',
                        borderTop: i === 0 ? 'none' : '1px solid var(--line-soft)',
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: tone.bg }} />
                      <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-800)' }}>{a.name}</span>
                      {a.policy_count === 0 && (
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: 'var(--critical)',
                            background: 'var(--critical-bg)',
                            border: '1px solid var(--critical-line)',
                            borderRadius: 6,
                            padding: '2px 8px',
                          }}
                        >
                          No policy
                        </span>
                      )}
                      {a.critical_chains > 0 && (
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--critical)' }}>
                          {a.critical_chains} critical
                        </span>
                      )}
                      <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: tone.color, textAlign: 'right' }}>
                        {Math.round(sc)}
                      </span>
                      <span style={{ color: 'var(--ink-300)', display: 'flex' }}>
                        <ChevronRight size={15} />
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )
      })()}

      {agentTab === 'agents' && (
      <section>
        {agents.length > 0 && (() => {
          // Sum the forecast twice more, split on observed deployment state, so
          // the tile can separate spend the CFO is already paying from spend
          // that only lands once these agents ship. Deployment state comes from
          // the server; when it is absent the split is dropped, not guessed.
          const sumFor = (pred: (a: AgentListItem) => boolean) =>
            agents.reduce<number | null>((acc, a) => {
              if (!pred(a)) return acc
              const f = spendForecasts[a.id]
              return f == null ? acc : (acc ?? 0) + f.point
            }, null)
          const isDeployed = (a: AgentListItem) => a.deployment_state === 'deployed'
          const graded = agents.some((a) => a.deployment_state)
          const deployed = graded ? sumFor(isDeployed) ?? 0 : null
          const pending = graded ? sumFor((a) => !isDeployed(a)) ?? 0 : null

          return (
            <FleetStrip
              total={agents.length}
              spend={Object.values(spendForecasts).reduce<number | null>((acc, f) => {
                if (f === null) return acc
                return (acc ?? 0) + f.point
              }, null)}
              criticalChains={chains.filter((c) => c.severity === 'critical').length}
              unguarded={agents.filter((a) => a.policy_count === 0).length}
              spendDeployed={deployed}
              spendPreDeployment={pending}
              deployedCount={graded ? agents.filter(isDeployed).length : undefined}
              preDeploymentCount={graded ? agents.filter((a) => !isDeployed(a)).length : undefined}
            />
          )
        })()}
        <div className="flex items-center justify-between mb-5">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink-900)', letterSpacing: -0.2, margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Agent risk scores
            <Tooltip content={RISK_SCORE_METHODOLOGY}>
              <Info size={13} className="text-gray-400 cursor-help" style={{ display: 'block' }} />
            </Tooltip>
          </h2>
          <div className="flex items-center gap-3">
            <Input
              type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents, tools…"
              icon={<Search size={13} />}
              style={{ width: 196 }}
            />
            {/* Risk "Filter" dropdown removed — it keyed on the same
                blast_radius.score as Sort (which defaults to Highest Risk), so
                the two were redundant. Search (text) + Sort (risk order) remain. */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-gray-400 whitespace-nowrap">Sort:</span>
              <select
                value={sortBy} onChange={(e) => setSortBy(e.target.value)}
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', padding: '0 12px', height: '36px', fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
              >
                {SORT_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="view-toggle" role="group" aria-label="Agent catalog layout">
              {([
                { v: 'rail' as const, icon: GalleryHorizontal, label: 'Rail, scroll sideways' },
                { v: 'vscroll' as const, icon: GalleryVertical, label: 'Stack, scroll up and down inside the box' },
                { v: 'grid' as const, icon: LayoutGrid, label: 'Grid, show everything' },
              ]).map(({ v, icon: Icon, label }) => (
                <button
                  key={v}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={agentView === v}
                  className={`view-toggle-btn${agentView === v ? ' is-active' : ''}`}
                  onClick={() => changeAgentView(v)}
                >
                  <Icon size={15} strokeWidth={1.8} />
                </button>
              ))}
            </div>
          </div>
        </div>

        {filteredAgents.length === 0 ? (
          agents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center" style={{ maxWidth: 480, margin: '0 auto' }}>
              <Bot size={32} style={{ color: 'var(--text-muted)' }} />
              <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>No agents analyzed yet.</h3>
              <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
                Once you register an agent, you'll see its overall risk score, the worst-case actions it could take, any dangerous capability chains (like accessing customer data then sending external emails), and a recommended approval policy.
              </p>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                ↑ Connect your first agent above to get started.
              </p>
            </div>
          ) : (
          <div className="flex flex-col items-center justify-center py-16 gap-2" style={{ color: 'var(--ink-400)' }}>
            <Settings2 size={28} />
            <span className="text-sm font-medium">No agents match your search</span>
            <span className="text-xs">Try a different name or tool</span>
          </div>
          )
        ) : (() => {
          const railClass = `agent-rail${agentView === 'vscroll' ? ' agent-rail--v' : agentView === 'grid' ? ' agent-rail--grid' : ''}`

          const renderCard = (a: AgentListItem) => {
              const br = a.blast_radius
              const data: AgentCardData = {
                id: a.id,
                name: a.name,
                description: a.description,
                tools: a.tools,
                score: br.score,
                residual: br.residual_score,
                band: br.band,
                unclassified: br.coverage?.unclassifiedActions,
                caps: {
                  money:    br.moves_money,
                  pii:      br.touches_pii,
                  delete:   br.deletes_data,
                  external: br.sends_external,
                  prod:     br.changes_production,
                },
                spend: spendForecasts[a.id]?.point ?? null,
                actions: br.total_actions,
                irreversible: br.irreversible_actions,
                chains: a.chain_count,
                critical: a.critical_chains,
                policies: a.policy_count,
                policiesByEffect: a.policies_by_effect,
                lastActive: a.last_execution_at ?? undefined,
                deploymentState: a.deployment_state,
                deploymentMismatch: a.deployment_mismatch ?? null,
                liveCalls7d: a.live_calls_7d,
              }
              return (
                <div key={a.id} className="agent-rail-item">
                  <NewAgentCard
                    agent={data}
                    onOpen={(agent) => {
                      recordAgentView(agent.id)
                      setViewBump((n) => n + 1)
                      setDrawerAgent(agent)
                    }}
                  />
                </div>
              )
          }

          // Older backends don't send deployment_state; render one flat list
          // rather than inventing a section every agent falls into.
          const graded = filteredAgents.some((a) => a.deployment_state)
          if (!graded) {
            return <div className={railClass}>{filteredAgents.map(renderCard)}</div>
          }

          const sections = [
            {
              key: 'deployed',
              title: 'In production',
              note: 'Ran, or captured traffic in the last 7 days',
              items: filteredAgents.filter((a) => a.deployment_state === 'deployed'),
            },
            {
              key: 'pre_deployment',
              title: 'Pre-deployment',
              note: 'Nothing has run and no calls captured, so this is forecast only',
              items: filteredAgents.filter((a) => a.deployment_state !== 'deployed'),
            },
          ].filter((sec) => sec.items.length > 0)

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              {sections.map((sec) => (
                <div key={sec.key}>
                  {/* The section header carries the state, so the card's own
                      slot carries the evidence for it rather than repeating
                      the word. */}
                  <div
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 10,
                      paddingBottom: 8, marginBottom: 14,
                      borderBottom: '1px solid var(--line)',
                    }}
                  >
                    <span style={{
                      fontSize: 'var(--fs-micro)', fontWeight: 700, letterSpacing: 0.6,
                      textTransform: 'uppercase', color: 'var(--ink-600)',
                    }}>
                      {sec.title}
                    </span>
                    <span className="mono" style={{ fontSize: 'var(--fs-micro)', color: 'var(--ink-400)' }}>
                      {sec.items.length}
                    </span>
                    <span style={{
                      fontSize: 'var(--fs-small)', color: 'var(--ink-400)',
                      marginLeft: 'auto', textAlign: 'right',
                    }}>
                      {sec.note}
                    </span>
                  </div>
                  <div className={railClass}>{sec.items.map(renderCard)}</div>
                </div>
              ))}
            </div>
          )
        })()}
      </section>

      )}

      {agentTab === 'chains' && (() => {
        // Bridge backend severity (critical|high|medium) → handoff (critical|warning).
        const sevKey = (s: string) => (s === 'critical' ? 'critical' : 'warning') as 'critical' | 'warning'
        const allChains = chains
        const criticalCount = allChains.filter((c) => sevKey(c.severity) === 'critical').length
        const warningCount  = allChains.filter((c) => sevKey(c.severity) === 'warning').length
        const filter = chainSeverityFilter
        const visible = filter === 'all' ? allChains : allChains.filter((c) => sevKey(c.severity) === filter)

        const pills = [
          { k: 'all' as const,      label: 'All',      count: allChains.length },
          { k: 'critical' as const, label: 'Critical', count: criticalCount },
          { k: 'warning' as const,  label: 'Warning',  count: warningCount },
        ]

        const openDrawerForChain = (chainAgentId: string) => {
          // Match by id (from the chain payload), not name — name-matching broke
          // on duplicate/renamed agents.
          const target = agents.find((a) => a.id === chainAgentId)
          if (!target) return
          const br = target.blast_radius
          setDrawerAgent({
            id: target.id,
            name: target.name,
            description: target.description,
            tools: target.tools,
            score: br.score,
            residual: br.residual_score,
            band: br.band,
            unclassified: br.coverage?.unclassifiedActions,
            caps: {
              money:    br.moves_money,
              pii:      br.touches_pii,
              delete:   br.deletes_data,
              external: br.sends_external,
              prod:     br.changes_production,
            },
            spend: spendForecasts[target.id]?.point ?? null,
            actions: br.total_actions,
            irreversible: br.irreversible_actions,
            chains: target.chain_count,
            critical: target.critical_chains,
            policies: target.policy_count,
            policiesByEffect: target.policies_by_effect,
          })
        }

        return (
        <section id="danger-chains">
          {/* Filter pills */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
            {pills.map((p) => {
              const active = filter === p.k
              return (
                <button
                  key={p.k}
                  type="button"
                  onClick={() => setChainSeverityFilter(p.k)}
                  className="ag-btn"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 7,
                    background: active ? 'var(--ink-900)' : '#fff',
                    color: active ? '#fff' : 'var(--ink-600)',
                    border: active ? 'none' : '1px solid var(--line)',
                    borderRadius: 9, padding: '7px 14px',
                    fontSize: 13, fontWeight: 500, fontFamily: 'var(--font-sans)',
                    cursor: 'pointer',
                  }}
                >
                  {p.label}
                  <span className="mono" style={{ fontSize: 12, color: active ? 'rgba(255,255,255,0.7)' : 'var(--ink-400)' }}>
                    {p.count}
                  </span>
                </button>
              )
            })}
          </div>

          {visible.length === 0 ? (
            <div style={{ background: 'var(--card)', borderRadius: 14, padding: '40px 24px', textAlign: 'center', boxShadow: 'var(--shadow-card-new)' }}>
              <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--ink-600)' }}>No risk chains match this filter.</div>
              <div style={{ fontSize: 13.5, color: 'var(--ink-400)', marginTop: 6 }}>
                {allChains.length === 0 ? 'Run a simulation to surface dangerous capability sequences.' : 'Switch to All to see every chain across the fleet.'}
              </div>
            </div>
          ) : (
            <div style={{ background: 'var(--card)', borderRadius: 14, boxShadow: 'var(--shadow-card-new)', overflow: 'hidden' }}>
              {visible.map((c, i) => {
                const sev = sevKey(c.severity)
                const sevColor = sev === 'critical' ? 'var(--critical)' : 'var(--on-caution)'
                const sevBg    = sev === 'critical' ? 'var(--critical-bg)' : 'var(--caution-bg)'
                return (
                  <div
                    key={i}
                    className="ag-row"
                    onClick={() => openDrawerForChain(c.agent_id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawerForChain(c.agent_id) } }}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 14,
                      padding: '15px 22px',
                      borderBottom: i < visible.length - 1 ? '1px solid var(--line-soft)' : 'none',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: sevColor, flexShrink: 0, marginTop: 6 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-800)' }}>
                          {chainShortLabel(c.chain_id ?? c.chain_name)}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--ink-400)' }}>· {c.agent_name}</span>
                      </div>
                      {c.description && (
                        <div style={{ fontSize: 12.5, color: 'var(--ink-600)', marginTop: 4, lineHeight: 1.4 }}>
                          {c.description}
                        </div>
                      )}
                      {c.steps && c.steps.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                          {c.steps.map((step, si) => (
                            <span key={si} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              {si > 0 && <span style={{ color: 'var(--ink-300)', fontSize: 12 }}>→</span>}
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--ink-600)' }}>
                                <span style={{ width: 6, height: 6, borderRadius: 2, background: 'var(--ink-300)' }} />
                                {riskLabelName(step)}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
                        color: sevColor, background: sevBg, borderRadius: 5, padding: '3px 8px',
                        flexShrink: 0, marginTop: 2,
                      }}
                    >
                      {sev}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>
        )
      })()}

      <AgentDrawer
        agent={drawerAgent}
        onClose={() => setDrawerAgent(null)}
        onSimulate={(agentId) => navigate(`/sandbox?agent=${agentId}`)}
      />
    </div>
  )
}
