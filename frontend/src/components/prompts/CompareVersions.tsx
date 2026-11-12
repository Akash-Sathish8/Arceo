/**
 * Private A/B: run 2-3 versions of a prompt on the same inputs and model, and
 * see output, cost and danger side by side. Nothing is published. "Use this
 * version" copies the winner into the editor (saved with the normal Save).
 */

import { useState } from "react"
import { Play, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { toast } from "@/components/shared/Toast"
import DangerBadge from "@/components/prompts/DangerBadge"
import { CARD, EYEBROW, FIELD, Label } from "@/components/prompts/ui"
import { compareVersions, fixPrompt, formatMonthly, formatRunCost, modelName, monthlyCost, type CompareResult, type Prompt } from "@/lib/promptsApi"

const MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6", "gpt-5-mini", "gpt-4o-mini"]

export default function CompareVersions({ prompt, onAdopt, onClose }: {
  prompt: Prompt
  onAdopt: (body: string) => void
  onClose: () => void
}) {
  const [variants, setVariants] = useState([
    { label: "Current", body: prompt.body },
    { label: "Version B", body: "" },
  ])
  const [model, setModel] = useState(prompt.model && MODELS.includes(prompt.model) ? prompt.model : "claude-haiku-4-5")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CompareResult | null>(null)

  async function prefillFixed(i: number) {
    try {
      const f = await fixPrompt({ body: prompt.body, variables: prompt.variables ?? {}, tools: prompt.tools ?? [] })
      setVariants((v) => v.map((x, j) => (j === i ? { ...x, body: f.body, label: "Safer" } : x)))
    } catch (e) { toast((e as Error).message, "error") }
  }

  async function run() {
    if (variants.some((v) => !v.body.trim())) { toast("Fill in every version first.", "error"); return }
    setBusy(true)
    try { setResult(await compareVersions(prompt.id, variants, model)) }
    catch (e) { toast((e as Error).message, "error") }
    finally { setBusy(false) }
  }

  return (
    <div style={CARD}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ ...EYEBROW, flex: 1 }}>Compare versions</div>
        <button type="button" aria-label="Close compare" onClick={onClose} style={{ border: 0, background: "none", cursor: "pointer", color: "var(--ink-400)" }}><X size={16} /></button>
      </div>
      <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 6 }}>
        Try two or three wordings on the same examples and the same AI, and see the answers side by side. Only you see this. Uses one free test.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 12 }}>
        {variants.map((v, i) => (
          <div key={i}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
              <input aria-label="Version name" style={{ ...FIELD, fontWeight: 600 }} value={v.label}
                onChange={(e) => setVariants((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
              {i >= 2 && <button type="button" aria-label="Remove version" onClick={() => setVariants((x) => x.filter((_, j) => j !== i))}
                style={{ border: 0, background: "none", cursor: "pointer", color: "var(--ink-400)" }}><X size={14} /></button>}
            </div>
            <textarea aria-label={`${v.label} text`} rows={7} style={{ ...FIELD, resize: "vertical" }} value={v.body}
              placeholder="Paste or write another way of asking"
              onChange={(e) => setVariants((x) => x.map((y, j) => (j === i ? { ...y, body: e.target.value } : y)))} />
            {i > 0 && !v.body && (
              <button type="button" onClick={() => void prefillFixed(i)}
                style={{ border: 0, background: "none", padding: 0, marginTop: 4, color: "var(--accent)", fontSize: "var(--fs-small)", cursor: "pointer" }}>
                Start from the safer version
              </button>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginTop: 12 }}>
        {variants.length < 3 && (
          <Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={() => setVariants((v) => [...v, { label: "Version C", body: "" }])}>Add a version</Button>
        )}
        <div style={{ flex: 1 }} />
        <div>
          <Label htmlFor="cmp-model">AI model</Label>
          <select id="cmp-model" style={{ ...FIELD, width: 180 }} value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => <option key={m} value={m}>{modelName(m)}</option>)}
          </select>
        </div>
        <Button icon={<Play size={13} />} loading={busy} onClick={() => void run()}>Compare</Button>
      </div>

      {result && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(220px, 1fr))`, gap: 10, marginTop: 16 }}>
          {result.variants.map((v) => {
            const m = monthlyCost(v.cost.usd_per_run, result.runs_per_day)
            return (
              <div key={v.label} style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-md)", padding: 12, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{v.label}</div>
                <DangerBadge danger={v.danger} size={34} />
                <div style={{ fontFamily: "var(--font-num)", fontWeight: 600 }}>
                  {m != null ? formatMonthly(m) : `${formatRunCost(v.cost.usd_per_run)} each time`}
                  <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", fontWeight: 400 }}> · from real answers</span>
                </div>
                {v.outputs.map((o, k) => (
                  <details key={k} open={k === 0}>
                    <summary style={{ cursor: "pointer", fontSize: "var(--fs-micro)", color: "var(--ink-500)" }}>{result.cases[k]?.label ?? `example ${k + 1}`}</summary>
                    <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-sans)", fontSize: "var(--fs-small)", color: "var(--ink-800)", margin: "6px 0 0", maxHeight: 220, overflow: "auto" }}>{o}</pre>
                  </details>
                ))}
                <div style={{ marginTop: "auto" }}>
                  <Button variant="secondary" size="sm" onClick={() => { onAdopt(v.body); toast(`Copied "${v.label}" into the editor. Save to keep it.`) }}>Use this version</Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
