/**
 * "Is this already in the library?" for the adding-a-prompt flow
 * (docs/prompts-rework-plan.md §1, "Where matching shows up", case 1).
 *
 * While typing: useDuplicateCheck / <DuplicateCheck> run a live check 500 ms
 * after the person stops typing, once the text has 8 or more real words, and
 * show one small, calm card under the text box for the best match:
 *   same   "Looks like 'X'"                  [Use that one] [Send to…]    [Keep writing mine]
 *          "Looks like one of yours: 'X'"    [Open mine]    [Send to…]    [Keep writing mine]
 *   close  "Close to 'X'" + what differs      [Open it] [Keep writing mine]
 *   related matches never interrupt here (they live in the Similar prompts row).
 * A live "same" only claims "Already in the library: 'X'" / "You already have
 * this one: 'X'" when it's an exact copy (`exact` from the server) or the match
 * came from the Save check (`checked`): before Save's careful check, the quick
 * check can mistake a reworded prompt that adds or drops a requirement for the
 * same one.
 *
 * On Save: useDuplicateSaveGuard().confirmSaveAgainstDuplicates(draft) runs one
 * careful check and, only when the best match does the same job and the person
 * hasn't already said "Keep writing mine", asks once: "This one's already in
 * the library" [Use that one] [Save mine anyway]. A close match never blocks.
 *
 * "Keep writing mine" is remembered for the browser tab (sessionStorage), so
 * neither the live card nor the Save question brings that prompt up again.
 * The score on a Match orders results only; it is never shown.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { ReactNode } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ExternalLink, Library, X } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { VAR_RE } from "@/lib/promptFormat"
import { matchDraft, type Match, type MatchDraft, type MatchOptions } from "@/lib/similarApi"
import { useIsMobile } from "@/lib/useIsMobile"

// ── Tunables ────────────────────────────────────────────────────────────

/** Wait this long after the last keystroke before checking. */
export const LIVE_DEBOUNCE_MS = 500
/** Don't check until the text has this many real words: a half-typed sentence
 *  matches everything and nothing. */
export const MIN_CONTENT_WORDS = 8
/** A Save never waits longer than this on the check; past it, the save goes ahead. */
export const SAVE_CHECK_TIMEOUT_MS = 8_000

// ── Counting real words ─────────────────────────────────────────────────

// Words that carry no meaning on their own. Kept short on purpose: this only
// decides WHEN to check, the backend does the real matching.
const STOPWORDS = new Set((
  "a an the and or but if then so of to in on at by for with from into onto about as is are was were be been being " +
  "it its this that these those there here i me my we our you your he she they them their his her him " +
  "do does did done can could will would should shall may might must have has had not no yes " +
  "please just also very really some any all each every what which who whom whose when where why how " +
  "than too up down out over under again more most such only own same other"
).split(" "))

/** Real words in a prompt: blanks ({{name}}), punctuation and filler words
 *  ("the", "please", "you") don't count. */
export function contentWordCount(text: string | null | undefined): number {
  const words = (text ?? "").replace(VAR_RE, " ").toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? []
  let n = 0
  for (const w of words) if (!STOPWORDS.has(w.replace(/['’].*$/, "")) && (w.length > 1 || /\d/.test(w))) n++
  return n
}

// ── "Keep writing mine": remembered for this tab ────────────────────────

const KEEP_MINE_KEY = "arceo.prompts.keepMine"
let keepMine: ReadonlySet<string> = loadKeepMine()
const keepMineListeners = new Set<() => void>()

function loadKeepMine(): ReadonlySet<string> {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEEP_MINE_KEY)
    const ids = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [])
  } catch {
    return new Set()
  }
}

/** Don't bring this prompt up again in this tab, live or on Save. */
export function dismissMatch(id: string): void {
  if (keepMine.has(id)) return
  keepMine = new Set([...keepMine, id])
  try { globalThis.sessionStorage?.setItem(KEEP_MINE_KEY, JSON.stringify([...keepMine])) } catch { /* private mode: in-memory only */ }
  keepMineListeners.forEach((l) => l())
}

export const isMatchDismissed = (id: string): boolean => keepMine.has(id)

/** @internal Tests only: forget every "Keep writing mine". */
export function resetDismissedMatches(): void {
  keepMine = new Set()
  try { globalThis.sessionStorage?.removeItem(KEEP_MINE_KEY) } catch { /* ignore */ }
  keepMineListeners.forEach((l) => l())
}

const subscribeKeepMine = (l: () => void) => { keepMineListeners.add(l); return () => { keepMineListeners.delete(l) } }
const getKeepMine = () => keepMine

/** The ids the person said "Keep writing mine" to, re-rendering when it changes. */
export function useDismissedMatches(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeKeepMine, getKeepMine, getKeepMine)
}

// ── Which match deserves to interrupt ───────────────────────────────────

/** The one match worth a card: a "same" if there is one, else a "close".
 *  Never a related match, a copy of the prompt being edited, or one the
 *  person already waved off. */
export function pickInterruption(matches: readonly Match[], dismissed: ReadonlySet<string> = keepMine): Match | null {
  const eligible = matches.filter((m) => !m.copy_of_yours && !dismissed.has(m.id))
  return eligible.find((m) => m.level === "same") ?? eligible.find((m) => m.level === "close") ?? null
}

const MAX_TERMS = 4
const terms = (xs: readonly string[] | null | undefined) =>
  (xs ?? []).filter(Boolean).slice(0, MAX_TERMS).join(" · ")

/** What differs, in plain words: "Yours also: draft a reply", "Theirs also: deadline". */
export function matchDifferences(m: Match): { yoursAlso: string | null; theirsAlso: string | null; note: string | null } {
  return {
    yoursAlso: terms(m.yours_only) || null,
    theirsAlso: terms(m.theirs_only) || null,
    note: m.note?.trim() || null,
  }
}

/** The server says the draft is the same text as this prompt (blanks, pasted
 *  content and wording folded), not just the same job by the quick check. */
export const isExactMatch = (m: Match): boolean => (m as Match & { exact?: boolean }).exact === true

/** The card's one-line headline; also what a screen reader hears. `checked`:
 *  the match came from the Save check rather than the quick one while typing. */
export function matchHeadline(m: Match, opts: { checked?: boolean } = {}): string {
  if (m.level === "same") {
    if (isExactMatch(m) || opts.checked) {
      return m.owned ? `You already have this one: “${m.title}”` : `Already in the library: “${m.title}”`
    }
    return m.owned ? `Looks like one of yours: “${m.title}”` : `Looks like “${m.title}”`
  }
  return m.owned ? `Close to one of yours: “${m.title}”` : `Close to “${m.title}”`
}

// ── Live check: debounce, word gate, stale-request guard ────────────────

export type MatchFetcher = (draft: MatchDraft, opts: MatchOptions) => Promise<Match[]>

export interface LiveCheckState {
  /** Matches for the most recent finished check, best first. */
  matches: Match[]
  /** A check is on its way to the server. */
  checking: boolean
  /** The text is long enough to check at all. */
  enoughWords: boolean
}

const IDLE: LiveCheckState = { matches: [], checking: false, enoughWords: false }

/** What decides whether a new check is needed. Whitespace-only edits and blank
 *  examples don't trigger one; the latest examples still go with each check. */
const draftKey = (d: MatchDraft, excludeId?: string) =>
  JSON.stringify([d.body.replace(/\s+/g, " ").trim(), d.title?.trim() ?? "", d.description?.trim() ?? "", d.use_case ?? "", excludeId ?? ""])

/**
 * The live duplicate check without React, so its timing can be tested.
 * Call update() with every draft; it waits for a pause in typing, skips text
 * that's too short, cancels the request in flight when the text changes, and
 * ignores any answer that arrives for text that's no longer there.
 */
export class LiveDuplicateChecker {
  private state: LiveCheckState = IDLE
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private controller: AbortController | null = null
  private seq = 0
  private key: string | null = null

  constructor(
    private readonly fetcher: MatchFetcher = matchDraft,
    private readonly delayMs = LIVE_DEBOUNCE_MS,
    private readonly minWords = MIN_CONTENT_WORDS,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getState = (): LiveCheckState => this.state

  update(draft: MatchDraft, excludeId?: string): void {
    const key = draftKey(draft, excludeId)
    if (key === this.key) return
    this.key = key
    this.cancel()
    if (contentWordCount(draft.body) < this.minWords) {
      this.set(IDLE)
      return
    }
    // Keep the last answer on screen while the person types: no flicker.
    if (!this.state.enoughWords) this.set({ ...this.state, enoughWords: true })
    const snapshot: MatchDraft = { ...draft }
    this.timer = setTimeout(() => this.run(snapshot, excludeId), this.delayMs)
  }

  /** Stop any pending or in-flight check and forget the last draft (unmount). */
  reset(): void {
    this.cancel()
    this.key = null
  }

  private run(draft: MatchDraft, excludeId?: string): void {
    this.timer = null
    const id = ++this.seq
    const controller = new AbortController()
    this.controller = controller
    this.set({ ...this.state, checking: true })
    let request: Promise<Match[]>
    try {
      request = this.fetcher(draft, { excludeId, k: 5, mode: "live", signal: controller.signal })
    } catch (e) {
      request = Promise.reject(e)
    }
    request.then(
      (matches) => {
        if (id !== this.seq) return                  // the text changed since: stale
        this.controller = null
        this.set({ matches: Array.isArray(matches) ? matches : [], checking: false, enoughWords: true })
      },
      () => {
        if (id !== this.seq) return
        this.controller = null
        // A failed live check is not worth a message; keep what was there.
        this.set({ ...this.state, checking: false })
      },
    )
  }

  private cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.seq++                                       // any answer still on its way is now stale
    if (this.controller) { this.controller.abort(); this.controller = null }
    if (this.state.checking) this.set({ ...this.state, checking: false })
  }

  private set(next: LiveCheckState): void {
    this.state = next
    this.listeners.forEach((l) => l())
  }
}

export interface DuplicateCheckResult extends LiveCheckState {
  /** The match to show in the card, or null for nothing. */
  match: Match | null
  /** "Keep writing mine": hide this match for the rest of the tab. */
  dismiss: (id: string) => void
}

const NOTHING: MatchDraft = { body: "" }

/**
 * Live "already in the library?" check for a draft that's being typed.
 * Pass the whole draft every render; only real changes trigger a check.
 * `excludeId` is the prompt being edited (so it never matches itself).
 * `enabled: false` turns it off (for example on a prompt the person can't edit).
 */
export function useDuplicateCheck(
  draft: MatchDraft,
  opts: { excludeId?: string; enabled?: boolean } = {},
): DuplicateCheckResult {
  const [checker] = useState(() => new LiveDuplicateChecker())
  const state = useSyncExternalStore(checker.subscribe, checker.getState, checker.getState)
  const dismissed = useDismissedMatches()
  const enabled = opts.enabled ?? true

  // Every render: update() is a no-op unless the text really changed.
  useEffect(() => { checker.update(enabled ? draft : NOTHING, opts.excludeId) })
  useEffect(() => () => checker.reset(), [checker])

  const match = useMemo(() => pickInterruption(state.matches, dismissed), [state.matches, dismissed])
  return { ...state, match, dismiss: dismissMatch }
}

// ── Save-time check ─────────────────────────────────────────────────────

/**
 * The careful check on Save. Resolves to the match that should stop the save
 * (same job, not waved off, not a copy of this prompt), or null to go ahead.
 * Never rejects and never waits past `timeoutMs`: a slow or failed check must
 * not stop anyone saving their work.
 */
export async function findBlockingMatch(
  draft: MatchDraft,
  opts: { excludeId?: string; timeoutMs?: number; fetcher?: MatchFetcher } = {},
): Promise<Match | null> {
  if (!draft.body.trim()) return null
  const fetcher = opts.fetcher ?? matchDraft
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null) }, opts.timeoutMs ?? SAVE_CHECK_TIMEOUT_MS)
  })
  try {
    const check = Promise.resolve()
      .then(() => fetcher(draft, { excludeId: opts.excludeId, k: 3, mode: "save", signal: controller.signal }))
      .then((matches) => {
        const top = pickInterruption(Array.isArray(matches) ? matches : [])
        return top?.level === "same" ? top : null
      })
      .catch(() => null)
    return await Promise.race([check, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Save-time guard for a page. Usage:
 *
 *   const guard = useDuplicateSaveGuard({ renderAction })
 *   async function save() {
 *     if (!(await guard.confirmSaveAgainstDuplicates(draft, { excludeId }))) return
 *     ...createPrompt / updatePrompt...
 *   }
 *   return <>{...}{guard.sheet}</>
 *
 * confirmSaveAgainstDuplicates resolves true to go ahead, false to stop (the
 * person chose the existing prompt, which also navigates to it, or closed the
 * question). "Save mine anyway" also counts as "Keep writing mine".
 */
export function useDuplicateSaveGuard(opts: {
  /** Replaces the default "go to /prompts/:id" for [Use that one]. */
  onUse?: (m: Match) => void
  hrefFor?: (m: Match) => string
} = {}) {
  const navigate = useNavigate()
  const [pending, setPending] = useState<{ match: Match; resolve: (go: boolean) => void } | null>(null)
  const [checking, setChecking] = useState(false)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const { onUse, hrefFor } = opts

  // Leaving the page with the question open counts as "don't save".
  useEffect(() => () => pendingRef.current?.resolve(false), [])

  const confirmSaveAgainstDuplicates = useCallback(async (draft: MatchDraft, o: { excludeId?: string } = {}): Promise<boolean> => {
    pendingRef.current?.resolve(false)
    setChecking(true)
    let match: Match | null
    try { match = await findBlockingMatch(draft, { excludeId: o.excludeId }) } finally { setChecking(false) }
    if (!match) return true
    const found = match
    return new Promise<boolean>((resolve) => setPending({ match: found, resolve }))
  }, [])

  const settle = useCallback((go: boolean) => {
    const p = pendingRef.current
    if (!p) return
    setPending(null)
    p.resolve(go)
  }, [])

  const sheet = pending ? (
    <DuplicateSaveSheet
      match={pending.match}
      onUse={() => {
        const m = pending.match
        settle(false)
        if (onUse) onUse(m)
        else navigate(hrefFor ? hrefFor(m) : promptHref(m))
      }}
      onSaveAnyway={() => { dismissMatch(pending.match.id); settle(true) }}
      onCancel={() => settle(false)}
    />
  ) : null

  return { confirmSaveAgainstDuplicates, sheet, checking }
}

// ── Pieces on screen ────────────────────────────────────────────────────

export const promptHref = (m: Pick<Match, "id">) => `/prompts/${encodeURIComponent(m.id)}`

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden",
  clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
}

const CARD_STYLE: React.CSSProperties = {
  display: "flex", gap: 10, alignItems: "flex-start",
  marginTop: 8, padding: "12px 14px",
  background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--radius-md)",
  color: "var(--ink-800)",
}

const SMALL: React.CSSProperties = { fontSize: "var(--fs-small)", lineHeight: 1.5, color: "var(--ink-600)", margin: "2px 0 0" }

export interface DuplicateCardProps {
  match: Match
  /** The send action ("Send to…", or "Send to Cursor" once an agent is remembered) on a same-job match, e.g. (m) => <SendButton promptId={m.id} title={m.title} compact />. */
  renderAction?: (m: Match) => ReactNode
  /** Replaces the default link to /prompts/:id for [Use that one] / [Open mine]. */
  onUse?: (m: Match) => void
  hrefFor?: (m: Match) => string
  /** [Keep writing mine]. */
  onKeepWriting: (m: Match) => void
  /** The match came from the Save check (mode "save"), not the quick one while typing. */
  checked?: boolean
}

/** The small card under the text box. Presentational; <DuplicateCheck> wires it up. */
export function DuplicateCard({ match: m, renderAction, onUse, hrefFor, onKeepWriting, checked }: DuplicateCardProps) {
  const href = hrefFor ? hrefFor(m) : promptHref(m)
  const diff = matchDifferences(m)
  const same = m.level === "same"
  const useLabel = m.owned ? "Open mine" : same ? "Use that one" : "Open it"
  const action = same && renderAction ? renderAction(m) : null

  return (
    <section aria-label="A similar prompt already exists" style={CARD_STYLE}>
      <Library size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: "var(--ink-500)" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--ink-900)", overflowWrap: "anywhere" }}>
          {matchHeadline(m, { checked })}
        </div>
        {same ? (
          m.description && <p style={SMALL}>{m.description}</p>
        ) : (
          <>
            {diff.yoursAlso && <p style={SMALL}><b style={{ color: "var(--ink-800)", fontWeight: 600 }}>Yours also:</b> {diff.yoursAlso}</p>}
            {diff.theirsAlso && <p style={SMALL}><b style={{ color: "var(--ink-800)", fontWeight: 600 }}>Theirs also:</b> {diff.theirsAlso}</p>}
            {!diff.yoursAlso && !diff.theirsAlso && !diff.note && m.description && <p style={SMALL}>{m.description}</p>}
          </>
        )}
        {diff.note && <p style={SMALL}>{diff.note}</p>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10, alignItems: "center" }}>
          {onUse ? (
            <Button size="sm" variant={same ? "primary" : "secondary"} onClick={() => onUse(m)}>{useLabel}</Button>
          ) : same ? (
            <Link to={href} className="btn btn--primary btn--sm">{useLabel}</Link>
          ) : (
            // A close match opens in a new tab so the draft being typed survives.
            <a href={href} target="_blank" rel="noopener noreferrer" className="btn btn--secondary btn--sm"
              aria-label={`${useLabel}: ${m.title} (opens in a new tab)`}>
              {useLabel}<ExternalLink size={13} aria-hidden />
            </a>
          )}
          {action}
          <Button size="sm" variant="ghost" onClick={() => onKeepWriting(m)}>Keep writing mine</Button>
        </div>
      </div>
    </section>
  )
}

export interface DuplicateCheckProps extends Omit<DuplicateCardProps, "match" | "onKeepWriting" | "checked"> {
  /** What's typed so far: body, plus title / description / use_case / variables when known. */
  draft: MatchDraft
  /** The prompt being edited, so it never matches itself. */
  excludeId?: string
  /** Turn the check off (default on). */
  enabled?: boolean
  /** Called after [Keep writing mine], e.g. to put focus back in the text box. */
  onKeepWriting?: (m: Match) => void
}

/**
 * Drop under the prompt's text box. Renders nothing until there's a same-job
 * or close match; announces a new match politely to screen readers.
 */
export default function DuplicateCheck({ draft, excludeId, enabled, onKeepWriting, ...card }: DuplicateCheckProps) {
  const { match, dismiss } = useDuplicateCheck(draft, { excludeId, enabled })
  return (
    <>
      {/* Always mounted, so screen readers hear when a match shows up. */}
      <div role="status" aria-live="polite" style={VISUALLY_HIDDEN}>{match ? matchHeadline(match) : ""}</div>
      {match && (
        <DuplicateCard {...card} match={match}
          onKeepWriting={(m) => { dismiss(m.id); onKeepWriting?.(m) }} />
      )}
    </>
  )
}

export interface DuplicateSaveSheetProps {
  match: Match
  onUse: () => void
  onSaveAnyway: () => void
  /** Escape, the close button or a click outside: don't save, stay here. */
  onCancel: () => void
}

/**
 * The one question asked on Save. A native modal <dialog>: focus stays inside,
 * Escape closes it and the page behind can't be clicked. A bottom sheet on
 * phones, a centered card elsewhere.
 */
export function DuplicateSaveSheet({ match: m, onUse, onSaveAnyway, onCancel }: DuplicateSaveSheetProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const useBtnRef = useRef<HTMLButtonElement>(null)
  const mobile = useIsMobile()
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel

  // Layout effect: open before the first paint, so the scrim never flashes in the page flow.
  useLayoutEffect(() => {
    const d = ref.current
    if (!d) return
    if (!d.open) {
      try { d.showModal() } catch { d.setAttribute("open", "") }
    }
    // The suggested choice gets focus (showModal would pick the close button).
    useBtnRef.current?.focus()
    const onNativeCancel = (e: Event) => { e.preventDefault(); cancelRef.current() }
    d.addEventListener("cancel", onNativeCancel)
    return () => {
      d.removeEventListener("cancel", onNativeCancel)
      if (d.open) d.close()
    }
  }, [])

  const heading = m.owned ? "You already have this one" : "This one's already in the library"
  const by = !m.owned && m.author_name ? ` by ${m.author_name}` : ""

  return (
    // The dialog itself is the full-screen scrim (same tint as UseModal), so the
    // look doesn't depend on styling ::backdrop; the card sits inside it.
    <dialog ref={ref} aria-labelledby="dup-save-title" aria-describedby="dup-save-body"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
      style={{
        border: 0, margin: 0, inset: 0, width: "100%", height: "100%", maxWidth: "100%", maxHeight: "100%",
        boxSizing: "border-box", padding: mobile ? 0 : 16, background: "rgba(15,15,15,0.4)", color: "var(--ink-900)",
        display: "flex", alignItems: mobile ? "flex-end" : "center", justifyContent: "center", overflow: "auto",
      }}>
      <div style={{
        width: "100%", maxWidth: mobile ? "100%" : 460, maxHeight: mobile ? "90%" : undefined, overflow: "auto", boxSizing: "border-box",
        background: "var(--card)", boxShadow: "var(--shadow-lg)",
        borderRadius: mobile ? "14px 14px 0 0" : 14,
        padding: mobile ? "18px 16px calc(18px + env(safe-area-inset-bottom))" : "20px 24px",
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <h2 id="dup-save-title" style={{ fontSize: "var(--fs-title)", fontWeight: 600, margin: 0, flex: 1, minWidth: 0 }}>{heading}</h2>
          <button type="button" aria-label="Close" onClick={onCancel}
            style={{ border: 0, background: "none", cursor: "pointer", color: "var(--ink-400)", padding: 2, lineHeight: 0 }}>
            <X size={18} />
          </button>
        </div>
        <p id="dup-save-body" style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)", lineHeight: 1.55, margin: "8px 0 0", overflowWrap: "anywhere" }}>
          “{m.title}”{by} does the same job. {m.owned ? "Open yours, or save this one as well." : "You can use it as it is, or save yours anyway."}
        </p>
        {m.description && (
          <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", lineHeight: 1.55, margin: "8px 0 0", padding: "8px 10px", background: "var(--paper-2)", borderRadius: "var(--radius-md)" }}>
            {m.description}
          </p>
        )}
        {m.note && m.note.trim() !== "Does the same job." && <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)", lineHeight: 1.55, margin: "8px 0 0" }}>{m.note}</p>}
        {/* On phones the buttons stack full width, suggested choice on top. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16, flexDirection: mobile ? "column-reverse" : "row", justifyContent: "flex-end" }}>
          <Button variant="secondary" onClick={onSaveAnyway} className={mobile ? "btn--block" : undefined}>Save mine anyway</Button>
          <Button ref={useBtnRef} onClick={onUse} className={mobile ? "btn--block" : undefined}>{m.owned ? "Open mine" : "Use that one"}</Button>
        </div>
      </div>
    </dialog>
  )
}
