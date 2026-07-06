/**
 * Cost Portfolio — clicked-through detail view from an agent card's spend value.
 *
 * V1 EXTENDED. Fetches the real forecast from /api/agents/{id}/spend-forecast.
 * Sliders re-fetch with debounced overrides so the numbers recompute live.
 * Spec: brain/Live/Forecast UI sketch.md
 */

import { useParams, Link } from "react-router-dom"
import { useEffect, useRef, useState } from "react"
import {
  Banknote, Sliders, PieChart, BarChart3, Target,
  TrendingUp, Shield, Search, FileText, Plus, HelpCircle, X,
  AlertTriangle, Check, ArrowRight,
} from "lucide-react"
import type { MockSpend } from "@/lib/mockSpend"
import { fetchSpendForecast, fetchSpendTimeseries, fetchSpendAnomalies, fetchBudgetFit, fetchSavedBudget, saveBudget, applyGatePolicy, setForecastInputs, runSweep } from "@/lib/spendApi"
import type { SpendTimeseries, SpendAnomaly, BudgetFit, SavedBudget } from "@/lib/spendApi"
import { ExportCFOReportButton } from "@/components/ExportCFOReportButton"
import { apiFetch } from "@/lib/api"
import { toast } from "@/components/shared/Toast"
import { pickWorstCase, type CostReportResponse } from "@/lib/cfoReport"

type SourceStatus = "calibrated" | "active" | "partial" | "disconnected"

const STATUS_TONE: Record<SourceStatus, string> = {
  calibrated:   "var(--severity-safe)",
  active:       "var(--severity-safe)",
  partial:      "var(--severity-medium)",
  disconnected: "var(--text-muted)",
}

type Confidence = "low" | "medium" | "high"

const CONFIDENCE_CHIP: Record<Confidence, { label: string; bg: string; color: string; border: string; tooltip: string }> = {
  low:    { label: "LOW CONFIDENCE",    bg: "var(--severity-medium-bg)",   color: "var(--severity-high)",     border: "var(--severity-medium-border)", tooltip: "Based on the agent's capabilities alone. Confidence improves as sandbox runs and live traces accumulate — the Data sources panel below shows what's connected." },
  medium: { label: "MEDIUM CONFIDENCE", bg: "var(--severity-medium-bg)",   color: "var(--severity-medium)",   border: "var(--severity-medium-border)", tooltip: "Test runs measured how this agent behaves (steps per task, response sizes) — but not production volumes like document sizes or which actions dominate real traffic, so the range stays wide on the high side. Connect live traffic to tighten it." },
  high:   { label: "HIGH CONFIDENCE",   bg: "var(--severity-safe-bg)",     color: "var(--severity-safe)",     border: "var(--severity-safe-border)",   tooltip: "Based on this agent's real production calls. The longer the observed window, the more the monthly number can be trusted." },
}

// Per-input provenance: never let a defaulted input read as a measurement.
const SOURCE_BADGE: Record<string, { label: string; color: string; bg: string; tip: string }> = {
  declared: { label: "declared", color: "var(--severity-safe, #047857)",  bg: "var(--severity-safe-bg, #ecfdf5)",   tip: "You declared this value." },
  measured: { label: "measured", color: "var(--severity-safe, #047857)",  bg: "var(--severity-safe-bg, #ecfdf5)",   tip: "Measured from this agent's sandbox or live traces." },
  default:  { label: "default",  color: "var(--severity-medium, #b45309)", bg: "var(--severity-medium-bg, #fffbeb)", tip: "Industry-typical default — not measured for this agent. Declare it or run a sweep to make it real." },
  volume:   { label: "in volume", color: "var(--severity-safe, #047857)",  bg: "var(--severity-safe-bg, #ecfdf5)",   tip: "Your declared daily volume already counts every model call, so no extra per-run multiplier is applied. Declare turns per run if your number was runs, not calls." },
}

function SourceBadge({ source }: { source?: string }) {
  const s = source ? SOURCE_BADGE[source] : undefined
  if (!s) return null
  return (
    <span
      className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ml-1.5 cursor-help align-middle"
      title={s.tip}
      style={{ background: s.bg, color: s.color }}
    >{s.label}</span>
  )
}

type SliderTone = "neutral" | "positive" | "negative"

function LiveSlider({
  label, value, displayValue, min, max, step, onChange, tone = "neutral",
}: {
  label: string; value: number; displayValue: string;
  min: number; max: number; step: number;
  onChange: (v: number) => void; tone?: SliderTone;
}) {
  const fillPct = ((value - min) / (max - min)) * 100
  const fillClass = tone === "positive" ? "slider-fill slider-fill--positive"
                  : tone === "negative" ? "slider-fill slider-fill--negative"
                  : "slider-fill"
  const knobClass = tone === "positive" ? "slider-knob slider-knob--positive"
                  : tone === "negative" ? "slider-knob slider-knob--negative"
                  : "slider-knob"
  return (
    <div className="slider-row">
      <label className="text-sm text-gray-600">{label}</label>
      <div className="relative h-6 flex items-center">
        <div className="slider-track">
          <div className={fillClass} style={{ width: `${fillPct}%` }} />
        </div>
        <div className={knobClass} style={{ left: `${fillPct}%` }} />
        <input
          type="range"
          min={min} max={max} step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer"
        />
      </div>
      <div className="text-right text-sm font-semibold mono">{displayValue}</div>
    </div>
  )
}

function PanelCard({ title, icon, help, children, fullWidth = false }: { title: string; icon: React.ReactNode; help?: string; children: React.ReactNode; fullWidth?: boolean }) {
  return (
    <div className={`panel-card ${fullWidth ? "panel-card--wide" : ""}`}>
      <h3 className="text-[13px] font-semibold flex items-center gap-2">
        <span className="text-gray-500">{icon}</span> {title}
      </h3>
      {help && <p className="mt-1 mb-4 text-xs text-gray-400">{help}</p>}
      {children}
    </div>
  )
}

function fmtDailyUsd(v: number): string {
  if (v >= 100) return `$${Math.round(v).toLocaleString()}`
  if (v >= 1) return `$${v.toFixed(2)}`
  if (v >= 0.01) return `$${v.toFixed(2)}`
  return `$${v.toFixed(4)}`
}

/**
 * Real actuals-vs-projection chart. Left 30 cols = observed daily LLM cost from
 * live traces (solid). Right cols = forecast projection at the current daily
 * point with the confidence band shaded. All numbers are real — no hand-drawn
 * paths or hardcoded axes (the thing this panel replaced).
 */
function ActualsChart({ data }: { data: SpendTimeseries }) {
  const actuals = data.timeseries
  const nA = actuals.length // 30
  const proj = data.projection
  const projDays = proj.days // 90
  const W = nA + projDays
  const H = 100

  const maxActual = actuals.reduce((mx, p) => Math.max(mx, p.usd), 0)
  const yMax = Math.max(maxActual, proj.dailyHigh, 0.0001) * 1.15
  const y = (v: number) => H - (v / yMax) * H

  const actualsPath = actuals
    .map((p, i) => `${i === 0 ? "M" : "L"} ${i} ${y(p.usd).toFixed(2)}`)
    .join(" ")

  const x0 = nA - 0.5 // projection starts at "today"
  const x1 = W - 1
  const bandPath = `M ${x0} ${y(proj.dailyLow).toFixed(2)} L ${x1} ${y(proj.dailyLow).toFixed(2)} L ${x1} ${y(proj.dailyHigh).toFixed(2)} L ${x0} ${y(proj.dailyHigh).toFixed(2)} Z`
  const projLine = `M ${x0} ${y(proj.dailyPoint).toFixed(2)} L ${x1} ${y(proj.dailyPoint).toFixed(2)}`

  return (
    <div>
      <div className="flex items-start justify-between mb-3 text-xs">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-gray-600"><span className="inline-block w-3 h-0.5 rounded" style={{ background: "var(--text-primary)" }} /> Observed LLM cost / day</span>
          <span className="flex items-center gap-1.5 text-gray-600"><span className="inline-block w-3 h-0.5 rounded" style={{ background: "var(--severity-safe)", borderTop: "1px dashed" }} /> Forecast band</span>
        </div>
        <span className="mono text-gray-500">{data.totalCalls.toLocaleString()} calls captured</span>
      </div>
      <div className="relative" style={{ paddingLeft: 36 }}>
        <div className="absolute left-0 top-0 bottom-5 flex flex-col justify-between text-[10px] text-gray-400 mono text-right" style={{ width: 32 }}>
          <span>{fmtDailyUsd(yMax)}</span>
          <span>{fmtDailyUsd(yMax / 2)}</span>
          <span>$0</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: 160 }}>
          {/* horizontal gridlines */}
          {[0, 0.5, 1].map((f) => (
            <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--border)" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
          ))}
          {/* forecast band */}
          <path d={bandPath} fill="var(--severity-safe)" opacity={0.10} />
          <path d={projLine} fill="none" stroke="var(--severity-safe)" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          {/* today divider */}
          <line x1={x0} x2={x0} y1={0} y2={H} stroke="var(--text-muted)" strokeWidth={0.75} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
          {/* observed actuals */}
          <path d={actualsPath} fill="none" stroke="var(--text-primary)" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="flex justify-between text-[10px] text-gray-400 mt-1" style={{ marginLeft: 0 }}>
          <span>30 days ago</span>
          <span>today</span>
          <span>+90 day projection</span>
        </div>
      </div>
    </div>
  )
}

function AnomalyBanner({ anomaly, displayName }: { anomaly: SpendAnomaly; displayName: string }) {
  // CFO-facing: plain scenario language, no jargon. The drivers come from the
  // backend already phrased as plain-English fragments.
  return (
    <div
      className="mt-4 rounded-xl border p-4 flex items-start gap-3"
      style={{
        background: "var(--severity-critical-bg)",
        borderColor: "var(--severity-critical-border, var(--border))",
      }}
    >
      <span
        className="w-7 h-7 rounded-lg inline-flex items-center justify-center shrink-0 mt-0.5"
        style={{ color: "var(--severity-critical)" }}
      >
        <AlertTriangle size={16} />
      </span>
      <div className="text-sm leading-relaxed">
        <div className="font-bold text-gray-900">
          Unusual spending in the last 24 hours
        </div>
        <div className="text-gray-700 mt-1">
          {displayName} spent <span className="mono font-semibold">${anomaly.last24hUsd.toFixed(2)}</span> in
          the last 24 hours — <span className="font-semibold">{anomaly.ratio.toFixed(1)}× its usual daily
          rate</span> (normally about <span className="mono">${anomaly.baselineDailyUsd.toFixed(2)}</span> per day).
        </div>
        {anomaly.drivers.length > 0 && (
          <div className="text-gray-700 mt-1">
            <span className="font-semibold">What changed:</span>{" "}
            {anomaly.drivers.join("; ")}.
          </div>
        )}
      </div>
    </div>
  )
}

function csvEscape(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadForecastCsv(
  displayName: string,
  m: MockSpend,
  timeseries: SpendTimeseries | null,
  costReport: CostReportResponse | null,
) {
  const rows: Array<Array<string | number>> = [
    ["Arceo cost forecast", displayName],
    ["Generated", new Date().toISOString().slice(0, 10)],
    [],
    ["Metric", "Value"],
    ["Estimated monthly spend (USD)", m.point],
    ["Low estimate (USD)", m.low],
    ["High estimate (USD)", m.high],
    ["Annualized (USD)", m.annual],
    ["Confidence", m.confidence],
    ["Model", m.model ?? ""],
    ["Calls per day", m.callsPerDay],
    ["Tokens per call", m.tokensPerCall],
    ["Cache hit rate (%)", m.cacheHit],
    ["Retry rate (%)", m.retryRate],
    [],
    ["Cost composition", "USD", "Percent"],
    ["LLM tokens", m.tokensUsd, m.tokensPct],
    ["Tool calls", m.toolsUsd, m.toolsPct],
    ["Infrastructure", m.infraUsd, m.infraPct],
  ]
  if (m.topTools?.length) {
    rows.push([], ["Top tool calls", "Calls per month", "Cost per call (USD)", "Monthly (USD)"])
    for (const t of m.topTools) rows.push([t.tool, t.callsPerMonth, t.costPer, t.monthly])
  }
  if (m.unitEcon?.length) {
    rows.push([], ["Unit economics", "Value"])
    for (const u of m.unitEcon) rows.push([u.label, u.value ?? "not measured"])
  }
  if (costReport) {
    rows.push(
      [],
      ["Worst-case exposure", "Value"],
      ["Worst single incident (USD, up to)", costReport.per_incident.max_usd],
      ["Risky actions without a guarding rule", `${costReport.total_unprotected} of ${costReport.total_risky_actions}`],
    )
  }
  if (timeseries?.hasData) {
    rows.push([], ["Observed daily LLM spend", "", ""], ["Date", "USD", "Calls"])
    for (const p of timeseries.timeseries) rows.push([p.date, p.usd, p.calls])
  }
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = `arceo-cost-forecast-${displayName.toLowerCase().replace(/\s+/g, "-")}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

function displayNameFromId(agentId: string | undefined): string {
  return (agentId ?? "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "just now"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "just now"
  const secs = Math.max(0, (Date.now() - then) / 1000)
  if (secs < 60) return "just now"
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

function formatCalibrationDate(iso: string | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
}

function CostPortfolioEmpty({ agentId, displayName }: { agentId: string | undefined; displayName: string }) {
  return (
    <div className="min-h-screen p-8" style={{ background: "var(--bg-page)" }}>
      <div className="text-xs text-gray-400 mb-2">
        <Link to="/" className="hover:underline" style={{ color: "var(--text-link)" }}>Agents</Link> · <Link to={`/agent/${agentId}`} className="hover:underline" style={{ color: "var(--text-link)" }}>{displayName}</Link> · Cost portfolio
      </div>
      <h1 className="text-2xl font-bold tracking-tight">Cost portfolio · {displayName}</h1>
      <div className="panel-card mt-8 text-center" style={{ padding: 48 }}>
        <Banknote className="mx-auto mb-4 text-gray-400" size={36} />
        <div className="text-base font-semibold text-gray-900">No forecast yet for this agent</div>
        <p className="text-sm text-gray-500 mt-2 max-w-md mx-auto leading-relaxed">
          A spend forecast is generated from sandbox traces. Run at least one simulation
          for {displayName} and the cost portfolio will populate within a few seconds.
        </p>
        <Link
          to={`/sandbox?agent=${agentId}`}
          className="inline-block mt-5 text-sm px-4 py-2 rounded-lg bg-gray-900 text-white font-medium"
        >
          Run a simulation
        </Link>
      </div>
    </div>
  )
}

function CostPortfolioLoading({ agentId, displayName }: { agentId: string | undefined; displayName: string }) {
  return (
    <div className="min-h-screen p-8" style={{ background: "var(--bg-page)" }}>
      <div className="text-xs text-gray-400 mb-2">
        <Link to="/" className="hover:underline" style={{ color: "var(--text-link)" }}>Agents</Link> · <Link to={`/agent/${agentId}`} className="hover:underline" style={{ color: "var(--text-link)" }}>{displayName}</Link> · Cost portfolio
      </div>
      <h1 className="text-2xl font-bold tracking-tight">Cost portfolio · {displayName}</h1>
      <p className="text-sm text-gray-500 mt-3">Loading forecast…</p>
    </div>
  )
}

export default function CostPortfolio() {
  const { agentId } = useParams<{ agentId: string }>()
  const [forecast, setForecast] = useState<MockSpend | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!agentId) { setLoading(false); return }
    fetchSpendForecast(agentId)
      .then((f) => { if (f) setForecast(f) })
      .finally(() => setLoading(false))
  }, [agentId])

  const displayName = displayNameFromId(agentId)

  if (loading) return <CostPortfolioLoading agentId={agentId} displayName={displayName} />
  if (!forecast) return <CostPortfolioEmpty agentId={agentId} displayName={displayName} />

  return <CostPortfolioContent agentId={agentId} displayName={displayName} forecast={forecast} setForecast={setForecast} />
}

const FORECAST_MODELS = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "gpt-5", label: "GPT-5" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "gemini-2-5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2-5-flash", label: "Gemini 2.5 Flash" },
]

type SweepPhase = "idle" | "form" | "running" | "done"

function ForecastUnavailableView({
  agentId,
  displayName,
  coverage,
  liveCalls7d,
  liveCallsNeeded,
  onDeclared,
}: {
  agentId: string | undefined
  displayName: string
  coverage?: MockSpend["coverage"]
  liveCalls7d?: number
  liveCallsNeeded?: number
  onDeclared: () => void
}) {
  const [phase, setPhase] = useState<SweepPhase>("idle")
  const [runs, setRuns] = useState<number>(100)
  const [turns, setTurns] = useState<number>(4)
  const [model, setModel] = useState<string>("claude-sonnet-4-6")
  const [contextSize, setContextSize] = useState<"" | "small" | "medium" | "large" | "xlarge">("")

  // Plain-English buckets → tokens. A tool list can't reveal that a RAG agent
  // reads 80k tokens of documents per call; without this the forecast is
  // structurally low for context-heavy agents.
  // Each value is the geometric midpoint of the range its label covers, not the
  // range's floor — a floor under-prices every agent in the upper half of its
  // bucket ("long documents" spans ~20k–80k → midpoint 40k; the old 30k left a
  // 2.7× dead zone to the next bucket, wider than the medium-tier band).
  const CONTEXT_TOKENS: Record<string, number> = { small: 0, medium: 8000, large: 40000, xlarge: 80000 }

  // Feed inputs → persist them → sandbox the agent → report upgrades to medium tier.
  const generate = async () => {
    if (!agentId || runs <= 0 || turns <= 0) return
    setPhase("running")
    const saved = await setForecastInputs(agentId, {
      expected_calls_per_day: runs,
      expected_turns_per_run: turns,
      simulation_model: model,
      ...(contextSize && contextSize !== "small" ? { avg_context_tokens: CONTEXT_TOKENS[contextSize] } : {}),
    })
    if (!saved) {
      toast("Couldn't save your inputs", "error")
      setPhase("form")
      return
    }
    // Sandbox the agent — real LLM runs, measures token + turn usage. Slow.
    const swept = await runSweep(agentId)
    if (!swept) {
      // Inputs still landed, so the forecast leaves "unavailable" — just at low tier.
      toast("Sandbox run didn't complete — showing the estimate from your inputs", "error")
    } else {
      toast("Agent sandboxed — measured forecast ready")
    }
    setPhase("done")
    onDeclared()
  }

  if (phase === "running") {
    return (
      <div className="min-h-screen p-8" style={{ background: "var(--bg-page)" }}>
        <div className="text-xs text-gray-400 mb-2">Cost Portfolio · {displayName}</div>
        <div
          className="max-w-xl rounded-xl border p-8 text-center mx-auto mt-8"
          style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}
        >
          <div className="mx-auto h-7 w-7 rounded-full border-2 border-gray-300 border-t-gray-800 animate-spin" />
          <div className="mt-4 text-base font-semibold text-gray-800">Sandboxing {displayName}…</div>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            Running {displayName} through every risk scenario to measure its real token and turn
            usage. This takes up to a minute — sit tight, we'll show the measured forecast when it's done.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-8" style={{ background: "var(--bg-page)" }}>
      <div className="text-xs text-gray-400 mb-2">Cost Portfolio · {displayName}</div>
      <div
        className="max-w-xl rounded-xl border p-8 mx-auto mt-8"
        style={{ background: "var(--bg-card)", border: "1px dashed var(--border)" }}
      >
        <div className="text-center">
          <Banknote size={28} className="mx-auto text-gray-400" />
          {liveCalls7d && liveCalls7d > 0 ? (
            // Live capture IS working — never tell this customer "no data" (D27).
            <>
              <div className="mt-3 text-base font-semibold text-gray-800">
                We're watching {displayName}'s real traffic
              </div>
              <p className="mt-2 text-sm text-gray-500 leading-relaxed">
                {liveCalls7d} of {liveCallsNeeded ?? 5} calls captured so far. Once {liveCallsNeeded ?? 5} real
                calls come through, a spend forecast built from your actual traffic appears here automatically —
                usually within a day. Don't want to wait? Answer three questions below and we'll estimate it now.
              </p>
            </>
          ) : (
            <>
              <div className="mt-3 text-base font-semibold text-gray-800">No forecast yet for {displayName}</div>
              <p className="mt-2 text-sm text-gray-500 leading-relaxed">
                We won't show a dollar figure built only from defaults. Tell us three things about how this
                agent runs — we'll sandbox it against every risk scenario and hand back a measured
                forecast with a real ± band.
              </p>
            </>
          )}
        </div>

        {phase === "idle" ? (
          <div className="mt-6 text-center">
            <button
              onClick={() => setPhase("form")}
              className="text-sm px-5 py-2.5 rounded-lg font-medium text-white"
              style={{ background: "var(--color-cta, #0f172a)", border: "none", cursor: "pointer" }}
            >
              Get cost report
            </button>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Runs per day</span>
              <input
                type="number" min={1} value={runs}
                onChange={(e) => setRuns(Number(e.target.value))}
                className="mt-1 w-full px-3 py-2 rounded-md border bg-white text-sm mono"
                style={{ borderColor: "var(--border)" }}
              />
              <span className="text-[11px] text-gray-400">How many times this agent runs in a typical day.</span>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Turns per run</span>
              <input
                type="number" min={1} value={turns}
                onChange={(e) => setTurns(Number(e.target.value))}
                className="mt-1 w-full px-3 py-2 rounded-md border bg-white text-sm mono"
                style={{ borderColor: "var(--border)" }}
              />
              <span className="text-[11px] text-gray-400">
                Roughly how many model calls your agent makes each time it runs. Reading a total
                "API calls per day" off your provider's dashboard instead? Put that under runs and set this to 1.
              </span>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Model</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md border bg-white text-sm"
                style={{ borderColor: "var(--border)" }}
              >
                {FORECAST_MODELS.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
              <span className="text-[11px] text-gray-400">The model this agent calls — sets the price per token.</span>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">How much does it read per run? <span className="font-normal text-gray-400">(optional)</span></span>
              <select
                value={contextSize}
                onChange={(e) => setContextSize(e.target.value as typeof contextSize)}
                className="mt-1 w-full px-3 py-2 rounded-md border bg-white text-sm"
                style={{ borderColor: "var(--border)" }}
              >
                <option value="">Not sure — estimate for me</option>
                <option value="small">Just instructions — no documents</option>
                <option value="medium">A few pages (emails, tickets)</option>
                <option value="large">Long documents (contracts, reports)</option>
                <option value="xlarge">Whole knowledge bases (RAG, large retrievals)</option>
              </select>
              <span className="text-[11px] text-gray-400">
                Agents that read big documents each run cost far more per call — this is the
                single biggest thing a tool list can't tell us.
              </span>
            </label>
            <button
              onClick={generate}
              className="w-full text-sm px-4 py-2.5 rounded-lg font-medium text-white"
              style={{ background: "var(--color-cta, #0f172a)", border: "none", cursor: "pointer" }}
            >
              Sandbox agent &amp; generate report
            </button>
            <p className="text-[11px] text-gray-400 text-center">
              Runs real scenarios against your agent (~30s–1min) to measure its actual usage.
            </p>
          </div>
        )}

        {coverage && coverage.declaredModel && !coverage.modelRecognized && (
          <div className="mt-4 text-[11px] text-gray-400 text-center">
            Declared model <span className="mono">{coverage.declaredModel}</span> isn't in our price list —
            add your rate in Settings → Cost model for an accurate number.
          </div>
        )}
      </div>
    </div>
  )
}

function CostPortfolioContent({
  agentId, displayName, forecast, setForecast,
}: {
  agentId: string | undefined
  displayName: string
  forecast: MockSpend
  setForecast: (f: MockSpend) => void
}) {
  // Sliders are seeded once from the first forecast we receive. Updates to
  // `forecast` after that come from this component's own debounced refetches.
  const [runsPerDay, setRunsPerDay] = useState(forecast.runsPerDay ?? forecast.callsPerDay)
  const [turnsPerRun, setTurnsPerRun] = useState(forecast.turnsPerRun ?? 4)
  const [runtime, setRuntime] = useState(forecast.runtime)
  const [model, setModel] = useState(forecast.model ?? "claude-sonnet-4-6")
  const [cacheHit, setCacheHit] = useState(forecast.cacheHit)
  const [retryRate, setRetryRate] = useState(forecast.retryRate)
  const [recalculating, setRecalculating] = useState(false)
  const [timeseries, setTimeseries] = useState<SpendTimeseries | null>(null)
  const [anomaly, setAnomaly] = useState<SpendAnomaly | null>(null)
  const [costReport, setCostReport] = useState<CostReportResponse | null>(null)

  useEffect(() => {
    if (!agentId) return
    fetchSpendTimeseries(agentId).then(setTimeseries)
    fetchSpendAnomalies().then((list) => {
      setAnomaly(list.find((a) => a.agentId === agentId) ?? null)
    })
    // Worst-case exposure beside the spend forecast — the wedge in one view.
    // daily_runs aligns annualized exposure with the forecast's volume.
    apiFetch<CostReportResponse>(`/api/agents/${agentId}/cost-report?daily_runs=${forecast.runsPerDay ?? forecast.callsPerDay}`)
      .then(setCostReport)
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  // Skip the first run so we don't refetch the same values we were just given.
  const skipNextRefetchRef = useRef(true)

  useEffect(() => {
    if (!agentId) return
    if (skipNextRefetchRef.current) { skipNextRefetchRef.current = false; return }
    setRecalculating(true)
    const handle = setTimeout(() => {
      fetchSpendForecast(agentId, {
        runs_per_day: runsPerDay,
        turns_per_run: turnsPerRun,
        runtime,
        model,
        cache_hit: cacheHit,
        retry_rate: retryRate,
      }).then((f) => {
        if (f) setForecast(f)
        setRecalculating(false)
      })
    }, 250)
    return () => clearTimeout(handle)
  }, [agentId, runsPerDay, turnsPerRun, runtime, model, cacheHit, retryRate, setForecast])

  const m = forecast
  const conf = CONFIDENCE_CHIP[m.confidence] ?? CONFIDENCE_CHIP.low
  const riskCost = costReport ? pickWorstCase(costReport.items) : null
  // Budget-fit: CFO types a monthly number; we say whether it fits and, if not,
  // the honest levers to close the gap. Default to a round number near forecast.
  const budgetDefault = Math.max(1, Math.round(((m.point ?? 0) * 1.2) / 50) * 50)
  const [budget, setBudget] = useState<number>(budgetDefault)
  const [budgetFit, setBudgetFit] = useState<BudgetFit | null>(null)
  const [budgetLoading, setBudgetLoading] = useState(false)
  const [savedBudget, setSavedBudget] = useState<SavedBudget | null>(null)
  const [applyingGate, setApplyingGate] = useState(false)
  const [showMethodology, setShowMethodology] = useState(false)

  // Restore a previously-saved budget so the panel reflects the real cap.
  const loadSavedBudget = useRef<() => void>(() => {})
  loadSavedBudget.current = () => {
    if (!agentId) return
    fetchSavedBudget(agentId).then((s) => {
      setSavedBudget(s)
      if (s?.budget) setBudget(s.budget)
    })
  }
  useEffect(() => { loadSavedBudget.current() }, [agentId])

  useEffect(() => {
    if (!agentId || !budget || budget <= 0) { setBudgetFit(null); return }
    setBudgetLoading(true)
    const handle = setTimeout(() => {
      fetchBudgetFit(agentId, budget).then((f) => {
        setBudgetFit(f)
        setBudgetLoading(false)
      })
    }, 350)
    return () => clearTimeout(handle)
  }, [agentId, budget])

  const onSaveBudgetAlert = async () => {
    if (!agentId || budget <= 0) return
    const ok = await saveBudget(agentId, budget)
    toast(ok ? `Alert set — we'll ping Slack at 80% of $${budget.toLocaleString()}/mo` : "Couldn't save the alert", ok ? undefined : "error")
    if (ok) loadSavedBudget.current()
  }

  const onApplyGate = async (actionPattern: string) => {
    if (!agentId) return
    setApplyingGate(true)
    const ok = await applyGatePolicy(agentId, actionPattern)
    if (ok) {
      toast(`Approval now required on ${actionPattern}`)
      // Re-run budget-fit — the action is protected, so the gate rec drops.
      const f = await fetchBudgetFit(agentId, budget)
      setBudgetFit(f)
      apiFetch<CostReportResponse>(`/api/agents/${agentId}/cost-report?daily_runs=${m.callsPerDay}`).then(setCostReport).catch(() => {})
    } else {
      toast("Couldn't apply the rule", "error")
    }
    setApplyingGate(false)
  }

  // ── Suppressed: no real signal yet → never fabricate a number ──
  if (m.available === false || m.point == null) {
    return (
      <ForecastUnavailableView
        agentId={agentId}
        displayName={displayName}
        coverage={m.coverage}
        liveCalls7d={m.liveCalls7d}
        liveCallsNeeded={m.liveCallsNeeded}
        onDeclared={() => { if (agentId) fetchSpendForecast(agentId).then((f) => { if (f) setForecast(f) }) }}
      />
    )
  }

  return (
    <div className="min-h-screen p-8" style={{ background: "var(--bg-page)" }}>
      <div className="text-xs text-gray-400 mb-2">
        <Link to="/" className="hover:underline" style={{ color: "var(--text-link)" }}>Agents</Link> · <Link to={`/agent/${agentId}`} className="hover:underline" style={{ color: "var(--text-link)" }}>{displayName}</Link> · Cost portfolio
      </div>
      <h1 className="text-2xl font-bold tracking-tight">Cost portfolio · {displayName}</h1>
      <div className="mt-2">
        <div className="text-sm font-medium text-gray-700">Operational spend forecast</div>
        {/* observedDays is only set when live traffic actually fed the number —
            below 50 calls the confidence stays low/medium but the basis is
            still real traffic, not the capability tree (D27). */}
        <div className="text-xs text-gray-500 mt-1">Updated {relativeTime(m.capturedAt)} · derived from <span className="font-semibold text-gray-700">{m.confidence === "high" || m.observedDays != null ? "live traces" : m.confidence === "medium" ? "sandbox traces" : "capability tree"}</span></div>
      </div>

      {anomaly && <AnomalyBanner anomaly={anomaly} displayName={displayName} />}

      {m.coverage && (!m.coverage.modelRecognized || (m.coverage.toolsTotal > 0 && m.coverage.toolsPriced < m.coverage.toolsTotal)) && (
        <div
          className="mt-4 rounded-lg border px-4 py-3"
          style={{ background: "var(--severity-medium-bg)", borderColor: "var(--severity-medium-border)" }}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} style={{ color: "var(--severity-high)", marginTop: 2, flexShrink: 0 }} />
            <div>
              <div className="font-semibold text-sm mb-1">Forecast confidence is limited by what we can price</div>
              <ul className="space-y-1 text-[13px] text-gray-700 list-disc pl-4">
                {!m.coverage.modelRecognized && (
                  <li>
                    This agent runs <span className="font-medium">{m.coverage.declaredModel}</span>, which isn't in our
                    price list. The forecast is computed at <span className="font-medium">{m.coverage.pricedModel}</span>{" "}
                    rates as a placeholder and could be materially off. Add your rate in{" "}
                    <Link to="/settings" className="underline" style={{ color: "var(--text-link)" }}>Settings → Cost model</Link>,
                    or connect live traces to measure it directly.
                  </li>
                )}
                {m.coverage.toolsTotal > 0 && m.coverage.toolsPriced < m.coverage.toolsTotal && (
                  <li>
                    {m.coverage.toolsTotal - m.coverage.toolsPriced} of {m.coverage.toolsTotal} tools have no known
                    per-call price, so tool costs may be understated.
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="panel-card mt-6 mb-8 flex items-start gap-6">
        <div className="flex-1">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-600">
            <span
              className="w-7 h-7 rounded-lg inline-flex items-center justify-center"
              style={{ background: "var(--severity-safe-bg)", color: "var(--severity-safe)" }}
            >
              <Banknote size={15} />
            </span>
            Estimated monthly spend
          </div>
          <div className="mt-3 flex items-center gap-4">
            <div className="mono font-bold tracking-tight text-gray-900 leading-none" style={{ fontSize: 64 }}>
              ${m.point.toLocaleString()}
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowMethodology((v) => !v)}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium bg-gray-100 hover:bg-gray-200 transition-colors border-0 cursor-pointer text-gray-700"
              >
                <HelpCircle size={13} />
                How this is calculated
              </button>
              {showMethodology && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMethodology(false)} />
                  <div
                    className="absolute top-full mt-3 left-0 w-[420px] rounded-xl border p-5 z-50"
                    style={{ background: "var(--bg-card)", borderColor: "var(--border)", boxShadow: "var(--shadow-lg)" }}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <h4 className="text-sm font-bold text-gray-900">How this forecast is calculated</h4>
                      <button
                        type="button"
                        onClick={() => setShowMethodology(false)}
                        className="text-gray-400 hover:text-gray-600 -mt-1 -mr-1 bg-transparent border-0 cursor-pointer"
                        aria-label="Close"
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <div className="space-y-4 text-xs text-gray-700 leading-relaxed">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Method</div>
                        <p>Per-run token cost (input + output tokens × model price) plus per-run tool API cost (Stripe, SendGrid, etc.), multiplied by projected daily volume × ~30 days/month.</p>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Assumptions</div>
                        <p>Daily call volume, runtime per call, primary model, cache hit rate, retry rate. All adjustable in the "Adjust forecast assumptions" panel below.</p>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Confidence range</div>
                        <p>The <strong className="mono">${m.low.toLocaleString()}–${m.high.toLocaleString()}</strong> band reflects how much data backs this forecast ({m.confidence} confidence), not measured run-to-run variance. It narrows as sandbox runs and live traces accumulate — reaching about ±15% after ~7 days of live production usage.</p>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">How to raise confidence</div>
                        <p>Connect production traces (biggest gain), finish tool pricing for remaining services, and accumulate 30+ days of live data to anchor the baseline.</p>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="mt-3 text-sm text-gray-600">
            range <span className="text-gray-900 mono font-semibold">${m.low.toLocaleString()} – ${m.high.toLocaleString()}</span>
            <span
              className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full mx-2 cursor-help"
              title={m.observedDays != null && m.confidence !== "high"
                ? "Built from this agent's first captured production calls — real traffic, but not enough of it yet to promise a tight range. The range narrows automatically as calls accumulate; high confidence unlocks at 50 calls."
                : conf.tooltip}
              style={{ background: conf.bg, color: conf.color, border: `1px solid ${conf.border}` }}
            >{conf.label}</span>
            {m.observedDays != null && (
              <span className="text-xs text-gray-500 mr-2">
                based on {m.observedDays <= 1 ? "1 day" : `${Math.round(m.observedDays)} days`} of observed traffic
                {m.confidence !== "high" && " — early days, so the range is wide; it tightens as more calls come through"}
              </span>
            )}
            · last calibrated <strong className="text-gray-900">{formatCalibrationDate(m.lastCalibrated)}</strong>
          </div>
          {m.confidence !== "high" && (
            <div className="mt-2 text-xs text-gray-500">
              To raise confidence: connect production traces and let live data accumulate (biggest gain). Detail in <button
                type="button"
                onClick={() => {
                  document.getElementById("confidence-sources")?.scrollIntoView({ behavior: "smooth", block: "center" })
                }}
                className="underline underline-offset-2 bg-transparent border-0 p-0 cursor-pointer text-gray-700 font-medium hover:text-gray-900"
              >Confidence sources</button>.
            </div>
          )}
          {m.inputSources && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
              <span className="font-semibold text-gray-400 uppercase tracking-wider text-[9px]">Where each input came from</span>
              <span>Volume<SourceBadge source={m.inputSources.runsPerDay} /></span>
              <span>Turns/run<SourceBadge source={m.inputSources.turnsPerRun} /></span>
              <span>Tokens/call<SourceBadge source={m.inputSources.tokensPerCall} /></span>
              <span>Cache<SourceBadge source={m.inputSources.cacheHit} /></span>
              <span>Model<SourceBadge source={m.inputSources.model} /></span>
              <span>Tool mix<SourceBadge source={m.inputSources.toolMix} /></span>
            </div>
          )}
        </div>
        {riskCost?.worst && (
          <div className="text-right pl-6 border-l border-gray-100 self-center">
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Worst case if it goes wrong</div>
            <div className="text-base font-semibold mono mt-1" style={{ color: "var(--severity-critical, #dc2626)" }}>
              up to ${riskCost.worst.usd.toLocaleString()}
            </div>
            <div className="text-[10px] text-gray-400 mt-1">single incident · details below</div>
          </div>
        )}
        <div className="text-right pl-6 border-l border-gray-100 self-center">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Annual run rate</div>
          <div className="text-base font-semibold mono text-gray-700 mt-1">${m.annual.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400 mt-1">at projected volume · pre-deployment</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-8">
        <PanelCard title="Adjust forecast assumptions" icon={<Sliders size={14} />} help='Move any slider to recompute the forecast live. "Reset" snaps back to the inferred value from sandbox traces.'>
          <LiveSlider
            label="Runs / day" value={runsPerDay} displayValue={runsPerDay.toLocaleString()}
            min={1} max={10000} step={10} onChange={setRunsPerDay}
          />
          <LiveSlider
            label="Turns / run" value={turnsPerRun}
            displayValue={`${turnsPerRun} (${(runsPerDay * turnsPerRun).toLocaleString()} LLM calls/day)`}
            min={1} max={30} step={1} onChange={setTurnsPerRun}
          />
          <LiveSlider
            label="Runtime / call" value={runtime} displayValue={`${runtime.toFixed(1)} s`}
            min={0.5} max={30} step={0.1} onChange={setRuntime}
          />
          <div className="slider-row slider-row--select">
            <label className="text-sm text-gray-600">Primary model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-3 py-2 rounded-md border bg-white text-sm mono"
              style={{ borderColor: "var(--border)" }}
            >
              <option value="claude-sonnet-4-6">claude-sonnet-4-6 — $3 / $15 per Mtok</option>
              <option value="claude-haiku-4-5">claude-haiku-4-5 — $1 / $5 per Mtok</option>
              <option value="claude-opus-4-7">claude-opus-4-7 — $5 / $25 per Mtok</option>
              <option value="gpt-4o">gpt-4o — $2.50 / $10 per Mtok</option>
              <option value="gpt-4o-mini">gpt-4o-mini — $0.15 / $0.60 per Mtok</option>
              <option value="gpt-5">gpt-5 — $5 / $30 per Mtok</option>
            </select>
          </div>
          <LiveSlider
            label="Cache hit rate" value={cacheHit} displayValue={`${cacheHit}%`}
            min={0} max={95} step={1} onChange={setCacheHit}
            tone="positive"
          />
          <LiveSlider
            label="Retry rate" value={retryRate} displayValue={`${retryRate}%`}
            min={0} max={25} step={1} onChange={setRetryRate}
            tone="negative"
          />
          <div
            className={`mt-6 px-4 py-3 rounded-lg flex justify-between items-center transition-opacity ${recalculating ? "opacity-60" : ""}`}
            style={{ background: "var(--severity-safe-bg)", border: "1px solid var(--severity-safe-border)" }}
          >
            <div className="flex items-center gap-2">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: "var(--severity-safe)", boxShadow: "0 0 0 3px rgba(26, 158, 110, 0.15)" }}
              />
              <div className="text-xs text-gray-600 uppercase font-bold tracking-wider">{recalculating ? "Recalculating…" : "Updated forecast"}</div>
            </div>
            <div className="text-2xl font-semibold mono text-gray-900">${m.low.toLocaleString()} – ${m.high.toLocaleString()}</div>
          </div>
        </PanelCard>

        <PanelCard
          title="If something goes wrong — worst case in dollars"
          icon={<AlertTriangle size={14} />}
          help="From the same engine that maps this agent's risky actions. Dollar figures are worst-case single incidents from configured breach costs."
        >
          {!riskCost?.worst ? (
            <div className="text-sm text-gray-500 py-4">
              No risky actions detected for this agent — nothing it can do has a meaningful dollar downside.
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-3">
                <div className="mono font-bold tracking-tight leading-none" style={{ fontSize: 32, color: "var(--severity-critical, #dc2626)" }}>
                  up to ${riskCost.worst.usd.toLocaleString()}
                </div>
                <div className="text-xs text-gray-500">in a single incident</div>
              </div>
              <div className="mt-3 text-sm text-gray-700 leading-relaxed">{riskCost.worst.scenario}</div>
              <div className="mt-2">
                <span
                  className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                  style={riskCost.worst.enforced
                    ? { background: "var(--severity-safe-bg)", color: "var(--severity-safe)", border: "1px solid var(--severity-safe-border)" }
                    : { background: "var(--severity-critical-bg)", color: "var(--severity-critical)", border: "1px solid var(--severity-critical-border, var(--border))" }}
                >
                  {riskCost.worst.enforced ? "A rule already guards this" : "Nothing stops this today"}
                </span>
              </div>
              {riskCost.others.length > 0 && (
                <div className="mt-4 border-t border-dashed border-gray-100 pt-3 space-y-2">
                  {riskCost.others.map((o, i) => (
                    <div key={i} className="grid grid-cols-[1fr_auto] gap-3 text-xs text-gray-600 items-start">
                      <span>{o.description}</span>
                      <span className="mono font-semibold text-gray-900 whitespace-nowrap">up to ${o.maxUsd.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
              {costReport && (
                <div className="mt-4 px-4 py-3 rounded-lg text-xs text-gray-600 flex items-center justify-between gap-3"
                  style={{ background: "var(--bg-sunken)", border: "1px solid var(--border)" }}>
                  <span>
                    <strong className="text-gray-900">{costReport.total_unprotected} of {costReport.total_risky_actions}</strong> risky
                    actions have no rule stopping them yet
                    {costReport.per_incident.max_usd > 0 && (
                      <> · combined worst case <strong className="mono text-gray-900">up to ${costReport.per_incident.max_usd.toLocaleString()}</strong> per incident</>
                    )}
                  </span>
                  <Link
                    to={`/agent/${agentId}`}
                    className="font-medium whitespace-nowrap underline underline-offset-2"
                    style={{ color: "var(--text-link)" }}
                  >
                    Review guardrails
                  </Link>
                </div>
              )}
              {(costReport?.assumptions?.length ?? 0) > 0 && (
                <div className="mt-3 pt-3 border-t border-dashed border-gray-100">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">
                    How these dollars are computed
                  </div>
                  <ul className="space-y-1">
                    {costReport!.assumptions!.map((a, i) => (
                      <li key={i} className="text-[11px] text-gray-500 leading-relaxed pl-3 relative">
                        <span className="absolute left-0">·</span>{a}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </PanelCard>

        <PanelCard title="Where the money goes" icon={<PieChart size={14} />} help="Per-call cost breakdown, rolled up to a monthly total.">
          {(() => {
            const r = 55
            const c = 2 * Math.PI * r
            const tokensArc = (m.tokensPct / 100) * c
            const toolsArc = (m.toolsPct / 100) * c
            const infraArc = (m.infraPct / 100) * c
            return (
              <div className="flex items-center gap-5 mb-4">
                <svg viewBox="0 0 140 140" width="140" height="140" style={{ flexShrink: 0 }}>
                  <circle cx="70" cy="70" r={r} fill="none" stroke="var(--chart-grid)" strokeWidth="22" />
                  <circle cx="70" cy="70" r={r} fill="none" stroke="var(--chart-tokens)" strokeWidth="22"
                    strokeDasharray={`${tokensArc} ${c - tokensArc}`}
                    transform="rotate(-90 70 70)" />
                  <circle cx="70" cy="70" r={r} fill="none" stroke="var(--chart-tools)" strokeWidth="22"
                    strokeDasharray={`${toolsArc} ${c - toolsArc}`}
                    strokeDashoffset={-tokensArc}
                    transform="rotate(-90 70 70)" />
                  <circle cx="70" cy="70" r={r} fill="none" stroke="var(--chart-infra)" strokeWidth="22"
                    strokeDasharray={`${infraArc} ${c - infraArc}`}
                    strokeDashoffset={-(tokensArc + toolsArc)}
                    transform="rotate(-90 70 70)" />
                  <text x="70" y="66" textAnchor="middle" fontSize="9" fill="var(--text-muted)" fontWeight="600" letterSpacing="0.08em">MONTHLY</text>
                  <text x="70" y="84" textAnchor="middle" fontSize="17" fontWeight="700" fill="var(--text-primary)">${m.point.toLocaleString()}</text>
                </svg>
                <div className="flex-1 space-y-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-sm" style={{ background: "var(--chart-tokens)" }} />
                    LLM tokens
                    <span className="ml-auto text-gray-900 font-semibold mono">${m.tokensUsd.toLocaleString()} ({m.tokensPct}%)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-sm" style={{ background: "var(--chart-tools)" }} />
                    Tool API calls
                    <span className="ml-auto text-gray-900 font-semibold mono">${m.toolsUsd.toLocaleString()} ({m.toolsPct}%)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-sm" style={{ background: "var(--chart-infra)" }} />
                    Compute / sandbox
                    <span className="ml-auto text-gray-900 font-semibold mono">${m.infraUsd.toLocaleString()} ({m.infraPct}%)</span>
                  </div>
                </div>
              </div>
            )
          })()}
          <h3 className="text-[13px] font-semibold mt-6 mb-2">Top tool calls</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b-2 border-gray-200 text-[11px] uppercase text-gray-500 font-bold tracking-wide">
                <th className="text-left py-2 pl-2">Tool · action</th>
                <th className="text-right py-2">Calls/mo</th>
                <th className="text-right py-2">$/call</th>
                <th className="text-right py-2 pr-2">$/mo</th>
              </tr>
            </thead>
            <tbody>
              {m.topTools.map((t, i) => (
                <tr key={t.tool} className={i % 2 === 1 ? "bg-gray-50" : ""}>
                  <td className="py-2 pl-2 font-medium text-gray-900">{t.tool}</td>
                  <td className="py-2 text-right mono text-gray-700">{t.callsPerMonth.toLocaleString()}</td>
                  <td className="py-2 text-right mono text-gray-700">${t.costPer.toFixed(2)}</td>
                  <td className="py-2 pr-2 text-right mono font-semibold text-gray-900">${t.monthly}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PanelCard>

        <PanelCard title="Unit economics" icon={<BarChart3 size={14} />}>
          <p className="mb-4 text-sm text-gray-600 leading-relaxed">Cost per business outcome. These are the lines that hold up in a budget review.</p>
          {m.unitEcon.map((u, i) => (
            <div key={u.label} className={`grid grid-cols-[1fr_auto] py-2 text-sm ${i < m.unitEcon.length - 1 ? "border-b border-dashed border-gray-100" : ""}`}>
              <span className="text-gray-600">{u.label}</span>
              <span className="font-semibold mono" style={u.value == null ? { color: "var(--text-muted)" } : undefined}>
                {u.value ?? "—"}
              </span>
            </div>
          ))}
          <div className="mt-3 text-[11px] text-gray-400">
            {m.unitEcon.every((u) => u.value == null)
              ? "Not measured yet. Run a sandbox sweep so we can compute cost per outcome from this agent's own action mix — we won't show a fabricated figure."
              : "Computed from this agent's observed action mix. Calibrates further once live traces stream in."}
          </div>
        </PanelCard>

        <PanelCard title="Sensitivity — what affects cost most" icon={<Target size={14} />} help={(() => {
          const top = m.sensitivity[0]
          if (!top || top.pct <= 0) return "Each bar shows how much that input changes your forecast. Improving the top driver has the biggest accuracy payoff."
          const dollarImpact = Math.round((m.point * top.pct) / 100)
          return `Each bar shows how much that input changes your forecast. A swing in ${top.label.toLowerCase()} moves cost by ~$${dollarImpact.toLocaleString()}/mo — improving this input has the biggest accuracy payoff.`
        })()}>
          {m.sensitivity.length === 0 ? (
            <div className="text-xs text-gray-400 py-2">
              Needs data. Sensitivity is computed by re-running this agent's forecast at ±20% per input — it appears once there's a real baseline (declare volume or run a sweep).
            </div>
          ) : m.sensitivity.map((s) => {
            const tone = s.pct >= 60 ? "var(--severity-critical)"
                      : s.pct >= 30 ? "var(--severity-high)"
                      : "var(--severity-safe)"
            return (
              <div key={s.label} className="sensitivity-row">
                <label className="text-xs text-gray-600">{s.label}</label>
                <div className="h-2 bg-gray-100 rounded-sm overflow-hidden">
                  <div className="h-full" style={{ width: `${s.pct}%`, background: tone }} />
                </div>
                <span className="text-right mono font-semibold text-xs" style={{ color: tone }}>{s.pct}%</span>
              </div>
            )
          })}
        </PanelCard>

        <PanelCard title="30-day actuals + 90-day projection" icon={<TrendingUp size={14} />} help="Solid line = observed daily LLM cost from live traces. Shaded band = forward forecast range." fullWidth>
          {timeseries && timeseries.hasData ? (
            <ActualsChart data={timeseries} />
          ) : (
            <div className="rounded-lg p-8 text-center" style={{ background: "var(--bg-sunken)", border: "1px dashed var(--border)" }}>
              <TrendingUp size={28} className="mx-auto text-gray-400" />
              <div className="mt-3 text-sm font-semibold text-gray-700">Awaiting live data</div>
              <p className="mt-1 text-xs text-gray-500 max-w-md mx-auto leading-relaxed">
                The actuals-vs-forecast view populates once live LLM traces accumulate. Connect production traces via the SDK's <span className="mono">wrap_llm()</span> helper, or import from LangSmith/LangFuse, to backfill the past 30 days.
              </p>
              <Link
                to={`/settings`}
                className="inline-flex items-center gap-2 mt-4 text-xs px-3 py-2 rounded-lg border bg-white text-gray-900 font-medium hover:bg-gray-50"
                style={{ borderColor: "var(--border)" }}
              >
                <Plus size={12} /> Connect a trace source
              </Link>
            </div>
          )}
        </PanelCard>

        <PanelCard title="Fit it to a budget" icon={<Shield size={14} />} help="Enter your monthly budget. If the agent doesn't fit, we show the honest ways to close the gap — each with its trade-off. We rank options; you decide.">
          <div className="flex items-center gap-3 mb-3">
            <label className="text-sm text-gray-600 whitespace-nowrap">Monthly budget</label>
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 mono">$</span>
              <input
                type="number"
                min={1}
                className="w-full pl-7 pr-3 py-2 rounded-md border bg-white text-sm mono"
                style={{ borderColor: "var(--border)" }}
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
              />
            </div>
            <button
              onClick={onSaveBudgetAlert}
              className="text-xs px-3 py-2 rounded-md font-medium cursor-pointer whitespace-nowrap text-white"
              style={{ background: "var(--text-primary, #0f172a)" }}
            >
              {savedBudget?.budget === budget ? "Alert set ✓" : "Set a cap alert"}
            </button>
          </div>

          {/* Month-to-date actual spend vs the saved cap. */}
          {savedBudget?.budget != null && (
            <div className="text-xs text-gray-600 mb-3">
              Spent <span className="mono font-semibold text-gray-900">${savedBudget.monthToDateUsd.toLocaleString()}</span> of
              your <span className="mono">${savedBudget.budget.toLocaleString()}</span> cap this month
              {savedBudget.pctUsed != null && <> (<strong className={savedBudget.pctUsed >= (savedBudget.alertThresholdPct ?? 80) ? "" : "text-gray-900"} style={savedBudget.pctUsed >= (savedBudget.alertThresholdPct ?? 80) ? { color: "var(--severity-critical, #dc2626)" } : undefined}>{savedBudget.pctUsed}%</strong>)</>}.
              {savedBudget.alertThresholdPct != null && <span className="text-gray-400"> Slack alert at {savedBudget.alertThresholdPct}%.</span>}
            </div>
          )}

          {budgetFit && (
            <>
              {budgetFit.status === "under" ? (
                <div
                  className="flex items-center gap-2 text-sm px-3 py-2.5 rounded-lg"
                  style={{ background: "var(--severity-safe-bg)", border: "1px solid var(--severity-safe-border)", color: "var(--severity-safe)" }}
                >
                  <Check size={15} />
                  <span>
                    Fits — forecast <span className="mono font-semibold">${budgetFit.forecastPoint.toLocaleString()}</span> is
                    <strong> ${Math.abs(budgetFit.gap).toLocaleString()} under</strong> your ${budgetFit.budget.toLocaleString()} budget.
                  </span>
                </div>
              ) : (
                <>
                  <div
                    className="flex items-center gap-2 text-sm px-3 py-2.5 rounded-lg mb-3"
                    style={{ background: "var(--severity-critical-bg)", border: "1px solid var(--severity-critical-border, var(--border))", color: "var(--severity-critical, #dc2626)" }}
                  >
                    <AlertTriangle size={15} />
                    <span>
                      <strong>${budgetFit.gap.toLocaleString()} over.</strong> Forecast is <span className="mono font-semibold">${budgetFit.forecastPoint.toLocaleString()}</span> vs your ${budgetFit.budget.toLocaleString()} budget.
                    </span>
                  </div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-2">Ways to close the gap</div>
                  <div className="space-y-2">
                    {budgetFit.recommendations.map((r, i) => (
                      <div key={i} className="rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-sm font-medium text-gray-900">{r.label}</div>
                          <div className="text-right whitespace-nowrap">
                            {r.projectedSaving > 0 && (
                              <div className="text-sm font-semibold mono" style={{ color: "var(--severity-safe)" }}>
                                −${r.projectedSaving.toLocaleString()}/mo
                              </div>
                            )}
                            {r.riskReductionUsd ? (
                              <div className="text-[11px] mono" style={{ color: "var(--severity-critical, #dc2626)" }}>
                                −${r.riskReductionUsd.toLocaleString()} risk
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className="text-xs text-gray-500 mt-1.5 flex items-start gap-1.5">
                          <ArrowRight size={12} className="mt-0.5 shrink-0" />
                          {r.tradeoff}
                        </div>
                        {r.lever === "gate" && (
                          <button
                            disabled={applyingGate}
                            onClick={() => onApplyGate(r.label.replace(/^Require approval on\s+/, ""))}
                            className="mt-2 text-xs px-3 py-1.5 rounded-md border font-medium cursor-pointer disabled:opacity-50"
                            style={{ borderColor: "var(--border)", background: "var(--card)" }}
                          >
                            {applyingGate ? "Applying…" : "Apply — require approval"}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-3">
                    We rank options by impact and show the trade-off — we only auto-apply the guardrail (the rest are your call). Spikes above your usual rate already alert via Slack (Settings).
                  </div>
                </>
              )}
            </>
          )}
          {!budgetFit && budgetLoading && (
            <div className="text-xs text-gray-400 py-2">Checking the budget…</div>
          )}
        </PanelCard>

        <div id="confidence-sources">
        <PanelCard title="Confidence sources" icon={<Search size={14} />} help="What data informs this forecast. Add a source to raise confidence.">
          {(m.dataSources ?? []).map((c) => (
            <div key={c.label} className="conf-row text-xs">
              <span>
                <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ background: STATUS_TONE[c.statusTone as SourceStatus] }} />
                {c.label}
              </span>
              <span className="text-[11px] font-semibold mono" style={{ color: STATUS_TONE[c.statusTone as SourceStatus] }}>{c.status}</span>
            </div>
          ))}
          <Link
            to="/settings"
            className="text-xs px-3 py-2 rounded-lg border bg-white text-gray-900 font-medium hover:bg-gray-50 mt-2 inline-flex items-center gap-2"
            style={{ borderColor: "var(--border)", textDecoration: "none", width: "fit-content" }}
          >
            <Plus size={12} /> Connect production traces
          </Link>
        </PanelCard>
        </div>

        <div
          className="col-span-2 rounded-xl p-6 flex items-center justify-between"
          style={{ background: "var(--bg-sunken)", border: "1px dashed var(--border)" }}
        >
          <div>
            <div className="text-sm font-semibold">Share this with finance</div>
            <div className="text-xs text-gray-500 mt-1">CFO PDF = narrative + chart · CSV = raw numbers for their BI tool</div>
          </div>
          <div className="flex gap-2">
            <button
              className="text-sm px-4 py-2 rounded-lg border bg-white text-gray-900 font-medium cursor-pointer"
              style={{ borderColor: "var(--border)" }}
              onClick={() => downloadForecastCsv(displayName, m, timeseries, costReport)}
            >
              Export to CSV
            </button>
            {/* Excel + Save-as-scenario intentionally not shown — they were
                no-ops; pending Akash's decision on scope (see brain handoff).
                CSV + CFO PDF below are the two working exports. */}
            {agentId && (
              <ExportCFOReportButton
                agentId={agentId}
                displayName={displayName}
                forecast={m}
                className="text-sm px-4 py-2 rounded-lg bg-gray-900 text-white font-medium inline-flex items-center gap-2 no-underline cursor-pointer"
                label={<><FileText size={14} /> Export CFO PDF</>}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
