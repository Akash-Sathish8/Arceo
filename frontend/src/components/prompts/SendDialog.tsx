/**
 * Send a prompt to an agent (docs/prompts-rework-plan.md §4).
 *
 *   1. Fill in the blanks (only when the prompt has any).
 *   2. Pick where it goes: Coding agents / App builders / Chat apps. The popular
 *      few show first; "More" opens the full list with a search box. "My
 *      connected agent" sits on top once the person has connected one.
 *
 * Coding agents and app builders can change files and run things, so when the
 * prompt has warnings they're shown before the send, with "Send anyway".
 * The last choice is remembered (agentTargets.rememberTarget). A use is counted
 * once per dialog.
 *
 *   <SendDialog prompt={{ id, title, body, variables, danger_summary }} signedIn onClose={...} />
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  AlertTriangle, ArrowLeft, Blocks, Check, ChevronDown, ChevronUp, Code2, Copy, MessageCircle, Plug, Search, X,
} from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"
import { toast } from "@/components/shared/Toast"
import { EYEBROW, FIELD, Label } from "@/components/prompts/ui"
import { blankName, blankPlaceholder, exampleHint, fillPrompt, importantWarnings, variablesIn } from "@/lib/promptFormat"
import { recordUse, type DangerSummary, type Prompt, type VariableSpec } from "@/lib/promptsApi"
import { listAgentTokens, sendToAgent } from "@/lib/agentApi"
import {
  CONNECTED_SAY, CONNECTED_SLASH, CONNECTED_TARGET, GROUP_LABEL, GROUP_ORDER, TARGETS,
  actsOnComputer, copyText, findTarget, rememberTarget, rememberedTargetId, searchTargets, sendTo,
  type AgentTarget, type SendResult, type TargetGroup,
} from "@/lib/agentTargets"
import { useIsMobile } from "@/lib/useIsMobile"

/** What the dialog needs from a prompt. `id` is "" for an unsaved draft. */
export type SendablePrompt = Pick<Prompt, "id" | "title" | "body"> & {
  variables?: Record<string, VariableSpec> | null
  danger_summary?: DangerSummary | null
  /** The text differs from the saved prompt `id` (an Edit not saved yet). A
   *  connected agent gets the saved text from the server, so it isn't offered. */
  unsaved?: boolean
}

export interface SendDialogProps {
  prompt: SendablePrompt
  /** Signed-in people count uses on the private endpoint and can use a connected agent. */
  signedIn: boolean
  onClose: () => void
  /** Blanks already filled in (for example on the prompt's page). */
  initialValues?: Record<string, string>
  /** Skip straight to choosing an agent even if the prompt has blanks. */
  startAt?: "fill" | "choose"
  /** Open straight on this agent's "Read this before sending" step (SendButton
   *  uses it when the remembered agent needs the warnings shown first). */
  confirmTargetId?: string
  /** Called after each send. */
  onSent?: (target: AgentTarget, result: SendResult | null) => void
}

const GROUP_ICON: Record<TargetGroup, React.ReactNode> = {
  coding: <Code2 size={15} />,
  builder: <Blocks size={15} />,
  chat: <MessageCircle size={15} />,
}

// Blanks that usually hold a paragraph or more get a taller box.
const LONG_BLANK = /email|message|transcript|notes|document|article|page|review|ticket|post|resume|text|error|code|draft|content/i

/** The fill-in-the-blanks fields. Exported so a page can show them inline. */
export function BlankFields({ names, values, onChange, variables, idPrefix = "send" }: {
  names: string[]
  values: Record<string, string>
  onChange: (name: string, value: string) => void
  variables?: Record<string, VariableSpec> | null
  idPrefix?: string
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {names.map((n) => (
        <div key={n}>
          <Label htmlFor={`${idPrefix}-${n}`}>{blankName(n)}</Label>
          <textarea id={`${idPrefix}-${n}`} rows={LONG_BLANK.test(n) ? 5 : 2}
            style={{ ...FIELD, resize: "vertical" }} value={values[n] ?? ""}
            placeholder={exampleHint(variables?.[n]?.sample)}
            onChange={(e) => onChange(n, e.target.value)} />
        </div>
      ))}
    </div>
  )
}

/** Small copy button next to a line of text. */
export function CopyLine({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--radius-md)", padding: "6px 6px 6px 10px", minWidth: 0 }}>
      <code style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: "var(--fs-small)", color: "var(--ink-800)", overflowWrap: "anywhere" }}>{text}</code>
      <Button size="sm" variant="secondary" aria-label={label} icon={done ? <Check size={13} /> : <Copy size={13} />}
        onClick={() => {
          void copyText(text).then((ok) => {
            if (ok) { setDone(true); window.setTimeout(() => setDone(false), 1600) } else toast("Couldn't copy. Select it and copy it.", "error")
          })
        }}>
        {done ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

function TargetButton({ target, last, onPick }: { target: AgentTarget; last: boolean; onPick: (t: AgentTarget) => void }) {
  const hint = target.kind === "mcp" ? "Sends it straight to your agent"
    : target.kind === "link" ? (target.sendsImmediately ? "Opens and asks right away" : "Opens with it filled in")
    : "Copies it for you to paste"
  return (
    <button type="button" onClick={() => onPick(target)}
      className="ag-card"
      style={{
        display: "flex", alignItems: "flex-start", gap: 8, textAlign: "left", cursor: "pointer", minWidth: 0,
        padding: "10px 12px", borderRadius: "var(--radius-md)", font: "inherit", color: "var(--ink-900)",
        background: last ? "var(--accent-soft)" : "var(--card)",
        border: `1px solid ${last ? "var(--accent-line)" : "var(--line)"}`,
      }}>
      <span style={{ color: "var(--ink-500)", marginTop: 1, flexShrink: 0, lineHeight: 0 }}>
        {target.kind === "mcp" ? <Plug size={15} /> : GROUP_ICON[target.group]}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: "var(--fs-body)", fontWeight: 600, overflowWrap: "anywhere" }}>{target.name}</span>
        <span style={{ display: "block", fontSize: "var(--fs-micro)", color: "var(--ink-500)", marginTop: 2 }}>
          {last ? "Last used · " : ""}{hint}
        </span>
      </span>
    </button>
  )
}

const GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 170px), 1fr))", gap: 8 }

type Done = { target: AgentTarget; result: SendResult | null }

export default function SendDialog({ prompt, signedIn, onClose, initialValues, startAt, confirmTargetId, onSent }: SendDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const mobile = useIsMobile()
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const names = useMemo(() => variablesIn(prompt.body), [prompt.body])
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(names.map((n) => [n, initialValues?.[n] ?? ""])))
  const confirmFirst = findTarget(confirmTargetId)
  const [step, setStep] = useState<"fill" | "choose">(() =>
    names.length > 0 && startAt !== "choose" && !confirmFirst ? "fill" : "choose")
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState("")
  const [confirm, setConfirm] = useState<AgentTarget | null>(confirmFirst ?? null)
  const [done, setDone] = useState<Done | null>(null)
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [lastId] = useState(() => rememberedTargetId())
  const counted = useRef(false)

  // An empty blank goes as "[customer email]", never as a silent hole, so the
  // app (and the connected agent) shows what still needs filling in.
  const filled = fillPrompt(prompt.body, values, blankPlaceholder)
  const empty = names.filter((n) => !values[n]?.trim())
  const canConnect = connected && !prompt.unsaved
  const warnings = useMemo(() => importantWarnings(prompt.danger_summary), [prompt.danger_summary])

  // Open as a native modal before first paint: focus stays inside, Escape closes.
  useLayoutEffect(() => {
    const d = ref.current
    if (!d) return
    if (!d.open) {
      try { d.showModal() } catch { d.setAttribute("open", "") }
    }
    d.querySelector<HTMLElement>("textarea, [data-autofocus], button:not([aria-label='Close'])")?.focus()
    const onCancel = (e: Event) => { e.preventDefault(); closeRef.current() }
    d.addEventListener("cancel", onCancel)
    return () => {
      d.removeEventListener("cancel", onCancel)
      if (d.open) d.close()
    }
  }, [])

  // "My connected agent" shows only when the person has a live connection.
  useEffect(() => {
    if (!signedIn || !prompt.id) return
    let live = true
    listAgentTokens()
      .then((ts) => { if (live) setConnected(ts.some((t) => !t.revoked_at)) })
      .catch(() => { /* no connections yet, or the server is older: just don't offer it */ })
    return () => { live = false }
  }, [signedIn, prompt.id])

  function count() {
    if (counted.current || !prompt.id) return  // unsaved drafts have nothing to count
    counted.current = true
    void recordUse(prompt.id, signedIn)
  }

  async function sendConnected() {
    setBusy(true)
    try {
      await sendToAgent(prompt.id, Object.fromEntries(names.map((n) => [n, values[n]?.trim() ? values[n] : blankPlaceholder(n)])))
      rememberTarget(CONNECTED_TARGET.id)
      count()
      setConfirm(null)
      setDone({ target: CONNECTED_TARGET, result: null })
      onSent?.(CONNECTED_TARGET, null)
    } catch (e) {
      toast(`Couldn't send it to your agent. ${e instanceof Error ? e.message : "Try again."}`, "error")
    } finally {
      setBusy(false)
    }
  }

  // Runs straight from the click: sendTo copies and opens before any await.
  function send(target: AgentTarget) {
    if (target.kind === "mcp") { void sendConnected(); return }
    const pending = sendTo(target, filled)
    rememberTarget(target.id)
    count()
    setConfirm(null)
    void pending.then((result) => {
      setDone({ target, result })
      onSent?.(target, result)
    })
  }

  function pick(target: AgentTarget) {
    if (warnings.length > 0 && actsOnComputer(target)) { setConfirm(target); return }
    send(target)
  }

  // ── Lists ──
  const last = findTarget(lastId)
  const lastUsable = last && (last.kind !== "mcp" || canConnect) ? last : undefined
  const searching = expanded && query.trim().length > 0
  const shown = (g: TargetGroup) => {
    const pool = TARGETS.filter((t) => t.group === g)
    if (searching) return searchTargets(query, pool)
    const list = expanded ? pool : pool.filter((t) => t.popular)
    // Keep the last-used one visible even when it's not a popular one.
    if (!expanded && lastUsable && lastUsable.group === g && !list.includes(lastUsable)) return [lastUsable, ...list]
    return list
  }
  const anyFound = GROUP_ORDER.some((g) => shown(g).length > 0)

  const title = `Send “${prompt.title || "this prompt"}”`
  const headId = "send-dialog-title"

  let content: React.ReactNode
  if (done) {
    content = <DoneView done={done} filled={filled} onAgain={() => setDone(null)} onClose={onClose} />
  } else if (confirm) {
    content = (
      <div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 14px", borderRadius: "var(--radius-md)", background: "var(--high-bg)", border: "1px solid var(--high-line)" }}>
          <AlertTriangle size={16} style={{ color: "var(--high)", flexShrink: 0, marginTop: 2 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: "var(--fs-body)", color: "var(--ink-900)" }}>Read this before sending</div>
            <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
              {warnings.map((w) => (
                <li key={w.id} style={{ fontSize: "var(--fs-small)", color: "var(--ink-700)", lineHeight: 1.5 }}>
                  <b style={{ fontWeight: 600 }}>{w.title}.</b> {w.detail}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 10, lineHeight: 1.5 }}>
          {confirm.name} can change files and run things on your computer. Only send it if you're happy with what it asks for.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14, flexDirection: mobile ? "column-reverse" : "row", justifyContent: "flex-end" }}>
          <Button variant="secondary" className={mobile ? "btn--block" : undefined} onClick={() => setConfirm(null)}>Back</Button>
          <Button data-autofocus className={mobile ? "btn--block" : undefined} loading={busy} onClick={() => send(confirm)}>
            Send anyway
          </Button>
        </div>
      </div>
    )
  } else if (step === "fill") {
    content = (
      <div>
        <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: "0 0 14px" }}>
          Fill in the blanks first. What you type stays on your computer until you send it.
        </p>
        <BlankFields names={names} values={values} variables={prompt.variables}
          onChange={(n, v) => setValues((cur) => ({ ...cur, [n]: v }))} />
        <div style={{ ...EYEBROW, marginTop: 16 }}>What the AI will get</div>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-sans)", fontSize: "var(--fs-small)", lineHeight: 1.55, background: "var(--paper-2)", padding: 12, borderRadius: "var(--radius-md)", margin: "6px 0 0", maxHeight: 200, overflow: "auto", color: "var(--ink-800)" }}>
          {filled}
        </pre>
        {empty.length > 0 && (
          <p style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", marginTop: 6 }}>
            Still blank: {empty.map(blankName).join(", ")}. {empty.length === 1 ? "It goes" : "They go"} in [brackets] so you can fill {empty.length === 1 ? "it" : "them"} in there.
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <Button className={mobile ? "btn--block" : undefined} onClick={() => setStep("choose")}>Next: choose where to send it</Button>
        </div>
      </div>
    )
  } else {
    content = (
      <div>
        {names.length > 0 && (
          <button type="button" onClick={() => setStep("fill")}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, border: 0, background: "none", padding: 0, cursor: "pointer", font: "inherit", fontSize: "var(--fs-small)", color: "var(--ink-500)", marginBottom: 10 }}>
            <ArrowLeft size={13} /> Back to the blanks{empty.length > 0 ? ` (${empty.length} still empty)` : ""}
          </button>
        )}
        {connected && prompt.unsaved && !searching && (
          <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: "0 0 12px", lineHeight: 1.5 }}>
            Save your changes first to send this to your connected agent.
          </p>
        )}
        {canConnect && !searching && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ ...EYEBROW, marginBottom: 6 }}>Your agent</div>
            <div style={GRID}>
              <TargetButton target={CONNECTED_TARGET} last={lastUsable?.id === CONNECTED_TARGET.id} onPick={pick} />
            </div>
            <p style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)", marginTop: 6 }}>
              Kept for 24 hours so your agent can pick it up.
            </p>
          </div>
        )}
        {expanded && (
          <div style={{ marginBottom: 12 }}>
            <Input icon={<Search size={14} />} placeholder="Search apps and agents" value={query} aria-label="Search apps and agents"
              autoFocus onChange={(e) => setQuery(e.target.value)} />
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {GROUP_ORDER.map((g) => {
            const list = shown(g)
            if (!list.length) return null
            return (
              <section key={g} aria-label={GROUP_LABEL[g]}>
                <div style={{ ...EYEBROW, marginBottom: 6 }}>{GROUP_LABEL[g]}</div>
                <div style={GRID}>
                  {list.map((t) => <TargetButton key={t.id} target={t} last={lastUsable?.id === t.id} onPick={pick} />)}
                </div>
              </section>
            )
          })}
          {!anyFound && (
            <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: 0 }}>
              Nothing called “{query.trim()}”. You can still copy the prompt and paste it anywhere.
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 14 }}>
          <Button variant="ghost" size="sm" icon={expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            aria-expanded={expanded}
            onClick={() => { setExpanded((v) => !v); setQuery("") }}>
            {expanded ? "Fewer" : `More (${TARGETS.length} in all)`}
          </Button>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" size="sm" icon={<Copy size={13} />}
            onClick={() => {
              void copyText(filled).then((ok) => {
                if (ok) { count(); toast("Copied. Paste it into any AI app.") } else toast("Couldn't copy automatically. Select the text and copy it.", "error")
              })
            }}>
            Just copy it
          </Button>
        </div>
      </div>
    )
  }

  return createPortal(
    <dialog ref={ref} aria-labelledby={headId}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        border: 0, margin: 0, inset: 0, width: "100%", height: "100%", maxWidth: "100%", maxHeight: "100%",
        boxSizing: "border-box", padding: mobile ? 0 : 16, background: "rgba(15,15,15,0.4)", color: "var(--ink-900)",
        display: "flex", alignItems: mobile ? "flex-end" : "center", justifyContent: "center", overflow: "auto",
      }}>
      <div style={{
        width: "100%", maxWidth: mobile ? "100%" : 640, maxHeight: mobile ? "92%" : "90vh", overflow: "auto", boxSizing: "border-box",
        background: "var(--card)", boxShadow: "var(--shadow-lg)",
        borderRadius: mobile ? "14px 14px 0 0" : 14,
        padding: mobile ? "18px 16px calc(18px + env(safe-area-inset-bottom))" : "20px 24px",
      }}>
        {/* Sticky, so the title and Close stay in view after "More" makes the list long.
            Sticky offsets count from inside the box's padding, so `top` cancels it. */}
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 8, position: "sticky", top: mobile ? -18 : -20, zIndex: 1, background: "var(--card)",
          margin: mobile ? "-18px -16px 4px" : "-20px -24px 4px", padding: mobile ? "18px 16px 8px" : "20px 24px 8px",
        }}>
          <h2 id={headId} style={{ fontSize: "var(--fs-title)", fontWeight: 600, margin: 0, flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose}
            style={{ border: 0, background: "none", cursor: "pointer", color: "var(--ink-400)", padding: 2, lineHeight: 0 }}>
            <X size={18} />
          </button>
        </div>
        {content}
      </div>
    </dialog>,
    document.body,
  )
}

function DoneView({ done, filled, onAgain, onClose }: { done: Done; filled: string; onAgain: () => void; onClose: () => void }) {
  const { target, result } = done
  const mobile = useIsMobile()
  const textRef = useRef<HTMLTextAreaElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)
  const failed = result?.status === "copy-failed"
  // The button that was clicked is gone now: put focus somewhere sensible.
  useEffect(() => {
    if (failed) textRef.current?.select()
    else doneRef.current?.focus()
  }, [failed, done])

  const buttons = (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16, flexDirection: mobile ? "column-reverse" : "row", justifyContent: "flex-end" }}>
      <Button variant="secondary" className={mobile ? "btn--block" : undefined} onClick={onAgain}>Send somewhere else</Button>
      <Button ref={doneRef} data-autofocus className={mobile ? "btn--block" : undefined} onClick={onClose}>Done</Button>
    </div>
  )

  if (target.kind === "mcp") {
    return (
      <div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600, fontSize: "var(--fs-body)" }}>
          <Check size={16} style={{ color: "var(--ink-700)" }} /> Sent. In your agent, say:
        </div>
        <div style={{ marginTop: 10 }}><CopyLine text={CONNECTED_SAY} label="Copy what to say" /></div>
        <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: "12px 0 6px", lineHeight: 1.5 }}>
          In Claude Code you can also type:
        </p>
        <CopyLine text={CONNECTED_SLASH} label="Copy the Claude Code shortcut" />
        <p style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)", marginTop: 10 }}>It waits for your agent for 24 hours.</p>
        {buttons}
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: "var(--fs-body)", lineHeight: 1.5 }}>
        {failed
          ? <AlertTriangle size={16} style={{ color: "var(--high)", flexShrink: 0, marginTop: 3 }} />
          : <Check size={16} style={{ color: "var(--ink-700)", flexShrink: 0, marginTop: 3 }} />}
        <span>{result?.message ?? `Sent to ${target.name}.`}</span>
      </div>
      {failed && (
        <textarea ref={textRef} readOnly value={filled} rows={6} aria-label="The prompt, to copy"
          style={{ ...FIELD, marginTop: 12, resize: "vertical" }} onFocus={(e) => e.currentTarget.select()} />
      )}
      {target.help && !failed && (
        <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 10, lineHeight: 1.5 }}>
          {target.help}
        </p>
      )}
      {buttons}
    </div>
  )
}
