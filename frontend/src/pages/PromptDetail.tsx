/**
 * One prompt (docs/prompts-rework-plan.md §3).
 *
 * Read first: everyone lands on what the prompt does, its text, the blanks to
 * fill, a big "Send to…" button, plain warnings (only when something applies),
 * what it costs and similar prompts. Owners press Edit to change it; nobody
 * else ever sees a disabled form, they get "Save a copy".
 *
 * Writing (new prompt, or Edit): the cost updates as you type, plain warnings
 * with "Fix it for me", and the "already in the library?" check runs under the
 * text box while typing and once more on Save.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { Copy, GitFork, Link2, Pencil, Plus, Send, Trash2, X } from "lucide-react"
import PageHeader from "@/components/shared/PageHeader"
import ErrorState from "@/components/shared/ErrorState"
import { toast } from "@/components/shared/Toast"
import { Button } from "@/components/ui/Button"
import { CostPanel } from "@/components/prompts/ScorePanels"
import Warnings from "@/components/prompts/Warnings"
import SendDialog, { BlankFields } from "@/components/prompts/SendDialog"
import SendButton from "@/components/prompts/SendButton"
import SimilarPrompts from "@/components/prompts/SimilarPrompts"
import DuplicateCheck, { useDuplicateSaveGuard } from "@/components/prompts/DuplicateCheck"
import PromptText from "@/components/prompts/PromptText"
import { CARD, EYEBROW, FIELD, Label, PAGE_PAD, Pill, SegControl, TD, TH } from "@/components/prompts/ui"
import {
  OUTPUT_PRESETS, blankName, createPrompt, deletePrompt, dismissReason, forkPrompt, getPrompt, modelName, publishPrompt,
  scorePrompt, tokensToWords, unpublishPrompt, updatePrompt, wordsToTokens,
  type CostSummary, type DangerSummary, type FixResult, type Prompt, type PromptDraft, type VariableSpec,
} from "@/lib/promptsApi"
import { shareUrl } from "@/lib/shareUrl"
import { CATEGORIES, variablesIn } from "@/lib/promptFormat"
import { needsDuplicateCheckOnSave, sendableDraft, toDraft, withServerDismissed } from "@/lib/promptDraft"
import type { MatchDraft } from "@/lib/similarApi"

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
  use_case: "Customer support",
  body: "Read the customer's email below and send a reply. If they ask for their money back, issue a refund.\n{{email}}",
  variables: { email: { sample: "Hi, I was charged twice this month. Please refund the extra charge. Thanks, Sam" } },
  expected_output_tokens: 330,
  runs_per_day: 40,
}

function VariablesTable({ names, vars, untrusted, onChange }: {
  names: string[]
  vars: Record<string, VariableSpec>
  untrusted: string[]
  onChange: (name: string, spec: VariableSpec) => void
}) {
  if (names.length === 0) {
    return <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", lineHeight: 1.5, margin: 0 }}>
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
                  <textarea aria-label={`Example for ${n}`} rows={2} value={spec.sample ?? ""}
                    onChange={(e) => onChange(n, { ...spec, sample: e.target.value || undefined })}
                    style={{ ...FIELD, resize: "vertical" }} />
                </td>
                <td style={TD}>
                  <input aria-label={`Typical length of ${n} in words`} type="number" min={0}
                    value={spec.expected_tokens != null ? tokensToWords(spec.expected_tokens) : ""}
                    onChange={(e) => onChange(n, { ...spec, expected_tokens: e.target.value ? wordsToTokens(Number(e.target.value)) : undefined })}
                    style={FIELD} />
                </td>
                <td style={TD}>
                  <select aria-label={`Where ${n} comes from`}
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

function OutputLength({ tokens, onChange }: { tokens: number | null; onChange: (t: number | null) => void }) {
  const preset = OUTPUT_PRESETS.find((p) => p.tokens === tokens)
  const [custom, setCustom] = useState(!preset && tokens != null)
  const value = custom ? "custom" : preset?.key ?? "custom"
  return (
    <div>
      <Label>How long are answers?</Label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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

/** Owners: who can see it, and the share link. */
function ShareCard({ prompt, onShare, onUnshare, blocked }: {
  prompt: Prompt | null
  onShare: (visibility: "public" | "org") => void
  onUnshare: () => void
  blocked: boolean
}) {
  const [visibility, setVisibility] = useState<"public" | "org">(prompt?.visibility === "org" ? "org" : "public")
  const link = prompt?.status === "published" && prompt.visibility === "public" ? shareUrl("p", prompt.id) : null
  return (
    <div style={CARD}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={EYEBROW}>Share</div>
        {prompt?.status === "published" && (
          <Pill tone="accent">{prompt.visibility === "org" ? "Shared with your team" : "Shared with everyone"}</Pill>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <SegControl
          options={[{ value: "public", label: "Everyone" }, { value: "org", label: "Just my team" }] as const}
          value={visibility} onChange={setVisibility}
        />
        <Button onClick={() => onShare(visibility)} disabled={blocked}>
          {prompt?.status === "published" ? "Share the update" : "Share"}
        </Button>
        {prompt?.status === "published" && (
          <Button variant="ghost" size="sm" onClick={onUnshare}>Stop sharing</Button>
        )}
      </div>
      {blocked && (
        <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: "10px 0 0", lineHeight: 1.5 }}>
          Take out the private details listed above before you share it.
        </p>
      )}
      {link && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, minWidth: 0 }}>
          <Link2 size={14} style={{ color: "var(--ink-400)", flexShrink: 0 }} />
          <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{link}</span>
          <Button variant="ghost" size="sm" icon={<Copy size={13} />}
            onClick={() => navigator.clipboard?.writeText(link).then(() => toast("Link copied"))}>Copy</Button>
        </div>
      )}
    </div>
  )
}

export default function PromptDetail() {
  const { promptId } = useParams()
  const [search, setSearch] = useSearchParams()
  const isNew = !promptId || promptId === "new"
  const showExample = isNew && search.get("example") === "1"
  const navigate = useNavigate()

  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [draft, setDraft] = useState<PromptDraft>(showExample ? EXAMPLE : EMPTY)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [live, setLive] = useState<{ cost: CostSummary; danger: DangerSummary } | null>(null)
  const [scoring, setScoring] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [preFix, setPreFix] = useState<{ body: string; variables: Record<string, VariableSpec> } | null>(null)
  const [sending, setSending] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [exampleTip, setExampleTip] = useState(showExample)
  const dirty = useRef(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const guard = useDuplicateSaveGuard()

  const load = useCallback(() => {
    if (isNew) { setPrompt(null); return }
    setPrompt(null)
    getPrompt(promptId!)
      .then((p) => { setPrompt(p); setDraft(toDraft(p)); setLoadError(null); setValues({}); dirty.current = false })
      .catch((e: Error) => setLoadError(e.message))
  }, [isNew, promptId])

  useEffect(load, [load])

  const owned = isNew || !!prompt?.owned
  // Owners open on the read view too; Edit (or ?edit=1) shows the form.
  const editing = isNew || (owned && search.get("edit") === "1")
  const names = useMemo(() => variablesIn(draft.body), [draft.body])

  function setEditing(on: boolean) {
    const next = new URLSearchParams(search)
    if (on) next.set("edit", "1"); else next.delete("edit")
    setSearch(next, { replace: true })
  }

  // Live cost while writing (debounced). Readers see the stored one.
  useEffect(() => {
    if (!editing || !draft.body.trim()) { setLive(null); return }
    let alive = true
    setScoring(true)
    const t = setTimeout(() => {
      scorePrompt(draft, prompt?.id)
        .then((r) => { if (alive) setLive({ cost: r.cost, danger: r.danger }) })
        .catch(() => { /* the stored numbers still show; a failed live check isn't worth a toast */ })
        .finally(() => { if (alive) setScoring(false) })
    }, 600)
    return () => { alive = false; clearTimeout(t) }
  }, [editing, draft, prompt?.id])

  const set = (patch: Partial<PromptDraft>) => { dirty.current = true; setDraft((d) => ({ ...d, ...patch })) }

  const cost = (editing ? live?.cost : null) ?? prompt?.cost_summary ?? null
  const danger = (editing ? live?.danger : null) ?? prompt?.danger_summary ?? null
  const modelOptions = useMemo(() => {
    const fromCost = (cost?.models ?? []).filter((m) => m.available && m.model_key).map((m) => m.model_key!)
    return Array.from(new Set([...(draft.model ? [draft.model] : []), ...(fromCost.length ? fromCost : FALLBACK_MODELS)]))
  }, [cost, draft.model])

  const matchDraft: MatchDraft = useMemo(() => ({
    body: draft.body, title: draft.title, description: draft.description, use_case: draft.use_case, variables: draft.variables,
  }), [draft.body, draft.title, draft.description, draft.use_case, draft.variables])

  async function save(opts: { stayEditing?: boolean } = {}): Promise<Prompt | null> {
    if (!draft.title.trim() || !draft.body.trim()) { toast("Give the prompt a name and some text first.", "error"); return null }
    // "Is this already in the library?" once more, carefully, before anything is
    // saved. Only when the text is new: a saved prompt whose text didn't change
    // was already checked (and kept) when it was first saved.
    if (needsDuplicateCheckOnSave(isNew ? null : prompt, draft.body)
      && !(await guard.confirmSaveAgainstDuplicates(matchDraft, { excludeId: prompt?.id }))) return null
    setSaving(true)
    try {
      const vars = Object.fromEntries(Object.entries(draft.variables).filter(([k]) => names.includes(k)))
      const body = { ...draft, variables: vars }
      const p = isNew ? await createPrompt(body) : await updatePrompt(promptId!, body)
      dirty.current = false
      setPrompt(p); setDraft(toDraft(p)); setExampleTip(false); setPreFix(null)
      if (isNew) navigate(`/prompts/${p.id}`, { replace: true })
      else if (!opts.stayEditing) setEditing(false)
      toast("Saved")
      return p
    } catch (e) {
      toast((e as Error).message, "error")
      return null
    } finally {
      setSaving(false)
    }
  }

  async function share(visibility: "public" | "org") {
    const saved = dirty.current || isNew ? await save({ stayEditing: true }) : prompt
    if (!saved) return
    try {
      const p = await publishPrompt(saved.id, visibility)
      setPrompt(p); setDraft(toDraft(p))
      toast(visibility === "public" ? "Shared. Anyone with Arceo can find and use it." : "Shared with your team")
    } catch (e) {
      toast((e as Error).message, "error")
    }
  }

  function applyFix(r: FixResult) {
    setPreFix({ body: draft.body, variables: draft.variables })
    set({ body: r.body, variables: { ...draft.variables, ...r.variables } })
    setExampleTip(false)
  }

  function undoFix() {
    if (!preFix) return
    set({ body: preFix.body, variables: preFix.variables })
    setPreFix(null)
  }

  async function onDismiss(reasonId: string, dismissed: boolean) {
    const next = dismissed ? [...new Set([...draft.dismissed, reasonId])] : draft.dismissed.filter((d) => d !== reasonId)
    set({ dismissed: next })
    if (prompt?.owned) {
      const p = await dismissReason(prompt.id, reasonId, dismissed)
      setPrompt(p)
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

  async function onFork() {
    try {
      const p = await forkPrompt(prompt!.id)
      toast("Saved a copy to your library. Change it however you like.")
      navigate(`/prompts/${p.id}?edit=1`)
    } catch (e) { toast((e as Error).message, "error") }
  }

  async function onDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    try { await deletePrompt(prompt!.id); toast("Deleted"); navigate("/prompts") }
    catch (e) { toast((e as Error).message, "error") }
  }

  function cancelEdit() {
    if (prompt) setDraft(toDraft(prompt))
    dirty.current = false
    setPreFix(null)
    setEditing(false)
  }

  if (loadError) {
    return <div style={{ padding: PAGE_PAD }}><ErrorState message={loadError} onRetry={load} /></div>
  }
  if (!isNew && !prompt) {
    return <div style={{ padding: PAGE_PAD }} aria-busy="true"><div className="skeleton" style={{ height: 30, width: 260 }} /></div>
  }

  const blocked = (danger?.publish_blockers?.length ?? 0) > 0
  const sendable = editing ? sendableDraft(prompt, draft, danger) : prompt!
  const sendDialog = sending && (
    <SendDialog prompt={sendable} signedIn initialValues={editing ? undefined : values}
      startAt={!editing && names.length > 0 && names.every((n) => values[n]?.trim()) ? "choose" : undefined}
      onClose={() => setSending(false)} />
  )

  // ── Read view ──────────────────────────────────────────────────────────
  if (!editing && prompt) {
    const meta = [
      prompt.use_case,
      owned ? (prompt.status === "published" ? (prompt.visibility === "org" ? "Shared with your team" : "Shared with everyone") : "Only you can see it")
        : prompt.author_name ? `By ${prompt.author_name}` : null,
      prompt.use_count ? `Used ${prompt.use_count} ${prompt.use_count === 1 ? "time" : "times"}` : null,
    ].filter(Boolean) as string[]
    return (
      <div style={{ padding: PAGE_PAD }}>
        <PageHeader
          back={{ to: "/prompts", label: "Prompts" }}
          title={prompt.title}
          description={prompt.description || undefined}
          byline={!owned && prompt.author_id ? { to: `/creators/${prompt.author_id}`, label: `More from ${prompt.author_name ?? "this creator"}` } : undefined}
          actions={(
            <>
              {owned ? (
                <>
                  <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={onDelete}>
                    {confirmDelete ? "Click again to delete" : "Delete"}
                  </Button>
                  <Button variant="secondary" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Edit</Button>
                </>
              ) : (
                <Button variant="secondary" icon={<GitFork size={14} />} onClick={onFork}>Save a copy</Button>
              )}
              <Button icon={<Send size={14} />} onClick={() => setSending(true)}>Send to…</Button>
            </>
          )}
        />

        {meta.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "-12px 0 18px" }}>
            {meta.map((m, i) => <Pill key={m} tone={i === 0 && prompt.use_case ? "accent" : "neutral"}>{m}</Pill>)}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <Warnings prompt={prompt} compact={!owned} editable={owned}
              onChanged={(p) => { setPrompt(p); setDraft((d) => withServerDismissed(d, p)) }} />
            <div style={CARD}>
              <div style={{ ...EYEBROW, marginBottom: 10 }}>The prompt</div>
              <PromptText body={prompt.body} />
            </div>
            {names.length > 0 && (
              <div style={CARD}>
                <div style={{ ...EYEBROW, marginBottom: 4 }}>Fill in the blanks</div>
                <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: "0 0 12px", lineHeight: 1.5 }}>
                  What you type stays on your computer until you send it.
                </p>
                <BlankFields names={names} values={values} variables={prompt.variables} idPrefix="read"
                  onChange={(n, v) => setValues((cur) => ({ ...cur, [n]: v }))} />
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
                  <Button icon={<Send size={14} />} onClick={() => setSending(true)}>Send to…</Button>
                </div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <CostPanel cost={cost} runsPerDay={prompt.runs_per_day} preferredModel={prompt.model} />
            {owned && (
              <ShareCard prompt={prompt} blocked={blocked} onShare={(v) => void share(v)}
                onUnshare={() => unpublishPrompt(prompt.id).then((p) => { setPrompt(p); toast("No longer shared") })} />
            )}
          </div>
        </div>

        <div style={{ marginTop: 28 }}>
          <SimilarPrompts promptId={prompt.id}
            renderAction={(m) => <SendButton promptId={m.id} title={m.title} compact />} />
        </div>
        {sendDialog}
      </div>
    )
  }

  // ── Writing view (new prompt, or an owner's Edit) ──────────────────────
  return (
    <div style={{ padding: PAGE_PAD }}>
      <PageHeader
        back={isNew ? { to: "/prompts", label: "Prompts" } : undefined}
        title={isNew ? "New prompt" : `Edit “${prompt?.title ?? ""}”`}
        description={isNew
          ? "Paste or write what you ask an AI to do. We'll tell you if it's already in the library. Only you can see it until you share it."
          : "The cost updates as you type. Only you can see your changes until you share them."}
        actions={(
          <>
            {!isNew && <Button variant="ghost" size="sm" icon={<X size={14} />} onClick={cancelEdit}>Cancel</Button>}
            {draft.body.trim() && <Button variant="secondary" icon={<Send size={14} />} onClick={() => setSending(true)}>Send to…</Button>}
            <Button loading={saving || guard.checking} onClick={() => void save()}>Save</Button>
          </>
        )}
      />

      {exampleTip && (
        <div style={{ ...CARD, display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 16, background: "var(--accent-soft)" }}>
          <div style={{ flex: 1, fontSize: "var(--fs-small)", color: "var(--accent-ink)", lineHeight: 1.5 }}>
            <b>Here's an example to try.</b> It's risky on purpose: a stranger's email could trick it into giving out refunds.
            Press <b>Fix it for me</b> and see what changes. Then swap in your own words.
          </div>
          <button type="button" aria-label="Dismiss tip" onClick={() => setExampleTip(false)} style={{ border: 0, background: "none", cursor: "pointer", color: "var(--accent-ink)" }}><X size={15} /></button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div style={CARD}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <div>
                <Label htmlFor="p-title">Name</Label>
                <input id="p-title" style={FIELD} value={draft.title}
                  placeholder="Client email summary" onChange={(e) => set({ title: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="p-use">Category</Label>
                <input id="p-use" style={FIELD} value={draft.use_case} list="p-categories"
                  placeholder="Pick one or type your own" onChange={(e) => set({ use_case: e.target.value })} />
                <datalist id="p-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <Label htmlFor="p-desc">What it does, in one line</Label>
              <input id="p-desc" style={FIELD} value={draft.description}
                placeholder="Turns a long client email into three short bullet points" onChange={(e) => set({ description: e.target.value })} />
            </div>
            <div style={{ marginTop: 12 }}>
              <Label htmlFor="p-body">What should the AI do?</Label>
              <textarea
                ref={bodyRef}
                id="p-body" rows={12} value={draft.body}
                placeholder={"Summarize the client email below in 3 bullet points.\n{{email}}"}
                onChange={(e) => set({ body: e.target.value })}
                style={{ ...FIELD, lineHeight: 1.55, resize: "vertical" }}
              />
              <DuplicateCheck draft={matchDraft} excludeId={prompt?.id}
                renderAction={(m) => <SendButton promptId={m.id} title={m.title} compact />}
                onKeepWriting={() => bodyRef.current?.focus()} />
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                <Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={addBlank}>Add a blank</Button>
                <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", flex: "1 1 220px", lineHeight: 1.45 }}>
                  Blanks are the parts that change each time, like {"{{email}}"} or {"{{customer_name}}"}. Use one word, no spaces.
                </span>
              </div>
            </div>
          </div>

          <Warnings danger={danger} promptId={prompt?.id} fixDraft={draft} editable
            onFixed={applyFix} onUndoFix={preFix ? undoFix : undefined} onDismiss={onDismiss} />

          <div style={CARD}>
            <div style={{ ...EYEBROW, marginBottom: 8 }}>Fill-in blanks</div>
            <VariablesTable
              names={names} vars={draft.variables} untrusted={danger?.untrusted_variables ?? []}
              onChange={(n, spec) => set({ variables: { ...draft.variables, [n]: spec } })}
            />
          </div>

          <div style={CARD}>
            <div style={{ ...EYEBROW, marginBottom: 10 }}>How you'll use it</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
              <div>
                <Label htmlFor="p-runs">Times used a day</Label>
                <input id="p-runs" type="number" min={0} style={FIELD}
                  value={draft.runs_per_day ?? ""} placeholder="e.g. 20"
                  onChange={(e) => set({ runs_per_day: e.target.value ? Number(e.target.value) : null })} />
              </div>
              <div>
                <Label htmlFor="p-model">Which AI?</Label>
                <select id="p-model" style={FIELD} value={draft.model ?? ""}
                  onChange={(e) => set({ model: e.target.value || null })}>
                  <option value="">Not sure (show the cheapest)</option>
                  {modelOptions.map((m) => <option key={m} value={m}>{modelName(m)}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <OutputLength tokens={draft.expected_output_tokens} onChange={(t) => set({ expected_output_tokens: t })} />
            </div>
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer", fontSize: "var(--fs-small)", color: "var(--ink-500)" }}>For developers: tools it can use</summary>
              <input aria-label="Tools it can use" style={{ ...FIELD, marginTop: 8 }} value={draft.tools.join(", ")}
                placeholder="gmail.send_email, stripe.create_refund"
                onChange={(e) => set({ tools: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </details>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }} aria-busy={scoring}>
          {cost ? (
            <CostPanel cost={cost} runsPerDay={draft.runs_per_day} preferredModel={draft.model} writing />
          ) : (
            <div style={{ ...CARD, color: "var(--ink-500)", fontSize: "var(--fs-small)" }}>
              Start typing to see what this prompt costs a month.
            </div>
          )}
          {!isNew && (
            <ShareCard prompt={prompt} blocked={blocked} onShare={(v) => void share(v)}
              onUnshare={() => unpublishPrompt(prompt!.id).then((p) => { setPrompt(p); toast("No longer shared") })} />
          )}
        </div>
      </div>
      {sendDialog}
      {guard.sheet}
    </div>
  )
}
