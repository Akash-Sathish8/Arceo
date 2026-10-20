/**
 * QA for one prompt: test cases + checks, run on real models, then canary
 * attacks through every pasted-in variable. A run turns the cost from
 * "declared" into "measured" and the danger score from "static only" into
 * "red-teamed". Spend is capped server-side and shown after each run.
 */

import { useEffect, useMemo, useState } from "react"
import { CheckCircle2, Play, Plus, X, XCircle } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { toast } from "@/components/shared/Toast"
import { CARD, EYEBROW, FIELD, Label } from "@/components/prompts/ui"
import {
  formatRunCost, getQaHistory, runQa, saveQaSuite,
  type Prompt, type QaCheck, type QaHistoryRun, type QaSuite,
} from "@/lib/promptsApi"

const QA_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6", "gpt-5-mini", "gpt-4o-mini"]

const CHECK_TYPES: { value: QaCheck["type"]; label: string; needsValue: boolean; placeholder?: string }[] = [
  { value: "contains", label: "Contains", needsValue: true, placeholder: "text" },
  { value: "not_contains", label: "Doesn't contain", needsValue: true, placeholder: "text" },
  { value: "max_words", label: "At most N words", needsValue: true, placeholder: "100" },
  { value: "regex", label: "Matches regex", needsValue: true, placeholder: "^- " },
  { value: "json", label: "Is valid JSON", needsValue: false },
  { value: "judge", label: "AI judge rubric", needsValue: true, placeholder: "Exactly three bullets, no greeting" },
]

const PROBE_LABEL: Record<string, string> = {
  injection: "Injected instructions",
  leak: "Leak a confidential code",
  hijack: "Hijack output into phishing",
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

export default function QaPanel({ prompt, onUpdated }: { prompt: Prompt; onUpdated: () => void }) {
  const names = useMemo(() => {
    const seen: string[] = []
    for (const m of prompt.body.matchAll(VAR_RE)) if (!seen.includes(m[1])) seen.push(m[1])
    return seen
  }, [prompt.body])

  const [suite, setSuite] = useState<QaSuite>(() => ({
    cases: [], checks: [], models: ["claude-haiku-4-5"], probes: true, ...(prompt.tests ?? {}),
  }))
  const [running, setRunning] = useState(false)
  const [last, setLast] = useState<{ at: string; runs: QaHistoryRun[] } | null>(null)
  const [lastSpend, setLastSpend] = useState<number | null>(null)

  useEffect(() => {
    getQaHistory(prompt.id).then((h) => setLast(h.runs[0] ?? null)).catch(() => {})
  }, [prompt.id])

  const patch = (p: Partial<QaSuite>) => setSuite((s) => ({ ...s, ...p }))

  async function run() {
    setRunning(true)
    try {
      await saveQaSuite(prompt.id, suite)
      const r = await runQa(prompt.id)
      setLastSpend(r.usd_total)
      const h = await getQaHistory(prompt.id)
      setLast(h.runs[0] ?? null)
      toast(`QA done · ${r.reliability == null ? "no test cases" : `${Math.round(r.reliability * 100)}% passed`}`)
      onUpdated()
    } catch (e) {
      toast((e as Error).message, "error")
    } finally {
      setRunning(false)
    }
  }

  const tests = last?.runs.filter((r) => r.kind === "test") ?? []
  const probes = last?.runs.filter((r) => r.kind === "probe") ?? []
  const passRate = tests.length ? tests.filter((r) => r.passed).length / tests.length : null

  return (
    <div style={CARD}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={EYEBROW}>QA and red team</div>
        <Button size="sm" icon={<Play size={13} />} loading={running} onClick={() => void run()}>Run QA</Button>
      </div>
      <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 6, lineHeight: 1.5 }}>
        Runs each test case on the models you pick and measures the real cost, then tries three attacks through
        every pasted-in variable. Runs on Arceo's key and is capped per run.
      </p>

      {/* Test cases */}
      <div style={{ marginTop: 14 }}>
        <Label>Test cases {suite.cases.length === 0 && <span style={{ textTransform: "none", fontWeight: 400 }}>(none: uses your variable samples)</span>}</Label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {suite.cases.map((c, i) => (
            <div key={i} style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-md)", padding: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input aria-label="Case label" style={{ ...FIELD, maxWidth: 200 }} value={c.label}
                  onChange={(e) => patch({ cases: suite.cases.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} />
                <div style={{ flex: 1 }} />
                <button type="button" aria-label="Remove case" onClick={() => patch({ cases: suite.cases.filter((_, j) => j !== i) })}
                  style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--ink-400)" }}><X size={14} /></button>
              </div>
              {names.map((n) => (
                <textarea key={n} aria-label={`${c.label}: ${n}`} rows={2} placeholder={`{{${n}}}`}
                  value={c.values[n] ?? ""}
                  onChange={(e) => patch({ cases: suite.cases.map((x, j) => j === i ? { ...x, values: { ...x.values, [n]: e.target.value } } : x) })}
                  style={{ ...FIELD, marginTop: 8, resize: "vertical" }} />
              ))}
            </div>
          ))}
          {suite.cases.length < 5 && (
            <Button variant="ghost" size="sm" icon={<Plus size={13} />}
              onClick={() => patch({ cases: [...suite.cases, { label: `case ${suite.cases.length + 1}`, values: {} }] })}>
              Add test case
            </Button>
          )}
        </div>
      </div>

      {/* Checks */}
      <div style={{ marginTop: 14 }}>
        <Label>Pass if the output…</Label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {suite.checks.map((c, i) => {
            const meta = CHECK_TYPES.find((t) => t.value === c.type)!
            return (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <select aria-label="Check type" style={{ ...FIELD, width: 170 }} value={c.type}
                  onChange={(e) => patch({ checks: suite.checks.map((x, j) => j === i ? { type: e.target.value as QaCheck["type"] } : x) })}>
                  {CHECK_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                {meta.needsValue && (
                  <input aria-label="Check value" style={{ ...FIELD, flex: "1 1 160px", width: "auto" }} placeholder={meta.placeholder}
                    value={c.value ?? ""}
                    onChange={(e) => patch({ checks: suite.checks.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })} />
                )}
                <button type="button" aria-label="Remove check" onClick={() => patch({ checks: suite.checks.filter((_, j) => j !== i) })}
                  style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--ink-400)" }}><X size={14} /></button>
              </div>
            )
          })}
          <Button variant="ghost" size="sm" icon={<Plus size={13} />}
            onClick={() => patch({ checks: [...suite.checks, { type: "contains", value: "" }] })}>Add check</Button>
        </div>
      </div>

      {/* Models + probes */}
      <div style={{ marginTop: 14, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <Label>Models (up to 3)</Label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {QA_MODELS.map((m) => {
              const on = suite.models.includes(m)
              return (
                <label key={m} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: "var(--fs-small)", color: "var(--ink-700)" }}>
                  <input type="checkbox" checked={on} disabled={!on && suite.models.length >= 3}
                    onChange={() => patch({ models: on ? suite.models.filter((x) => x !== m) : [...suite.models, m] })} />
                  {m}
                </label>
              )
            })}
          </div>
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "var(--fs-small)", color: "var(--ink-700)", marginTop: 20 }}>
          <input type="checkbox" checked={suite.probes} onChange={(e) => patch({ probes: e.target.checked })} />
          Red-team probes
        </label>
      </div>

      {/* Last run */}
      {last && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "baseline" }}>
            <div>
              <div style={EYEBROW}>Reliability</div>
              <div style={{ fontFamily: "var(--font-num)", fontSize: "var(--fs-title)", fontWeight: 600 }}>
                {passRate == null ? "n/a" : `${Math.round(passRate * 100)}%`}
              </div>
            </div>
            <div>
              <div style={EYEBROW}>Attacks that worked</div>
              <div style={{ fontFamily: "var(--font-num)", fontSize: "var(--fs-title)", fontWeight: 600,
                color: probes.some((p) => p.passed === false) ? "var(--critical)" : "var(--ink-900)" }}>
                {probes.length ? `${probes.filter((p) => p.passed === false).length} of ${probes.length}` : "n/a"}
              </div>
            </div>
            {lastSpend != null && (
              <div>
                <div style={EYEBROW}>This run cost</div>
                <div style={{ fontFamily: "var(--font-num)", fontSize: "var(--fs-title)", fontWeight: 600 }}>{formatRunCost(lastSpend)}</div>
              </div>
            )}
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "flex", flexDirection: "column", gap: 6 }}>
            {[...tests, ...probes].map((r, i) => (
              <li key={i}>
                <details>
                  <summary style={{ cursor: "pointer", fontSize: "var(--fs-small)", color: "var(--ink-800)", display: "flex", gap: 6, alignItems: "center" }}>
                    {r.passed ? <CheckCircle2 size={14} color="var(--safe)" /> : <XCircle size={14} color="var(--critical)" />}
                    <span>{r.kind === "probe" ? `${PROBE_LABEL[r.probe_type ?? ""] ?? r.probe_type} via {{${r.input_label}}}` : r.input_label}</span>
                    <span style={{ color: "var(--ink-400)" }}>· {r.model}{r.output_tokens != null ? ` · ${r.output_tokens} out` : ""}</span>
                  </summary>
                  <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-code)", fontSize: 12, background: "var(--paper-2)",
                    padding: 10, borderRadius: "var(--radius-md)", marginTop: 6, color: "var(--ink-700)", maxHeight: 240, overflow: "auto" }}>
                    {r.error ? `Error: ${r.error}` : r.output}
                  </pre>
                  {r.checks && r.checks.length > 0 && (
                    <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", marginTop: 4 }}>
                      {r.checks.map((c) => `${c.passed ? "✓" : "✗"} ${c.type}${c.value ? ` "${c.value}"` : ""}${c.note ? ` (${c.note})` : ""}`).join(" · ")}
                    </div>
                  )}
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
