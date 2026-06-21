import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bot, Headphones, Terminal, BarChart2, Settings2,
  AlertTriangle, Plus, X, ChevronRight, Info, Search, Upload,
} from 'lucide-react'
import { apiFetch, getUser } from '@/lib/api'
import { fetchBatchSpendForecasts } from '@/lib/spendApi'
import type { MockSpend } from '@/lib/mockSpend'
import { toast } from '@/components/shared/Toast'
import Tooltip from '@/components/shared/Tooltip'
import { RISK_SCORE_METHODOLOGY, MCP_GLOSSARY } from '@/lib/methodology'
import { chainShortLabel } from '@/lib/chainLabels'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import NewAgentCard, { type AgentCardData } from '@/components/agents/AgentCard'
import FleetStrip from '@/components/agents/FleetStrip'
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
  residual_score?: number
  confidence?: 'low' | 'medium' | 'high'
  magnitude_usd?: number
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
  pending_count: number
  last_execution_at: string | null
}

interface ChainItem {
  severity: 'critical' | 'high' | 'medium'
  chain_name: string
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
  { value: 'name-asc',     label: 'Name A–Z' },
]

const RISK_FILTERS = [
  { value: 'all',      label: 'All Agents' },
  { value: 'critical', label: 'Critical (70+)' },
  { value: 'warning',  label: 'Warning (40–69)' },
  { value: 'safe',     label: 'Low (<40)' },
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
  const [agents, setAgents] = useState<AgentListItem[]>([])
  const [spendForecasts, setSpendForecasts] = useState<Record<string, MockSpend | null>>({})
  const [chains, setChains] = useState<ChainItem[]>([])
  const [, setExecutions] = useState<ExecutionEntry[]>([])
  const [, setSimulations] = useState<SimulationRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('score-desc')
  const [riskFilter, setRiskFilter] = useState('all')
  const [chainSeverityFilter, setChainSeverityFilter] = useState('all')

  // Create agent form
  const [showCreate, setShowCreate] = useState(false)
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
  } | null>(null)
  const [batchQueue, setBatchQueue] = useState<{ filename: string; status: 'pending' | 'extracting' | 'done' | 'failed'; agentId?: string; toolsCount?: number; error?: string }[]>([])
  const [batchRunning, setBatchRunning] = useState(false)
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
    Promise.all([
      apiFetch<{ agents: AgentListItem[] }>('/api/authority/agents'),
      apiFetch<{ chains: ChainItem[] }>('/api/authority/chains'),
      apiFetch<{ entries: ExecutionEntry[] }>('/api/executions').catch(() => ({ entries: [] as ExecutionEntry[] })),
      apiFetch<{ simulations: SimulationRun[] }>('/api/sandbox/simulations').catch(() => ({ simulations: [] as SimulationRun[] })),
    ])
      .then(([agentData, chainData, execData, simData]) => {
        setAgents(agentData.agents)
        setChains(chainData.chains)
        setExecutions(execData.entries || [])
        setSimulations(simData.simulations || [])
        setLoading(false)
        // Fire spend-forecast batch fetch in the background.
        fetchBatchSpendForecasts().then(setSpendForecasts).catch(() => { /* ignore — cards fall back to local mock */ })
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
  }

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (searchParams.get('connect') === 'true') {
      setShowCreate(true)
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
      setAgentTab('overview')
      setShowCreate(true)
      setShowConnectTabs(false)
    } else {
      setAgentTab('agents')
    }
    initialTabRef.current = true
  }, [loading, agents.length])

  const handleFileUpload = async (file: File) => {
    setUploadFilename(file.name)
    const text = await file.text()
    setUploadFileContent(text)
  }

  const handleMultiFileUpload = async (files: FileList) => {
    const list = Array.from(files)
    if (list.length === 0) return
    if (list.length === 1) {
      // Single file → put it in the textarea/preview, user clicks Extract
      handleFileUpload(list[0])
      return
    }
    // Multi-file: extract each in sequence, show progress
    const initial = list.map((f) => ({ filename: f.name, status: 'pending' as const }))
    setBatchQueue(initial)
    setBatchRunning(true)
    for (let i = 0; i < list.length; i++) {
      setBatchQueue((q) => q.map((item, idx) => idx === i ? { ...item, status: 'extracting' } : item))
      try {
        const text = await list[i].text()
        const data: { id: string; tools_count: number } = await apiFetch('/api/authority/agents/extract', {
          method: 'POST',
          body: JSON.stringify({ filename: list[i].name, content: text }),
        })
        setBatchQueue((q) => q.map((item, idx) => idx === i ? { ...item, status: 'done', agentId: data.id, toolsCount: data.tools_count } : item))
      } catch (err) {
        setBatchQueue((q) => q.map((item, idx) => idx === i ? { ...item, status: 'failed', error: (err as Error).message } : item))
      }
    }
    setBatchRunning(false)
    loadData()
    toast(`Batch upload complete`)
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
      if (data && data.agents_registered > 0) {
        toast(`Registered ${data.agents_registered} agent${data.agents_registered !== 1 ? 's' : ''} from ${data.owner}/${data.repo}`)
      } else {
        toast('Scan complete — no agent files detected', 'error')
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
      toast('Paste or upload some agent code first', 'error')
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
      toast(`Connected — ${data.tools_imported} tool${data.tools_imported !== 1 ? 's' : ''} imported`)
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
    if (riskFilter === 'critical')      result = result.filter((a) => a.blast_radius.score >= 70)
    else if (riskFilter === 'warning')  result = result.filter((a) => (a.blast_radius.score >= 40 && a.blast_radius.score < 70) || (a.blast_radius.score < 40 && a.critical_chains > 0))
    else if (riskFilter === 'safe')     result = result.filter((a) => a.blast_radius.score < 40 && a.critical_chains === 0)

    const [field, dir] = sortBy.split('-')
    result.sort((a, b) => {
      let va: string | number
      let vb: string | number
      if (field === 'score')          { va = a.blast_radius.score;        vb = b.blast_radius.score }
      else if (field === 'actions')   { va = a.blast_radius.total_actions; vb = b.blast_radius.total_actions }
      else if (field === 'chains')    { va = a.chain_count;               vb = b.chain_count }
      else                            { va = a.name;                       vb = b.name }
      if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb as string) : (vb as string).localeCompare(va)
      return dir === 'asc' ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
    return result
  }, [agents, search, sortBy, riskFilter])

  // ─── Loading / error ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-500">
        <div className="w-6 h-6 border-2 border-gray-200 border-t-gray-700 rounded-full animate-spin" />
        <span className="text-sm">Loading agents…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center p-10">
        <AlertTriangle size={32} className="text-red-500" />
        <h2 className="font-semibold text-gray-900">Failed to load data</h2>
        <p className="text-sm text-gray-500">{error}</p>
        <Button onClick={() => window.location.reload()}>Retry</Button>
      </div>
    )
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

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', padding: '34px 40px 64px', fontFamily: 'var(--font-sans)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--ink-400)',
              letterSpacing: 1.1,
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            Agents
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 32,
              fontWeight: 700,
              letterSpacing: -0.8,
              color: 'var(--ink-900)',
              lineHeight: 1.15,
            }}
          >
            Welcome back{greetingName ? <>, <span style={{ color: 'var(--accent)' }}>{greetingName}</span></> : ''}
          </h1>
          <p style={{ margin: '8px 0 0', fontSize: 14.5, color: 'var(--ink-500)', maxWidth: 520, lineHeight: 1.5 }}>
            Inventory every action your AI agents can take, and enforce the ones that matter.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setShowCreate(!showCreate); setShowMcpConnect(false); setAgentTab('agents') }}
          className="ag-btn"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
            background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9,
            padding: '11px 17px', fontSize: 14, fontWeight: 550, fontFamily: 'var(--font-sans)',
            cursor: 'pointer', boxShadow: 'var(--shadow-card-new)',
          }}
        >
          {showCreate ? <X size={16} strokeWidth={2} /> : <Plus size={16} strokeWidth={2} />}
          {showCreate ? 'Cancel' : 'Connect agent'}
        </button>
      </div>

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

      {/* Create agent panel */}
      <AnimatePresence mode="wait" initial={false}>
      {showCreate && agentTab === 'agents' && (
        <motion.div
          ref={connectFormRef}
          className="bg-white border border-gray-200 rounded-xl shadow-sm p-6"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        >

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
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>Name it, describe what it does, and list its tools — Arceo scores the risk in seconds.</div>
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
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
                { id: 'proxy', label: 'Route through Arceo', sub: 'Zero code change — set one env var' },
                { id: 'mcp',   label: 'Connect via MCP',     sub: 'Auto-discover an MCP server' },
              ]
              const dropdownMenu = (
                items: { id: ConnectTabId; label: string; sub: string }[],
                onPick: (id: ConnectTabId) => void,
              ) => (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                  background: '#fff', border: '1px solid var(--border)',
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
                Arceo reads your agent file and extracts every action it can take.{' '}
                You'll get: <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>risk score · worst-case scenarios · recommended approval policy</span> — in ~30 seconds.
              </p>
              <form onSubmit={handleUploadSubmit} className="space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".py,.ts,.tsx,.js,.jsx,.json,.yaml,.yml,.txt,.md"
                  multiple
                  onChange={(e) => { if (e.target.files) handleMultiFileUpload(e.target.files) }}
                  style={{ display: 'none' }}
                />
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOver(false)
                    if (e.dataTransfer.files) handleMultiFileUpload(e.dataTransfer.files)
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
                  {uploadFilename && batchQueue.length === 0 ? (
                    <>
                      <p className="text-sm font-medium text-gray-900">{uploadFilename}</p>
                      <p className="text-[11px] text-gray-500 mt-1">{uploadFileContent.length.toLocaleString()} chars loaded · click to replace</p>
                    </>
                  ) : (
                    <p className="text-sm font-medium text-gray-900">Drag &amp; drop your agent file here, or click to browse</p>
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
                {batchQueue.length > 0 && (
                  <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-1.5 max-h-60 overflow-auto">
                    <div className="text-[11px] font-semibold text-gray-700 mb-1.5">
                      Batch upload {batchRunning ? '— extracting…' : '— complete'} ({batchQueue.filter(b => b.status === 'done').length} / {batchQueue.length})
                    </div>
                    {batchQueue.map((b, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px]">
                        <span style={{
                          width: 8, height: 8, borderRadius: 4, flexShrink: 0,
                          background: b.status === 'done' ? '#16a34a' : b.status === 'failed' ? '#dc2626' : b.status === 'extracting' ? '#f59e0b' : '#9ca3af',
                        }} />
                        <code className="font-mono text-gray-700 truncate flex-1">{b.filename}</code>
                        <span className="text-gray-500">
                          {b.status === 'done' ? `→ ${b.agentId} (${b.toolsCount} tools)` : b.status === 'failed' ? `failed: ${b.error}` : b.status === 'extracting' ? 'extracting…' : 'queued'}
                        </span>
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
                  <div><strong className="text-gray-900">Generate an API key.</strong>{' '}<a href="/settings" className="underline text-gray-900 hover:text-indigo-600">Settings → API Keys → New Key</a>. Copy it once — you won't see it again.</div>
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
                <div>{'      '}- uses: Akash-Sathish8/Arceo/.github/actions/scan@dev</div>
                <div>{'        '}with:</div>
                <div>{'          '}api-key: <span className="text-amber-300">${'${{ secrets.ARCEO_API_KEY }}'}</span></div>
                <div>{'          '}threshold: <span className="text-amber-300">60</span></div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard.writeText(`name: Arceo Agent Security\n\non:\n  push:\n  pull_request:\n\njobs:\n  scan:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: Akash-Sathish8/Arceo/.github/actions/scan@dev\n        with:\n          api-key: \${{ secrets.ARCEO_API_KEY }}\n          threshold: 60\n`); toast('Workflow YAML copied') }}>
                  Copy YAML
                </Button>
                <a href="https://github.com/Akash-Sathish8/Arceo/tree/dev/.github/actions/scan" target="_blank" rel="noopener noreferrer" className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md hover:bg-gray-50">
                  Full docs
                </a>
              </div>
            </div>
          )}

          {connectTab === 'github' && (
            <div className="space-y-4">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', background: 'var(--bg-sunken)', borderRadius: 8, padding: '10px 14px', margin: 0 }}>
                Arceo walks your repo, picks every file with LLM SDK usage, and registers each agent automatically. You'll get a full fleet overview in one scan.
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
                {githubResult && (
                  <div className="mt-2 bg-green-50 border border-green-200 rounded-lg p-4 space-y-2 text-xs">
                    <div className="font-semibold text-green-900">✓ {githubResult.owner}/{githubResult.repo} <span className="font-normal text-green-700">({githubResult.branch})</span></div>
                    <div className="text-green-800">
                      Scanned <strong>{githubResult.files_scanned}</strong> files → detected <strong>{githubResult.agents_detected}</strong> with LLM SDK usage → registered <strong>{githubResult.agents_registered}</strong> agents.
                    </div>
                    {githubResult.results.length > 0 && (
                      <details className="text-green-800">
                        <summary className="cursor-pointer">Per-file results</summary>
                        <div className="mt-2 bg-white rounded p-2 max-h-60 overflow-auto space-y-1">
                          {githubResult.results.map((r, i) => (
                            <div key={i} className="flex items-center gap-2 text-[11px]">
                              <span style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: r.status === 'registered' ? '#16a34a' : '#dc2626' }} />
                              <code className="font-mono text-gray-700 truncate flex-1">{r.path}</code>
                              <span className="text-gray-500">{r.status === 'registered' ? `→ ${r.agent_id} (${r.tools_count} tools${r.model ? `, ${r.model}` : ''})` : `failed: ${r.error}`}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </form>
            </div>
          )}

          {connectTab === 'proxy' && (
            <div className="space-y-4">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', background: 'var(--bg-sunken)', borderRadius: 8, padding: '10px 14px', margin: 0 }}>
                Point one environment variable at Arceo — no code changes, no SDK install. Every LLM call flows through us and appears in the dashboard. <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>~2 minutes to set up.</span>
              </p>

              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">What do you call this agent? (used as <code className="text-[11px] bg-gray-100 px-1 rounded">X-Agent-ID</code> header)</label>
                <Input
                  type="text" value={proxyName} onChange={(e) => setProxyName(e.target.value)}
                  placeholder="e.g. production-support-agent"
                  style={{ height: 40 }}
                />
                <p className="text-[11px] text-gray-500 mt-1">No registration needed — Arceo auto-creates the agent on the first call.</p>
              </div>

              <div className="bg-gray-900 text-gray-100 rounded-lg p-4 font-mono text-[12px] leading-relaxed overflow-x-auto">
                <div className="text-gray-500"># Anthropic SDK (Python / JS / any language)</div>
                <div>export ANTHROPIC_BASE_URL=<span className="text-amber-300">"https://api.arceo.io/proxy/llm/anthropic"</span></div>
                <div className="mt-3 text-gray-500"># OpenAI SDK</div>
                <div>export OPENAI_BASE_URL=<span className="text-amber-300">"https://api.arceo.io/proxy/llm/openai"</span></div>
                <div className="mt-3 text-gray-500"># Default header (set in your shared client config)</div>
                <div>X-Agent-ID: <span className="text-amber-300">"{proxyName || '<your-agent-name>'}"</span></div>
                <div className="mt-3 text-gray-500"># That's it. No SDK install, no code change. Restart your service —</div>
                <div className="text-gray-500"># every messages.create() and chat.completions.create() now flows</div>
                <div className="text-gray-500"># through Arceo and appears in the dashboard.</div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const name = proxyName.trim() || '<your-agent-name>'
                    const snippet = `export ANTHROPIC_BASE_URL="https://api.arceo.io/proxy/llm/anthropic"\nexport OPENAI_BASE_URL="https://api.arceo.io/proxy/llm/openai"\n# Set on every outbound request from your agent:\n#   X-Agent-ID: ${name}\n`
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
                Point Arceo at your <Tooltip content={MCP_GLOSSARY}><span className="cursor-help underline decoration-dotted underline-offset-2">MCP</span></Tooltip> server — we call <code style={{ fontSize: 11, background: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 3 }}>tools/list</code> and import every tool your agent exposes automatically. <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>~1 minute to set up.</span>
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
        </motion.div>
      )}
      </AnimatePresence>

      {agentTab === 'overview' && (() => {
        const sumSpend = Object.values(spendForecasts).reduce<number | null>((acc, f) => {
          if (f === null) return acc
          return (acc ?? 0) + f.point
        }, null)
        const criticalAgents = agents.filter((a) => a.blast_radius.score >= 67)
        const cautionAgents  = agents.filter((a) => (a.blast_radius.score >= 40 && a.blast_radius.score < 67) || (a.blast_radius.score < 40 && a.critical_chains > 0))
        const safeAgents     = agents.filter((a) => a.blast_radius.score < 40 && a.critical_chains === 0)
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
          })
        }

        const tile = (label: string, value: React.ReactNode, valueColor?: string, note?: string) => (
          <div
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              padding: '18px 20px',
              boxShadow: 'var(--shadow-card-new)',
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-400)' }}>
              {label}
            </div>
            <div
              className="mono"
              style={{ fontSize: 30, fontWeight: 600, color: valueColor ?? 'var(--ink-900)', letterSpacing: -0.6, marginTop: 8 }}
            >
              {value}
            </div>
            {note && (
              <div style={{ fontSize: 12, color: 'var(--ink-400)', marginTop: 6 }}>{note}</div>
            )}
          </div>
        )

        return (
          <section>
            {/* 4 stat tiles */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
              {tile('Agents monitored', `${totalAgents} of ${totalAgents}`)}
              {tile('Forecast spend / mo', sumSpend !== null ? `$${sumSpend.toLocaleString()}` : '—', 'var(--accent)',
                sumSpend === null ? 'Awaiting forecasts' : `Across ${forecastRows.length} ${forecastRows.length === 1 ? 'agent' : 'agents'}`)}
              {tile('Critical chains', criticalChainsCount, 'var(--critical)',
                criticalChainsCount > 0 ? 'Review and add policies' : 'None outstanding')}
              {tile('Unguarded agents', unguardedCount, 'var(--caution)',
                unguardedCount > 0 ? 'Policy not set' : 'All covered')}
            </div>

            {/* Two panels */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
              {/* Fleet risk distribution */}
              <div
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
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
                  border: '1px solid var(--line)',
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
                      const tone = sc >= 67 ? TONE.critical : sc >= 40 || a.critical_chains > 0 ? TONE.caution : TONE.safe
                      const pct = Math.round(((spend ?? 0) / maxSpend) * 100)
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
                  border: '1px solid var(--line)',
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
                  const tone = sc >= 67 ? TONE.critical : sc >= 40 || a.critical_chains > 0 ? TONE.caution : TONE.safe
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
        {agents.length > 0 && (
          <FleetStrip
            monitored={agents.length}
            total={agents.length}
            spend={Object.values(spendForecasts).reduce<number | null>((acc, f) => {
              if (f === null) return acc
              return (acc ?? 0) + f.point
            }, null)}
            criticalChains={chains.filter((c) => c.severity === 'critical').length}
            unguarded={agents.filter((a) => a.policy_count === 0).length}
          />
        )}
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
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-gray-400 whitespace-nowrap">Filter:</span>
              <select
                value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)}
                style={{ background: 'var(--bg-sunken)', border: '2px solid transparent', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', padding: '0 12px', height: '36px', fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--border-focus)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
              >
                {RISK_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
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
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
            <Settings2 size={28} />
            <span className="text-sm font-medium">No agents match your filters</span>
            <span className="text-xs">Try adjusting your search or risk filter</span>
          </div>
          )
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 20 }}>
            {filteredAgents.map((a) => {
              const br = a.blast_radius
              const data: AgentCardData = {
                id: a.id,
                name: a.name,
                description: a.description,
                tools: a.tools,
                score: br.score,
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
              }
              return (
                <NewAgentCard
                  key={a.id}
                  agent={data}
                  onOpen={(agent) => setDrawerAgent(agent)}
                />
              )
            })}
          </div>
        )}
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

        const openDrawerForChain = (chainAgentName: string) => {
          const target = agents.find((a) => a.name === chainAgentName)
          if (!target) return
          const br = target.blast_radius
          setDrawerAgent({
            id: target.id,
            name: target.name,
            description: target.description,
            tools: target.tools,
            score: br.score,
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
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '40px 24px', textAlign: 'center', boxShadow: 'var(--shadow-card-new)' }}>
              <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--ink-600)' }}>No risk chains match this filter.</div>
              <div style={{ fontSize: 13.5, color: 'var(--ink-400)', marginTop: 6 }}>
                {allChains.length === 0 ? 'Run a simulation to surface dangerous capability sequences.' : 'Switch to All to see every chain across the fleet.'}
              </div>
            </div>
          ) : (
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, boxShadow: 'var(--shadow-card-new)', overflow: 'hidden' }}>
              {visible.map((c, i) => {
                const sev = sevKey(c.severity)
                const sevColor = sev === 'critical' ? 'var(--critical)' : 'var(--caution)'
                const sevBg    = sev === 'critical' ? 'var(--critical-bg)' : 'var(--caution-bg)'
                return (
                  <div
                    key={i}
                    className="ag-row"
                    onClick={() => openDrawerForChain(c.agent_name)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawerForChain(c.agent_name) } }}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '12px 1.6fr 1fr auto',
                      alignItems: 'center',
                      gap: 16,
                      padding: '15px 22px',
                      borderBottom: i < visible.length - 1 ? '1px solid var(--line-soft)' : 'none',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: sevColor }} />
                    <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-800)' }}>
                      {chainShortLabel(c.chain_name)}
                    </span>
                    <span style={{ fontSize: 12.5, color: 'var(--ink-500)' }}>{c.agent_name}</span>
                    <span
                      style={{
                        fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
                        color: sevColor, background: sevBg, borderRadius: 5, padding: '3px 8px',
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
