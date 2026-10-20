/**
 * Prompt library: every prompt with what it costs to run and how dangerous it is.
 *
 * Tabs: everything you can see (yours + community), only yours, only the
 * community's published prompts. Cards follow AgentCard: severity on the left
 * edge, ring + band word, then the cost of one run in graphite.
 */

import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Plus, Search, ScrollText } from "lucide-react"
import PageHeader from "@/components/shared/PageHeader"
import EmptyState from "@/components/shared/EmptyState"
import ErrorState from "@/components/shared/ErrorState"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"
import CostBadge from "@/components/prompts/CostBadge"
import DangerBadge from "@/components/prompts/DangerBadge"
import { PAGE_PAD, Pill, SegControl } from "@/components/prompts/ui"
import { headlineCost, listPrompts, type PromptListItem } from "@/lib/promptsApi"
import { scoreBand, timeAgo } from "@/lib/utils"

type Scope = "all" | "mine" | "public"

const SCOPES = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "public", label: "Community" },
] as const

function PromptCard({ p, onOpen }: { p: PromptListItem; onOpen: () => void }) {
  const ring = p.danger_summary ? scoreBand(p.danger_summary.score, 0, p.danger_summary.band).ring : "var(--line)"
  const row = headlineCost(p.cost_summary)
  return (
    <div
      className="ag-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen() } }}
      style={{
        background: "var(--card)", borderLeft: `3px solid ${ring}`, borderRadius: 10,
        padding: "14px 18px", boxShadow: "var(--shadow-card-new)", cursor: "pointer",
        display: "flex", flexDirection: "column", gap: 12, minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div title={p.title} style={{
            fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--ink-900)", letterSpacing: -0.2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {p.title}
          </div>
          <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {[p.use_case, p.owned ? "You" : p.author_name, timeAgo(p.updated_at)].filter(Boolean).join(" · ")}
          </div>
        </div>
        {p.owned && p.status === "draft" && <Pill>Draft</Pill>}
        {p.owned && p.status === "published" && <Pill tone="accent">{p.visibility === "org" ? "Team" : "Published"}</Pill>}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <DangerBadge danger={p.danger_summary} size={36} />
        <div style={{ textAlign: "right" }}>
          <CostBadge row={row} />
          {row && <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)", marginTop: 2 }}>cheapest: {row.model_key}</div>}
        </div>
      </div>
    </div>
  )
}

export default function PromptLibrary() {
  const navigate = useNavigate()
  const [scope, setScope] = useState<Scope>("all")
  const [q, setQ] = useState("")
  const [items, setItems] = useState<PromptListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      listPrompts(scope, q.trim() || undefined)
        .then((r) => { if (live) { setItems(r.prompts); setError(null) } })
        .catch((e: Error) => { if (live) setError(e.message) })
    }, q ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [scope, q, reload])

  return (
    <div style={{ padding: PAGE_PAD }}>
      <PageHeader
        title="Prompts"
        description="Every prompt shows what one run costs on each model and how it could be abused, before you ship it."
        actions={<Button icon={<Plus size={14} />} onClick={() => navigate("/prompts/new")}>New prompt</Button>}
      />
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 18 }}>
        <SegControl options={SCOPES} value={scope} onChange={setScope} />
        <div style={{ flex: "1 1 220px", maxWidth: 360 }}>
          <Input icon={<Search size={14} />} placeholder="Search prompts" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => setReload((n) => n + 1)} />
      ) : items === null ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }} aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 112, borderRadius: 10 }} />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ScrollText size={22} />}
          title={scope === "public" ? "No community prompts yet" : "No prompts yet"}
          body="Paste a prompt you use every week. You'll see its cost per run on each model and what could go wrong with it."
          action={<Button onClick={() => navigate("/prompts/new")}>New prompt</Button>}
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {items.map((p) => <PromptCard key={p.id} p={p} onOpen={() => navigate(`/prompts/${p.id}`)} />)}
        </div>
      )}
    </div>
  )
}
