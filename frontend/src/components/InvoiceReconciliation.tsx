/**
 * Invoice reconciliation — "Arceo tracked $X, your invoice says $Y."
 *
 * The accuracy story made checkable: import what the provider actually billed
 * (usage-export CSV or just the invoice total) and compare it to the LLM spend
 * Arceo captured over the same window. Org-level per provider — an invoice
 * covers an API key, never one agent.
 *
 * Honesty rules mirrored from the backend: demo imports are labeled, captured
 * calls are priced at today's rates (said out loud), and a gap gets concrete
 * likely causes instead of a shrug.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { CheckCircle2, AlertTriangle, FileText, Trash2, Upload } from "lucide-react"
import {
  deleteInvoice, fetchReconciliation, importInvoice, type Reconciliation,
} from "@/lib/spendApi"

const VERDICT_COPY: Record<string, { label: string; blurb: string; tone: "safe" | "medium" | "high" }> = {
  reconciled: {
    label: "Reconciles with your bill",
    blurb: "Arceo's tracked spend matches the provider's bill within 5%, so the numbers on this page are the numbers you pay.",
    tone: "safe",
  },
  partial: {
    label: "Mostly reconciles",
    blurb: "Tracked spend is within 20% of the bill. The gap usually has a boring explanation. Here are the likely causes.",
    tone: "medium",
  },
  large_gap: {
    label: "Large gap vs your bill",
    blurb: "Tracked spend differs from the bill by more than 20%. Worth understanding before you trust either number. Here are the likely causes.",
    tone: "high",
  },
  no_invoice_total: {
    label: "No invoice total",
    blurb: "The import carried no usable total, so there's nothing to reconcile against.",
    tone: "medium",
  },
}

function toneVars(tone: "safe" | "medium" | "high") {
  return {
    bg: `var(--severity-${tone}-bg, var(--bg-sunken))`,
    border: `var(--severity-${tone}-border, var(--border))`,
    fg: `var(--severity-${tone})`,
  }
}

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google (Gemini)" },
]

export default function InvoiceReconciliationPanel() {
  const [recon, setRecon] = useState<Reconciliation | null>(null)
  const [loading, setLoading] = useState(true)
  const [showImport, setShowImport] = useState(false)
  const [mode, setMode] = useState<"csv" | "manual">("csv")
  const [provider, setProvider] = useState("anthropic")
  const [manualTotal, setManualTotal] = useState("")
  const [periodStart, setPeriodStart] = useState("")
  const [periodEnd, setPeriodEnd] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    fetchReconciliation().then((r) => { setRecon(r); setLoading(false) })
  }, [])
  useEffect(load, [load])

  async function submit(body: Parameters<typeof importInvoice>[0]) {
    setBusy(true); setError(null)
    try {
      setRecon(await importInvoice(body))
      setShowImport(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed")
    } finally {
      setBusy(false)
    }
  }

  function onFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => submit({
      provider, source: "csv", filename: file.name,
      csv_text: String(reader.result ?? ""),
      period_start: periodStart || undefined, period_end: periodEnd || undefined,
    })
    reader.readAsText(file)
  }

  function onManual() {
    const total = Number(manualTotal)
    if (!total || total <= 0) { setError("Enter the invoice total in dollars."); return }
    submit({
      provider, source: "manual", total_usd: total,
      period_start: periodStart || undefined, period_end: periodEnd || undefined,
    })
  }

  const verdict = recon ? VERDICT_COPY[recon.verdict] ?? VERDICT_COPY.no_invoice_total : null
  const tone = verdict ? toneVars(verdict.tone) : null

  return (
    <div className="panel-card mb-6" style={{ padding: 20 }}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[13px] font-semibold flex items-center gap-2">
            <FileText size={14} /> Does Arceo match your bill?
            {recon?.isDemo && (
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full cursor-help"
                title="This comparison uses a sample bill we seeded for the demo. Import your real provider export to reconcile against it."
                style={{ background: "var(--severity-medium-bg)", color: "var(--severity-high)", border: "1px solid var(--severity-medium-border)" }}
              >Sample import</span>
            )}
          </h3>
          <p className="text-[11px] text-gray-400 mt-1">
            Import your provider's bill and we compare it to what Arceo tracked.
          </p>
        </div>
        <button
          onClick={() => { setShowImport(!showImport); setError(null) }}
          className="text-xs px-3 py-2 rounded-md border bg-white font-medium cursor-pointer whitespace-nowrap"
          style={{ borderColor: "var(--border)" }}
        >
          {showImport ? "Cancel" : recon ? "Import another bill" : "Import a bill"}
        </button>
      </div>

      {showImport && (
        <div className="mt-4 rounded-lg p-4" style={{ background: "var(--bg-sunken)", border: "1px solid var(--border)" }}>
          <div className="flex items-center gap-3 mb-3">
            <select
              value={provider} onChange={(e) => setProvider(e.target.value)}
              className="text-xs px-2 py-2 rounded-md border bg-white"
              style={{ borderColor: "var(--border)" }}
            >
              {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            <div className="flex rounded-md overflow-hidden border" style={{ borderColor: "var(--border)" }}>
              {(["csv", "manual"] as const).map((m) => (
                <button
                  key={m} onClick={() => setMode(m)}
                  className={`text-xs px-3 py-2 cursor-pointer ${mode === m ? "bg-white font-semibold" : "text-gray-500"}`}
                >{m === "csv" ? "Upload usage export (CSV)" : "Type the invoice total"}</button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3 mb-3 text-xs text-gray-600">
            <label>Period</label>
            <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)}
                   className="px-2 py-1.5 rounded-md border bg-white" style={{ borderColor: "var(--border)" }} />
            <span>→</span>
            <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)}
                   className="px-2 py-1.5 rounded-md border bg-white" style={{ borderColor: "var(--border)" }} />
            <span className="text-gray-400">optional. A CSV's own dates win, and without any we compare the last 30 days</span>
          </div>
          {mode === "csv" ? (
            <div className="flex items-center gap-3">
              <input
                ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = "" }}
              />
              <button
                onClick={() => fileRef.current?.click()} disabled={busy}
                className="inline-flex items-center gap-2 text-xs px-3 py-2 rounded-md font-medium cursor-pointer text-white"
                style={{ background: "var(--text-primary, #0f172a)" }}
              ><Upload size={12} /> {busy ? "Importing…" : "Choose the export file"}</button>
              <span className="text-[11px] text-gray-400">
                Any provider usage or billing CSV works. We find the cost, date, and model columns for you.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 mono text-xs">$</span>
                <input
                  type="number" min={0.01} step="0.01" placeholder="1234.56" value={manualTotal}
                  onChange={(e) => setManualTotal(e.target.value)}
                  className="pl-6 pr-3 py-2 rounded-md border bg-white text-xs mono w-36"
                  style={{ borderColor: "var(--border)" }}
                />
              </div>
              <button
                onClick={onManual} disabled={busy}
                className="text-xs px-3 py-2 rounded-md font-medium cursor-pointer text-white"
                style={{ background: "var(--text-primary, #0f172a)" }}
              >{busy ? "Importing…" : "Compare"}</button>
              <span className="text-[11px] text-gray-400">The number on the provider's invoice for this period.</span>
            </div>
          )}
          {error && <div className="mt-2 text-xs" style={{ color: "var(--severity-high)" }}>{error}</div>}
        </div>
      )}

      {loading ? (
        <div className="mt-4 text-xs text-gray-400">Loading…</div>
      ) : !recon ? (
        <div className="mt-4 rounded-lg p-6 text-center" style={{ background: "var(--bg-sunken)", border: "1px dashed var(--border)" }}>
          <div className="text-sm font-semibold text-gray-700">No bill imported yet</div>
          <p className="mt-1 text-xs text-gray-500 max-w-lg mx-auto leading-relaxed">
            Import a bill to see "Arceo tracked $X, your invoice says $Y."
          </p>
        </div>
      ) : verdict && tone && (
        <div className="mt-4">
          <div className="rounded-lg border px-4 py-3 mb-4" style={{ background: tone.bg, borderColor: tone.border }}>
            <div className="flex items-start gap-2">
              {verdict.tone === "safe"
                ? <CheckCircle2 size={15} style={{ color: tone.fg, marginTop: 2, flexShrink: 0 }} />
                : <AlertTriangle size={15} style={{ color: tone.fg, marginTop: 2, flexShrink: 0 }} />}
              <div>
                <div className="font-semibold text-sm">{verdict.label}</div>
                <p className="text-[12px] text-gray-700 mt-0.5">{verdict.blurb}</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-3">
            <div>
              <div className="text-[11px] text-gray-400 uppercase tracking-wide">Arceo tracked</div>
              <div className="text-xl font-bold mono">${recon.trackedUsd.toLocaleString()}</div>
              <div className="text-[11px] text-gray-400">{recon.trackedCalls.toLocaleString()} captured calls</div>
            </div>
            <div>
              <div className="text-[11px] text-gray-400 uppercase tracking-wide">
                Your {recon.provider} bill{recon.periodStart ? ` · ${recon.periodStart} → ${recon.periodEnd}` : ""}
              </div>
              <div className="text-xl font-bold mono">${recon.invoiceUsd.toLocaleString()}</div>
              <div className="text-[11px] text-gray-400">
                {recon.source === "manual" ? "typed total" : recon.source === "demo" ? "sample export" : "usage export"}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-gray-400 uppercase tracking-wide">Difference</div>
              <div className="text-xl font-bold mono" style={{ color: verdict.tone === "safe" ? "var(--severity-safe)" : tone.fg }}>
                {recon.deltaUsd >= 0 ? "+" : "−"}${Math.abs(recon.deltaUsd).toLocaleString()}
                {recon.deltaPct != null && <span className="text-sm font-semibold"> ({Math.abs(recon.deltaPct)}%)</span>}
              </div>
              {recon.coveragePct != null && (
                <div className="text-[11px] text-gray-400">Arceo saw {recon.coveragePct}% of the bill</div>
              )}
            </div>
          </div>

          {recon.coveragePct != null && (
            <div className="h-2 rounded overflow-hidden mb-3" style={{ background: "var(--bg-sunken)" }}>
              <div className="h-full rounded" style={{ width: `${recon.coveragePct}%`, background: "var(--severity-safe)" }} />
            </div>
          )}

          {recon.causes.length > 0 && (
            <div className="mb-3">
              <div className="text-[11px] font-semibold text-gray-600 mb-1">Likely causes of the gap</div>
              <ul className="space-y-1 text-[12px] text-gray-700 list-disc pl-4">
                {recon.causes.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-between text-[11px] text-gray-400">
            <span>
              Captured calls are priced at today's rates, so if the provider repriced mid-period that shows up as part of the difference.
              {recon.windowAssumed30d && " No period on the import, so this compares against the last 30 days."}
            </span>
            <button
              onClick={async () => { if (await deleteInvoice(recon.invoiceId)) { setRecon(null); load() } }}
              className="inline-flex items-center gap-1 cursor-pointer hover:text-gray-600"
              title="Remove this import"
            ><Trash2 size={11} /> Remove</button>
          </div>
        </div>
      )}
    </div>
  )
}
