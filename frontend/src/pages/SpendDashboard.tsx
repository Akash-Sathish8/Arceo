/**
 * AI Spend Dashboard — fleet-wide rollup over the user's REAL connected agents.
 *
 * Fetches /api/authority/agents and /api/agents/spend-forecasts (batch) so
 * totals = sum of per-agent card values from the real backend forecaster.
 *
 * Spec: brain/Live/Forecast UI sketch.md, methodology in
 * brain/Signals/Cost calculation methodology.md
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import {
  FileText, Banknote, X, Download,
  Headset, Terminal, BarChart2, Settings2, Bot,
  Calendar, TrendingUp, ShieldCheck, Search, ChevronRight, ListTree,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { lazy, Suspense } from "react"
import { apiFetch } from "@/lib/api"
import ErrorState from "@/components/shared/ErrorState"
import { agentIcon, scoreBand, timeAgo } from "@/lib/utils"
import type { MockSpend } from "@/lib/mockSpend"
import { fetchBatchSpendForecasts } from "@/lib/spendApi"
import InvoiceReconciliationPanel from "@/components/InvoiceReconciliation"
import { pluralize } from "@/lib/strings"
import { formatMoney } from "@/lib/format"
import SpendTrendCard from "@/components/agents/SpendTrendCard"
import { currentOrgName } from "@/lib/orgName"
import { type FleetReportData } from "@/components/FleetCFOReport"

// @react-pdf/renderer (~1MB) loads only when a user opens the fleet export.
const FleetCFODownloadLink = lazy(() => import("@/components/FleetCFODownloadLink"))

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function triggerDownload(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

interface AgentSummary {
  id: string
  name: string
  agent_type?: string
  blast_radius?: { score: number }
}

// agentIcon() returns a Lucide component name; map it to the actual icon.
const AGENT_ICONS: Record<string, LucideIcon> = {
  Headset, Terminal, BarChart2, Settings2, Bot,
}

function AgentGlyph({ agentType, size = 14 }: { agentType: string; size?: number }) {
  const Icon = AGENT_ICONS[agentIcon(agentType)] ?? Bot
  return <Icon size={size} />
}

function riskTone(score: number): string {
  // Shared 4-band scale (lib/utils.ts scoreBand) mapped onto severity tokens.
  switch (scoreBand(score).key) {
    case "critical": return "var(--severity-critical)"
    case "high":     return "var(--severity-high)"
    case "medium":   return "var(--severity-medium)"
    default:         return "var(--severity-safe)"
  }
}

function deltaTone(delta: number): string {
  if (delta > 0) return "var(--severity-high)"
  if (delta < 0) return "var(--severity-safe)"
  return "var(--text-muted)"
}

function StatCard({ label, value, delta, deltaTone: tone = "var(--text-muted)" }: { label: string; value: string; delta?: string; deltaTone?: string }) {
  return (
    <div className="panel-card" style={{ padding: 16 }}>
      <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1 tracking-tight mono">{value}</div>
      {delta && <div className="text-[11px] mt-1" style={{ color: tone }}>{delta}</div>}
    </div>
  )
}

function AnchorStat({ label, value, delta, deltaTone: tone = "var(--text-muted)" }: { label: string; value: string; delta?: string; deltaTone?: string }) {
  return (
    <div className="panel-card flex flex-col justify-center" style={{ padding: 28 }}>
      <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">{label}</div>
      <div className="font-bold tabular-nums mt-2 tracking-tight text-gray-900 leading-none" style={{ fontSize: 48 }}>{value}</div>
      {delta && <div className="text-sm mt-2" style={{ color: tone }}>{delta}</div>}
    </div>
  )
}

export default function SpendDashboard() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [forecasts, setForecasts] = useState<Record<string, MockSpend | null>>({})
  const [loading, setLoading] = useState(true)
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showMethodology, setShowMethodology] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    // agents is the primary load; forecasts are secondary and may degrade.
    apiFetch<{ agents: AgentSummary[] }>("/api/authority/agents")
      .then(async (agentData) => {
        setAgents(agentData.agents ?? [])
        setForecasts(await fetchBatchSpendForecasts())
        setLoadedAt(new Date().toISOString())
      })
      // Don't fake "No agents connected yet." on an outage.
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const fleet = useMemo(() => {
    return agents.map((a) => {
      const m = forecasts[a.id] ?? null
      const score = a.blast_radius?.score ?? 0
      return {
        id: a.id,
        name: a.name,
        agentType: a.agent_type ?? "",
        risk: score,
        riskTone: riskTone(score),
        forecast: m,
      }
    })
  }, [agents, forecasts])

  // A forecast counts toward the fleet only when it's backed by real signal.
  // An `available:false` object (no declared volume / sweep / live traces) is
  // NOT calibrated — it lands in the "needs data" bucket, never summed as 0.
  const isUsable = (m: MockSpend | null): m is MockSpend =>
    m !== null && m.available !== false && m.point != null
  const withForecast = fleet.filter((r) => isUsable(r.forecast))
  const noForecast = fleet.filter((r) => !isUsable(r.forecast))
  const totalSpend = withForecast.reduce((s, r) => s + (r.forecast?.point ?? 0), 0)
  // vs-last-month is only meaningful for agents that actually have a ~30-day-old
  // snapshot. Until any do, hide the comparison rather than show an ambiguous 0%.
  const comparable = withForecast.filter((r) => r.forecast?.vsLastMonthAvailable)
  const comparableSpend = comparable.reduce((s, r) => s + (r.forecast?.point ?? 0), 0)
  const hasComparison = comparable.length > 0
  const weightedDelta = comparableSpend > 0
    ? Math.round(comparable.reduce((s, r) => s + (r.forecast?.vsLastMonth ?? 0) * (r.forecast?.point ?? 0), 0) / comparableSpend)
    : 0
  const annualRunRate = totalSpend * 12

  // Composition rolls up the same per-category dollars the per-agent forecast
  // returns (tokensUsd, toolsUsd, infraUsd). No estimation — it's a sum.
  const llmTotal   = withForecast.reduce((s, r) => s + (r.forecast?.tokensUsd ?? 0), 0)
  const toolTotal  = withForecast.reduce((s, r) => s + (r.forecast?.toolsUsd ?? 0), 0)
  const infraTotal = withForecast.reduce((s, r) => s + (r.forecast?.infraUsd ?? 0), 0)
  const compositionTotal = llmTotal + toolTotal + infraTotal

  const pctOf = (n: number) => compositionTotal > 0 ? Math.round((n / compositionTotal) * 100) : 0
  const composition = [
    { label: "AI model usage", amount: llmTotal,   pct: pctOf(llmTotal),   color: "var(--chart-tokens)" },
    { label: "Software fees",  amount: toolTotal,  pct: pctOf(toolTotal),  color: "var(--chart-tools)"  },
    { label: "Infrastructure", amount: infraTotal, pct: pctOf(infraTotal), color: "var(--text-secondary)" },
  ]

  // By model — split each agent's LLM-token spend across the models it ACTUALLY
  // ran, using the observed cost shares from its captured calls. An agent
  // declares one model but a real one may route across several; attributing its
  // whole spend to the declared model overstated that model and hid the others,
  // and this figure also feeds the fleet CFO PDF. Agents with nothing captured
  // fall back to their declared model, and an agent reporting no model at all
  // lands in "Unspecified" so we never silently double-count.
  const MODEL_COLORS: Record<string, string> = {
    "claude-opus-4-8":   "var(--severity-critical)",
    "claude-sonnet-4-6": "var(--chart-tokens)",
    "claude-haiku-4-5":  "var(--chart-tools)",
    "gpt-4o":            "var(--severity-safe)",
    "gpt-4o-mini":       "var(--severity-high)",
    "gpt-5":             "var(--severity-medium)",
  }
  const byModelMap = new Map<string, number>()
  for (const r of withForecast) {
    const spend = r.forecast?.tokensUsd ?? 0
    const observed = r.forecast?.coverage?.observedModels ?? []
    if (observed.length > 0) {
      for (const om of observed) {
        byModelMap.set(om.model, (byModelMap.get(om.model) ?? 0) + spend * om.costShare)
      }
    } else {
      const key = r.forecast?.model ?? "Unspecified"
      byModelMap.set(key, (byModelMap.get(key) ?? 0) + spend)
    }
  }
  const byModel = Array.from(byModelMap.entries())
    .map(([name, amount]) => ({
      name,
      amount,
      pctOfLlm: llmTotal > 0 ? Math.round((amount / llmTotal) * 100) : 0,
      color: MODEL_COLORS[name] ?? "var(--text-muted)",
    }))
    .sort((a, b) => b.amount - a.amount)

  const sortedFleet = [...withForecast].sort(
    (a, b) => (b.forecast?.point ?? 0) - (a.forecast?.point ?? 0),
  )

  const forecastCount = withForecast.length
  const forecastSource = `Rolled up from ${forecastCount} ${pluralize(forecastCount, "agent")} with live forecasts.`

  const handleExportCsv = () => {
    const header = ["Agent", "Risk score", "Monthly est (USD)", "% of fleet", "vs last month", "Annual est (USD)"]
    const rows = sortedFleet.map((a) => {
      const monthly = a.forecast?.point ?? 0
      const share = totalSpend > 0 ? Math.round((monthly / totalSpend) * 100) : 0
      const vs = a.forecast?.vsLastMonthAvailable ? `${a.forecast?.vsLastMonth ?? 0}%` : "n/a"
      return [a.name, a.risk, Math.round(monthly), `${share}%`, vs, Math.round(monthly * 12)]
    })
    const totalRow = ["Total", "", Math.round(totalSpend), "100%", "", Math.round(annualRunRate)]
    const csv = [header, ...rows, totalRow].map((r) => r.map(csvCell).join(",")).join("\n")
    triggerDownload(`arceo-fleet-spend-${todayIso()}.csv`, csv, "text/csv;charset=utf-8;")
  }

  // Aggregate each agent's REAL forecast band instead of a hardcoded ±28%.
  // The band is asymmetric per tier (low [0.5,3.0], med [0.7,2.0], high ±15%),
  // so a fleet of mostly-low-confidence agents is far wider than ±28% — show
  // the true −X% / +Y% derived from the summed low/high.
  const fleetLow = Math.round(withForecast.reduce((s, r) => s + (r.forecast?.low ?? r.forecast?.point ?? 0), 0))
  const fleetHigh = Math.round(withForecast.reduce((s, r) => s + (r.forecast?.high ?? r.forecast?.point ?? 0), 0))
  const fleetBandLabel = totalSpend > 0
    ? `−${Math.max(0, Math.round((1 - fleetLow / totalSpend) * 100))}% / +${Math.max(0, Math.round((fleetHigh / totalSpend - 1) * 100))}%`
    : "n/a"

  // Per-agent confidence tier counts for the PDF's band sentence — it used to
  // assert "medium-confidence" regardless of the actual mix.
  const tierMix = withForecast.reduce(
    (acc, r) => {
      const tier = r.forecast?.confidence
      if (tier === "high" || tier === "medium" || tier === "low") acc[tier] += 1
      return acc
    },
    { high: 0, medium: 0, low: 0 },
  )

  const fleetReportData: FleetReportData = {
    org: currentOrgName(),
    tierMix,
    dateString: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    agentCount: withForecast.length,
    uncalibrated: noForecast.length,
    totalMonthly: totalSpend,
    monthlyLow: fleetLow,
    monthlyHigh: fleetHigh,
    annualRunRate,
    confidenceBand: fleetBandLabel,
    composition: composition.map((c) => ({ label: c.label, usd: c.amount, pct: c.pct })),
    byModel: byModel.map((m) => ({ name: m.name, amount: m.amount, pctOfLlm: m.pctOfLlm })),
    agents: sortedFleet.map((a) => ({
      name: a.name,
      risk: a.risk,
      monthly: a.forecast?.point ?? 0,
      annual: (a.forecast?.point ?? 0) * 12,
    })),
  }

  // Fleet-wide tool spend: every agent's priced tool calls, merged by
  // tool.action and attributed to the agent that runs it.
  const topToolActions = (() => {
    const rows: { key: string; tool: string; agent: string; calls: number; costPer: number; monthly: number }[] = []
    for (const r of withForecast) {
      for (const t of r.forecast?.topTools ?? []) {
        rows.push({
          key: `${r.id}:${t.tool}`,
          tool: t.tool,
          agent: r.name,
          calls: t.callsPerMonth,
          costPer: t.costPer,
          monthly: t.monthly,
        })
      }
    }
    return rows.sort((a, b) => b.monthly - a.monthly)
  })()
  const shownToolActions = topToolActions.slice(0, 6)

  const confidenceLabel = withForecast.length === 0
    ? "Not enough data"
    : withForecast.every((r) => r.forecast?.confidence === "high")
      ? "High confidence"
      : withForecast.some((r) => r.forecast?.confidence === "high")
        ? "Mixed confidence"
        : "Building confidence"

  return (
    <div className="px-container-padding py-stack-gap w-full flex flex-col gap-stack-gap">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-page-title text-page-title text-neutral-primary m-0">Organization Spend Overview</h1>
          <p className="font-meta text-meta text-neutral-secondary m-0 mt-1">
            Consolidated financial telemetry for all deployed autonomous systems.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 bg-neutral-sunken px-3 py-2 rounded-lg border border-neutral-border">
            <Calendar size={18} className="text-neutral-secondary" />
            <span className="font-monospace-label text-monospace-label text-neutral-primary">Current forecast</span>
          </span>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-2 bg-surface-container-lowest border border-neutral-border text-neutral-secondary px-4 py-2 rounded-lg font-body text-body font-medium hover:text-on-surface hover:bg-neutral-sunken transition-colors cursor-pointer"
          >
            <ListTree size={18} />
            View agent forecasts
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="flex items-center gap-2 bg-primary text-on-primary px-4 py-2 rounded-lg font-body text-body font-medium hover:opacity-90 transition-opacity shadow-sm border-0 cursor-pointer"
          >
            <Download size={18} />
            Export Report
          </button>
        </div>
      </div>

      {loadError && agents.length === 0 ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((k) => <div key={k} className="skeleton" style={{ height: 132 }} />)}
        </div>
      ) : agents.length === 0 ? (
        <div className="bg-white p-10 rounded-xl border border-neutral-border text-center">
          <p className="font-body text-body text-neutral-secondary m-0">
            No agents connected yet. <Link to="/" style={{ color: "var(--text-link)" }}>Connect one</Link> to start forecasting.
          </p>
        </div>
      ) : (
      <>
      {/* ── Hero metrics ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total fleet spend" Icon={Banknote}>
          <div className="font-monospace-data text-display text-neutral-primary">
            {formatMoney(totalSpend)}<span className="text-neutral-secondary text-body font-normal"> /mo</span>
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            {hasComparison ? (
              <>
                <span
                  className="text-xs font-monospace-label px-2 py-0.5 rounded font-semibold"
                  style={
                    weightedDelta >= 0
                      ? { background: "var(--caution-bg)", color: "var(--amber-ink)" }
                      : { background: "var(--aqua-soft)", color: "var(--aqua-deep)" }
                  }
                >
                  {weightedDelta >= 0 ? "+" : ""}{weightedDelta}%
                </span>
                <span className="font-meta text-meta text-neutral-secondary">vs last month</span>
              </>
            ) : (
              <span className="font-meta text-meta text-neutral-secondary">No prior month to compare yet</span>
            )}
          </div>
        </KpiCard>

        <KpiCard label="Projected annual run rate" Icon={TrendingUp}>
          <div className="font-monospace-data text-display text-neutral-primary">{formatMoney(annualRunRate)}</div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="font-monospace-label text-xs" style={{ color: "var(--aqua-deep)" }}>
              At the current monthly forecast
            </span>
          </div>
        </KpiCard>

        <KpiCard label="Active agents" Icon={Bot}>
          <div className="font-monospace-data text-display text-neutral-primary">
            {withForecast.length} <span className="text-neutral-secondary text-body font-normal">
              {pluralize(withForecast.length, "agent")}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="font-meta text-meta text-neutral-secondary">
              {noForecast.length > 0 ? `${noForecast.length} more need sandbox runs` : "All agents forecast"}
            </span>
          </div>
        </KpiCard>

        <KpiCard label="Forecast confidence" Icon={ShieldCheck} iconColor="var(--aqua-deep)">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-card-title text-card-title text-neutral-primary">{confidenceLabel}</div>
              <div className="font-meta text-meta text-neutral-secondary mt-1">Band {fleetBandLabel}</div>
            </div>
            <span
              className="font-monospace-label px-3 py-1 rounded-full text-xs font-semibold"
              style={{ background: "var(--aqua-soft)", color: "var(--aqua-deep)", border: "1px solid var(--aqua-line)" }}
            >
              {withForecast.length}/{agents.length}
            </span>
          </div>
        </KpiCard>
      </div>

      {/* ── Fleet spend trend ── */}
      <div className="bg-white p-6 rounded-xl border border-neutral-border shadow-sm flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase">Historical trajectory</span>
            <h2 className="font-card-title text-card-title text-neutral-primary m-0">Fleet spend trend</h2>
          </div>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-sm" style={{ background: "var(--accent)" }} />
              <span className="font-meta text-meta text-neutral-secondary">Actual spend</span>
            </span>
          </div>
        </div>
        <SpendTrendCard compact />
      </div>

      {/* ── Allocation + model split ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BreakdownCard
          eyebrow="Allocation"
          title="Spend by agent"
          total={formatMoney(totalSpend) + " /mo"}
          rows={sortedFleet.slice(0, 5).map((r, i) => ({
            label: r.name,
            amount: r.forecast?.point ?? 0,
            pct: totalSpend > 0 ? Math.round(((r.forecast?.point ?? 0) / totalSpend) * 100) : 0,
            color: AGENT_BAR_COLORS[i % AGENT_BAR_COLORS.length],
          }))}
          footNote={`${withForecast.length} ${pluralize(withForecast.length, "agent")} forecast`}
          linkLabel="View fleet"
          linkTo="/"
        />
        <BreakdownCard
          eyebrow="Model breakdown"
          title="Spend by AI model"
          total={`${byModel.length} ${byModel.length === 1 ? "endpoint" : "endpoints"}`}
          rows={byModel.slice(0, 5).map((m) => ({
            label: m.name,
            amount: m.amount,
            pct: m.pctOfLlm,
            color: m.color,
          }))}
          footNote="Token-weighted across captured calls"
          linkLabel="Token metrics"
          linkTo="/history"
        />
      </div>

      {/* ── Fleet-wide tool actions ── */}
      <div className="bg-white rounded-xl border border-neutral-border shadow-sm overflow-hidden">
        <div className="p-6 border-b border-neutral-border flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase">Granular telemetry</span>
            <h2 className="font-card-title text-card-title text-neutral-primary m-0">Top costly tool actions across fleet</h2>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-meta text-meta text-neutral-secondary">Sort by:</span>
            <span
              className="font-monospace-label px-3 py-1 rounded"
              style={{ color: "var(--accent)", background: "var(--accent-soft)", border: "1px solid var(--accent-line)" }}
            >
              Total spend (desc)
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-neutral-sunken font-eyebrow text-eyebrow text-neutral-secondary uppercase border-b border-neutral-border">
                <th className="py-3 px-6">Tool &amp; action</th>
                <th className="py-3 px-6">Agent</th>
                <th className="py-3 px-6 text-right">Calls / mo</th>
                <th className="py-3 px-6 text-right">$ / call</th>
                <th className="py-3 px-6 text-right">Total $ / mo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-border font-body text-body">
              {shownToolActions.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 px-6 text-center text-neutral-muted">
                    No priced tool calls captured yet.
                  </td>
                </tr>
              )}
              {shownToolActions.map((t) => (
                <tr key={t.key} className="hover:bg-neutral-sunken transition-colors">
                  <td className="py-4 px-6">
                    <span className="font-monospace-data text-neutral-primary font-medium flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "var(--accent)" }} />
                      {t.tool}
                    </span>
                  </td>
                  <td className="py-4 px-6 text-neutral-secondary">{t.agent}</td>
                  <td className="py-4 px-6 text-right font-monospace-data text-neutral-primary">{t.calls.toLocaleString()}</td>
                  <td className="py-4 px-6 text-right font-monospace-data text-neutral-secondary">${t.costPer.toFixed(3)}</td>
                  <td className="py-4 px-6 text-right font-monospace-data font-semibold" style={{ color: "var(--accent)" }}>
                    ${t.monthly.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="p-4 px-6 border-t border-neutral-border bg-neutral-sunken flex items-center justify-between font-meta text-meta text-neutral-secondary">
          <span>
            Showing {shownToolActions.length} of {topToolActions.length} priced tool {pluralize(topToolActions.length, "integration")}
          </span>
          <Suspense fallback={<span>Preparing export…</span>}>
            <FleetCFODownloadLink data={fleetReportData} fileName={`arceo-fleet-cfo-report-${todayIso()}.pdf`} />
          </Suspense>
        </div>
      </div>
      </>
      )}

      {/* Rendered outside the loaded/empty branch so the picker is reachable
          even while a forecast batch is still coming back. */}
      <AgentForecastPicker open={pickerOpen} rows={fleet} onClose={() => setPickerOpen(false)} />
    </div>
  )
}

/** Bar colours for the per-agent split — the single-hue chart ramp, so an
 *  agent's bar never borrows the severity or risk-label scales. */
const AGENT_BAR_COLORS = ["var(--chart-tokens)", "var(--chart-tools)", "var(--chart-infra)", "var(--aqua-ink)", "var(--ink-400)"]

/** One hero metric card: eyebrow + icon, then the figure block. */
function KpiCard({
  label, Icon, iconColor, children,
}: {
  label: string
  Icon: typeof Banknote
  iconColor?: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-white p-6 rounded-xl border border-neutral-border shadow-sm flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase">{label}</span>
        <Icon size={20} style={{ color: iconColor ?? "var(--accent)" }} />
      </div>
      <div className="my-4">{children}</div>
    </div>
  )
}

/** A labelled share breakdown with a bar per row. */
function BreakdownCard({
  eyebrow, title, total, rows, footNote, linkLabel, linkTo,
}: {
  eyebrow: string
  title: string
  total: string
  rows: { label: string; amount: number; pct: number; color: string }[]
  footNote: string
  linkLabel: string
  linkTo: string
}) {
  return (
    <div className="bg-white p-6 rounded-xl border border-neutral-border shadow-sm flex flex-col justify-between">
      <div>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase">{eyebrow}</span>
            <h2 className="font-card-title text-card-title text-neutral-primary m-0">{title}</h2>
          </div>
          <span className="font-monospace-data text-neutral-primary whitespace-nowrap">{total}</span>
        </div>
        <div className="flex flex-col gap-4 mt-6">
          {rows.length === 0 && (
            <p className="font-meta text-meta text-neutral-muted m-0">Nothing measured yet.</p>
          )}
          {rows.map((r) => (
            <div key={r.label}>
              <div className="flex justify-between gap-3 mb-1.5 font-body text-body">
                <span className="font-medium text-neutral-primary flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: r.color }} />
                  <span className="truncate">{r.label}</span>
                </span>
                <span className="font-monospace-data text-neutral-primary whitespace-nowrap">
                  {r.pct}% <span className="text-neutral-secondary">({formatMoney(r.amount)})</span>
                </span>
              </div>
              <div className="w-full bg-neutral-sunken h-2 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${r.pct}%`, background: r.color }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between mt-6 pt-4 border-t border-neutral-border font-meta text-meta text-neutral-secondary">
        <span>{footNote}</span>
        <Link to={linkTo} style={{ color: "var(--text-link)" }} className="no-underline">
          {linkLabel} →
        </Link>
      </div>
    </div>
  )
}

// ── Agent forecast picker ─────────────────────────────────────────────────────

interface FleetRow {
  id: string
  name: string
  agentType: string
  risk: number
  riskTone: string
  forecast: MockSpend | null
}

/**
 * Centred picker for jumping from the fleet rollup to one agent's own forecast.
 *
 * Same shell as the Configure Simulation dialog — scrim, header band, footer
 * band — so every modal in the product opens the same way. Rows are links, not
 * click handlers, so a forecast can be opened in a new tab.
 */
function AgentForecastPicker({
  open,
  rows,
  onClose,
}: {
  open: boolean
  rows: FleetRow[]
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery("")
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => { window.clearTimeout(t); window.removeEventListener("keydown", onKey) }
  }, [open, onClose])

  if (!open) return null

  const q = query.trim().toLowerCase()
  const visible = q
    ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.agentType.toLowerCase().includes(q))
    : rows

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto"
      style={{ background: "rgba(30, 40, 54, 0.5)", backdropFilter: "blur(2px)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-forecast-picker-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-surface-container-lowest border border-neutral-border rounded-lg flex flex-col my-auto outline-none"
        style={{ maxHeight: "calc(100vh - 2rem)", boxShadow: "0 4px 24px rgba(30, 40, 54, 0.08), 0 1px 2px rgba(15,15,15,0.03)" }}
      >
        {/* Header */}
        <div className="px-8 pt-8 pb-6 border-b border-neutral-border shrink-0">
          <h2
            id="agent-forecast-picker-title"
            className="text-page-title font-page-title text-on-surface mb-2 tracking-tight m-0"
          >
            Agent forecasts
          </h2>
          <p className="text-body font-body text-neutral-secondary leading-relaxed m-0">
            Open one agent&rsquo;s forecast — its drivers, confidence tier and sensitivity — instead of the fleet rollup.
          </p>
          <div className="relative mt-5">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-secondary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents…"
              aria-label="Search agents"
              className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-neutral-border bg-surface-container-lowest text-body font-body text-on-surface outline-none focus:border-primary"
            />
          </div>
        </div>

        {/* Body */}
        <div className="px-8 py-5 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="text-body font-body text-neutral-secondary m-0 py-6 text-center">
              No agents match “{query}”.
            </p>
          ) : (
            <div className="flex flex-col">
              {visible.map((r) => {
                const f = r.forecast
                const usable = f !== null && f.available !== false && f.point != null
                return (
                  <Link
                    key={r.id}
                    to={`/agent/${r.id}/spend`}
                    onClick={onClose}
                    className="flex items-center gap-4 py-3 px-3 -mx-3 rounded-lg no-underline hover:bg-neutral-sunken transition-colors"
                  >
                    <span
                      aria-hidden
                      className="shrink-0 rounded-full"
                      style={{ width: 8, height: 8, background: r.riskTone }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-body font-body font-medium text-on-surface truncate">
                        {r.name}
                      </span>
                      <span className="block font-monospace-label text-monospace-label text-neutral-secondary truncate">
                        {r.agentType || "agent"} · risk {Math.round(r.risk)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      {usable ? (
                        <>
                          <span className="block font-monospace-data text-monospace-data text-on-surface">
                            {formatMoney(f!.point!)}
                          </span>
                          <span className="block font-monospace-label text-monospace-label text-neutral-secondary">
                            per month
                          </span>
                        </>
                      ) : (
                        // Never render an uncalibrated forecast as $0 — the
                        // fleet rollup makes the same distinction.
                        <span className="block font-monospace-label text-monospace-label text-neutral-secondary">
                          Needs data
                        </span>
                      )}
                    </span>
                    <ChevronRight size={16} className="shrink-0 text-neutral-secondary" />
                  </Link>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-8 py-5 border-t border-neutral-border bg-neutral-sunken flex items-center justify-between gap-3 rounded-b-lg shrink-0">
          <span className="font-monospace-label text-monospace-label text-neutral-secondary">
            {visible.length} of {rows.length} {rows.length === 1 ? "agent" : "agents"}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="bg-surface-container-lowest border border-neutral-border text-neutral-secondary font-body text-body font-medium px-5 py-2.5 rounded hover:text-on-surface transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
