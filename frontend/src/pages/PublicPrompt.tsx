/**
 * Public share page for one published prompt: /p/:promptId. No login, no
 * sidebar. Shows the published version only, with its cost per run and danger
 * breakdown, so a founder can send a teammate or client one link.
 */

import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { Copy, GitFork } from "lucide-react"
import LogoMark, { ArceoWordmark } from "@/components/shared/LogoMark"
import ErrorState from "@/components/shared/ErrorState"
import { toast } from "@/components/shared/Toast"
import { Button } from "@/components/ui/Button"
import { CostTable, DangerPanel } from "@/components/prompts/ScorePanels"
import { CARD, EYEBROW } from "@/components/prompts/ui"
import { isLoggedIn } from "@/lib/api"
import { getPublicPrompt, type Prompt } from "@/lib/promptsApi"

export default function PublicPrompt() {
  const { promptId } = useParams()
  const [p, setP] = useState<Prompt | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getPublicPrompt(promptId!).then(setP).catch((e: Error) => setError(e.message))
  }, [promptId])

  useEffect(() => {
    if (p) document.title = `${p.title} · Arceo prompts`
  }, [p])

  const forkHref = isLoggedIn() ? `/prompts/${promptId}` : "/login"

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-page)", fontFamily: "var(--font-sans)", color: "var(--ink-900)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "18px clamp(16px, 4vw, 40px)", borderBottom: "1px solid var(--line)" }}>
        <Link to="/" style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }} aria-label="Arceo">
          <LogoMark size={26} />
          <ArceoWordmark height={12} />
        </Link>
        <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-400)", marginLeft: 6 }}>Prompts</span>
      </header>
      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "32px clamp(16px, 4vw, 40px) 64px" }}>
        {error ? (
          <ErrorState title="This prompt isn't available" message="It may have been unpublished, or the link is wrong." />
        ) : !p ? (
          <div className="skeleton" style={{ height: 30, width: 280 }} aria-busy="true" />
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
              <div style={{ minWidth: 0 }}>
                <h1 style={{ fontSize: "var(--fs-page)", fontWeight: 600, lineHeight: 1.2 }}>{p.title}</h1>
                <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 5 }}>
                  {[p.author_name && `By ${p.author_name}`, p.use_case, `version ${p.published_version}`].filter(Boolean).join(" · ")}
                </p>
                {p.description && <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)", marginTop: 8, maxWidth: 620, lineHeight: 1.5 }}>{p.description}</p>}
              </div>
              <a href={forkHref} style={{ textDecoration: "none" }}>
                <Button icon={<GitFork size={14} />}>Fork in Arceo</Button>
              </a>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, alignItems: "start" }}>
              <div style={CARD}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={EYEBROW}>Prompt</div>
                  <Button variant="ghost" size="sm" icon={<Copy size={13} />}
                    onClick={() => navigator.clipboard?.writeText(p.body).then(() => toast("Copied"))}>Copy</Button>
                </div>
                <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-code)", fontSize: 13, lineHeight: 1.55, color: "var(--ink-800)", marginTop: 10 }}>
                  {p.body}
                </pre>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
                <DangerPanel danger={p.danger_summary} />
                <CostTable cost={p.cost_summary} />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
