/**
 * Workflow builder: pick prompts in order, wire each {{variable}} to a workflow
 * input or an earlier step's output, and watch the combined cost each time
 * update, with plain warnings when a step needs one. Sequential only in v1.
 */

import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ArrowDown, Play, Plus, Trash2, X } from "lucide-react"
import PageHeader from "@/components/shared/PageHeader"
import ErrorState from "@/components/shared/ErrorState"
import { toast } from "@/components/shared/Toast"
import { Button } from "@/components/ui/Button"
import Warnings from "@/components/prompts/Warnings"
import { CARD, EYEBROW, FIELD, Label, PAGE_PAD, SegControl, TD, TH } from "@/components/prompts/ui"
import {
  BASIS_LABEL, blankName, createWorkflow, deleteWorkflow, formatRunCost, getPrompt, getWorkflow, listPrompts, modelName, publishWorkflow,
  runWorkflow, scoreWorkflow, tokensToWords, updateWorkflow, wordsToTokens,
  type DangerSummary, type Prompt, type PromptListItem, type PromptWorkflow, type StepSource, type WorkflowRunResult, type WorkflowScore,
  type WorkflowSpec,
} from "@/lib/promptsApi"
import { variablesIn } from "@/lib/promptFormat"

/** Drop step i; later steps that read its output lose that wire, and wires to
 *  steps after it shift down by one so they still point at the same prompt. */
function removeStep(spec: WorkflowSpec, i: number): WorkflowSpec {
  return {
    ...spec,
    steps: spec.steps.filter((_, j) => j !== i).map((st) => ({
      ...st,
      input_map: Object.fromEntries(
        Object.entries(st.input_map)
          .filter(([, src]) => !(src.from === "step" && src.step === i))
          .map(([k, src]) => [k, src.from === "step" && src.step > i ? { from: "step" as const, step: src.step - 1 } : src]),
      ),
    })),
  }
}

const RUN_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6", "gpt-5-mini", "gpt-4o-mini"]

function RunPanel({ wf, spec }: { wf: PromptWorkflow; spec: WorkflowSpec }) {
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [model, setModel] = useState(RUN_MODELS[0])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<WorkflowRunResult | null>(wf.last_run ?? null)

  async function run() {
    setBusy(true)
    try { setResult(await runWorkflow(wf.id, inputs, model)); toast("Done. Every step ran.") }
    catch (e) { toast((e as Error).message, "error") }
    finally { setBusy(false) }
  }

  return (
    <div style={CARD}>
      <div style={EYEBROW}>Try it</div>
      <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 6 }}>
        Runs every step for real, passing each answer to the next step. Uses one free test.
      </p>
      {spec.inputs.map((inp) => (
        <div key={inp.name} style={{ marginTop: 10 }}>
          <Label htmlFor={`run-${inp.name}`}>{blankName(inp.name)}</Label>
          <textarea id={`run-${inp.name}`} rows={4} style={{ ...FIELD, resize: "vertical" }} value={inputs[inp.name] ?? ""}
            onChange={(e) => setInputs((v) => ({ ...v, [inp.name]: e.target.value }))} />
        </div>
      ))}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
        <div>
          <Label htmlFor="run-model">AI model</Label>
          <select id="run-model" style={{ ...FIELD, width: 180 }} value={model} onChange={(e) => setModel(e.target.value)}>
            {RUN_MODELS.map((m) => <option key={m} value={m}>{modelName(m)}</option>)}
          </select>
        </div>
        <Button icon={<Play size={13} />} loading={busy} onClick={() => void run()}>Run all steps</Button>
      </div>
      {result && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-700)", fontWeight: 600 }}>
            Last run on {modelName(result.model)}: {formatRunCost(result.usd_total)} for all {result.steps.length} steps
          </div>
          {result.steps.map((st) => (
            <details key={st.step} open={st.step === result.steps.length - 1} style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: "var(--fs-small)", color: "var(--ink-800)" }}>
                Step {st.step + 1}: {st.title} <span style={{ color: "var(--ink-400)" }}>· {formatRunCost(st.usd)}</span>
              </summary>
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-sans)", fontSize: "var(--fs-small)", background: "var(--paper-2)", padding: 10, borderRadius: "var(--radius-md)", marginTop: 6, maxHeight: 240, overflow: "auto" }}>{st.output}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

export default function PromptWorkflowBuilder() {
  const { workflowId } = useParams()
  const isNew = !workflowId || workflowId === "new"
  const navigate = useNavigate()

  const [title, setTitle] = useState("")
  const [spec, setSpec] = useState<WorkflowSpec>({ steps: [], inputs: [] })
  const [wf, setWf] = useState<PromptWorkflow | null>(null)
  const [library, setLibrary] = useState<PromptListItem[]>([])
  const [bodies, setBodies] = useState<Record<string, Prompt>>({})
  const [score, setScore] = useState<WorkflowScore | null>(null)
  const [scoreError, setScoreError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [visibility, setVisibility] = useState<"public" | "org">("public")

  useEffect(() => { listPrompts("all").then((r) => setLibrary(r.prompts)).catch(() => {}) }, [])
  useEffect(() => {
    if (isNew) return
    getWorkflow(workflowId!).then((w) => {
      setWf(w); setTitle(w.title); setSpec(w.steps ?? { steps: [], inputs: [] }); setScore(w.cost_summary && w.danger_summary ? { cost: w.cost_summary, danger: w.danger_summary } : null)
    }).catch((e: Error) => setLoadError(e.message))
  }, [isNew, workflowId])

  // Fetch each step's prompt once, for its variables.
  useEffect(() => {
    for (const s of spec.steps) {
      if (!bodies[s.prompt_id]) getPrompt(s.prompt_id).then((p) => setBodies((b) => ({ ...b, [p.id]: p }))).catch(() => {})
    }
  }, [spec.steps, bodies])

  const owned = isNew || !!wf?.owned

  useEffect(() => {
    if (!owned || spec.steps.length === 0) { setScore(null); return }
    const t = setTimeout(() => {
      scoreWorkflow(spec).then((r) => { setScore(r); setScoreError(null) }).catch((e: Error) => setScoreError(e.message))
    }, 400)
    return () => clearTimeout(t)
  }, [owned, spec])

  const setStep = (i: number, patch: Partial<WorkflowSpec["steps"][number]>) =>
    setSpec((s) => ({ ...s, steps: s.steps.map((x, j) => (j === i ? { ...x, ...patch } : x)) }))

  function addStep(promptId: string) {
    if (!promptId) return
    setSpec((s) => ({ ...s, steps: [...s.steps, { prompt_id: promptId, input_map: {} }] }))
  }

  function mapVar(i: number, v: string, value: string) {
    const step = spec.steps[i]
    const next = { ...step.input_map }
    if (value === "") delete next[v]
    else if (value.startsWith("step:")) next[v] = { from: "step", step: Number(value.slice(5)) }
    else {
      const name = value.slice(6)
      next[v] = { from: "input", name }
      if (!spec.inputs.some((x) => x.name === name)) setSpec((s) => ({ ...s, inputs: [...s.inputs, { name }] }))
    }
    setStep(i, { input_map: next })
  }

  const srcValue = (src?: StepSource) => !src ? "" : src.from === "step" ? `step:${src.step}` : `input:${src.name}`

  async function save() {
    if (!title.trim()) { toast("Give the workflow a title.", "error"); return }
    try {
      const body = { ...spec, title, description: "" }
      const w = isNew ? await createWorkflow(body) : await updateWorkflow(workflowId!, body)
      setWf(w); toast("Saved")
      if (isNew) navigate(`/prompt-workflows/${w.id}`, { replace: true })
    } catch (e) { toast((e as Error).message, "error") }
  }

  // Plain warnings across all steps, each saying which step it's about.
  const stepDanger = useMemo(() => score ? {
    ...score.danger,
    reasons: score.danger.reasons.map((r) => ({ ...r, id: `${r.step}:${r.id}`, title: `Step ${r.step + 1}: ${r.title}` })),
  } : null, [score])

  if (loadError) return <div style={{ padding: PAGE_PAD }}><ErrorState message={loadError} /></div>

  const cheapest = score?.cost.models.find((m) => m.model_key === score.cost.cheapest_model)

  return (
    <div style={{ padding: PAGE_PAD }}>
      <PageHeader
        back={{ to: "/prompt-workflows", label: "Prompt workflows" }}
        title={isNew ? "New workflow" : title}
        description={owned ? "Link prompts into steps. Each blank gets something you paste in, or the answer from an earlier step." : `By ${wf?.author_name ?? "a creator"}`}
        actions={owned ? (
          <>
            {!isNew && <Button variant="ghost" size="sm" icon={<Trash2 size={14} />}
              onClick={() => deleteWorkflow(workflowId!).then(() => { toast("Deleted"); navigate("/prompt-workflows") })}>Delete</Button>}
            <Button variant="secondary" onClick={() => void save()}>Save</Button>
          </>
        ) : undefined}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          {owned && (
            <div style={CARD}>
              <Label htmlFor="wf-title">Title</Label>
              <input id="wf-title" style={FIELD} value={title} placeholder="Inbox to reply" onChange={(e) => setTitle(e.target.value)} />
            </div>
          )}
          {spec.steps.map((s, i) => {
            const p = bodies[s.prompt_id]
            const vars = p ? variablesIn(p.body) : []
            return (
              <div key={i}>
                {i > 0 && <div style={{ display: "flex", justifyContent: "center", color: "var(--ink-300)" }}><ArrowDown size={16} /></div>}
                <div style={CARD}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={EYEBROW}>Step {i + 1}</span>
                    <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p?.title ?? "…"}</span>
                    {owned && <button type="button" aria-label="Remove step" style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--ink-400)" }}
                      onClick={() => setSpec((x) => removeStep(x, i))}><X size={14} /></button>}
                  </div>
                  {vars.length > 0 && (
                    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
                      <thead><tr><th style={TH}>Blank</th><th style={TH}>Filled with</th></tr></thead>
                      <tbody>
                        {vars.map((v) => (
                          <tr key={v}>
                            <td style={{ ...TD, fontFamily: "var(--font-num)" }}>{`{{${v}}}`}</td>
                            <td style={TD}>
                              <select aria-label={`Source for ${v}`} style={FIELD} disabled={!owned} value={srcValue(s.input_map[v])}
                                onChange={(e) => mapVar(i, v, e.target.value)}>
                                <option value="">Its own example text</option>
                                {spec.inputs.map((inp) => <option key={inp.name} value={`input:${inp.name}`}>The {inp.name.replace(/_/g, " ")} you paste in</option>)}
                                {!spec.inputs.some((inp) => inp.name === v) && <option value={`input:${v}`}>Something you paste in ({v.replace(/_/g, " ")})</option>}
                                {spec.steps.slice(0, i).map((_, k) => <option key={k} value={`step:${k}`}>Step {k + 1}'s result</option>)}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )
          })}
          {owned && spec.steps.length < 8 && (
            <div style={CARD}>
              <Label htmlFor="wf-add">Add a step</Label>
              <select id="wf-add" style={FIELD} value="" onChange={(e) => addStep(e.target.value)}>
                <option value="">Choose a prompt…</option>
                {library.map((p) => <option key={p.id} value={p.id}>{p.title}{p.owned ? "" : ` (by ${p.author_name ?? "community"})`}</option>)}
              </select>
              {library.length === 0 && <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 6 }}>Save a prompt first, then add it here.</p>}
            </div>
          )}
          {spec.inputs.length > 0 && owned && (
            <div style={CARD}>
              <div style={{ ...EYEBROW, marginBottom: 8 }}>What you paste in</div>
              {spec.inputs.map((inp, i) => (
                <div key={inp.name} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--font-num)", minWidth: 120 }}>{inp.name}</span>
                  <select aria-label={`Source of ${inp.name}`} style={{ ...FIELD, width: 170 }}
                    value={inp.untrusted == null ? "auto" : inp.untrusted ? "untrusted" : "trusted"}
                    onChange={(e) => setSpec((s) => ({ ...s, inputs: s.inputs.map((x, j) => j === i ? { ...x, untrusted: e.target.value === "auto" ? undefined : e.target.value === "untrusted" } : x) }))}>
                    <option value="auto">Guess for me</option><option value="untrusted">Someone else (emails, web pages, customers)</option><option value="trusted">Me</option>
                  </select>
                  <input aria-label={`About how many words ${inp.name.replace(/_/g, " ")} usually is`} type="number" min={0} placeholder="~words" style={{ ...FIELD, width: 100 }}
                    value={inp.expected_tokens != null ? tokensToWords(inp.expected_tokens) : ""}
                    onChange={(e) => setSpec((s) => ({ ...s, inputs: s.inputs.map((x, j) => j === i ? { ...x, expected_tokens: e.target.value ? wordsToTokens(Number(e.target.value)) : undefined } : x) }))} />
                  <button type="button" aria-label="Remove input" style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--ink-400)" }}
                    onClick={() => setSpec((s) => ({ inputs: s.inputs.filter((_, j) => j !== i), steps: s.steps.map((st) => ({ ...st, input_map: Object.fromEntries(Object.entries(st.input_map).filter(([, src]) => !(src.from === "input" && src.name === inp.name))) })) }))}>
                    <X size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          {scoreError && <div style={{ ...CARD, color: "var(--critical)", fontSize: "var(--fs-small)" }}>{scoreError}</div>}
          {!score ? (
            <div style={{ ...CARD, color: "var(--ink-500)", fontSize: "var(--fs-small)" }}>
              <Plus size={14} style={{ verticalAlign: -2 }} /> Add a step to see what the whole workflow costs each time.
            </div>
          ) : (
            <>
              <Warnings danger={stepDanger as DangerSummary | null} compact />
              <div style={CARD}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div style={EYEBROW}>Cost each time, all steps</div>
                  {cheapest && <span style={{ fontFamily: "var(--font-num)", fontWeight: 600 }}>{formatRunCost(cheapest.usd_per_run)} on {modelName(cheapest.model_key)}</span>}
                </div>
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 360 }}>
                    <thead><tr><th style={TH}>AI model</th><th style={{ ...TH, textAlign: "right" }}>Each time</th></tr></thead>
                    <tbody>
                      {score.cost.models.map((m) => (
                        <tr key={m.model}>
                          <td style={TD}>{modelName(m.model_key ?? m.model)}</td>
                          {m.available ? (
                            <>
                              <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)" }}>
                                {m.is_floor ? "≥ " : ""}{formatRunCost(m.usd_per_run)}
                                <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)", fontFamily: "var(--font-sans)" }}>{BASIS_LABEL[m.is_floor ? "floor" : (m.basis ?? "heuristic")]}</div>
                              </td>
                            </>
                          ) : <td style={{ ...TD, color: "var(--ink-400)" }}>Price not available yet</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {owned && wf && <RunPanel wf={wf} spec={spec} />}
              {owned && wf && (
                <div style={CARD}>
                  <div style={{ ...EYEBROW, marginBottom: 10 }}>Share</div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <SegControl options={[{ value: "public", label: "Everyone" }, { value: "org", label: "Just my team" }] as const} value={visibility} onChange={setVisibility} />
                    <Button onClick={() => publishWorkflow(wf.id, visibility).then((w) => { setWf(w); toast("Shared") }).catch((e: Error) => toast(e.message, "error"))}>
                      Share
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
