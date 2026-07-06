/**
 * AI Spend Dashboard — fleet-wide rollup over the user's REAL connected agents.
 *
 * Fetches /api/authority/agents and /api/agents/spend-forecasts (batch) so
 * totals = sum of per-agent card values from the real backend forecaster.
 *
 * Spec: brain/Live/Forecast UI sketch.md, methodology in
 * brain/Signals/Cost calculation methodology.md
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import {
  FileText, Banknote, X, Download,
  Headset, Terminal, BarChart2, Settings2, Bot,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { lazy, Suspense } from "react"
import { apiFetch } from "@/lib/api"
import ErrorState from "@/components/shared/ErrorState"
import { agentIcon, scoreBand, timeAgo } from "@/lib/utils"
import type { MockSpend } from "@/lib/mockSpend"
import { fetchBatchSpendForecasts } from "@/lib/spendApi"
import { pluralize } from "@/lib/strings"
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
      <div className="text-2xl font-bold tabular-nums mt-1 tracking-tight">{value}</div>
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

  // By model — group by each agent's primary model, sum its LLM-token spend.
  // An agent that only reports a `point` total without a model lands in
  // "Unspecified" so we don't silently double-count.
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
    const key = r.forecast?.model ?? "Unspecified"
    byModelMap.set(key, (byModelMap.get(key) ?? 0) + (r.forecast?.tokensUsd ?? 0))
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

  const fleetReportData: FleetReportData = {
    org: "your organization",
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

  return (
    <div className="min-h-screen p-8" style={{ background: "var(--bg-page)" }}>
      <h1 className="text-2xl font-bold tracking-tight">AI Spend</h1>
      <p className="text-sm text-gray-600 mt-1">
        {loading
          ? "Loading fleet…"
          : loadError
            ? "Couldn't load the fleet."
            : agents.length === 0
            ? "No agents connected yet."
            : `Fleet-wide forecast across ${withForecast.length} ${pluralize(withForecast.length, "agent")}${noForecast.length > 0 ? ` · ${noForecast.length} more need sandbox runs` : ""}`}
      </p>
      {!loading && agents.length > 0 && (
        <div className="flex items-center gap-3 text-xs text-gray-500 mt-2 relative">
          {loadedAt && <span>Updated {timeAgo(loadedAt)}</span>}
          {loadedAt && <span className="text-gray-300">·</span>}
          <button
            type="button"
            onClick={() => setShowMethodology((v) => !v)}
            className="font-medium bg-transparent border-0 p-0 cursor-pointer hover:underline"
            style={{ color: "var(--text-link)" }}
          >
            How this is calculated
          </button>
          {showMethodology && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowMethodology(false)} />
              <div
                className="absolute top-full mt-3 left-0 w-[460px] rounded-xl border p-5 z-50 text-left"
                style={{ background: "var(--bg-card)", borderColor: "var(--border)", boxShadow: "var(--shadow-lg)" }}
              >
                <div className="flex items-start justify-between mb-3">
                  <h4 className="text-sm font-bold text-gray-900">How this fleet forecast is calculated</h4>
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
                    <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Per-agent forecast</div>
                    <p>Each agent's monthly cost = (input + output tokens × model price) + tool API charges + compute. Volume comes from sandbox runs and live trace ingest, multiplied by ~30 days/month.</p>
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Fleet rollup</div>
                    <p>Per-category dollars (LLM tokens / Tool APIs / Compute) are summed across every agent with a live forecast — no estimation. The By-model panel groups those agents by their primary model.</p>
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Confidence band</div>
                    <p>The ±28% band is a medium-confidence estimate applied across the fleet, not measured run-to-run variance, and it does not yet aggregate each agent's individual confidence. Connect production traces and accumulate 30+ days of live data to tighten it.</p>
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Agents not forecasted</div>
                    <p>An agent shows up under "need sandbox runs" until at least one simulation has executed against it. The fleet total doesn't extrapolate over those agents — it reports only what's calibrated.</p>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {!loading && loadError && (
        <div className="mt-6"><ErrorState message={loadError} onRetry={load} /></div>
      )}

      {!loading && !loadError && agents.length === 0 && (
        <div className="panel-card mt-6 text-center" style={{ padding: 40 }}>
          <Banknote className="mx-auto mb-3 text-gray-400" size={32} />
          <div className="text-gray-900 font-semibold">No connected agents to forecast yet</div>
          <p className="text-sm text-gray-500 mt-2 max-w-md mx-auto">
            Upload an agent file or connect an MCP server, then run a simulation to generate a spend forecast.
          </p>
          <Link to="/" className="inline-block mt-4 text-sm px-4 py-2 rounded-lg bg-gray-900 text-white font-medium">
            Connect your first agent
          </Link>
        </div>
      )}

      {!loading && agents.length > 0 && (
        <>
          <div className="grid grid-cols-3 gap-4 mt-6 mb-6">
            <div className="col-span-2">
              <AnchorStat
                label="This month (est.)"
                value={`$${totalSpend.toLocaleString()}`}
                delta={hasComparison
                  ? `${weightedDelta > 0 ? "↑ +" : weightedDelta < 0 ? "↓ " : "— "}${weightedDelta !== 0 ? Math.abs(weightedDelta) + "% vs last month" : "flat vs last month"}`
                  : "baseline building"}
                deltaTone={hasComparison ? deltaTone(weightedDelta) : undefined}
              />
            </div>
            <div className="flex flex-col gap-3">
              <StatCard
                label="Annual run rate"
                value={`$${annualRunRate.toLocaleString()}`}
                delta={annualRunRate > 0 ? `~${withForecast.length} ${pluralize(withForecast.length, "agent")} active` : undefined}
              />
              <StatCard
                label="Confidence band"
                value={withForecast.length > 0 ? "±28%" : "—"}
                delta={withForecast.length > 0 ? `$${Math.round(totalSpend * 0.72).toLocaleString()} – $${Math.round(totalSpend * 1.28).toLocaleString()}` : "needs more data"}
              />
              <StatCard
                label="Agents forecasted"
                value={`${withForecast.length} of ${fleet.length}`}
                delta={noForecast.length > 0 ? `${noForecast.length} need sandbox runs` : "all calibrated"}
                deltaTone={noForecast.length > 0 ? "var(--color-cta)" : "var(--severity-safe)"}
              />
            </div>
          </div>

          {compositionTotal > 0 && (
            <div className="grid grid-cols-2 gap-6 mb-6">
              <div className="panel-card" style={{ padding: 20 }}>
                <h3 className="text-[13px] font-semibold">Composition (this month)</h3>
                <p className="text-[11px] text-gray-400 mt-1 mb-4">Where the company's AI dollars are going.</p>
                <div className="flex h-4 rounded overflow-hidden mb-3">
                  {composition.map((c) => <div key={c.label} style={{ width: `${c.pct}%`, background: c.color }} />)}
                </div>
                <div className="space-y-2 text-xs">
                  {composition.map((c) => (
                    <div key={c.label} className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-sm" style={{ background: c.color }} />
                      {c.label}
                      <span className="ml-auto text-gray-900 font-semibold tabular-nums">${c.amount.toLocaleString()} ({c.pct}%)</span>
                    </div>
                  ))}
                </div>
                <div className="text-[11px] text-gray-400 mt-4">{forecastSource}</div>
              </div>

              {byModel.length > 0 && (
                <div className="panel-card" style={{ padding: 20 }}>
                  <h3 className="text-[13px] font-semibold">By model</h3>
                  <p className="text-[11px] text-gray-400 mt-1 mb-4">Which models are driving LLM spend.</p>
                  <div className="space-y-2 text-xs">
                    {byModel.map((mod) => (
                      <div key={mod.name} className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-sm" style={{ background: mod.color }} />
                        {mod.name}
                        <span className="ml-auto text-gray-900 font-semibold tabular-nums">${mod.amount.toLocaleString()} ({mod.pctOfLlm}% of LLM)</span>
                      </div>
                    ))}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-4">{forecastSource}</div>
                </div>
              )}
            </div>
          )}

          {sortedFleet.length > 0 && (
            <div className="panel-card overflow-hidden" style={{ padding: 0 }}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-[11px] uppercase tracking-wider text-gray-400 font-bold">
                    <th className="text-left px-4 py-3">Agent</th>
                    <th className="text-left px-4 py-3">Risk</th>
                    <th className="text-right px-4 py-3">Est. spend / mo</th>
                    <th className="text-right px-4 py-3">% of fleet</th>
                    <th className="text-right px-4 py-3">vs last month</th>
                    <th className="text-right px-4 py-3">Annual</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedFleet.map((a) => {
                    const monthly = a.forecast?.point ?? 0
                    const share = totalSpend > 0 ? Math.round((monthly / totalSpend) * 100) : 0
                    const vsLast = a.forecast?.vsLastMonth ?? 0
                    const delta = !a.forecast?.vsLastMonthAvailable
                      ? "—"
                      : vsLast > 0 ? `↑ +${vsLast}%` : vsLast < 0 ? `↓ ${vsLast}%` : "flat"
                    return (
                      <tr key={a.id} className="border-b border-gray-100 last:border-b-0">
                        <td className="px-4 py-4">
                          <Link to={`/agent/${a.id}/spend`} className="flex items-center gap-2 text-gray-900 hover:underline">
                            <div className="w-6 h-6 rounded bg-gray-100 inline-flex items-center justify-center text-gray-600">
                              <AgentGlyph agentType={a.agentType} />
                            </div>
                            {a.name}
                          </Link>
                        </td>
                        <td className="px-4 py-4 tabular-nums">
                          <span className="inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle" style={{ background: a.riskTone }} />
                          {a.risk}
                        </td>
                        <td className="px-4 py-4 text-right tabular-nums font-medium">${monthly.toLocaleString()}</td>
                        <td className="px-4 py-4 text-right tabular-nums">
                          <span className="inline-block h-1.5 rounded-sm align-middle mr-2" style={{ background: "var(--color-cta)", width: `${share * 2}px` }} />
                          {share}%
                        </td>
                        <td
                          className="px-4 py-4 text-right tabular-nums"
                          style={{ color: a.forecast?.vsLastMonthAvailable ? deltaTone(vsLast) : "var(--text-muted)" }}
                          title={a.forecast?.vsLastMonthAvailable ? undefined : "Comparison appears after ~30 days of history"}
                        >{delta}</td>
                        <td className="px-4 py-4 text-right tabular-nums">${(monthly * 12).toLocaleString()}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {noForecast.length > 0 && (
            <div className="mt-4 bg-white border border-dashed border-gray-200 rounded-xl p-4">
              <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">
                {noForecast.length} {pluralize(noForecast.length, "agent")} {pluralize(noForecast.length, "needs", "need")} a simulation
              </div>
              <div className="flex flex-wrap gap-2">
                {noForecast.map((a) => (
                  <Link
                    key={a.id}
                    to={`/sandbox?agent=${a.id}`}
                    className="text-xs px-2 py-1 rounded-md bg-gray-50 border border-gray-200 text-gray-700 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-700 transition-colors inline-flex items-center gap-2"
                  >
                    <AgentGlyph agentType={a.agentType} size={12} />
                    {a.name}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {sortedFleet.length > 0 && (
            <div className="flex gap-2 mt-4 justify-end">
              <button
                type="button"
                onClick={handleExportCsv}
                className="text-sm px-4 py-2 rounded-lg border bg-white text-gray-900 font-medium inline-flex items-center gap-2"
                style={{ borderColor: "var(--border)" }}
              >
                <Download size={14} /> Export CSV
              </button>
              <Suspense fallback={
                <span className="text-sm px-4 py-2 rounded-lg bg-gray-900 text-white font-medium inline-flex items-center gap-2 opacity-60">
                  <FileText size={14} /> Preparing export…
                </span>
              }>
                <FleetCFODownloadLink data={fleetReportData} fileName={`arceo-fleet-cfo-report-${todayIso()}.pdf`} />
              </Suspense>
            </div>
          )}
        </>
      )}
    </div>
  )
}
