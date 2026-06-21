import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shield, ArrowRight, ArrowLeft, Check, Eye, EyeOff, AlertCircle } from 'lucide-react'
import { apiFetch, setToken, setUser } from '@/lib/api'
import type { User } from '@/lib/types'

// ── Types ──────────────────────────────────────────────────────────────────

type AgentTypeId = 'support' | 'devops' | 'sales' | 'custom'
interface AgentTypeOption { id: AgentTypeId; label: string; desc: string }
interface AgentTemplate { name: string; description: string; tools: string }
interface LoginResponse { token: string; user: User }
interface DemoModeResponse { demo: boolean }
interface ToolAction { action: string; description: string; risk_labels: string[]; reversible: boolean }
interface ToolDef { name: string; service: string; description: string; actions: ToolAction[] }

type NodeType = 'large' | 'medium' | 'small' | 'red'

interface GraphNode {
  id: number; xPct: number; yPct: number; r: number; type: NodeType
  fill: string; stroke?: string; strokeWidth?: number
  label?: string; opacity: number
  driftXAmp: number; driftXFreq: number; driftXPhase: number
  driftYAmp: number; driftYFreq: number; driftYPhase: number
}

interface GraphEdge { from: number; to: number; isRed: boolean }

// ── Agent constants ────────────────────────────────────────────────────────

const AGENT_TYPES: AgentTypeOption[] = [
  { id: 'support', label: 'Customer support agent', desc: 'Handles tickets, refunds, account lookups, and customer emails' },
  { id: 'devops',  label: 'DevOps agent',           desc: 'Manages deployments, infrastructure, incidents, and alerts' },
  { id: 'sales',   label: 'Sales agent',            desc: 'CRM updates, outreach, deal tracking, and meeting scheduling' },
  { id: 'custom',  label: 'Custom / other',         desc: "I'll configure the tools and actions myself" },
]

const AGENT_TYPE_TEMPLATES: Record<string, AgentTemplate> = {
  support: {
    name: 'Customer Support Agent',
    description: 'Handles tickets, refunds, account lookups, and customer emails',
    tools:
      'Stripe: get_customer, list_payments, create_refund, create_charge, cancel_subscription\n' +
      'Zendesk: get_ticket, update_ticket, close_ticket, add_comment, delete_ticket\n' +
      'Salesforce: query_contacts, get_account, update_record, delete_record\n' +
      'SendGrid: send_email, send_template_email',
  },
  devops: {
    name: 'DevOps Agent',
    description: 'Manages deployments, infrastructure, incidents, and team notifications',
    tools:
      'GitHub: list_repos, get_pull_request, merge_pull_request, create_branch, delete_branch, trigger_workflow, create_release\n' +
      'AWS: list_instances, start_instance, stop_instance, terminate_instance, scale_service, update_security_group, delete_snapshot\n' +
      'Slack: send_message, send_channel_message\n' +
      'PagerDuty: create_incident, acknowledge_incident, resolve_incident, escalate_incident',
  },
  sales: {
    name: 'Sales Agent',
    description: 'Manages leads, outreach, deals, meetings, and pipeline updates',
    tools:
      'HubSpot: get_contact, create_contact, update_contact, delete_contact, list_deals, update_deal, create_deal, query_contacts\n' +
      'Gmail: send_email, read_inbox, search_emails, create_draft, send_draft\n' +
      'Slack: send_message, send_channel_message\n' +
      'Calendly: list_events, create_invite_link, cancel_event, get_availability',
  },
}

const PREVIEW_BARS: [string, string, string][] = [
  ['Moves Money',   '#dc2626', '55%'],
  ['Touches PII',   '#b45309', '40%'],
  ['Deletes Data',  '#374151', '30%'],
  ['Sends External','#6b7280', '20%'],
]

function templateToTools(toolsString: string): ToolDef[] {
  return toolsString.trim().split('\n').filter(Boolean).map((line) => {
    const [toolPart, actionsPart] = line.split(':').map((s) => s.trim())
    const actions = (actionsPart ?? '').split(',').map((a) => a.trim()).filter(Boolean)
    return {
      name: toolPart.toLowerCase().replace(/\s+/g, '_'),
      service: toolPart, description: toolPart,
      actions: actions.map((a) => ({ action: a.toLowerCase().replace(/\s+/g, '_'), description: a, risk_labels: [], reversible: true })),
    }
  })
}

// ── Node graph data ────────────────────────────────────────────────────────
// Frequencies: ω = 2π / period. Range 6-10s → ω 0.63-1.05

const GRAPH_NODES: GraphNode[] = [
  // Large nodes (r=26, 52px diameter) — one per quadrant, corners
  { id: 0,  xPct: 7,  yPct: 12, r: 26, type: 'large',  fill: '#111827',                        label: 'CRM',          opacity: 0.90, driftXAmp: 18, driftXFreq: 0.95, driftXPhase: 0,   driftYAmp: 15, driftYFreq: 0.72, driftYPhase: 1.2 },
  { id: 1,  xPct: 87, yPct: 10, r: 26, type: 'large',  fill: '#111827',                        label: 'Payments',     opacity: 0.90, driftXAmp: 16, driftXFreq: 0.82, driftXPhase: 0.5, driftYAmp: 18, driftYFreq: 0.90, driftYPhase: 2.1 },
  { id: 2,  xPct: 88, yPct: 83, r: 26, type: 'large',  fill: '#111827',                        label: 'Database',     opacity: 0.88, driftXAmp: 14, driftXFreq: 0.70, driftXPhase: 1.0, driftYAmp: 17, driftYFreq: 1.02, driftYPhase: 0.7 },
  { id: 3,  xPct: 9,  yPct: 85, r: 26, type: 'large',  fill: '#111827',                        label: 'Email',        opacity: 0.88, driftXAmp: 20, driftXFreq: 0.88, driftXPhase: 2.3, driftYAmp: 14, driftYFreq: 0.75, driftYPhase: 1.8 },
  // Medium nodes (r=16, 32px diameter) — white fill, 2px stroke
  { id: 4,  xPct: 27, yPct: 7,  r: 16, type: 'medium', fill: '#ffffff', stroke: '#9ca3af', strokeWidth: 1.5, opacity: 0.80, driftXAmp: 17, driftXFreq: 1.02, driftXPhase: 0.8, driftYAmp: 20, driftYFreq: 0.82, driftYPhase: 3.0 },
  { id: 5,  xPct: 67, yPct: 18, r: 16, type: 'medium', fill: '#ffffff', stroke: '#9ca3af', strokeWidth: 1.5, opacity: 0.78, driftXAmp: 21, driftXFreq: 0.75, driftXPhase: 1.5, driftYAmp: 16, driftYFreq: 0.98, driftYPhase: 0.3 },
  { id: 6,  xPct: 93, yPct: 42, r: 16, type: 'medium', fill: '#ffffff', stroke: '#9ca3af', strokeWidth: 1.5, opacity: 0.82, driftXAmp: 15, driftXFreq: 0.88, driftXPhase: 2.8, driftYAmp: 19, driftYFreq: 0.68, driftYPhase: 1.1 },
  { id: 7,  xPct: 78, yPct: 63, r: 16, type: 'medium', fill: '#ffffff', stroke: '#9ca3af', strokeWidth: 1.5, opacity: 0.76, driftXAmp: 18, driftXFreq: 0.80, driftXPhase: 0.2, driftYAmp: 15, driftYFreq: 1.08, driftYPhase: 2.5 },
  { id: 8,  xPct: 30, yPct: 87, r: 16, type: 'medium', fill: '#ffffff', stroke: '#9ca3af', strokeWidth: 1.5, opacity: 0.80, driftXAmp: 22, driftXFreq: 0.65, driftXPhase: 1.7, driftYAmp: 14, driftYFreq: 0.88, driftYPhase: 0.9 },
  { id: 9,  xPct: 5,  yPct: 53, r: 16, type: 'medium', fill: '#ffffff', stroke: '#9ca3af', strokeWidth: 1.5, opacity: 0.82, driftXAmp: 16, driftXFreq: 0.93, driftXPhase: 3.2, driftYAmp: 21, driftYFreq: 0.72, driftYPhase: 1.4 },
  // Small nodes (r=9, 18px diameter) — light gray fill, thin stroke
  { id: 10, xPct: 4,  yPct: 30, r: 9,  type: 'small',  fill: '#f3f4f6', stroke: '#d1d5db', strokeWidth: 1, opacity: 0.80, driftXAmp: 20, driftXFreq: 1.05, driftXPhase: 0.4, driftYAmp: 16, driftYFreq: 0.80, driftYPhase: 2.8 },
  { id: 11, xPct: 46, yPct: 4,  r: 9,  type: 'small',  fill: '#f3f4f6', stroke: '#d1d5db', strokeWidth: 1, opacity: 0.72, driftXAmp: 18, driftXFreq: 0.88, driftXPhase: 1.2, driftYAmp: 19, driftYFreq: 1.00, driftYPhase: 0.6 },
  { id: 12, xPct: 93, yPct: 26, r: 9,  type: 'small',  fill: '#f3f4f6', stroke: '#d1d5db', strokeWidth: 1, opacity: 0.82, driftXAmp: 15, driftXFreq: 0.72, driftXPhase: 2.1, driftYAmp: 22, driftYFreq: 0.88, driftYPhase: 1.9 },
  { id: 13, xPct: 92, yPct: 68, r: 9,  type: 'small',  fill: '#f3f4f6', stroke: '#d1d5db', strokeWidth: 1, opacity: 0.80, driftXAmp: 17, driftXFreq: 1.00, driftXPhase: 0.9, driftYAmp: 15, driftYFreq: 0.72, driftYPhase: 3.1 },
  { id: 14, xPct: 72, yPct: 93, r: 9,  type: 'small',  fill: '#f3f4f6', stroke: '#d1d5db', strokeWidth: 1, opacity: 0.78, driftXAmp: 19, driftXFreq: 0.80, driftXPhase: 2.6, driftYAmp: 17, driftYFreq: 0.93, driftYPhase: 0.1 },
  { id: 15, xPct: 20, yPct: 95, r: 9,  type: 'small',  fill: '#f3f4f6', stroke: '#d1d5db', strokeWidth: 1, opacity: 0.78, driftXAmp: 21, driftXFreq: 0.93, driftXPhase: 1.4, driftYAmp: 18, driftYFreq: 0.80, driftYPhase: 2.3 },
  { id: 16, xPct: 97, yPct: 78, r: 9,  type: 'small',  fill: '#f3f4f6', stroke: '#d1d5db', strokeWidth: 1, opacity: 0.84, driftXAmp: 14, driftXFreq: 0.88, driftXPhase: 0.7, driftYAmp: 20, driftYFreq: 0.85, driftYPhase: 1.6 },
  { id: 17, xPct: 3,  yPct: 72, r: 9,  type: 'small',  fill: '#f3f4f6', stroke: '#d1d5db', strokeWidth: 1, opacity: 0.84, driftXAmp: 22, driftXFreq: 0.85, driftXPhase: 1.9, driftYAmp: 16, driftYFreq: 0.65, driftYPhase: 0.4 },
  // Red risk nodes (r=18, 36px diameter) — flanking the login card
  { id: 18, xPct: 22, yPct: 48, r: 18, type: 'red',    fill: '#ef4444', stroke: '#ffffff', strokeWidth: 2, label: 'moves_money',  opacity: 0.92, driftXAmp: 16, driftXFreq: 0.80, driftXPhase: 0.6, driftYAmp: 18, driftYFreq: 1.00, driftYPhase: 2.7 },
  { id: 19, xPct: 78, yPct: 52, r: 18, type: 'red',    fill: '#ef4444', stroke: '#ffffff', strokeWidth: 2, label: 'deletes_data', opacity: 0.92, driftXAmp: 14, driftXFreq: 0.93, driftXPhase: 1.8, driftYAmp: 20, driftYFreq: 0.72, driftYPhase: 0.3 },
]

const GRAPH_EDGES: GraphEdge[] = [
  // CRM → neighbors
  { from: 0,  to: 4,  isRed: false }, { from: 0,  to: 9,  isRed: false },
  { from: 0,  to: 10, isRed: false }, { from: 0,  to: 18, isRed: true  },
  // Payments → neighbors
  { from: 1,  to: 5,  isRed: false }, { from: 1,  to: 11, isRed: false },
  { from: 1,  to: 12, isRed: false }, { from: 1,  to: 18, isRed: true  },
  // Database → neighbors
  { from: 2,  to: 6,  isRed: false }, { from: 2,  to: 7,  isRed: false },
  { from: 2,  to: 13, isRed: false }, { from: 2,  to: 19, isRed: true  },
  // Email → neighbors
  { from: 3,  to: 8,  isRed: false }, { from: 3,  to: 15, isRed: false },
  { from: 3,  to: 17, isRed: false }, { from: 3,  to: 19, isRed: true  },
  // Medium chains
  { from: 4,  to: 5,  isRed: false }, { from: 5,  to: 6,  isRed: false },
  { from: 7,  to: 8,  isRed: false }, { from: 9,  to: 3,  isRed: false },
  // Risk chains into red nodes
  { from: 5,  to: 18, isRed: true  }, { from: 7,  to: 19, isRed: true  },
]

// ── CSS animations (injected once) ────────────────────────────────────────

const GRAPH_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');

  @keyframes lgn-node-pulse {
    0%, 100% { transform: scale(1); }
    50%       { transform: scale(1.15); }
  }
  .lgn-pulse {
    transform-box: fill-box;
    transform-origin: center;
    animation: lgn-node-pulse 2.5s ease-in-out infinite;
  }

  @keyframes lgn-red-pulse {
    0%, 100% {
      transform: scale(1);
      filter: drop-shadow(0 0 4px rgba(239,68,68,0.50));
    }
    50% {
      transform: scale(1.25);
      filter: drop-shadow(0 0 18px rgba(239,68,68,0.85));
    }
  }
  .lgn-red-pulse {
    transform-box: fill-box;
    transform-origin: center;
    animation: lgn-red-pulse 2.5s ease-in-out infinite;
  }

  @keyframes lgn-edge-flicker {
    0%, 100% { opacity: 0.35; }
    50%       { opacity: 1;    }
  }
  .lgn-red-edge {
    animation: lgn-edge-flicker 3s ease-in-out infinite;
  }
`

// ── Node label chip (rendered below the circle in SVG space) ──────────────

function NodeChip({ label, r }: { label: string; r: number }) {
  const fontSize = 11
  const padX = 8
  const chipWidth = label.length * 6.6 + padX * 2
  const chipHeight = 18
  const yTop = r + 10

  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect
        x={-chipWidth / 2} y={yTop}
        width={chipWidth} height={chipHeight}
        rx={4}
        fill="white" stroke="#e5e7eb" strokeWidth={1}
      />
      <text
        x={0} y={yTop + chipHeight / 2}
        textAnchor="middle" dominantBaseline="middle"
        fontSize={fontSize} fontWeight={600} fill="#111827"
        fontFamily="'DM Sans', system-ui, sans-serif"
        style={{ userSelect: 'none' } as React.CSSProperties}
      >
        {label}
      </text>
    </g>
  )
}

// ── Arceo logo (5-node "A") ────────────────────────────────────────────────

function ShieldLogo({ size = 52, color = "#111827" }: { size?: number; color?: string } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <line x1="16" y1="5"  x2="10" y2="18" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="16" y1="5"  x2="22" y2="18" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="10" y1="18" x2="22" y2="18" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="10" y1="18" x2="5"  y2="27" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="22" y1="18" x2="27" y2="27" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <circle cx="16" cy="5"  r="2.5" fill={color} />
      <circle cx="10" cy="18" r="2.5" fill={color} />
      <circle cx="22" cy="18" r="2.5" fill={color} />
      <circle cx="5"  cy="27" r="2.5" fill={color} />
      <circle cx="27" cy="27" r="2.5" fill={color} />
    </svg>
  )
}

// ── Animated node graph ────────────────────────────────────────────────────

function NodeGraph() {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    let rafId: number

    const animate = (ts: number) => {
      const t = ts / 1000
      const vw = svg.clientWidth  || window.innerWidth
      const vh = svg.clientHeight || window.innerHeight

      const pos = GRAPH_NODES.map((n) => ({
        x: (n.xPct / 100) * vw + n.driftXAmp * Math.sin(t * n.driftXFreq + n.driftXPhase),
        y: (n.yPct / 100) * vh + n.driftYAmp * Math.sin(t * n.driftYFreq + n.driftYPhase),
      }))

      GRAPH_NODES.forEach((_, i) => {
        svg.querySelector(`[data-node="${i}"]`)
          ?.setAttribute('transform', `translate(${pos[i].x},${pos[i].y})`)
      })

      GRAPH_EDGES.forEach((e, i) => {
        const el = svg.querySelector(`[data-edge="${i}"]`)
        if (el) {
          el.setAttribute('x1', String(pos[e.from].x))
          el.setAttribute('y1', String(pos[e.from].y))
          el.setAttribute('x2', String(pos[e.to].x))
          el.setAttribute('y2', String(pos[e.to].y))
        }
      })

      rafId = requestAnimationFrame(animate)
    }

    rafId = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return (
    <svg
      ref={svgRef}
      width="100%" height="100%"
      style={{ position: 'absolute', inset: 0, display: 'block', pointerEvents: 'none' }}
    >
      <style>{GRAPH_STYLES}</style>

      {/* Background */}
      <rect width="100%" height="100%" fill="#fafafa" />

      {/* Edges — rendered before nodes so they appear behind */}
      {GRAPH_EDGES.map((edge, i) => (
        <line
          key={i}
          data-edge={String(i)}
          x1="0" y1="0" x2="0" y2="0"
          stroke={edge.isRed ? '#fca5a5' : '#d1d5db'}
          strokeWidth={edge.isRed ? 2 : 1.5}
          strokeDasharray={edge.isRed ? '6 3' : undefined}
          className={edge.isRed ? 'lgn-red-edge' : undefined}
          style={edge.isRed ? { animationDelay: `${(i * 0.37) % 3}s` } : undefined}
        />
      ))}

      {/* Nodes */}
      {GRAPH_NODES.map((node, i) => {
        const isRed = node.type === 'red'
        const pulseDelay = `${(i * 0.28) % 4}s`

        return (
          <g key={i} data-node={String(i)} style={{ opacity: node.opacity }}>
            {/* Pulse group — scale animation only on the circle */}
            <g
              className={isRed ? 'lgn-red-pulse' : 'lgn-pulse'}
              style={{ animationDelay: pulseDelay }}
            >
              <circle
                r={node.r}
                fill={node.fill}
                stroke={node.stroke}
                strokeWidth={node.strokeWidth}
              />
            </g>

            {/* Label chip — static, drifts with node but doesn't scale */}
            {node.label && <NodeChip label={node.label} r={node.r} />}
          </g>
        )
      })}
    </svg>
  )
}

// ── Shared onboarding nav styles ───────────────────────────────────────────

const backBtnClass =
  'flex items-center gap-1.5 text-sm text-gray-400 font-medium hover:text-gray-900 transition-colors bg-transparent border-none cursor-pointer p-0'

const primaryBtnClass =
  'flex items-center gap-1.5 text-sm font-semibold text-white px-6 py-2.5 rounded-lg border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed'

// ── Component ──────────────────────────────────────────────────────────────

export default function Login() {
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [selectedTypes, setSelectedTypes] = useState<AgentTypeId[]>([])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [autoLogging, setAutoLogging] = useState(false)
  const navigate = useNavigate()

  // Load DM Sans for card text
  useEffect(() => {
    if (!document.querySelector('link[data-dm-sans]')) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.setAttribute('data-dm-sans', 'true')
      link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap'
      document.head.appendChild(link)
    }
  }, [])

  useEffect(() => {
    apiFetch<DemoModeResponse>('/api/demo-mode', { skipLogoutOn401: true })
      .then((data) => {
        if (data?.demo) {
          setAutoLogging(true)
          apiFetch<LoginResponse>('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: 'admin@actiongate.io', password: 'admin123' }),
            skipLogoutOn401: true,
          }).then((d) => { setToken(d.token); setUser(d.user); navigate('/') }).catch(() => setAutoLogging(false))
        }
      }).catch(() => {})
  }, [navigate])

  const doLogin = async () => {
    setLoading(true); setError(null)
    try {
      const data = await apiFetch<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email || 'admin@actiongate.io', password: password || 'admin123' }),
        skipLogoutOn401: true,
      })
      setToken(data.token); setUser(data.user); navigate('/')
    } catch { setError('Invalid email or password') }
    setLoading(false)
  }

  const handleLoginSubmit = async (e: React.FormEvent) => { e.preventDefault(); await doLogin() }

  const doGetStarted = async () => {
    setLoading(true); setError(null)
    const loginEmail    = email    || 'admin@actiongate.io'
    const loginPassword = password || 'admin123'
    if (email.trim() && password.trim()) {
      try {
        await apiFetch('/api/auth/signup', {
          method: 'POST',
          body: JSON.stringify({ email: email.trim(), password: password.trim(), name: email.split('@')[0] }),
          skipLogoutOn401: true,
        })
      } catch { /* user may already exist */ }
    }
    try {
      const data = await apiFetch<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
        skipLogoutOn401: true,
      })
      setToken(data.token); setUser(data.user)
      for (const typeId of selectedTypes.filter((id) => id !== 'custom' && AGENT_TYPE_TEMPLATES[id])) {
        const tmpl = AGENT_TYPE_TEMPLATES[typeId]
        try {
          await apiFetch('/api/authority/agents', {
            method: 'POST',
            body: JSON.stringify({ name: tmpl.name, description: tmpl.description, tools: templateToTools(tmpl.tools) }),
          })
        } catch { /* non-fatal */ }
      }
      navigate('/')
    } catch { setError('Invalid email or password') }
    setLoading(false)
  }

  const toggleType = (id: AgentTypeId) =>
    setSelectedTypes((prev) => prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id])

  // ── Auto-login loading ───────────────────────────────────────────────────

  if (autoLogging) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#fafafa', gap: 16 }}>
        <div style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ShieldLogo size={40} />
        </div>
        <div style={{ width: 24, height: 24, border: '2.5px solid #e5e7eb', borderTopColor: '#111827', borderRadius: '50%', animation: 'btn-spin 0.7s linear infinite' }} />
        <span style={{ fontSize: 14, color: '#6b7280', fontFamily: "'DM Sans', system-ui, sans-serif" }}>Loading demo environment…</span>
      </div>
    )
  }

  // ── Step 1 ────────────────────────────────────────────────────────────────

  if (step === 1) {
    return (
      <div className="min-h-screen flex flex-col bg-white font-sans">
        <div className="flex items-center justify-between px-10 py-5 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: '#0f1117' }}>
              <ShieldLogo size={16} color="#fff" />
            </div>
            <span className="text-[15px] font-bold tracking-tight text-gray-900">Arceo</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-gray-400 font-medium">Step 1 of 2</span>
            <div className="w-40 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-500" style={{ width: '50%', background: '#0f1117' }} />
            </div>
          </div>
        </div>
        <div className="flex flex-1 items-center gap-16 px-16 py-12 max-w-[1120px] mx-auto w-full box-border">
          <div className="flex-1 max-w-[440px]">
            <h1 className="text-[26px] font-bold leading-snug text-gray-900 mb-2">Get started with Arceo</h1>
            <p className="text-[15px] text-gray-500 leading-relaxed mb-10">
              A safe environment to audit AI agent risk before anything runs in production.
            </p>
            <ol className="list-none p-0 m-0 flex flex-col">
              {[
                { num: 1, title: 'Register your agent', body: 'List the tools your AI agent can access — Stripe, Zendesk, Salesforce, or any custom tool.' },
                { num: 2, title: 'Assess the risk exposure', body: 'Instantly see which actions can move money, delete data, or leak PII — and how dangerous they are.' },
                { num: 3, title: 'Enforce policies', body: 'Block or require human approval for risky actions before they run in production.' },
              ].map((s, i, arr) => (
                <li key={s.num} className="flex gap-4 py-5 pl-8 ml-3 relative"
                  style={{ borderLeft: i < arr.length - 1 ? '2px solid #e5e7eb' : '2px solid transparent' }}>
                  <div className="absolute -left-[13px] top-5 w-[26px] h-[26px] rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold text-white" style={{ background: '#0f1117' }}>{s.num}</div>
                  <div>
                    <strong className="block text-[13px] font-semibold text-gray-900 mb-1">{s.title}</strong>
                    <p className="text-[13px] text-gray-400 m-0 leading-relaxed">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="flex-1">
            <div className="rounded-xl overflow-hidden" style={{ background: '#f8fafc', border: '1px solid #e5e7eb', boxShadow: '0 8px 40px rgba(0,0,0,0.08)' }}>
              <div className="text-white text-[12px] font-semibold px-4 py-3 tracking-wide flex items-center gap-2" style={{ background: '#0f1117' }}>
                <Shield size={12} /> Risk Analysis Preview
              </div>
              <div className="p-4 flex flex-col gap-3">
                <div className="bg-white border border-gray-100 rounded-lg p-4">
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex flex-col gap-2 flex-1">
                      <div className="h-2 bg-gray-100 rounded-full" style={{ width: '65%' }} />
                      <div className="h-2 bg-gray-100 rounded-full opacity-50" style={{ width: '42%' }} />
                    </div>
                    <div className="w-11 h-11 rounded-full flex items-center justify-center text-[15px] font-extrabold border-2 border-current flex-shrink-0 ml-4" style={{ background: '#fef2f2', color: '#dc2626' }}>67</div>
                  </div>
                  <div className="flex flex-col gap-2">
                    {PREVIEW_BARS.map(([label, color, w]) => (
                      <div key={label} className="flex items-center gap-3 text-[11px] text-gray-400">
                        <span className="w-[76px] flex-shrink-0">{label}</span>
                        <div className="flex-1 h-[5px] bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: w, background: color, opacity: 0.75 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bg-white border border-gray-100 rounded-lg px-4 py-3">
                  <div className="h-2 bg-gray-100 rounded-full mb-3" style={{ width: '48%' }} />
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wide" style={{ background: '#fef2f2', color: '#dc2626' }}>critical</span>
                    <span className="text-[12px] text-gray-700 font-medium">PII Exfiltration</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wide" style={{ background: '#fff7ed', color: '#ea580c' }}>high</span>
                    <span className="text-[12px] text-gray-700 font-medium">Unsupervised Refund</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="flex justify-between items-center px-10 py-5 border-t border-gray-100 flex-shrink-0">
          <button type="button" onClick={() => setStep(0)} className={backBtnClass}><ArrowLeft size={14} />Back</button>
          <button type="button" onClick={() => setStep(2)} className={primaryBtnClass} style={{ background: '#0f1117' }}>Continue<ArrowRight size={14} /></button>
        </div>
      </div>
    )
  }

  // ── Step 2 ────────────────────────────────────────────────────────────────

  if (step === 2) {
    return (
      <div className="min-h-screen flex flex-col bg-white font-sans">
        <div className="flex items-center justify-between px-10 py-5 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: '#0f1117' }}>
              <ShieldLogo size={16} color="#fff" />
            </div>
            <span className="text-[15px] font-bold tracking-tight text-gray-900">Arceo</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-gray-400 font-medium">Step 2 of 2</span>
            <div className="w-40 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-500" style={{ width: '100%', background: '#0f1117' }} />
            </div>
          </div>
        </div>
        <div className="flex flex-col flex-1 items-start gap-6 px-16 py-12 max-w-[640px] mx-auto w-full box-border">
          <div>
            <h1 className="text-[24px] font-bold text-gray-900 mb-2">What kind of agent are you working with?</h1>
            <p className="text-[14px] text-gray-500 m-0">We'll pre-load the right tools and risk model. You can always add more later.</p>
          </div>
          <div className="flex flex-col gap-2.5 w-full">
            {AGENT_TYPES.map((t) => {
              const sel = selectedTypes.includes(t.id)
              return (
                <label key={t.id} className="flex items-start gap-3.5 px-4 py-4 border-[1.5px] rounded-xl cursor-pointer transition-all duration-150"
                  style={{ borderColor: sel ? '#0f1117' : '#e5e7eb', background: sel ? '#f9fafb' : '#ffffff', boxShadow: sel ? '0 0 0 3px rgba(15,17,23,0.06)' : 'none' }}>
                  <div className="mt-0.5 w-[18px] h-[18px] rounded-[4px] flex items-center justify-center flex-shrink-0 border transition-all duration-150"
                    style={{ background: sel ? '#0f1117' : '#ffffff', borderColor: sel ? '#0f1117' : '#d1d5db' }}>
                    {sel && <Check size={11} strokeWidth={3} color="#ffffff" />}
                  </div>
                  <input type="checkbox" className="sr-only" checked={sel} onChange={() => toggleType(t.id)} aria-label={t.label} />
                  <div className="flex flex-col gap-0.5">
                    <strong className="text-[13px] font-semibold text-gray-900">{t.label}</strong>
                    <span className="text-[13px] text-gray-400 leading-relaxed">{t.desc}</span>
                  </div>
                </label>
              )
            })}
          </div>
        </div>
        <div className="flex justify-between items-center px-10 py-5 border-t border-gray-100 flex-shrink-0">
          <button type="button" onClick={() => setStep(1)} className={backBtnClass}><ArrowLeft size={14} />Back</button>
          <div className="flex items-center gap-2.5">
            <button type="button" onClick={doLogin} disabled={loading}
              className="text-[13px] font-medium text-gray-500 px-5 py-2.5 rounded-lg border border-gray-200 bg-transparent cursor-pointer hover:border-gray-900 hover:text-gray-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              Skip for now
            </button>
            <button type="button" onClick={doGetStarted} disabled={loading} className={primaryBtnClass} style={{ background: '#0f1117' }}>
              {loading ? 'Setting up...' : 'Get started'}{!loading && <ArrowRight size={14} />}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 0: Login card ────────────────────────────────────────────────────

  const dmSans = "'DM Sans', system-ui, -apple-system, sans-serif"

  return (
    <div style={{ minHeight: '100vh', position: 'relative', isolation: 'isolate', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>

      <NodeGraph />

      <div style={{
        position: 'relative', zIndex: 1,
        width: '100%', maxWidth: '480px', margin: '24px',
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: '20px',
        padding: '52px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.10)',
        fontFamily: dmSans,
      }}>

        {/* Logo */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '24px' }}>
          <ShieldLogo />
        </div>

        {/* Headline */}
        <h1 style={{ fontFamily: dmSans, fontSize: '30px', fontWeight: 700, color: '#111827', textAlign: 'center', margin: '0 0 10px', letterSpacing: '-0.5px', lineHeight: 1.2 }}>
          Welcome back
        </h1>
        <p style={{ fontFamily: dmSans, fontSize: '15px', color: '#6b7280', textAlign: 'center', margin: '0 0 34px', lineHeight: 1.5 }}>
          Sign in to access your dashboard
        </p>

        {/* Error */}
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '10px', padding: '12px 16px', marginBottom: '24px' }}>
            <AlertCircle size={15} color="#dc2626" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: '14px', color: '#dc2626', fontWeight: 500, fontFamily: dmSans }}>{error}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleLoginSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Email */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
            <label style={{ fontSize: '14px', fontWeight: 600, color: '#374151', fontFamily: dmSans }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{ width: '100%', height: '48px', padding: '0 16px', fontSize: '15px', fontFamily: dmSans, border: '1px solid #e5e7eb', borderRadius: '10px', background: '#fff', color: '#111827', boxSizing: 'border-box', outline: 'none', transition: 'border-color 0.15s' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#111827' }}
              onBlur={(e)  => { e.currentTarget.style.borderColor = '#e5e7eb' }}
            />
          </div>

          {/* Password */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ fontSize: '14px', fontWeight: 600, color: '#374151', fontFamily: dmSans }}>Password</label>
              <button type="button" style={{ background: 'none', border: 'none', padding: 0, fontSize: '13px', fontWeight: 500, color: '#6b7280', cursor: 'pointer', fontFamily: dmSans }}>
                Forgot password?
              </button>
            </div>
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ width: '100%', height: '48px', padding: '0 44px 0 16px', fontSize: '15px', fontFamily: dmSans, border: '1px solid #e5e7eb', borderRadius: '10px', background: '#fff', color: '#111827', boxSizing: 'border-box', outline: 'none', transition: 'border-color 0.15s' }}
                onFocus={(e) => { e.currentTarget.style.borderColor = '#111827' }}
                onBlur={(e)  => { e.currentTarget.style.borderColor = '#e5e7eb' }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: '4px', cursor: 'pointer', color: '#9ca3af', display: 'flex', alignItems: 'center' }}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </div>

          {/* Sign in */}
          <button
            type="submit"
            disabled={loading}
            style={{ width: '100%', height: '50px', fontSize: '15px', fontWeight: 600, fontFamily: dmSans, background: '#111827', color: '#fff', border: 'none', borderRadius: '999px', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1, marginTop: '4px', transition: 'background 0.15s, transform 0.1s, box-shadow 0.15s' }}
            onMouseEnter={(e) => { if (!loading) { e.currentTarget.style.background = '#1f2937'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.18)'; e.currentTarget.style.transform = 'translateY(-1px)' } }}
            onMouseLeave={(e) => { if (!loading) { e.currentTarget.style.background = '#111827'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none' } }}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        {/* Sign up link */}
        <p style={{ textAlign: 'center', fontSize: '14px', color: '#6b7280', margin: '24px 0 0', fontFamily: dmSans }}>
          Don&apos;t have an account?{' '}
          <button
            type="button"
            onClick={() => { setStep(1); setError(null) }}
            style={{ background: 'none', border: 'none', padding: 0, fontSize: '14px', fontWeight: 600, color: '#111827', cursor: 'pointer', fontFamily: dmSans, textDecoration: 'underline' }}
          >
            Sign up
          </button>
        </p>

        {/* Demo */}
        <button
          type="button"
          onClick={doLogin}
          disabled={loading}
          style={{ display: 'block', width: '100%', marginTop: '12px', padding: '11px', fontSize: '13px', fontWeight: 500, fontFamily: dmSans, background: 'none', border: '1.5px dashed #e5e7eb', borderRadius: '10px', color: '#9ca3af', cursor: loading ? 'not-allowed' : 'pointer', textAlign: 'center', transition: 'border-color 0.15s, color 0.15s', opacity: loading ? 0.4 : 1 }}
          onMouseEnter={(e) => { if (!loading) { e.currentTarget.style.borderColor = '#9ca3af'; e.currentTarget.style.color = '#374151' } }}
          onMouseLeave={(e) => { if (!loading) { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.color = '#9ca3af' } }}
        >
          Try demo account
        </button>

      </div>
    </div>
  )
}
