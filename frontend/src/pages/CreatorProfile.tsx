/**
 * A creator's public page: their shared prompts, how often they're used and
 * copied, each with a Send button. Agencies use it as a portfolio. In the app
 * at /creators/:id; public and chromeless at /u/:id.
 */

import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import LogoMark, { ArceoWordmark } from "@/components/shared/LogoMark"
import ErrorState from "@/components/shared/ErrorState"
import SendButton from "@/components/prompts/SendButton"
import { CARD, EYEBROW, PAGE_PAD, Pill } from "@/components/prompts/ui"
import { isLoggedIn } from "@/lib/api"
import { formatMonthly, formatRunCost, getCreator, headlineCost, monthlyCost, type CreatorProfile as Profile, type PromptListItem } from "@/lib/promptsApi"

/** The card's cost line, the same words as the library's cards (PromptLibrary cardCost):
 *  the author's own model when it's priced, else the cheapest. */
function costLine(x: PromptListItem): string {
  const row = headlineCost(x.cost_summary, x.model)
  if (!row || row.usd_per_run == null) return ""
  const m = monthlyCost(row.usd_per_run, x.runs_per_day)
  if (m != null) return m < 0.01 ? "Costs under a cent a month" : `About ${formatMonthly(m).replace("/mo", "")} a month`
  return `${row.is_floor ? "≥ " : ""}${formatRunCost(row.usd_per_run)} each time`
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ ...CARD, padding: "12px 16px", minWidth: 120 }}>
      <div style={EYEBROW}>{label}</div>
      <div style={{ fontFamily: "var(--font-num)", fontSize: 24, fontWeight: 600, marginTop: 4 }}>{value.toLocaleString()}</div>
    </div>
  )
}

export default function CreatorProfile({ publicView = false }: { publicView?: boolean }) {
  const { authorId } = useParams()
  const navigate = useNavigate()
  const [p, setP] = useState<Profile | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => { getCreator(authorId!).then(setP).catch(() => setError(true)) }, [authorId])
  useEffect(() => { if (p?.author_name) document.title = `${p.author_name} · Prompts · Arceo` }, [p])

  const hrefFor = (id: string) => (publicView || !isLoggedIn() ? `/p/${id}` : `/prompts/${id}`)

  const body = error ? <ErrorState title="Creator not found" message="The link may be wrong." /> : !p ? (
    <div className="skeleton" style={{ height: 30, width: 240 }} aria-busy="true" />
  ) : (
    <>
      <h1 style={{ fontSize: "var(--fs-page)", fontWeight: 600 }}>{p.author_name ?? "Creator"}</h1>
      <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 4 }}>Prompts they've shared on Arceo</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
        <Stat label="Prompts" value={p.prompts.length} />
        <Stat label="Uses" value={p.total_uses} />
        <Stat label="Copies saved" value={p.total_forks} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: 12, marginTop: 20 }}>
        {p.prompts.map((x) => {
          const cost = costLine(x)
          return (
            // The title is the real link; a click elsewhere on the card is a mouse
            // shortcut. No role on the card, so its Send buttons aren't nested in one.
            <div key={x.id} className="ag-card"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a, button, input, textarea, select, [role='button']")) return
                if (window.getSelection?.()?.toString()) return
                navigate(hrefFor(x.id))
              }}
              style={{ ...CARD, cursor: "pointer", display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
              <Link to={hrefFor(x.id)} style={{ fontWeight: 600, fontSize: "var(--fs-title)", overflowWrap: "anywhere", color: "var(--ink-900)", textDecoration: "none" }}>{x.title}</Link>
              {x.description && (
                <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: 0, lineHeight: 1.45,
                  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{x.description}</p>
              )}
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: "var(--fs-micro)", color: "var(--ink-400)" }}>
                {x.use_case && <Pill>{x.use_case}</Pill>}
                {x.use_count ? <span>Used {x.use_count} {x.use_count === 1 ? "time" : "times"}</span> : null}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: "auto" }}>
                <SendButton promptId={x.id} title={x.title} compact signedIn={!publicView && isLoggedIn()} />
                {cost && (
                  <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", fontFamily: "var(--font-num)" }}>{cost}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )

  if (!publicView) return <div style={{ padding: PAGE_PAD }}>{body}</div>
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-page)", fontFamily: "var(--font-sans)", color: "var(--ink-900)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "18px clamp(16px, 4vw, 40px)", borderBottom: "1px solid var(--line)" }}>
        <Link to="/" style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }} aria-label="Arceo">
          <LogoMark size={26} /><ArceoWordmark height={12} />
        </Link>
        <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-400)", marginLeft: 6 }}>Prompts</span>
      </header>
      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "32px clamp(16px, 4vw, 40px) 64px" }}>{body}</main>
    </div>
  )
}
