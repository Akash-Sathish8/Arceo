/**
 * A creator's public page: published prompts, total uses, forks and comparison
 * wins. Agencies use it as a portfolio. In the app at /creators/:id; public and
 * chromeless at /u/:id.
 */

import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import LogoMark, { ArceoWordmark } from "@/components/shared/LogoMark"
import ErrorState from "@/components/shared/ErrorState"
import DangerBadge from "@/components/prompts/DangerBadge"
import { CARD, EYEBROW, PAGE_PAD } from "@/components/prompts/ui"
import { isLoggedIn } from "@/lib/api"
import { formatMonthly, formatRunCost, getCreator, headlineCost, monthlyCost, type CreatorProfile as Profile } from "@/lib/promptsApi"

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
  useEffect(() => { if (p?.author_name) document.title = `${p.author_name} · Arceo prompts` }, [p])

  const open = (id: string) => (publicView || !isLoggedIn() ? navigate(`/p/${id}`) : navigate(`/prompts/${id}`))

  const body = error ? <ErrorState title="Creator not found" message="The link may be wrong." /> : !p ? (
    <div className="skeleton" style={{ height: 30, width: 240 }} aria-busy="true" />
  ) : (
    <>
      <h1 style={{ fontSize: "var(--fs-page)", fontWeight: 600 }}>{p.author_name ?? "Creator"}</h1>
      <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 4 }}>Published prompts on Arceo</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
        <Stat label="Prompts" value={p.prompts.length} />
        <Stat label="Uses" value={p.total_uses} />
        <Stat label="Copies saved" value={p.total_forks} />
        <Stat label="Comparison wins" value={p.comparison_wins} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: 12, marginTop: 20 }}>
        {p.prompts.map((x) => {
          const row = headlineCost(x.cost_summary)
          const m = row ? monthlyCost(row.usd_per_run, x.runs_per_day) : null
          return (
            <div key={x.id} className="ag-card" role="button" tabIndex={0} onClick={() => open(x.id)}
              onKeyDown={(e) => { if (e.key === "Enter") open(x.id) }}
              style={{ ...CARD, cursor: "pointer", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontWeight: 600, fontSize: "var(--fs-title)" }}>{x.title}</div>
              <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)" }}>{[x.use_case, x.use_count ? `used ${x.use_count}×` : null].filter(Boolean).join(" · ")}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <DangerBadge danger={x.danger_summary} size={32} />
                <span style={{ fontFamily: "var(--font-num)", fontWeight: 600 }}>{m != null ? formatMonthly(m) : row ? formatRunCost(row.usd_per_run) : ""}</span>
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
