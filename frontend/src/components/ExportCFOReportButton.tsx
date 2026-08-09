/**
 * Export CFO Report — button that fetches the cost-report on mount, then
 * renders a download link for the CFO PDF.
 *
 * Self-contained on purpose: callers pass agentId + displayName + the
 * spend forecast they already have, and this component handles the
 * second fetch + PDF wiring.
 */

import { useEffect, useState, lazy, Suspense, type ReactNode } from "react"
import { FileDown } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { buildCFOReportData, type CostReportResponse } from "@/lib/cfoReport"
import type { MockSpend } from "@/lib/mockSpend"

// @react-pdf/renderer (~1MB) loads only when a user opens an export.
const CFODownloadLink = lazy(() => import("@/components/CFODownloadLink"))

interface Props {
  agentId: string
  displayName: string
  forecast: MockSpend
  orgName?: string
  /** Override the default pill style — pass the same className the host
   * surface uses for its primary button so the download blends in. */
  className?: string
  /** Override the label (icon + text). Defaults to "Export CFO report". */
  label?: ReactNode
  /** Optional inline style override. Avoid unless className isn't enough. */
  style?: React.CSSProperties
}

function slugForFile(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent"
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function ExportCFOReportButton({
  agentId,
  displayName,
  forecast,
  orgName = "your organization",
  className,
  label,
  style,
}: Props) {
  const [costReport, setCostReport] = useState<CostReportResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiFetch<CostReportResponse>(`/api/agents/${agentId}/cost-report`)
      .then(r => { if (!cancelled) setCostReport(r) })
      .catch(() => { /* cost-report missing is acceptable — it only names the riskiest
                        unguarded action for recommendation #1; the PDF renders without it */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [agentId])

  // Tool keys come from the top-tools list in the forecast (best signal we
  // already have client-side without a third backend round-trip).
  const toolKeys = Array.from(new Set(
    (forecast.topTools ?? [])
      .map(t => (t.tool || "").split(".")[0])
      .filter(Boolean),
  ))

  const data = buildCFOReportData({
    orgName,
    agentDisplayName: displayName,
    toolKeys,
    forecast,
    costReport,
  })

  const fileName = `${slugForFile(displayName)}-cfo-report-${todayIso()}.pdf`

  const defaultClass = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border-0 cursor-pointer transition-colors text-white hover:opacity-90 no-underline"
  const defaultStyle: React.CSSProperties = { background: "var(--text-primary, #0f172a)", textDecoration: "none" }
  const resolvedClass = className ?? defaultClass
  const resolvedStyle: React.CSSProperties = className ? (style ?? {}) : { ...defaultStyle, ...(style ?? {}) }
  const resolvedLabel = label ?? (<><FileDown size={13} /> Export CFO report</>)

  const preparing = (
    <button type="button" disabled className={resolvedClass} style={{ ...resolvedStyle, opacity: 0.6, cursor: "wait" }}>
      {label ? label : (<><FileDown size={13} /> Preparing CFO report…</>)}
    </button>
  )

  if (loading) return preparing

  return (
    <Suspense fallback={preparing}>
      <CFODownloadLink data={data} fileName={fileName} className={resolvedClass} style={resolvedStyle} label={resolvedLabel} />
    </Suspense>
  )
}
