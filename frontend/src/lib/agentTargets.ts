/**
 * Every place a prompt can be sent: coding agents, app builders and chat apps.
 * The single registry for the Send button, the Send dialog and the Connect page
 * (docs/prompts-rework-plan.md §4 and §5).
 *
 * Three kinds of target:
 *   - "link":      the app documents a URL that opens it with the prompt typed
 *                  in. One click, then the person presses Enter there (every
 *                  vendor stops short of running it, on purpose).
 *   - "copy-open": no documented link. We copy the prompt, then open the app
 *                  (when it has a documented way to open at all) and tell the
 *                  person to paste. The prompt is NEVER put in these URLs.
 *   - "mcp":       the person's own connected agent (an Arceo connection); the
 *                  dialog sends through the server instead of a link.
 *
 * Each "link" target names the vendor doc it comes from in `docs`. Targets with
 * `verify: true` must be clicked for real on a Mac before shipping; any that
 * fail become "copy-open".
 *
 * sendTo() is the one function that acts: it copies and opens synchronously
 * inside the click (popup blockers and the clipboard both need that), falls
 * back to copy-open when a prompt is too long for a link, and returns what
 * happened so the UI can show a toast.
 */

import LZString from "lz-string"

export type TargetGroup = "coding" | "builder" | "chat"
export type TargetKind = "link" | "copy-open" | "mcp"

export interface AgentTarget {
  id: string
  name: string
  group: TargetGroup
  kind: TargetKind
  /** The URL to open. For "link" it carries the prompt; for "copy-open" it
   *  ignores the text and returns the app's plain address ("" when the app has
   *  no documented way to be opened from a web page). */
  build: (text: string) => string
  /** The app's plain address, without the prompt. Opened after copying when a
   *  link target falls back to copy-open (prompt too long). */
  openUrl?: string
  /** Most prompt characters the app's link accepts (its docs' limit). */
  maxLen?: number
  /** Longest whole link we'll open (servers and browsers reject longer ones).
   *  Defaults to DEFAULT_MAX_URL. */
  maxUrlLen?: number
  /** A gentle line for when nothing seems to happen. */
  help?: string
  /** Where to paste, for copy-open: "in Cascade", "in your terminal". */
  pasteWhere?: string
  /** Vendor documentation the link format comes from. */
  docs?: string
  /** Shown before "More" so the first list is short. */
  popular: boolean
  /** Not confirmed by a real click on a Mac yet. */
  verify?: boolean
  /** Date a real click on a Mac confirmed the prompt arrives (YYYY-MM-DD). */
  verifiedOn?: string
  /** The app asks right away instead of waiting for Enter (Perplexity). */
  sendsImmediately?: boolean
  /** A known bug in the app's link handling can lose part of this text, so we
   *  also copy the prompt as a safety net. */
  copyAlso?: (text: string) => boolean
}

export const GROUP_LABEL: Record<TargetGroup, string> = {
  coding: "Coding agents",
  builder: "App builders",
  chat: "Chat apps",
}

export const GROUP_ORDER: readonly TargetGroup[] = ["coding", "builder", "chat"]

/** Longest link we open when a target doesn't say otherwise. Most web servers
 *  refuse request lines past 8 KB. */
export const DEFAULT_MAX_URL = 8000
/** Links handed to the operating system (custom schemes) aren't sent to a
 *  server, but very long ones still fail on some systems. */
const APP_MAX_URL = 32000

/** Text with any half of an emoji (a lone surrogate, which some apps leave
 *  behind when text is cut) swapped for "\uFFFD". encodeURIComponent throws on
 *  those, which would make a Send click do nothing at all. */
export function wellFormed(text: string): string {
  // A pair stays whole; any surrogate left over is a broken half. (No regex
  // lookbehind: older Safari can't parse it.)
  return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : "\uFFFD"))
}

/** encodeURIComponent: spaces become %20 (never "+", which Cursor shows
 *  literally), "&" becomes %26, "#" %23, newlines %0A. Never throws. */
const enc = (text: string) => encodeURIComponent(wellFormed(text))

const link = (base: string) => (text: string) => base + enc(text)
const fixed = (url: string) => () => url

// ── Coding agents ────────────────────────────────────────────────────────────

const CODING: AgentTarget[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    group: "coding",
    kind: "link",
    // "q: Text to pre-fill in the prompt box. URL-encode the value. Use %0A for
    // line breaks. Maximum 5,000 characters." Not sent until the person presses Enter.
    docs: "https://code.claude.com/docs/en/deep-links",
    build: link("claude-cli://open?q="),
    openUrl: "claude-cli://open",
    maxLen: 5000,
    maxUrlLen: APP_MAX_URL,
    help: "Nothing happened? Open Claude Code once and send it any message, then try again.",
    popular: true,
    verifiedOn: "2026-11-12",
  },
  {
    id: "cursor",
    name: "Cursor",
    group: "coding",
    kind: "link",
    // "Deeplink URLs have a maximum length of 10,000 characters" (after encoding);
    // older docs and forum reports say 8,000, so we stay under that. Web form:
    // https://cursor.com/link/prompt?text= (see CURSOR_WEB_PROMPT).
    docs: "https://cursor.com/docs/integrations/deeplinks",
    build: link("cursor://anysphere.cursor-deeplink/prompt?text="),
    maxUrlLen: 8000,
    help: "Nothing happened? Make sure Cursor is installed, open it once, then try again.",
    pasteWhere: "in Cursor's chat",
    popular: true,
    verify: true,
    // Forum reports (Cursor 1.7, macOS) say text after "&" goes missing even
    // when it's correctly sent as %26. Copy the prompt too, so nothing is lost.
    // https://forum.cursor.com/t/cursor-looses-the-data-after-in-deeplinks/135681
    copyAlso: (text) => text.includes("&"),
  },
  {
    id: "codex",
    name: "Codex",
    group: "coding",
    kind: "link",
    // "prompt sets the initial composer text"; example
    // codex://threads/new?prompt=Show%20me%20some%20fun%20stats...
    docs: "https://learn.chatgpt.com/docs/reference/commands",
    build: link("codex://threads/new?prompt="),
    openUrl: "codex://threads/new",
    maxUrlLen: APP_MAX_URL,
    help: "Nothing happened? This opens the Codex app. Install it, open it once, then try again.",
    popular: true,
    verify: true,
  },
  {
    id: "vscode-copilot",
    name: "VS Code (Copilot)",
    group: "coding",
    kind: "link",
    // VS Code's own docs link "Ask in VS Code" as
    // vscode://GitHub.Copilot-Chat/chat?prompt=...; the handler
    // (src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts)
    // passes `prompt` as the chat box's inputValue: typed in, not sent.
    docs: "https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
    build: link("vscode://GitHub.Copilot-Chat/chat?prompt="),
    maxUrlLen: APP_MAX_URL,
    help: "Nothing happened? Open VS Code once with Copilot turned on, then try again.",
    pasteWhere: "in Copilot Chat",
    popular: true,
    verify: true,
  },
  {
    id: "claude-desktop-code",
    name: "Claude Code (desktop app)",
    group: "coding",
    kind: "link",
    // claude://code/new: "Optional q (alias prompt)... Text is truncated to roughly
    // 14,000 characters." Opens with the composer filled in, not sent.
    docs: "https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link",
    build: link("claude://code/new?q="),
    openUrl: "claude://code/new",
    maxLen: 14000,
    maxUrlLen: APP_MAX_URL,
    help: "Nothing happened? This opens the Claude desktop app. Install it, then try again.",
    popular: false,
    verify: true,
  },
  {
    id: "claude-code-web",
    name: "Claude Code on the web",
    group: "coding",
    kind: "link",
    // "Pre-fill sessions": prompt (alias q) prefills the input box.
    docs: "https://code.claude.com/docs/en/web-quickstart#pre-fill-sessions",
    build: link("https://claude.ai/code?prompt="),
    openUrl: "https://claude.ai/code",
    help: "Pick the project to work on, then press Enter.",
    popular: false,
    verifiedOn: "2026-11-12",
  },
  {
    id: "claude-code-vscode",
    name: "Claude Code in VS Code",
    group: "coding",
    kind: "link",
    // vscode://anthropic.claude-code/open?prompt=: "pre-filled but not submitted automatically."
    docs: "https://code.claude.com/docs/en/vs-code",
    build: link("vscode://anthropic.claude-code/open?prompt="),
    openUrl: "vscode://anthropic.claude-code/open",
    maxUrlLen: APP_MAX_URL,
    help: "Nothing happened? Install the Claude Code extension in VS Code, then try again.",
    popular: false,
    verify: true,
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    group: "coding",
    kind: "link",
    // Used by GitHub's own docs for "Run this prompt in Copilot Chat"
    // (changelog 2025-12-17, dynamic Copilot prompts on GitHub Docs).
    docs: "https://github.blog/changelog/2025-12-17-dynamic-copilot-prompts-on-github-docs",
    build: link("https://github.com/copilot?prompt="),
    openUrl: "https://github.com/copilot",
    popular: false,
    verifiedOn: "2026-11-12",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    group: "coding",
    kind: "copy-open",
    // windsurf://cascade/newChat?prompt= appears only in a GitHub issue, and
    // Windsurf is now Devin Desktop; no documented prompt link. Opening the
    // app's scheme just brings it forward (VS Code-based apps).
    build: fixed("windsurf://"),
    pasteWhere: "in Cascade",
    help: "Open Windsurf (now Devin Desktop), click into Cascade, and paste.",
    popular: false,
    verify: true,
  },
  {
    id: "copilot-agent",
    name: "GitHub Copilot coding agent",
    group: "coding",
    kind: "copy-open",
    // ghapp://session/new takes a prompt but requires a repo we can't know.
    build: fixed("https://github.com/copilot/agents"),
    pasteWhere: "in the task box",
    popular: false,
  },
  {
    id: "codex-web",
    name: "Codex on the web",
    group: "coding",
    kind: "copy-open",
    build: fixed("https://chatgpt.com/codex"),
    pasteWhere: "in the task box",
    popular: false,
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    group: "coding",
    kind: "copy-open",
    build: fixed(""),
    pasteWhere: "in your terminal after starting gemini",
    popular: false,
  },
  {
    id: "zed",
    name: "Zed",
    group: "coding",
    kind: "copy-open",
    build: fixed(""),
    pasteWhere: "in Zed's agent panel",
    popular: false,
  },
  {
    id: "kiro",
    name: "Kiro",
    group: "coding",
    kind: "copy-open",
    build: fixed("kiro://"),
    pasteWhere: "in Kiro's chat (Cmd+L)",
    popular: false,
    verify: true,
  },
  {
    id: "trae",
    name: "Trae",
    group: "coding",
    kind: "copy-open",
    build: fixed("trae://"),
    pasteWhere: "in Trae's chat",
    popular: false,
    verify: true,
  },
  {
    id: "jetbrains",
    name: "JetBrains (Junie, AI Assistant)",
    group: "coding",
    kind: "copy-open",
    build: fixed(""),
    pasteWhere: "in Junie or AI Assistant",
    popular: false,
  },
  { id: "cline", name: "Cline", group: "coding", kind: "copy-open", build: fixed(""), pasteWhere: "in Cline's chat", popular: false },
  { id: "roo-code", name: "Roo Code", group: "coding", kind: "copy-open", build: fixed(""), pasteWhere: "in Roo Code's chat", popular: false },
  { id: "continue", name: "Continue", group: "coding", kind: "copy-open", build: fixed(""), pasteWhere: "in Continue's chat", popular: false },
  { id: "aider", name: "Aider", group: "coding", kind: "copy-open", build: fixed(""), pasteWhere: "in your terminal after starting aider", popular: false },
  { id: "amp", name: "Amp", group: "coding", kind: "copy-open", build: fixed("https://ampcode.com/"), pasteWhere: "in a new thread", popular: false },
  {
    id: "warp",
    name: "Warp",
    group: "coding",
    kind: "copy-open",
    // Documented: warp://action/new_tab opens a new tab. No prompt parameter.
    docs: "https://docs.warp.dev/terminal/more-features/uri-scheme",
    build: fixed("warp://action/new_tab"),
    pasteWhere: "in the new tab",
    popular: false,
    verify: true,
  },
  { id: "devin", name: "Devin", group: "coding", kind: "copy-open", build: fixed("https://app.devin.ai/"), pasteWhere: "in a new session", popular: false },
  { id: "jules", name: "Jules", group: "coding", kind: "copy-open", build: fixed("https://jules.google.com/"), pasteWhere: "in the task box", popular: false },
]

// ── App builders ─────────────────────────────────────────────────────────────

const BUILDERS: AgentTarget[] = [
  {
    id: "lovable",
    name: "Lovable",
    group: "builder",
    kind: "link",
    // https://lovable.dev/#prompt=...: "Maximum 50,000 characters. If a prompt
    // exceeds this, Lovable discards the whole link." Opens unsent. The part
    // after # never reaches a server, so only the browser limits its length.
    docs: "https://docs.lovable.dev/integrations/build-with-url",
    build: link("https://lovable.dev/#prompt="),
    openUrl: "https://lovable.dev/",
    maxLen: 50000,
    maxUrlLen: 200000,
    popular: true,
    verifiedOn: "2026-11-12",
  },
  {
    id: "replit",
    name: "Replit",
    group: "builder",
    kind: "link",
    // https://replit.com/?stack=Build&prompt=<LZString.compressToEncodedURIComponent(prompt)>.
    // stack must be Design or Build; the uncompressed prompt can be up to 50,000
    // characters, but long links can still hit "URL too long".
    docs: "https://docs.replit.com/references/integrations/open-in-replit",
    build: (text) => `https://replit.com/?stack=Build&prompt=${LZString.compressToEncodedURIComponent(text)}`,
    openUrl: "https://replit.com/",
    maxLen: 50000,
    popular: true,
    verifiedOn: "2026-11-12",
  },
  {
    id: "bolt",
    name: "Bolt",
    group: "builder",
    kind: "copy-open",
    // No documented prompt parameter.
    build: fixed("https://bolt.new/"),
    pasteWhere: "in the prompt box",
    popular: true,
  },
  {
    id: "v0",
    name: "v0",
    group: "builder",
    kind: "copy-open",
    // ?q= is undocumented and reported to send right away, so we don't use it.
    build: fixed("https://v0.app/"),
    pasteWhere: "in the prompt box",
    popular: true,
  },
  { id: "base44", name: "Base44", group: "builder", kind: "copy-open", build: fixed("https://base44.com/"), pasteWhere: "in the prompt box", popular: false },
  { id: "same", name: "Same", group: "builder", kind: "copy-open", build: fixed("https://same.new/"), pasteWhere: "in the prompt box", popular: false },
  { id: "anything", name: "Anything", group: "builder", kind: "copy-open", build: fixed("https://www.createanything.com/"), pasteWhere: "in the prompt box", popular: false },
  { id: "rork", name: "Rork", group: "builder", kind: "copy-open", build: fixed("https://rork.com/"), pasteWhere: "in the prompt box", popular: false },
  { id: "bubble", name: "Bubble", group: "builder", kind: "copy-open", build: fixed("https://bubble.io/"), pasteWhere: "in the AI app generator", popular: false },
  { id: "softgen", name: "Softgen", group: "builder", kind: "copy-open", build: fixed("https://softgen.ai/"), pasteWhere: "in the prompt box", popular: false },
  { id: "tempo", name: "Tempo", group: "builder", kind: "copy-open", build: fixed("https://www.tempo.new/"), pasteWhere: "in the prompt box", popular: false },
  { id: "mocha", name: "Mocha", group: "builder", kind: "copy-open", build: fixed("https://getmocha.com/"), pasteWhere: "in the prompt box", popular: false },
  { id: "figma-make", name: "Figma Make", group: "builder", kind: "copy-open", build: fixed("https://www.figma.com/make/"), pasteWhere: "in the prompt box", popular: false },
]

// ── Chat apps ────────────────────────────────────────────────────────────────

const CHAT: AgentTarget[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    group: "chat",
    kind: "link",
    // Long-standing and very widely used (the app's own "Open in ChatGPT").
    build: link("https://chatgpt.com/?q="),
    openUrl: "https://chatgpt.com/",
    popular: true,
    verifiedOn: "2026-11-12",
  },
  {
    id: "claude",
    name: "Claude",
    group: "chat",
    kind: "link",
    // The desktop app documents claude://claude.ai/new with "Optional q prefills
    // the prompt field"; the website takes the same path and parameter.
    docs: "https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link",
    build: link("https://claude.ai/new?q="),
    openUrl: "https://claude.ai/new",
    popular: true,
    verifiedOn: "2026-11-12",
  },
  {
    id: "gemini",
    name: "Gemini",
    group: "chat",
    kind: "copy-open",
    // No documented way to fill in a prompt from a link.
    build: fixed("https://gemini.google.com/app"),
    pasteWhere: "in the chat box",
    popular: true,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    group: "chat",
    kind: "link",
    // The browser search-engine address (/search?q= now redirects to /search/new?q=).
    build: link("https://www.perplexity.ai/search/new?q="),
    openUrl: "https://www.perplexity.ai/",
    popular: false,
    // Checked 2026-11-12: Perplexity runs the search as soon as the link opens.
    sendsImmediately: true,
    verifiedOn: "2026-11-12",
  },
  {
    id: "grok",
    name: "Grok",
    group: "chat",
    kind: "link",
    // Widely used (browser search add-ons); not in xAI's docs.
    build: link("https://grok.com/?q="),
    openUrl: "https://grok.com/",
    popular: false,
    verifiedOn: "2026-11-12",
  },
  { id: "microsoft-copilot", name: "Microsoft Copilot", group: "chat", kind: "copy-open", build: fixed("https://copilot.microsoft.com/"), pasteWhere: "in the chat box", popular: false },
  { id: "meta-ai", name: "Meta AI", group: "chat", kind: "copy-open", build: fixed("https://www.meta.ai/"), pasteWhere: "in the chat box", popular: false },
  { id: "mistral", name: "Mistral Le Chat", group: "chat", kind: "copy-open", build: fixed("https://chat.mistral.ai/chat"), pasteWhere: "in the chat box", popular: false },
  { id: "deepseek", name: "DeepSeek", group: "chat", kind: "copy-open", build: fixed("https://chat.deepseek.com/"), pasteWhere: "in the chat box", popular: false },
  { id: "poe", name: "Poe", group: "chat", kind: "copy-open", build: fixed("https://poe.com/"), pasteWhere: "in the chat box", popular: false },
]

/** Every link and copy-open target, coding agents first. */
export const TARGETS: readonly AgentTarget[] = [...CODING, ...BUILDERS, ...CHAT]

/** The web form of Cursor's prompt link, for pages that can't open app links
 *  (the website mirror). Same limits as the app form. */
export const CURSOR_WEB_PROMPT = "https://cursor.com/link/prompt?text="

/** The person's own agent, connected to Arceo (plan §5). Shown only when they
 *  have an active connection; the Send dialog sends it through the server. */
export const CONNECTED_TARGET: AgentTarget = {
  id: "connected",
  name: "My connected agent",
  group: "coding",
  kind: "mcp",
  build: fixed(""),
  popular: true,
  help: "In your agent, say: run my Arceo prompt",
}

/** What to tell an agent after a send, and the Claude Code shortcut for it. */
export const CONNECTED_SAY = "run my Arceo prompt"
export const CONNECTED_SLASH = "/mcp__arceo__sent"

export function findTarget(id: string | null | undefined): AgentTarget | undefined {
  if (!id) return undefined
  if (id === CONNECTED_TARGET.id) return CONNECTED_TARGET
  return TARGETS.find((t) => t.id === id)
}

/** Name or group search for the "More" list: every word must match. */
export function searchTargets(query: string, targets: readonly AgentTarget[] = TARGETS): AgentTarget[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...targets]
  return targets.filter((t) => {
    const hay = `${t.name} ${t.id.replace(/-/g, " ")} ${GROUP_LABEL[t.group]}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** Coding agents and app builders can change files and run things, so warnings
 *  are shown before sending to them. */
export const actsOnComputer = (t: AgentTarget) => t.group !== "chat"

// ── Remembered choice ────────────────────────────────────────────────────────

const REMEMBER_KEY = "arceo.prompts.sendTarget"
const REMEMBER_EVENT = "arceo:send-target"

/** The last agent this person sent to, or null. Never throws (private mode). */
export function rememberedTargetId(): string | null {
  try {
    const id = typeof localStorage !== "undefined" ? localStorage.getItem(REMEMBER_KEY) : null
    return id && findTarget(id) ? id : null
  } catch {
    return null
  }
}

export function rememberTarget(id: string): void {
  try { localStorage.setItem(REMEMBER_KEY, id) } catch { /* private mode: just don't remember */ }
  try { window.dispatchEvent(new Event(REMEMBER_EVENT)) } catch { /* no window (tests) */ }
}

/** For useSyncExternalStore: every Send button relabels when the choice changes,
 *  in this tab or another. */
export function subscribeRememberedTarget(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  const onStorage = (e: StorageEvent) => { if (e.key === REMEMBER_KEY || e.key === null) onChange() }
  window.addEventListener(REMEMBER_EVENT, onChange)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(REMEMBER_EVENT, onChange)
    window.removeEventListener("storage", onStorage)
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────

export const isAppLink = (url: string) => !!url && !/^https?:/i.test(url)

/** The shortcut to say: Cmd+V on Apple computers, Ctrl+V elsewhere, none on phones. */
export function pasteKeys(): string | null {
  const nav = typeof navigator !== "undefined" ? navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } } : undefined
  if (!nav) return "Ctrl+V"
  const ua = nav.userAgent ?? ""
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(ua)) return null
  const platform = nav.userAgentData?.platform || nav.platform || ua
  return /mac/i.test(platform) ? "Cmd+V" : "Ctrl+V"
}

export type SendReason = "link" | "copy-open" | "too-long" | "link-bug"

export interface SendPlan {
  /** What to open, or null when there's nothing to open. */
  url: string | null
  /** Copy the prompt to the clipboard first. */
  copy: boolean
  reason: SendReason
}

/** What sending `text` to `target` will do. Pure, so every rule is testable. */
export function planSend(target: AgentTarget, rawText: string): SendPlan {
  const text = wellFormed(rawText)
  if (target.kind === "link") {
    const url = target.build(text)
    const tooLong = (target.maxLen != null && text.length > target.maxLen)
      || url.length > (target.maxUrlLen ?? DEFAULT_MAX_URL)
    if (tooLong) return { url: target.openUrl || null, copy: true, reason: "too-long" }
    if (target.copyAlso?.(text)) return { url, copy: true, reason: "link-bug" }
    return { url, copy: false, reason: "link" }
  }
  // copy-open: the prompt never goes in the URL.
  const url = target.kind === "copy-open" ? target.build("") : ""
  return { url: url || null, copy: true, reason: "copy-open" }
}

export interface SendResult {
  /** opened: the app was opened with the prompt in it. copied: the prompt is on
   *  the clipboard to paste. copy-failed: copying didn't work, the person has to
   *  select and copy it. nothing: empty prompt or a connected-agent target. */
  status: "opened" | "copied" | "copy-failed" | "nothing"
  opened: boolean
  copied: boolean
  reason?: SendReason
  url?: string
  /** One plain sentence for a toast. */
  message: string
}

/** The topmost open modal dialog, or <body> when none is open. */
function modalHost(active: HTMLElement | null): HTMLElement {
  let modals: NodeListOf<HTMLDialogElement> | null = null
  try { modals = document.querySelectorAll<HTMLDialogElement>("dialog:modal") } catch { /* no :modal support */ }
  if (modals && modals.length) return modals[modals.length - 1]
  return (active?.closest?.("dialog[open]") as HTMLElement | null) ?? document.body
}

/** Copy with the old synchronous command. It finishes inside the click, so it
 *  still works when the next line opens a tab and the page loses focus (the
 *  async clipboard rejects then). */
export function copySync(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false
  const active = document.activeElement as HTMLElement | null
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.setAttribute("aria-hidden", "true")
  ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none"
  // While a modal <dialog> is open (the Send dialog) everything outside it is
  // inert: a textarea in <body> can't hold a selection, so "copy" reports
  // success but copies nothing. Put it inside the open dialog instead.
  modalHost(active).appendChild(ta)
  let ok = false
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    ok = document.execCommand("copy")
  } catch {
    ok = false
  }
  ta.remove()
  try { active?.focus?.({ preventScroll: true }) } catch { /* ignore */ }
  return ok
}

/** Put text on the clipboard. Returns whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  if (copySync(text)) return true
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Open a URL from a click. App links (custom schemes) go through
 *  location.href, which hands them to the operating system without leaving the
 *  page. Web pages open in a new tab without access back to this one. A tab
 *  opened earlier (to keep the click's permission while the prompt loaded) is
 *  reused. */
export function openUrl(url: string, win?: Window | null): void {
  if (isAppLink(url)) {
    if (win && !win.closed) win.close()
    window.location.href = url
    return
  }
  if (win && !win.closed) {
    try { win.opener = null } catch { /* ignore */ }
    win.location.href = url
    return
  }
  window.open(url, "_blank", "noopener,noreferrer")
}

/** "Paste it in Cascade with Cmd+V." / "Open Zed and paste it in Zed's agent panel with Cmd+V." */
export function pasteSentence(target: AgentTarget, opened: boolean): string {
  const keys = pasteKeys()
  const where = target.pasteWhere ?? (target.group === "chat" ? "in the chat box" : "")
  const verb = opened ? "Paste it" : `Open ${target.name} and paste it`
  return `${[verb, where, keys ? `with ${keys}` : ""].filter(Boolean).join(" ")}.`
}

function copiedMessage(target: AgentTarget, reason: SendReason, opened: boolean): string {
  const lead = reason === "too-long"
    ? `It's too long to open ${target.name} with the prompt in it, so we copied it.`
    : "Copied."
  return `${lead} ${pasteSentence(target, opened)}`
}

/**
 * Send a finished prompt to a target. Call it straight from a click handler:
 * the copy and the open both happen before the first await, which is what
 * popup blockers and the clipboard's user-activation rule require.
 *
 * Pass `win` when a blank tab was opened at click time because the prompt was
 * still loading (SendButton): the page is put in that tab.
 */
export function sendTo(target: AgentTarget, rawText: string, opts: { win?: Window | null } = {}): Promise<SendResult> {
  // Copy and link carry the same text, and neither can throw inside the click.
  const text = wellFormed(rawText)
  if (target.kind === "mcp") {
    opts.win?.close()
    return Promise.resolve({ status: "nothing", opened: false, copied: false, message: "Send to your connected agent from the Send dialog." })
  }
  if (!text.trim()) {
    opts.win?.close()
    return Promise.resolve({ status: "nothing", opened: false, copied: false, message: "There's nothing to send yet." })
  }
  const plan = planSend(target, text)

  // 1. Copy, synchronously when possible (see copySync).
  let copied = plan.copy ? copySync(text) : false
  let pending: Promise<boolean> | null = null
  if (plan.copy && !copied) {
    try {
      pending = navigator.clipboard.writeText(text).then(() => true, () => false)
    } catch {
      pending = Promise.resolve(false)
    }
  }

  // 2. Open, still inside the click.
  let opened = false
  if (plan.url) {
    try {
      openUrl(plan.url, opts.win)
      opened = true
    } catch {
      opened = false
    }
  } else {
    opts.win?.close()
  }

  const finish = (ok: boolean): SendResult => {
    copied = ok
    if (plan.reason === "link-bug" && !copied) {
      // The copy was only a safety net; the link itself went through.
      return {
        status: "opened", opened, copied: false, reason: "link-bug", url: plan.url ?? undefined,
        message: `Opening ${target.name}. Check it over, then press Enter there.`,
      }
    }
    if (plan.copy && !copied) {
      return {
        status: "copy-failed", opened, copied: false, reason: plan.reason, url: plan.url ?? undefined,
        message: `Couldn't copy it automatically. Select the prompt, copy it, and paste it into ${target.name}.`,
      }
    }
    if (plan.reason === "link" && !opened) {
      return { status: "nothing", opened: false, copied: false, reason: "link", message: `Couldn't open ${target.name} from this page.` }
    }
    if (plan.reason === "link") {
      return {
        status: "opened", opened, copied: false, reason: "link", url: plan.url ?? undefined,
        message: target.group === "chat" ? `Opening ${target.name}.` : `Opening ${target.name}. Check it over, then press Enter there.`,
      }
    }
    if (plan.reason === "link-bug") {
      return {
        status: "opened", opened, copied: true, reason: "link-bug", url: plan.url ?? undefined,
        message: `Opening ${target.name}. We also copied the whole prompt, in case part of it is missing there.`,
      }
    }
    return { status: "copied", opened, copied: true, reason: plan.reason, url: plan.url ?? undefined, message: copiedMessage(target, plan.reason, opened) }
  }

  return pending ? pending.then(finish) : Promise.resolve(finish(copied || !plan.copy))
}

// ── Connecting an agent (the Connect page) ───────────────────────────────────

/** Server name agents see. Claude Code turns it into /mcp__arceo__sent. */
export const SERVER_NAME = "arceo"

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export interface ConnectSetup {
  id: string
  name: string
  /** One-click install link, when the app documents one. */
  installUrl?: string
  /** A command to run, or a file snippet to paste. */
  code?: string
  /** "command" runs in a terminal; "file" goes in the named settings file. */
  codeKind?: "command" | "file"
  /** Where it goes / what to do, in plain words. */
  where: string
  docs: string
  popular: boolean
  /** The install link isn't confirmed by a real click on a Mac yet. */
  verify?: boolean
}

/** For settings files that may already list other connections: pasting the
 *  whole snippet next to them would break the file. */
const mergeHint = (section: string) =>
  `If the file already lists other servers, add just the "${SERVER_NAME}" part inside "${section}".`

/** Per-agent setup for connecting to Arceo with a new key. Every format is
 *  from the agent's own docs (linked in `docs`). */
export function connectSetups(url: string, key: string): ConnectSetup[] {
  const auth = `Bearer ${key}`
  const headers = { Authorization: auth }
  const json = (v: unknown) => JSON.stringify(v, null, 2)
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      // claude mcp add --transport http <name> <url> --header "Authorization: Bearer ..."; --scope user = all projects.
      code: `claude mcp add --transport http --scope user ${SERVER_NAME} ${url} --header "Authorization: ${auth}"`,
      codeKind: "command",
      where: "Run this once in your terminal. It works in every project.",
      docs: "https://code.claude.com/docs/en/mcp",
      popular: true,
    },
    {
      id: "cursor",
      name: "Cursor",
      // cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_ENCODED_CONFIG,
      // config = the server object only (Cursor's own example decodes to {"command":"npx",...}),
      // JSON -> base64; we also URL-encode it so base64's + / = survive the query string.
      installUrl: `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(base64(JSON.stringify({ url, headers })))}`,
      code: json({ mcpServers: { [SERVER_NAME]: { url, headers } } }),
      codeKind: "file",
      where: `Click Add to Cursor. Or paste this into ~/.cursor/mcp.json. ${mergeHint("mcpServers")}`,
      docs: "https://cursor.com/docs/context/mcp/install-links",
      popular: true,
      verify: true,
    },
    {
      id: "vscode",
      name: "VS Code",
      // vscode:mcp/install?<encodeURIComponent(JSON {name, type, url, headers})>
      // Not in the current docs pages; it is VS Code's own handler:
      // src/vs/workbench/contrib/mcp/browser/mcpWorkbenchService.ts handleURL ('mcp/install')
      // -> parseMcpInstallUriPayload: JSON.parse(decodeURIComponent(query)), needs a non-empty `name`.
      // `code --add-mcp '<json>'` is documented on the docs page below.
      installUrl: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: "http", url, headers }))}`,
      code: `code --add-mcp '${JSON.stringify({ name: SERVER_NAME, type: "http", url, headers })}'`,
      codeKind: "command",
      where: "Click Add to VS Code. Or run this in your terminal.",
      docs: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
      popular: true,
      verify: true,
    },
    {
      id: "codex",
      name: "Codex",
      code: `[mcp_servers.${SERVER_NAME}]\nurl = "${url}"\nhttp_headers = { "Authorization" = "${auth}" }`,
      codeKind: "file",
      where: "Add this to the end of ~/.codex/config.toml. Keep anything already in the file.",
      docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
      popular: false,
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      code: `gemini mcp add --transport http --scope user --header "Authorization: ${auth}" ${SERVER_NAME} ${url}`,
      codeKind: "command",
      where: "Run this once in your terminal.",
      docs: "https://geminicli.com/docs/tools/mcp-server",
      popular: false,
    },
    {
      id: "windsurf",
      name: "Windsurf (Devin Desktop)",
      code: json({ mcpServers: { [SERVER_NAME]: { url, transport: "http", headers } } }),
      codeKind: "file",
      // Windsurf's docs now redirect to Devin Desktop: user file ~/.config/devin/mcp_config.json,
      // remote server = { url, transport: "http", headers }.
      where: `Add this to ~/.config/devin/mcp_config.json. ${mergeHint("mcpServers")}`,
      docs: "https://docs.devin.ai/desktop/cascade/mcp",
      popular: false,
    },
    {
      id: "zed",
      name: "Zed",
      code: json({ context_servers: { [SERVER_NAME]: { url, headers } } }),
      codeKind: "file",
      where: `Add this to Zed's settings.json. ${mergeHint("context_servers")}`,
      docs: "https://zed.dev/docs/ai/mcp",
      popular: false,
    },
    {
      id: "cline",
      name: "Cline",
      code: json({ mcpServers: { [SERVER_NAME]: { type: "streamableHttp", url, headers } } }),
      codeKind: "file",
      where: `In Cline, open MCP Servers, then Configure, and add this. ${mergeHint("mcpServers")}`,
      docs: "https://docs.cline.bot/mcp/connecting-to-a-remote-server",
      popular: false,
    },
    {
      id: "kiro",
      name: "Kiro",
      code: json({ mcpServers: { [SERVER_NAME]: { url, headers } } }),
      codeKind: "file",
      where: `Add this to ~/.kiro/settings/mcp.json. ${mergeHint("mcpServers")}`,
      docs: "https://kiro.dev/docs/mcp/configuration/",
      popular: false,
    },
    {
      id: "other",
      name: "Any other agent",
      code: json({ mcpServers: { [SERVER_NAME]: { type: "http", url, headers } } }),
      codeKind: "file",
      where: `Most agents take this in their connections settings. ${mergeHint("mcpServers")}`,
      docs: "https://modelcontextprotocol.io/docs/develop/connect-remote-servers",
      popular: false,
    },
  ]
}
