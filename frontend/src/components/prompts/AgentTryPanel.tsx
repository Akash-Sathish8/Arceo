/**
 * "Try on my agent": what this prompt can reach inside one of the team's own
 * agents, and what it costs there.
 *
 * The estimate is free and follows the editor: a dry run predicts the actions
 * the prompt reaches, scored against the agent's full blast radius, and the
 * cost uses the agent's own model, turns and volume. "Run it for real" runs
 * the agent once in the sandbox (mock tools, real policies) and shows measured
 * tokens, latency and dollars. It uses one QA run.
 */

import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Bot, Play } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { toast } from "@/components/shared/Toast"
import { CARD, EYEBROW, FIELD, Label, Pill, SegControl } from "@/components/prompts/ui"
import {
  estimateAgentTry, formatMonthly, formatRunCost, getQaBudget, listMyAgents, runAgentTry,
  type AgentTryAction, type AgentTryChain, type AgentTryEstimate, type AgentTryMode, type AgentTryRun,
  type MyAgent, type QaBudget, type VariableSpec,
} from "@/lib/promptsApi"
import { scoreBand } from "@/lib/utils"
import { useWorkspaceStore } from "@/store/workspace"

const MODES = [
  { value: "task" as const, label: "Send as a task" },
  { value: "instructions" as const, label: "As its instructions" },
]

const DECISION: Record<string, { label: string; color: string; bg: string }> = {
  ALLOW: { label: "Runs", color: "var(--high)", bg: "var(--high-bg)" },
  BLOCK: { label: "Blocked", color: "var(--safe)", bg: "var(--safe-bg)" },
  PENDING_APPROVAL: { label: "Needs approval", color: "var(--caution)", bg: "var(--caution-bg)" },
}

function ScoreTile({ label, score, band, hint }: { label: string; score: number; band?: string; hint?: string }) {
  const b = scoreBand(score, 0, band)
  return (
    <div style={{ flex: 1, minWidth: 120, padding: "10px 12px", borderRadius: "var(--radius-md)", background: b.bg }} title={hint}>
      <div style={{ ...EYEBROW, color: b.color }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
        <span style={{ fontFamily: "var(--font-num)", fontSize: 24, fontWeight: 600, color: b.color }}>{Math.round(score)}</span>
        <span style={{ fontSize: "var(--fs-small)", color: b.color }}>{b.label}</span>
      </div>
    </div>
  )
}

function Actions({ actions }: { actions: AgentTryAction[] }) {
  if (!actions.length) {
    return <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: "8px 0 0" }}>No tool calls.</p>
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 6 }}>
      {actions.map((a, i) => {
        const d = DECISION[a.decision] ?? { label: a.decision, color: "var(--ink-600)", bg: "var(--bg-sunken)" }
        return (
          <li key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-small)" }}>
            <code style={{ color: "var(--ink-800)" }}>{a.tool}.{a.action}</code>
            <span style={{ marginLeft: "auto", fontSize: "var(--fs-micro)", fontWeight: 600, padding: "2px 8px",
              borderRadius: "var(--radius-full)", color: d.color, background: d.bg, whiteSpace: "nowrap" }}>{d.label}</span>
          </li>
        )
      })}
    </ul>
  )
}

function Chains({ chains }: { chains: AgentTryChain[] }) {
  if (!chains.length) return null
  return (
    <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
      {chains.map((c, i) => {
        const b = scoreBand(0, 0, c.severity)
        return (
          <span key={i} style={{ fontSize: "var(--fs-micro)", fontWeight: 600, padding: "2px 8px", borderRadius: "var(--radius-full)", color: b.color, background: b.bg }}>
            Chain: {c.name}
          </span>
        )
      })}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ minWidth: 96 }}>
      <div style={EYEBROW}>{label}</div>
      <div style={{ fontFamily: "var(--font-num)", fontSize: 18, fontWeight: 600, color: "var(--ink-900)", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)" }}>{sub}</div>}
    </div>
  )
}

const SECTION: React.CSSProperties = { marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line-soft)" }
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)
const fmtTokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n.toLocaleString())

function EstimateView({ est }: { est: AgentTryEstimate }) {
  const br = est.blast_radius
  const eff = est.efficiency
  return (
    <>
      <div style={SECTION}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={EYEBROW}>Blast radius</div>
          <Pill>Estimate</Pill>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <ScoreTile label="Reachable from this prompt" score={br.reachable.score} band={br.reachable.band}
            hint="The agent's blast radius counting only the actions this prompt is likely to trigger." />
          <ScoreTile label="Agent ceiling" score={br.ceiling.score} band={br.ceiling.band}
            hint="Everything this agent's tools could do, whatever the prompt." />
        </div>
        {br.overlaps.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "flex", flexDirection: "column", gap: 8 }}>
            {br.overlaps.map((o, i) => {
              const b = o.severity === "info" ? null : scoreBand(0, 0, o.severity)
              return (
                <li key={i} style={{ borderLeft: `3px solid ${b ? b.ring : "var(--line)"}`, paddingLeft: 10, fontSize: "var(--fs-small)" }}>
                  <div style={{ color: "var(--ink-900)", fontWeight: b ? 600 : 400 }}>{o.title}</div>
                  {o.actions.length > 0 && (
                    <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", marginTop: 2 }}>{o.actions.join(", ")}</div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <div style={{ ...EYEBROW, marginTop: 12 }}>Likely actions</div>
        <Actions actions={br.likely_actions} />
        <Chains chains={br.chains} />
      </div>

      <div style={SECTION}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={EYEBROW}>Efficiency on {eff.model_key ?? est.agent.model}</div>
          <Pill>Estimate</Pill>
        </div>
        {eff.available ? (
          <>
            <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
              {eff.usd_per_month != null && <Stat label="Per month" value={formatMonthly(eff.usd_per_month)} sub={`${eff.runs_per_day} runs a day`} />}
              <Stat label="Per run" value={formatRunCost(eff.usd_per_run)} />
              <Stat label="Turns" value={String(eff.turns)} />
              <Stat label="Tool calls" value={String(eff.tool_calls)} />
            </div>
            {eff.delta_pct != null && Math.abs(eff.delta_pct) >= 1 && (
              <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: "var(--radius-md)", fontSize: "var(--fs-small)",
                background: eff.delta_pct > 0 ? "var(--caution-bg)" : "var(--accent-soft)",
                color: eff.delta_pct > 0 ? "var(--caution)" : "var(--accent-ink)" }}>
                About <b>{Math.abs(eff.delta_pct).toFixed(0)}% {eff.delta_pct > 0 ? "more" : "less"}</b> per
                run than {est.agent.name} costs today
                {eff.baseline_usd_per_month != null && eff.usd_per_month != null
                  ? ` (${formatMonthly(eff.baseline_usd_per_month)} → ${formatMonthly(eff.usd_per_month)} a month)` : ""}.
              </div>
            )}
          </>
        ) : (
          <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: "8px 0 0" }}>
            {est.agent.model} isn't in the price list, so cost can't be estimated.
          </p>
        )}
      </div>
    </>
  )
}

function RunView({ run }: { run: AgentTryRun }) {
  const br = run.blast_radius
  const eff = run.efficiency
  return (
    <div style={{ ...SECTION, borderTop: "2px solid var(--accent)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={EYEBROW}>Real run</div>
        <Pill tone="accent">Measured</Pill>
      </div>
      {run.error && (
        <p style={{ fontSize: "var(--fs-small)", color: "var(--critical)", margin: "8px 0 0" }}>The run stopped early: {run.error}</p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <ScoreTile label="Sim risk" score={br.risk_score} hint="Risk of what the agent actually did in this run." />
      </div>
      <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)", marginTop: 8 }}>
        {br.executed} ran · {br.blocked} blocked{br.pending ? ` · ${br.pending} waiting for approval` : ""}
      </div>
      <Actions actions={br.actions} />
      <Chains chains={br.chains} />
      {br.summary && <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-700)", lineHeight: 1.5, marginTop: 10 }}>{br.summary}</p>}

      <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
        {eff.usd_per_month != null && <Stat label="Per month" value={formatMonthly(eff.usd_per_month)} sub={`${eff.runs_per_day} runs a day`} />}
        <Stat label="Per run" value={formatRunCost(eff.usd_per_run)} sub={eff.model_key} />
        <Stat label="Latency" value={fmtMs(eff.latency_ms)} sub={eff.latency_ms_per_turn != null ? `${fmtMs(eff.latency_ms_per_turn)} a turn` : undefined} />
        <Stat label="Turns" value={String(eff.turns)} sub={`limit ${eff.max_turns}`} />
        <Stat label="Tool calls" value={String(eff.tool_calls)} />
        <Stat label="Tokens" value={`${fmtTokens(eff.input_tokens)} / ${fmtTokens(eff.output_tokens)}`} sub="in / out" />
      </div>
      <Link to={`/sandbox/${run.simulation_id}`} style={{ display: "inline-block", marginTop: 12, fontSize: "var(--fs-small)", color: "var(--accent)" }}>
        View the full trace
      </Link>
    </div>
  )
}

export default function AgentTryPanel({ promptId, body, variables }: {
  promptId: string
  body: string
  variables: Record<string, VariableSpec>
}) {
  const navigate = useNavigate()
  const setWorkspace = useWorkspaceStore((s) => s.set)
  const [agents, setAgents] = useState<MyAgent[] | null>(null)
  const [agentId, setAgentId] = useState("")
  const [mode, setMode] = useState<AgentTryMode>("task")
  const [task, setTask] = useState("")
  const [est, setEst] = useState<AgentTryEstimate | null>(null)
  const [estError, setEstError] = useState<string | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [run, setRun] = useState<AgentTryRun | null>(null)
  const [running, setRunning] = useState(false)
  const [budget, setBudget] = useState<QaBudget | null>(null)

  const values = useMemo(
    () => Object.fromEntries(Object.entries(variables).filter(([, v]) => v?.sample).map(([k, v]) => [k, v.sample!])),
    [variables],
  )

  useEffect(() => {
    listMyAgents()
      .then((a) => { setAgents(a); if (a.length) setAgentId((cur) => cur || a[0].id) })
      .catch(() => setAgents([]))
    getQaBudget().then(setBudget).catch(() => { /* the button still works without the counter */ })
  }, [])

  // A new agent, mode or prompt text invalidates a measured run.
  useEffect(() => { setRun(null) }, [agentId, mode, body])

  useEffect(() => {
    if (!agentId || !body.trim()) { setEst(null); return }
    let alive = true
    setEstimating(true)
    const t = setTimeout(() => {
      estimateAgentTry(promptId, { agent_id: agentId, mode, task: task || undefined, values, body })
        .then((r) => { if (alive) { setEst(r); setEstError(null) } })
        .catch((e: Error) => { if (alive) setEstError(e.message) })
        .finally(() => { if (alive) setEstimating(false) })
    }, 700)
    return () => { alive = false; clearTimeout(t) }
  }, [promptId, agentId, mode, task, values, body])

  async function runIt() {
    setRunning(true)
    try {
      setRun(await runAgentTry(promptId, { agent_id: agentId, mode, task: task || undefined, values, body }))
      getQaBudget().then(setBudget).catch(() => {})
    } catch (e) {
      toast((e as Error).message || "The run failed.", "error")
    } finally {
      setRunning(false)
    }
  }

  const ownKey = budget && (budget.own_keys.anthropic || budget.own_keys.openai)
  const runNote = !budget ? null
    : ownKey ? "Runs on your team's model key."
    : budget.remaining > 0 ? `Uses 1 of your ${budget.remaining} free runs left this month.`
    : "No free runs left this month. Add your own model key in Settings."

  // Agents are the technical side of Arceo. Someone without any (most prompt
  // users) never needs this panel, so it stays out of their way entirely.
  if (!agents || agents.length === 0) return null

  return (
    <div style={CARD} aria-busy={estimating || running}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={EYEBROW}>Try on my agent</div>
        {estimating && <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)" }}>Updating…</span>}
      </div>

      {agents === null ? (
        <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 10 }}>Loading your agents…</p>
      ) : agents.length === 0 ? (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)", margin: 0 }}>
            Add one of your agents to see what this prompt could make it do, and what it would cost there.
          </p>
          <Button size="sm" variant="secondary" icon={<Bot size={13} />} style={{ marginTop: 10 }}
            onClick={() => void setWorkspace("agents").then(() => navigate("/"))}>
            Add an agent
          </Button>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
            <div>
              <Label htmlFor="at-agent">Agent</Label>
              <select id="at-agent" style={{ ...FIELD, height: 36 }} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <SegControl options={MODES} value={mode} onChange={setMode} />
              <p style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", margin: "6px 0 0" }}>
                {mode === "task"
                  ? "The agent keeps its own instructions and gets this prompt as a request."
                  : "This prompt replaces the agent's instructions, and the agent gets the task below."}
              </p>
            </div>
            {mode === "instructions" && (
              <div>
                <Label htmlFor="at-task">Test task</Label>
                <textarea id="at-task" rows={2} style={{ ...FIELD, resize: "vertical" }} value={task}
                  placeholder="Leave empty for a typical request for this agent"
                  onChange={(e) => setTask(e.target.value)} />
              </div>
            )}
          </div>

          {estError && <p style={{ fontSize: "var(--fs-small)", color: "var(--critical)", marginTop: 10 }}>{estError}</p>}
          {est && <EstimateView est={est} />}

          <div style={{ ...SECTION, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Button size="sm" icon={<Play size={13} />} loading={running} disabled={!agentId || !body.trim()} onClick={() => void runIt()}>
              Run it for real
            </Button>
            {runNote && <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)" }}>{runNote}</span>}
          </div>
          {run && <RunView run={run} />}
        </>
      )}
    </div>
  )
}
