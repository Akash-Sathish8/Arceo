/**
 * The "Similar prompts" row on a prompt's page and its public share page
 * (docs/prompts-rework-plan.md §1, "Where matching shows up", case 2).
 *
 * Up to six small cards: title, a one-line description, the category, and a
 * "Yours" / "Your copy" tag. Shows a quiet placeholder while loading and
 * disappears entirely when there's nothing similar (or the lookup fails).
 * Matches are ordered by the backend; how close they are is never shown.
 */

import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import { Link, useNavigate } from "react-router-dom"
import { CARD, EYEBROW, Pill } from "@/components/prompts/ui"
import { categoryLabel } from "@/lib/promptLibrary"
import { publicSimilarTo, similarTo, type Match } from "@/lib/similarApi"
import { useIsMobile } from "@/lib/useIsMobile"

export const MAX_SIMILAR = 6

export interface SimilarPromptsProps {
  /** The prompt whose neighbours to show. */
  promptId: string
  /** Signed-out share page: public prompts only, cards link to /p/:id. */
  publicView?: boolean
  /** How many to ask for (1-6). Default 6. */
  k?: number
  /** An action per card, e.g. (m) => <SendButton promptId={m.id} title={m.title} compact />. */
  renderAction?: (m: Match) => ReactNode
  /** Where a card goes. Default /prompts/:id, or /p/:id when publicView. */
  hrefFor?: (m: Match) => string
  /** Section heading. Default "Similar prompts". */
  heading?: string
}

/** The small tag on a card, or null. A copy of the prompt being viewed is
 *  "Your copy" when it's yours, otherwise it's the one this prompt came from. */
export function matchTag(m: Pick<Match, "owned" | "copy_of_yours">): string | null {
  if (m.copy_of_yours) return m.owned ? "Your copy" : "Original"
  return m.owned ? "Yours" : null
}

export const similarHref = (m: Pick<Match, "id">, publicView?: boolean) =>
  `${publicView ? "/p" : "/prompts"}/${encodeURIComponent(m.id)}`

type Loaded = { key: string; matches: Match[] }

export default function SimilarPrompts({ promptId, publicView = false, k = MAX_SIMILAR, renderAction, hrefFor, heading = "Similar prompts" }: SimilarPromptsProps) {
  const limit = Math.max(1, Math.min(MAX_SIMILAR, Math.round(k) || MAX_SIMILAR))
  const key = `${publicView ? "p" : "s"}:${promptId}:${limit}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const mobile = useIsMobile()

  useEffect(() => {
    if (!promptId) return
    let alive = true
    const fetcher = publicView ? publicSimilarTo : similarTo
    fetcher(promptId, limit)
      .then((matches) => { if (alive) setLoaded({ key, matches: (matches ?? []).filter((m) => m.id !== promptId).slice(0, limit) }) })
      .catch(() => { if (alive) setLoaded({ key, matches: [] }) })   // a nice-to-have: fail quietly
    return () => { alive = false }
  }, [key, promptId, publicView, limit])

  if (!promptId) return null
  const loading = loaded?.key !== key
  if (!loading && loaded.matches.length === 0) return null

  const headingId = `similar-${promptId}`
  const items = loading ? null : loaded.matches
  const listStyle: React.CSSProperties = mobile
    // Phones: one swipeable row, so six cards don't push the page down.
    ? { display: "flex", gap: 10, overflowX: "auto", scrollSnapType: "x mandatory", overscrollBehaviorX: "contain",
        WebkitOverflowScrolling: "touch", margin: "10px 0 0", padding: "2px 2px 8px", listStyle: "none" }
    : { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10, marginTop: 10, padding: 0, listStyle: "none" }
  // minWidth 0: otherwise the one-line description's full width props the card open.
  const itemStyle: React.CSSProperties = mobile
    ? { flex: "0 0 78%", minWidth: 0, scrollSnapAlign: "start", display: "flex" }
    : { minWidth: 0, display: "flex" }

  return (
    <section aria-labelledby={headingId} aria-busy={loading || undefined}>
      <h2 id={headingId} style={{ ...EYEBROW, margin: 0 }}>{heading}</h2>
      <ul style={listStyle}>
        {items
          ? items.map((m) => (
              <li key={m.id} style={itemStyle}>
                <SimilarCard match={m} href={hrefFor ? hrefFor(m) : similarHref(m, publicView)} action={renderAction?.(m)} />
              </li>
            ))
          : Array.from({ length: mobile ? 2 : 3 }, (_, i) => (
              <li key={i} style={itemStyle} aria-hidden>
                <div className="skeleton" style={{ width: "100%", height: 92, borderRadius: 10 }} />
              </li>
            ))}
      </ul>
      {loading && <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Looking for similar prompts</span>}
    </section>
  )
}

const INTERACTIVE = "a, button, input, textarea, select, summary, [role='button'], [role='menuitem']"

/** One card. The title is the link (keyboard and screen readers); a click
 *  anywhere else on the card that isn't another control goes there too. */
export function SimilarCard({ match: m, href, action }: { match: Match; href: string; action?: ReactNode }) {
  const navigate = useNavigate()
  const tag = matchTag(m)
  // Same category words as the library's cards ("Ops" files under "Running the business").
  const category = categoryLabel(m.use_case)
  return (
    <article
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(INTERACTIVE)) return
        if (window.getSelection?.()?.toString()) return          // they were selecting text
        navigate(href)
      }}
      style={{ ...CARD, padding: "12px 14px", width: "100%", minWidth: 0, display: "flex", flexDirection: "column", gap: 6, cursor: "pointer" }}>
      <Link to={href} style={{
        fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--ink-900)", textDecoration: "none", lineHeight: 1.35,
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere",
      }}>
        {m.title}
      </Link>
      {m.description && (
        <p title={m.description} style={{
          fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: 0, lineHeight: 1.45,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {m.description}
        </p>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: "auto", paddingTop: 2 }}>
        {category && <Pill>{category}</Pill>}
        {tag && <Pill tone="accent">{tag}</Pill>}
        {action && <div style={{ marginLeft: "auto" }}>{action}</div>}
      </div>
    </article>
  )
}
