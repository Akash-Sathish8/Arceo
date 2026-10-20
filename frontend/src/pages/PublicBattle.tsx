/** Public battle page: /b/:battleId. Leaderboard only, no login. */

import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import LogoMark, { ArceoWordmark } from "@/components/shared/LogoMark"
import ErrorState from "@/components/shared/ErrorState"
import { Button } from "@/components/ui/Button"
import Leaderboard from "@/components/prompts/Leaderboard"
import { CARD, Pill } from "@/components/prompts/ui"
import { isLoggedIn } from "@/lib/api"
import { getPublicBattle, type Battle, type BattleSort } from "@/lib/promptsApi"

export default function PublicBattle() {
  const { battleId } = useParams()
  const [b, setB] = useState<Battle | null>(null)
  const [sort, setSort] = useState<BattleSort>("best")
  const [error, setError] = useState(false)

  useEffect(() => { getPublicBattle(battleId!, sort).then(setB).catch(() => setError(true)) }, [battleId, sort])
  useEffect(() => { if (b) document.title = `${b.title} · Arceo battles` }, [b])

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-page)", fontFamily: "var(--font-sans)", color: "var(--ink-900)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "18px clamp(16px, 4vw, 40px)", borderBottom: "1px solid var(--line)" }}>
        <Link to="/" style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }} aria-label="Arceo">
          <LogoMark size={26} /><ArceoWordmark height={12} />
        </Link>
        <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-400)", marginLeft: 6 }}>Battles</span>
      </header>
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "32px clamp(16px, 4vw, 40px) 64px" }}>
        {error ? <ErrorState title="This battle isn't available" message="The link may be wrong." /> : !b ? (
          <div className="skeleton" style={{ height: 30, width: 280 }} aria-busy="true" />
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 20 }}>
              <div>
                <h1 style={{ fontSize: "var(--fs-page)", fontWeight: 600 }}>{b.title}</h1>
                <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 5, maxWidth: 620 }}>
                  {b.task} · {b.model} · {b.entry_count} entries · {b.vote_count} votes
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Pill tone={b.status === "open" ? "accent" : "neutral"}>{b.status === "open" ? "Open" : "Closed"}</Pill>
                {b.status === "open" && <a href={isLoggedIn() ? `/battles/${b.id}` : "/login"} style={{ textDecoration: "none" }}><Button>Enter or vote</Button></a>}
              </div>
            </div>
            <div style={CARD}><Leaderboard rows={b.leaderboard} sort={sort} onSort={setSort} showBodies={b.status === "closed"} /></div>
          </>
        )}
      </main>
    </div>
  )
}
