/**
 * One prompt: write it and watch its monthly cost and danger update as you
 * type; fix what's risky in one click; use it, compare versions, test it,
 * publish it. Non-owners get a read-only view of the PUBLISHED version with
 * Use and Fork.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { Columns2, Copy, GitFork, Link2, Play, Plus, Trash2, X } from "lucide-react"
import PageHeader from "@/components/shared/PageHeader"
import ErrorState from "@/components/shared/ErrorState"
import { toast } from "@/components/shared/Toast"
import { Button } from "@/components/ui/Button"
import { CostPanel, DangerPanel } from "@/components/prompts/ScorePanels"
import QaPanel from "@/components/prompts/QaPanel"
import AgentTryPanel from "@/components/prompts/AgentTryPanel"
import UseModal from "@/components/prompts/UseModal"
import CompareVersions from "@/components/prompts/CompareVersions"
import { CARD, EYEBROW, FIELD, Label, PAGE_PAD, Pill, SegControl, TD, TH } from "@/components/prompts/ui"
import {
  OUTPUT_PRESETS, blankName, createPrompt, deletePrompt, dismissReason, fixPrompt, forkPrompt, getPrompt, modelName, publishPrompt,
  scorePrompt, tokensToWords, unpublishPrompt, updatePrompt, wordsToTokens,
  type CostSummary, type DangerReason, type DangerSummary, type Prompt, type PromptDraft, type VariableSpec,
} from "@/lib/promptsApi"
import { shareUrl } from "@/lib/shareUrl"

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

function varsIn(body: string): string[] {
  const seen: string[] = []
  for (const m of body.matchAll(VAR_RE)) if (!seen.includes(m[1])) seen.push(m[1])
  return seen
}

const FALLBACK_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6", "gpt-5", "gpt-5-mini", "gpt-4o-mini", "gemini-2-5-flash"]

const EMPTY: PromptDraft = {
  title: "", description: "", use_case: "", body: "", variables: {}, tools: [],
  expected_output_tokens: 330, runs_per_day: 20, model: null, dismissed: [],
}

// First run (#17): a realistic, deliberately risky prompt, so the first screen
// shows the product working. The banner points at Fix it for me.
const EXAMPLE: PromptDraft = {
  ...EMPTY,
  title: "Support email to reply",
  use_case: "support",
  body: "Read the customer's email below and send a reply. If they ask for their money back, issue a refund.\n{{email}}",
  variables: { email: { sample: "Hi, I was charged twice this month. Please refund the extra charge. Thanks, Sam" } },
  expected_output_tokens: 330,
  runs_per_day: 40,
}

function toDraft(p: Prompt): PromptDraft {
  return {
    title: p.title, description: p.description ?? "", use_case: p.use_case ?? "", body: p.body,
    variables: p.variables ?? {}, tools: p.tools ?? [], expected_output_tokens: p.expected_output_tokens,
    runs_per_day: p.runs_per_day, model: p.model, dismissed: p.dismissed ?? [],
  }
}

function VariablesTable({ names, vars, untrusted, onChange, readOnly }: {
  names: string[]
  vars: Record<string, VariableSpec>
  untrusted: string[]
  onChange: (name: string, spec: VariableSpec) => void
  readOnly?: boolean
}) {
  if (names.length === 0) {
    return <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", lineHeight: 1.5 }}>
      No blanks yet. A blank is a spot you fill in each time you use the prompt, like an email you paste in.
      Press <b>Add a blank</b> under the prompt to make one.
    </p>
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480, tableLayout: "fixed" }}>
        <colgroup><col style={{ width: 96 }} /><col /><col style={{ width: 90 }} /><col style={{ width: 196 }} /></colgroup>
        <thead>
          <tr>
            <th style={TH}>Blank</th>
            <th style={TH}>Example</th>
            <th style={TH}>Usual words</th>
            <th style={TH}>Who writes it</th>
          </tr>
        </thead>
        <tbody>
          {names.map((n) => {
            const spec = vars[n] ?? {}
            const isUntrusted = spec.untrusted ?? untrusted.includes(n)
            return (
              <tr key={n}>
                <td style={{ ...TD, fontWeight: 600, overflowWrap: "anywhere" }}>{blankName(n)}</td>
                <td style={TD}>
                  <textarea aria-label={`Example for ${n}`} rows={2} disabled={readOnly} value={spec.sample ?? ""}
                    onChange={(e) => onChange(n, { ...spec, sample: e.target.value || undefined })}
                    style={{ ...FIELD, resize: "vertical" }} />
                </td>
                <td style={TD}>
                  <input aria-label={`Typical length of ${n} in words`} type="number" min={0} disabled={readOnly}
                    value={spec.expected_tokens != null ? tokensToWords(spec.expected_tokens) : ""}
                    onChange={(e) => onChange(n, { ...spec, expected_tokens: e.target.value ? wordsToTokens(Number(e.target.value)) : undefined })}
                    style={FIELD} />
                </td>
                <td style={TD}>
                  <select aria-label={`Where ${n} comes from`} disabled={readOnly}
                    value={spec.untrusted == null ? "auto" : spec.untrusted ? "untrusted" : "trusted"}
                    onChange={(e) => onChange(n, { ...spec, untrusted: e.target.value === "auto" ? undefined : e.target.value === "untrusted" })}
                    style={FIELD}>
                    <option value="auto">Guess: {isUntrusted ? "someone else" : "you"}</option>
                    <option value="untrusted">Someone else (emails, web pages, customers)</option>
                    <option value="trusted">Me</option>
                  </select>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function OutputLength({ tokens, onChange, disabled }: { tokens: number | null; onChange: (t: number | null) => void; disabled?: boolean }) {
  const preset = OUTPUT_PRESETS.find((p) => p.tokens === tokens)
  const [custom, setCustom] = useState(!preset && tokens != null)
  const value = custom ? "custom" : preset?.key ?? "custom"
  return (
    <div>
      <Label>How long are answers?</Label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? "none" : undefined }}>
        <SegControl
          options={[...OUTPUT_PRESETS.map((p) => ({ value: p.key, label: p.label })), { value: "custom", label: "Words" }] as const}
          value={value as "short" | "medium" | "long" | "custom"}
          onChange={(v) => {
            if (v === "custom") { setCustom(true); return }
            setCustom(false)
            onChange(OUTPUT_PRESETS.find((p) => p.key === v)!.tokens)
          }}
        />
        {value === "custom" ? (
          <input aria-label="Answer length in words" type="number" min={1} style={{ ...FIELD, width: 100 }}
            value={tokens != null ? tokensToWords(tokens) : ""} placeholder="words"
            onChange={(e) => onChange(e.target.value ? wordsToTokens(Number(e.target.value)) : null)} />
        ) : (
          <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)" }}>{preset?.hint}</span>
        )}
      </div>
    </div>
  )
}

export default function PromptDetail() {
  const { promptId } = useParams()
  const [search] = useSearchParams()
  const isNew = !promptId || promptId === "new"
  const showExample = isNew && search.get("example") === "1"
  const navigate = useNavigate()

  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [draft, setDraft] = useState<PromptDraft>(showExample ? EXAMPLE : EMPTY)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [live, setLive] = useState<{ cost: CostSummary; danger: DangerSummary } | null>(null)
  const [scoring, setScoring] = useState(false)
  const [saving, setSaving] = useState(false)
  const [visibility, setVisibility] = useState<"public" | "org">("public")
  const [ack, setAck] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [preFix, setPreFix] = useState<{ body: string; variables: Record<string, VariableSpec>; changes: string[] } | null>(null)
  const [showUse, setShowUse] = useState(false)
  const [showCompare, setShowCompare] = useState(false)
  const [exampleTip, setExampleTip] = useState(showExample)
  const dirty = useRef(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(() => {
    if (isNew) { setPrompt(null); return }
    getPrompt(promptId!)
      .then((p) => { setPrompt(p); setDraft(toDraft(p)); setLoadError(null); dirty.current = false })
      .catch((e: Error) => setLoadError(e.message))
  }, [isNew, promptId])

  useEffect(load, [load])

  const owned = isNew || !!prompt?.owned
  const names = useMemo(() => varsIn(draft.body), [draft.body])

  // Live score while editing: debounced, owners only (readers see the stored score).
  useEffect(() => {
    if (!owned || !draft.body.trim()) { setLive(null); return }
    let alive = true
    setScoring(true)
    const t = setTimeout(() => {
      scorePrompt(draft, prompt?.id)
        .then((r) => { if (alive) setLive({ cost: r.cost, danger: r.danger }) })
        .catch(() => { /* the stored score still shows; a failed live score isn't worth a toast */ })
        .finally(() => { if (alive) setScoring(false) })
    }, 600)
    return () => { alive = false; clearTimeout(t) }
  }, [owned, draft, prompt?.id])

  const set = (patch: Partial<PromptDraft>) => { dirty.current = true; setDraft((d) => ({ ...d, ...patch })) }

  const cost = live?.cost ?? prompt?.cost_summary ?? null
  const danger = live?.danger ?? prompt?.danger_summary ?? null
  const modelOptions = useMemo(() => {
    const fromCost = (cost?.models ?? []).filter((m) => m.available && m.model_key).map((m) => m.model_key!) 
    return Array.from(new Set([...(draft.model ? [draft.model] : []), ...(fromCost.length ? fromCost : FALLBACK_MODELS)]))
  }, [cost, draft.model])

  async function save(): Promise<Prompt | null> {
    if (!draft.title.trim() || !draft.body.trim()) { toast("Give the prompt a name and some text first.", "error"); return null }
    setSaving(true)
    try {
      const vars = Object.fromEntries(Object.entries(draft.variables).filter(([k]) => names.includes(k)))
      const body = { ...draft, variables: vars }
      const p = isNew ? await createPrompt(body) : await updatePrompt(promptId!, body)
      dirty.current = false
      setPrompt(p); setDraft(toDraft(p)); setExampleTip(false)
      if (isNew) navigate(`/prompts/${p.id}`, { replace: true })
      toast("Saved")
      return p
    } catch (e) {
      toast((e as Error).message, "error")
      return null
    } finally {
      setSaving(false)
    }
  }

  async function publish() {
    const saved = dirty.current || isNew ? await save() : prompt
    if (!saved) return
    try {
      const p = await publishPrompt(saved.id, visibility, ack)
      setPrompt(p); setDraft(toDraft(p))
      toast(visibility === "public" ? "Shared. Anyone with Arceo can find and use it." : "Shared with your team")
    } catch (e) {
      toast((e as Error).message, "error")
    }
  }

  async function onFix() {
    setFixing(true)
    try {
      const r = await fixPrompt(draft)
      if (r.unchanged) { toast("Nothing left that Fix it for me can change."); return }
      setPreFix({ body: draft.body, variables: draft.variables, changes: r.changes })
      set({ body: r.body, variables: { ...draft.variables, ...r.variables } })
      setExampleTip(false)
      toast(`${r.before.band === r.after.band ? "Made safer" : `Danger went from ${r.before.band} to ${r.after.band}`}. Look over the changes, then save.`)
    } catch (e) {
      toast((e as Error).message, "error")
    } finally {
      setFixing(false)
    }
  }

  // Insert a {{blank}} at the cursor with its name selected, so the person
  // types the name straight over it instead of learning the brace syntax.
  function addBlank() {
    const el = bodyRef.current
    let name = "text"
    for (let i = 2; names.includes(name); i++) name = `text_${i}`
    const token = `{{${name}}}`
    const start = el?.selectionStart ?? draft.body.length
    const end = el?.selectionEnd ?? draft.body.length
    set({ body: draft.body.slice(0, start) + token + draft.body.slice(end) })
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(start + 2, start + 2 + name.length)
    })
  }

  function undoFix() {
    if (!preFix) return
    set({ body: preFix.body, variables: preFix.variables })
    setPreFix(null)
  }

  async function toggleDismiss(r: DangerReason) {
    const next = r.dismissed ? draft.dismissed.filter((d) => d !== r.id) : [...draft.dismissed, r.id]
    set({ dismissed: next })
    if (prompt?.owned) {
      try {
        const p = await dismissReason(prompt.id, r.id, !r.dismissed)
        setPrompt(p)
      } catch { /* the draft still carries it; Save will persist */ }
    }
  }

  async function onFork() {
    try {
      const p = await forkPrompt(prompt!.id)
      toast("Saved a copy to your library. Change it however you like.")
      navigate(`/prompts/${p.id}`)
    } catch (e) { toast((e as Error).message, "error") }
  }

  async function onDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    try { await deletePrompt(prompt!.id); toast("Deleted"); navigate("/prompts") }
    catch (e) { toast((e as Error).message, "error") }
  }

  if (loadError) {
    return <div style={{ padding: PAGE_PAD }}><ErrorState message={loadError} onRetry={load} /></div>
  }
  if (!isNew && !prompt) {
    return <div style={{ padding: PAGE_PAD }} aria-busy="true"><div className="skeleton" style={{ height: 30, width: 260 }} /></div>
  }

  const link = prompt?.status === "published" && prompt.visibility === "public" ? shareUrl("p", prompt.id) : null
  const critical = danger?.band === "critical"
  const blocked = (danger?.publish_blockers.length ?? 0) > 0

  return (
    <div style={{ padding: PAGE_PAD }}>
      <PageHeader
        back={{ to: "/prompts", label: "Prompts" }}
        title={isNew ? "New prompt" : (prompt?.title ?? "")}
        description={owned
          ? "The cost and safety check update as you type. Only you can see this until you share it."
          : `By ${prompt?.author_name ?? "a creator"} · version ${prompt?.published_version} · used ${prompt?.use_count ?? 0} ${prompt?.use_count === 1 ? "time" : "times"}`}
        byline={!owned && prompt?.author_id ? { to: `/creators/${prompt.author_id}`, label: `More from ${prompt.author_name ?? "this creator"}` } : undefined}
        actions={owned ? (
          <>
            {!isNew && (
              <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={onDelete}>
                {confirmDelete ? "Click again to delete" : "Delete"}
              </Button>
            )}
            {!isNew && <Button variant="secondary" size="sm" icon={<Columns2 size={14} />} onClick={() => setShowCompare((v) => !v)}>Compare versions</Button>}
            {draft.body.trim() && <Button variant="secondary" size="sm" icon={<Play size={14} />} onClick={() => setShowUse(true)}>Use</Button>}
            <Button loading={saving} onClick={() => void save()}>Save</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" icon={<Play size={14} />} onClick={() => setShowUse(true)}>Use</Button>
            <Button icon={<GitFork size={14} />} onClick={onFork}>Save a copy</Button>
          </>
        )}
      />

      {exampleTip && (
        <div style={{ ...CARD, display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 16, background: "var(--accent-soft)" }}>
          <div style={{ flex: 1, fontSize: "var(--fs-small)", color: "var(--accent-ink)", lineHeight: 1.5 }}>
            <b>Here's an example to try.</b> It's risky on purpose: a stranger's email could trick it into giving out refunds.
            Press <b>Fix it for me</b> and watch the danger drop. Then swap in your own words.
          </div>
          <button type="button" aria-label="Dismiss tip" onClick={() => setExampleTip(false)} style={{ border: 0, background: "none", cursor: "pointer", color: "var(--accent-ink)" }}><X size={15} /></button>
        </div>
      )}

      {showCompare && prompt && (
        <div style={{ marginBottom: 16 }}>
          <CompareVersions prompt={prompt} onClose={() => setShowCompare(false)} onAdopt={(b) => { set({ body: b }); setShowCompare(false) }} />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div style={CARD}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <div>
                <Label htmlFor="p-title">Name</Label>
                <input id="p-title" style={FIELD} disabled={!owned} value={draft.title}
                  placeholder="Client email summary" onChange={(e) => set({ title: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="p-use">Category</Label>
                <input id="p-use" style={FIELD} disabled={!owned} value={draft.use_case}
                  placeholder="e.g. sales, support, marketing" onChange={(e) => set({ use_case: e.target.value })} />
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <Label htmlFor="p-body">What should the AI do?</Label>
              <textarea
                ref={bodyRef}
                id="p-body" rows={12} disabled={!owned} value={draft.body}
                placeholder={"Summarize the client email below in 3 bullet points.\n{{email}}"}
                onChange={(e) => set({ body: e.target.value })}
                style={{ ...FIELD, lineHeight: 1.55, resize: "vertical" }}
              />
              {owned && (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                  <Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={addBlank}>Add a blank</Button>
                  <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", flex: "1 1 220px", lineHeight: 1.45 }}>
                    Blanks are the parts that change each time, like {"{{email}}"} or {"{{customer_name}}"}. Use one word, no spaces.
                  </span>
                </div>
              )}
            </div>
            {preFix && (
              <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--paper-2)", fontSize: "var(--fs-small)", color: "var(--ink-700)" }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>What Fix it for me changed:</div>
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>{preFix.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
              </div>
            )}
          </div>

          <div style={CARD}>
            <div style={{ ...EYEBROW, marginBottom: 10 }}>How you'll use it</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
              <div>
                <Label htmlFor="p-runs">Times used a day</Label>
                <input id="p-runs" type="number" min={0} style={FIELD} disabled={!owned}
                  value={draft.runs_per_day ?? ""} placeholder="e.g. 20"
                  onChange={(e) => set({ runs_per_day: e.target.value ? Number(e.target.value) : null })} />
              </div>
              <div>
                <Label htmlFor="p-model">Which AI?</Label>
                <select id="p-model" style={FIELD} disabled={!owned} value={draft.model ?? ""}
                  onChange={(e) => set({ model: e.target.value || null })}>
                  <option value="">Not sure (show the cheapest)</option>
                  {modelOptions.map((m) => <option key={m} value={m}>{modelName(m)}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <OutputLength tokens={draft.expected_output_tokens} disabled={!owned} onChange={(t) => set({ expected_output_tokens: t })} />
            </div>
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer", fontSize: "var(--fs-small)", color: "var(--ink-500)" }}>For developers: tools it can use</summary>
              <input aria-label="Tools it can use" style={{ ...FIELD, marginTop: 8 }} disabled={!owned} value={draft.tools.join(", ")}
                placeholder="gmail.send_email, stripe.create_refund"
                onChange={(e) => set({ tools: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </details>
          </div>

          <div style={CARD}>
            <div style={{ ...EYEBROW, marginBottom: 8 }}>Fill-in blanks</div>
            <VariablesTable
              names={names} vars={draft.variables} untrusted={danger?.untrusted_variables ?? []} readOnly={!owned}
              onChange={(n, spec) => set({ variables: { ...draft.variables, [n]: spec } })}
            />
          </div>

          {owned && (
            <div style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={EYEBROW}>Share</div>
                {prompt?.status === "published" && (
                  <Pill tone="accent">Version {prompt.published_version} · {prompt.visibility === "org" ? "shared with your team" : "shared with everyone"}</Pill>
                )}
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
                <SegControl
                  options={[{ value: "public", label: "Everyone" }, { value: "org", label: "Just my team" }] as const}
                  value={visibility} onChange={setVisibility}
                />
                <Button onClick={() => void publish()} disabled={blocked || (critical && !ack)}>
                  {prompt?.status === "published" ? "Share the update" : "Share"}
                </Button>
                {prompt?.status === "published" && (
                  <Button variant="ghost" size="sm" onClick={() => unpublishPrompt(prompt.id).then((p) => { setPrompt(p); toast("No longer shared") })}>
                    Stop sharing
                  </Button>
                )}
              </div>
              {critical && !blocked && (
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, fontSize: "var(--fs-small)", color: "var(--ink-700)" }}>
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 3 }} />
                  This prompt is rated critical. I've read the risks listed and still want to share it.
                </label>
              )}
              {link && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, minWidth: 0 }}>
                  <Link2 size={14} style={{ color: "var(--ink-400)", flexShrink: 0 }} />
                  <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{link}</span>
                  <Button variant="ghost" size="sm" icon={<Copy size={13} />}
                    onClick={() => navigator.clipboard?.writeText(link).then(() => toast("Link copied"))}>Copy</Button>
                </div>
              )}
            </div>
          )}

          {owned && prompt && <QaPanel prompt={prompt} onUpdated={load} />}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }} aria-busy={scoring}>
          {!cost && !danger ? (
            <div style={{ ...CARD, color: "var(--ink-500)", fontSize: "var(--fs-small)" }}>
              Start typing to see what this prompt costs a month and whether it's safe to use.
            </div>
          ) : (
            <>
              <DangerPanel danger={danger}
                onFix={owned ? () => void onFix() : undefined} fixing={fixing}
                onUndoFix={owned && preFix ? undoFix : undefined}
                onToggleDismiss={owned ? (r) => void toggleDismiss(r) : undefined} />
              <CostPanel cost={cost} runsPerDay={draft.runs_per_day} preferredModel={draft.model} />
            </>
          )}
          {owned && prompt && <AgentTryPanel promptId={prompt.id} body={draft.body} variables={draft.variables} />}
        </div>
      </div>

      {showUse && (
        <UseModal promptId={prompt?.id ?? ""} title={draft.title || "this prompt"} body={draft.body}
          variables={draft.variables} signedIn onClose={() => setShowUse(false)} />
      )}
    </div>
  )
}
