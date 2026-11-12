/**
 * Plain warnings for a prompt (docs/prompts-rework-plan.md §2). Replaces the
 * old "Is it safe?" panel: no ring, number, band, severity word or "tested"
 * label. It shows nothing at all unless something is worth a person's
 * attention (importantWarnings: high or critical problems, or anything that
 * stops the prompt being shared). When it does show, each problem is a short
 * plain sentence, with "Fix it for me" and "Doesn't apply to me" where they
 * make sense.
 *
 *   Editor:     <Warnings danger={danger} promptId={prompt?.id} fixDraft={draft} editable
 *                 onFixed={(r) => applyFix(r)} onUndoFix={preFix ? undoFix : undefined}
 *                 onDismiss={(id, d) => toggleDismiss(id, d)} />
 *   Read view:  <Warnings prompt={prompt} />
 *   Share page: <Warnings prompt={publicPrompt} compact />
 */

import { useId, useMemo, useState } from "react"
import { AlertTriangle, Sparkles, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { toast } from "@/components/shared/Toast"
import { CARD } from "@/components/prompts/ui"
import { importantWarnings, type Warning } from "@/lib/promptFormat"
import {
  dismissReason, fixPrompt,
  type DangerSummary, type FixResult, type Prompt, type PromptDraft,
} from "@/lib/promptsApi"

export interface WarningsProps {
  /** A saved prompt: supplies the warnings, its id and the text to fix. */
  prompt?: Pick<Prompt, "id" | "danger_summary" | "body" | "variables" | "tools"> | null
  /** The warnings to show (wins over prompt.danger_summary, e.g. a live check of an unsaved draft). */
  danger?: DangerSummary | null
  /** Saved prompt id, for "Doesn't apply to me" when there's no onDismiss. */
  promptId?: string | null
  /** The text "Fix it for me" works on (wins over the prompt's saved text). */
  fixDraft?: Pick<PromptDraft, "body" | "variables" | "tools"> | null
  /** The viewer can change this prompt: shows the buttons. */
  editable?: boolean
  /** Apply a fix to the draft. "Fix it for me" only shows when this is passed. */
  onFixed?: (fix: FixResult) => void
  /** Pass while a fix can be undone; shows "Undo" even once nothing is left to warn about. */
  onUndoFix?: () => void
  /** Owns "Doesn't apply to me" (for example to add it to an unsaved draft). Without it, a saved prompt is updated directly. */
  onDismiss?: (reasonId: string, dismissed: boolean) => void | Promise<unknown>
  /** The prompt after a direct "Doesn't apply to me" update. */
  onChanged?: (prompt: Prompt) => void
  /** Small read-only note for share pages and read views. Never shows buttons. */
  compact?: boolean
}

const SENTENCE: React.CSSProperties = { fontSize: "var(--fs-small)", lineHeight: 1.55, color: "var(--ink-600)", margin: 0 }
const LINK_BTN: React.CSSProperties = {
  border: 0, background: "none", padding: 0, cursor: "pointer", font: "inherit",
  fontSize: "var(--fs-small)", color: "var(--ink-500)", textDecoration: "underline", textUnderlineOffset: 2,
}

/** "Personal info in the prompt" → "Personal info in the prompt." */
const asSentence = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

export default function Warnings({
  prompt, danger: dangerProp, promptId: idProp, fixDraft, editable = false,
  onFixed, onUndoFix, onDismiss, onChanged, compact = false,
}: WarningsProps) {
  const danger = dangerProp !== undefined ? dangerProp : prompt?.danger_summary ?? null
  const promptId = idProp ?? prompt?.id ?? null
  const fixText = fixDraft ?? (prompt ? { body: prompt.body, variables: prompt.variables ?? {}, tools: prompt.tools ?? [] } : null)

  // Hidden right away on "Doesn't apply to me", before the new check comes back.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [justDismissed, setJustDismissed] = useState<{ id: string; title: string } | null>(null)
  const [fixing, setFixing] = useState(false)
  const [changes, setChanges] = useState<string[]>([])
  const headingId = useId()
  // The page dropped its undo (saved, or undid the fix): forget the old list.
  if (!onUndoFix && changes.length > 0) setChanges([])

  const all = useMemo(() => importantWarnings(danger), [danger])
  const warnings = all.filter((w) => !hidden.has(w.id))

  const canFix = editable && !compact && !!onFixed && !!fixText && warnings.some((w) => w.fixable)
  const canDismiss = editable && !compact && (!!onDismiss || !!promptId)
  const showUndo = editable && !compact && !!onUndoFix

  async function fix() {
    if (!fixText || !onFixed) return
    setFixing(true)
    try {
      const r = await fixPrompt(fixText)
      if (r.unchanged) { toast("Nothing here that Fix it for me can change. Edit the text yourself."); return }
      setChanges(r.changes ?? [])
      onFixed(r)
      toast("Made it safer. Look over the changes, then save.")
    } catch (e) {
      toast((e as Error).message, "error")
    } finally {
      setFixing(false)
    }
  }

  async function setDismissed(w: Pick<Warning, "id" | "title">, dismissed: boolean) {
    setHidden((h) => { const n = new Set(h); if (dismissed) n.add(w.id); else n.delete(w.id); return n })
    setJustDismissed(dismissed ? { id: w.id, title: w.title } : null)
    try {
      if (onDismiss) await onDismiss(w.id, dismissed)
      else if (promptId) onChanged?.(await dismissReason(promptId, w.id, dismissed))
    } catch (e) {
      setHidden((h) => { const n = new Set(h); if (dismissed) n.delete(w.id); else n.add(w.id); return n })
      setJustDismissed(null)
      toast((e as Error).message || "Couldn't save that. Try again.", "error")
    }
  }

  const undoDismiss = justDismissed && canDismiss ? (
    <p style={{ ...SENTENCE, color: "var(--ink-500)" }} role="status">
      You said “{justDismissed.title}” doesn't apply to you.{" "}
      <button type="button" style={LINK_BTN} onClick={() => void setDismissed(justDismissed, false)}>Undo</button>
    </p>
  ) : null

  const undoFix = showUndo ? (
    <div role="status" style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <p style={{ ...SENTENCE, color: "var(--ink-800)", fontWeight: 600 }}>We changed the prompt to make it safer. Look it over, then save.</p>
        {changes.length > 0 && (
          <ul style={{ ...SENTENCE, listStyle: "disc", paddingLeft: 18, marginTop: 4 }}>{changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
        )}
      </div>
      <Button variant="ghost" size="sm" icon={<Undo2 size={13} />} onClick={onUndoFix}>Undo</Button>
    </div>
  ) : null

  if (warnings.length === 0) {
    if (!undoFix && !undoDismiss) return null
    return <div style={{ ...CARD, display: "flex", flexDirection: "column", gap: 10 }}>{undoFix}{undoDismiss}</div>
  }

  const heading = warnings.length === 1 ? "Read this before you use it" : `Read these ${warnings.length} things before you use it`

  if (compact) {
    return (
      <aside aria-label="Before you use it" style={{
        display: "flex", gap: 10, padding: "12px 14px", borderRadius: "var(--radius-md)",
        background: "var(--high-bg)", border: "1px solid var(--high-line)",
      }}>
        <AlertTriangle size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: "var(--high)" }} />
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          {warnings.map((w) => (
            <li key={w.id} style={{ ...SENTENCE, color: "var(--ink-800)", overflowWrap: "anywhere" }}>
              <b style={{ fontWeight: 600 }}>{asSentence(w.title)}</b> {w.detail}
            </li>
          ))}
        </ul>
      </aside>
    )
  }

  return (
    <section aria-labelledby={headingId} style={{ ...CARD, borderLeft: "3px solid var(--high-line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <AlertTriangle size={16} aria-hidden style={{ flexShrink: 0, color: "var(--high)" }} />
        <h2 id={headingId} style={{ fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--ink-900)", margin: 0, flex: "1 1 200px", minWidth: 0 }}>
          {heading}
        </h2>
        {canFix && (
          <Button size="sm" icon={<Sparkles size={13} />} loading={fixing} onClick={() => void fix()}>Fix it for me</Button>
        )}
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "flex", flexDirection: "column", gap: 12 }}>
        {warnings.map((w) => (
          <li key={w.id} style={{ minWidth: 0 }}>
            <div style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--ink-900)", overflowWrap: "anywhere" }}>{w.title}</div>
            <p style={{ ...SENTENCE, marginTop: 2, overflowWrap: "anywhere" }}>{w.detail}</p>
            {(editable && w.blocksSharing) || (canDismiss && w.dismissable) ? (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "baseline", marginTop: 4 }}>
                {editable && w.blocksSharing && (
                  <span style={{ ...SENTENCE, color: "var(--ink-500)" }}>This has to come out before you can share it.</span>
                )}
                {canDismiss && w.dismissable && (
                  <button type="button" style={LINK_BTN} onClick={() => void setDismissed(w, true)}
                    aria-label={`“${w.title}” doesn't apply to me`}>
                    Doesn't apply to me
                  </button>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {(undoFix || undoDismiss) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line-soft)" }}>
          {undoFix}{undoDismiss}
        </div>
      )}
    </section>
  )
}
