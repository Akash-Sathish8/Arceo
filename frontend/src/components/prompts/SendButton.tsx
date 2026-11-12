/**
 * "Send to Cursor" on library cards and similar-prompt cards (plan §4).
 *
 * One click sends with the agent the person used last, when the prompt has no
 * blanks and nothing to warn about. Otherwise (blanks, warnings, or no agent
 * picked yet) it opens SendDialog. The small arrow opens the dialog to pick a
 * different agent.
 *
 * The prompt is fetched on hover or focus, so the click usually has it already.
 * If not, a web app (which browsers only let a click open) is handled two ways:
 *   - The card said the prompt has no blanks (`hasBlanks={false}`, from the list
 *     row) and has nothing to warn about for this agent: its tab opens inside
 *     the click, empty, and the app's page goes into it once the prompt arrives.
 *   - Otherwise nothing opens early (a tab for a prompt with blanks would only
 *     flash open and shut). When it turns out a web app could have opened in one
 *     click, the dialog opens on "choose", where the next click opens it.
 *
 *   <SendButton promptId={p.id} title={p.title} compact hasBlanks={p.has_blanks} dangerSummary={p.danger_summary} />
 */

import { useState, useSyncExternalStore } from "react"
import { ChevronDown, Send } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { toast } from "@/components/shared/Toast"
import SendDialog from "@/components/prompts/SendDialog"
import { isLoggedIn } from "@/lib/api"
import { sendToAgent } from "@/lib/agentApi"
import { importantWarnings, variablesIn } from "@/lib/promptFormat"
import { getPrompt, getPublicPrompt, recordUse, type DangerSummary, type Prompt } from "@/lib/promptsApi"
import {
  CONNECTED_SAY, actsOnComputer, findTarget, isAppLink, rememberedTargetId, sendTo, subscribeRememberedTarget,
  type AgentTarget,
} from "@/lib/agentTargets"

export interface SendButtonProps {
  promptId: string
  title: string
  /** Smaller, for cards. */
  compact?: boolean
  /** Defaults to whether someone is signed in. Signed-out viewers (share pages)
   *  load the public copy and can't use a connected agent. */
  signedIn?: boolean
  /** From a list row, before the prompt itself has loaded: false lets a web app
   *  open in one click even when the click beats the prompt (see the note above).
   *  Leave it out when it isn't known. */
  hasBlanks?: boolean
  /** The list row's warnings, read with hasBlanks. */
  dangerSummary?: DangerSummary | null
}

// ── Prompt cache: one fetch per prompt, shared by every button on the page ──

const TTL_MS = 5 * 60_000
interface Entry { at: number; promise: Promise<Prompt>; value?: Prompt }
const cache = new Map<string, Entry>()

/** Load (or reuse) a prompt. Failed loads are forgotten so the next try refetches. */
export function loadPrompt(id: string, signedIn: boolean): Entry {
  const key = `${signedIn ? "me" : "public"}:${id}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit
  const entry: Entry = { at: Date.now(), promise: Promise.resolve() as unknown as Promise<Prompt> }
  entry.promise = (signedIn ? getPrompt(id) : getPublicPrompt(id)).then(
    (p) => { entry.value = p; return p },
    (e) => { cache.delete(key); throw e },
  )
  // Hover prefetches nobody waits on must not surface as unhandled rejections.
  entry.promise.catch(() => {})
  cache.set(key, entry)
  return entry
}

/** Whether sending to this target opens a normal web page in a new tab (which
 *  browsers only allow straight from a click). False for app links and copy-only. */
export function opensWebTab(target: AgentTarget): boolean {
  if (target.kind === "link") return !isAppLink(target.build("x"))
  if (target.kind === "copy-open") { const u = target.build(""); return !!u && !isAppLink(u) }
  return false
}

/** What one click can't do on its own: blanks to fill, or warnings to read first. */
export function needsDialog(p: Pick<Prompt, "body" | "danger_summary">, t: AgentTarget): "fill" | "confirm" | null {
  if (variablesIn(p.body).length > 0) return "fill"
  if (actsOnComputer(t) && importantWarnings(p.danger_summary).length > 0) return "confirm"
  return null
}

/** Whether to open the app's tab inside the click, before the prompt arrives:
 *  only when the list row says one click will do (no blanks, no warnings to
 *  show this agent) and the app opens from a link carrying the prompt. Apps that
 *  need the prompt copied aren't opened early: the new tab takes the focus the
 *  copy needs. */
export function opensEarly(row: { hasBlanks?: boolean; dangerSummary?: DangerSummary | null }, t: AgentTarget | undefined): boolean {
  if (row.hasBlanks !== false || !t || t.kind !== "link" || !opensWebTab(t)) return false
  return !(actsOnComputer(t) && importantWarnings(row.dangerSummary).length > 0)
}

/** What to do once a prompt that wasn't loaded at click time arrives. "choose"
 *  opens the dialog on the agent list: the click's permission to open a tab
 *  has likely run out, and the dialog's next click has it. With `tabOpen` (a
 *  tab was opened in the click, see opensEarly) a web app is sent into it. */
export function afterLoad(p: Pick<Prompt, "body" | "danger_summary">, t: AgentTarget | undefined, tabOpen = false): "dialog" | "connected" | "choose" | "send" {
  if (!t || needsDialog(p, t)) return "dialog"
  if (t.kind === "mcp") return "connected"
  return opensWebTab(t) && !tabOpen ? "choose" : "send"
}

/** An empty tab, opened inside a click so the app's page can go in it later. */
function openBlankTab(): Window | null {
  let win: Window | null = null
  try { win = window.open("", "_blank") } catch { return null }
  try {
    if (win) {
      win.document.title = "Opening…"
      win.document.body.style.cssText = "font:15px system-ui,sans-serif;color:#555;padding:24px"
      win.document.body.textContent = "Opening…"
    }
  } catch { /* still a usable tab */ }
  return win
}

/** The button's words: "Send to Cursor", "Send to my agent", or "Send to…". */
export function sendLabel(t: AgentTarget | undefined): string {
  if (!t) return "Send to…"
  return t.kind === "mcp" ? "Send to my agent" : `Send to ${t.name}`
}

export default function SendButton({ promptId, title, compact = false, signedIn: signedInProp, hasBlanks, dangerSummary }: SendButtonProps) {
  const signedIn = signedInProp ?? isLoggedIn()
  const rememberedId = useSyncExternalStore(subscribeRememberedTarget, rememberedTargetId, () => null)
  const remembered = findTarget(rememberedId)
  // A connected agent needs a signed-in person and a saved prompt.
  const target = remembered && (remembered.kind !== "mcp" || signedIn) ? remembered : undefined

  const [dialog, setDialog] = useState<{ prompt: Prompt; confirmTargetId?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const prefetch = () => { if (promptId) loadPrompt(promptId, signedIn) }

  function openDialog(p: Prompt, t?: AgentTarget) {
    const why = t ? needsDialog(p, t) : null
    setDialog({ prompt: p, confirmTargetId: why === "confirm" ? t!.id : undefined })
  }

  async function sendConnected(p: Prompt) {
    setBusy(true)
    try {
      await sendToAgent(p.id, {})
      void recordUse(p.id, signedIn)
      toast(`Sent. In your agent, say: ${CONNECTED_SAY}`)
    } catch (e) {
      toast(`Couldn't send it to your agent. ${e instanceof Error ? e.message : "Try again."}`, "error")
    } finally {
      setBusy(false)
    }
  }

  function finishSend(p: Prompt, t: AgentTarget, win?: Window | null) {
    void sendTo(t, p.body, { win }).then((r) => {
      if (r.status === "copy-failed") {
        // Copying needs a fresh click once the page has waited; let them do it in the dialog.
        toast(r.message, "error")
        setDialog({ prompt: p })
        return
      }
      void recordUse(p.id, signedIn)
      const help = r.url && isAppLink(r.url) && t.help ? ` ${t.help}` : ""
      toast(`${r.message}${help}`)
    })
  }

  async function onSend() {
    if (!promptId) return
    const entry = loadPrompt(promptId, signedIn)

    // Fast path: the prompt is already here, so everything happens inside the click.
    if (entry.value) {
      const p = entry.value
      if (!target || needsDialog(p, target)) { openDialog(p, target); return }
      if (target.kind === "mcp") { void sendConnected(p); return }
      finishSend(p, target)
      return
    }

    // Slow path: wait for the prompt, then decide (see the note at the top).
    const tab = opensEarly({ hasBlanks, dangerSummary }, target) ? openBlankTab() : null
    setBusy(true)
    let p: Prompt
    try {
      p = await entry.promise
    } catch (e) {
      tab?.close()
      toast(`Couldn't load this prompt. ${e instanceof Error ? e.message : "Try again."}`, "error")
      return
    } finally {
      setBusy(false)
    }
    const next = afterLoad(p, target, !!tab && !tab.closed)
    if (next === "send") { finishSend(p, target!, tab); return }
    tab?.close()   // the prompt changed since the list loaded (now has blanks or warnings)
    if (next === "dialog") openDialog(p, target)
    else if (next === "choose") setDialog({ prompt: p })
    else void sendConnected(p)
  }

  async function onChoose() {
    if (!promptId) return
    const entry = loadPrompt(promptId, signedIn)
    if (entry.value) { setDialog({ prompt: entry.value }); return }
    setBusy(true)
    try {
      setDialog({ prompt: await entry.promise })
    } catch (e) {
      toast(`Couldn't load this prompt. ${e instanceof Error ? e.message : "Try again."}`, "error")
    } finally {
      setBusy(false)
    }
  }

  const label = sendLabel(target)
  const size = compact ? "sm" : "md"

  return (
    // Cards are clickable themselves: keep clicks and keys (also from inside the
    // dialog, which React bubbles through this tree) from opening the card.
    <span
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerEnter={prefetch}
      onFocus={prefetch}
      style={{ display: "inline-flex", alignItems: "stretch", gap: 1, maxWidth: "100%", minWidth: 0 }}
    >
      <Button size={size} icon={<Send size={compact ? 13 : 14} />} loading={busy}
        title={`${label}: “${title}”`}
        aria-label={`${label}: ${title}`}
        onClick={() => { void onSend() }}
        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0, minWidth: 0, maxWidth: "100%" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: compact ? 150 : 220 }}>{label}</span>
      </Button>
      <Button size={size} aria-label={`Choose where to send “${title}”`} title="Choose where to send it"
        onClick={() => { void onChoose() }} disabled={busy}
        style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingLeft: 8, paddingRight: 8 }}>
        <ChevronDown size={compact ? 13 : 14} />
      </Button>
      {dialog && (
        <SendDialog prompt={dialog.prompt} signedIn={signedIn} confirmTargetId={dialog.confirmTargetId}
          onClose={() => setDialog(null)} />
      )}
    </span>
  )
}
