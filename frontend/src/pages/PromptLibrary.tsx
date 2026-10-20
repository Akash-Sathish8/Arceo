/**
 * Prompt library: every prompt with what it costs a month and how dangerous it is.
 *
 * Tabs pick whose prompts (yours + community, yours, community); use-case chips,
 * a sort and a "low danger only" switch make a long list scannable. Cards follow
 * AgentCard: severity on the left edge, ring + band word, then cost in graphite.
 */

import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Plus, Search, ScrollText, Sparkles } from "lucide-react"
import PageHeader from "@/components/shared/PageHeader"
import EmptyState from "@/components/shared/EmptyState"
import ErrorState from "@/components/shared/ErrorState"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"
import DangerBadge from "@/components/prompts/DangerBadge"
import { CARD, FIELD, PAGE_PAD, Pill, SegControl } from "@/components/prompts/ui"
import { formatMonthly, formatRunCost, headlineCost, listPrompts, monthlyCost, type PromptListItem } from "@/lib/promptsApi"
import { scoreBand, timeAgo } from "@/lib/utils"

type Scope = "all" | "mine" | "public"
type Sort = "recent" | "cheapest" | "safest" | "used"

const SCOPES = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "public", label: "Community" },
] as const

function cardCost(p: PromptListItem): { value: number | null; text: string; sub: string } {
  const row = headlineCost(p.cost_summary, p.model)
  if (!row || row.usd_per_run == null) return { value: null, text: "n/a", sub: "" }
  const m = monthlyCost(row.usd_per_run, p.runs_per_day)
  if (m != null) return { value: m, text: `${row.is_floor ? "≥ " : ""}${formatMonthly(m)}`, sub: `${p.runs_per_day}/day on ${row.model_key}` }
  return { value: row.usd_per_run, text: `${row.is_floor ? "≥ " : ""}${formatRunCost(row.usd_per_run)}`, sub: `a run on ${row.model_key}` }
}

function PromptCard({ p, onOpen }: { p: PromptListItem; onOpen: () => void }) {
  const ring = p.danger_summary ? scoreBand(p.danger_summary.score, 0, p.danger_summary.band).ring : "var(--line)"
  const c = cardCost(p)
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
            {[p.use_case, p.owned ? "You" : p.author_name, p.use_count ? `used ${p.use_count}×` : null, timeAgo(p.updated_at)].filter(Boolean).join(" · ")}
          </div>
        </div>
        {p.owned && p.status === "draft" && <Pill>Draft</Pill>}
        {p.owned && p.status === "published" && <Pill tone="accent">{p.visibility === "org" ? "Team" : "Published"}</Pill>}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <DangerBadge danger={p.danger_summary} size={36} />
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: "var(--font-num)", fontWeight: 600, color: "var(--ink-900)" }}>{c.text}</div>
          {c.sub && <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)", marginTop: 2 }}>{c.sub}</div>}
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
  const [useCase, setUseCase] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>("recent")
  const [lowOnly, setLowOnly] = useState(false)

  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      listPrompts(scope, q.trim() || undefined)
        .then((r) => { if (live) { setItems(r.prompts); setError(null) } })
        .catch((e: Error) => { if (live) setError(e.message) })
    }, q ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [scope, q, reload])

  const useCases = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of items ?? []) if (p.use_case) counts.set(p.use_case, (counts.get(p.use_case) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k)
  }, [items])

  const shown = useMemo(() => {
    let rows = (items ?? []).filter((p) => (!useCase || p.use_case === useCase) && (!lowOnly || p.danger_summary?.band === "low"))
    const cost = (p: PromptListItem) => cardCost(p).value ?? Infinity
    if (sort === "cheapest") rows = [...rows].sort((a, b) => cost(a) - cost(b))
    if (sort === "safest") rows = [...rows].sort((a, b) => (a.danger_summary?.score ?? 100) - (b.danger_summary?.score ?? 100))
    if (sort === "used") rows = [...rows].sort((a, b) => (b.use_count ?? 0) - (a.use_count ?? 0))
    return rows
  }, [items, useCase, lowOnly, sort])

  const hasOwn = (items ?? []).some((p) => p.owned)

  return (
    <div style={{ padding: PAGE_PAD }}>
      <PageHeader
        title="Prompts"
        description="See what every prompt costs a month and how it could be abused, before you ship it."
        actions={<Button icon={<Plus size={14} />} onClick={() => navigate("/prompts/new")}>New prompt</Button>}
      />

      {items !== null && !hasOwn && scope !== "public" && (
        <div style={{ ...CARD, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginBottom: 18, background: "var(--accent-soft)" }}>
          <Sparkles size={18} style={{ color: "var(--accent-ink)", flexShrink: 0 }} />
          <div style={{ flex: "1 1 260px", fontSize: "var(--fs-small)", color: "var(--accent-ink)", lineHeight: 1.5 }}>
            <b>Start in 30 seconds.</b> Open an example, see its monthly cost and danger, and fix it with one click.
            Or paste a prompt you already use.
          </div>
          <Button size="sm" onClick={() => navigate("/prompts/new?example=1")}>Try an example</Button>
          <Button variant="secondary" size="sm" onClick={() => navigate("/prompts/new")}>Paste my own</Button>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <SegControl options={SCOPES} value={scope} onChange={setScope} />
        <div style={{ flex: "1 1 220px", maxWidth: 360 }}>
          <Input icon={<Search size={14} />} placeholder="Search prompts" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select aria-label="Sort" style={{ ...FIELD, width: 170 }} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="recent">Newest</option>
          <option value="cheapest">Cheapest</option>
          <option value="safest">Safest</option>
          <option value="used">Most used</option>
        </select>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "var(--fs-small)", color: "var(--ink-700)" }}>
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Low danger only
        </label>
      </div>
      {useCases.length > 1 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}>
          {[null, ...useCases].map((u) => (
            <button key={u ?? "all"} type="button" onClick={() => setUseCase(u)}
              style={{
                border: "1px solid var(--line)", borderRadius: "var(--radius-full)", padding: "4px 12px", cursor: "pointer",
                fontSize: "var(--fs-small)", background: useCase === u ? "var(--ink-900)" : "var(--card)",
                color: useCase === u ? "var(--paper)" : "var(--ink-700)",
              }}>
              {u ?? "All use cases"}
            </button>
          ))}
        </div>
      )}

      {error ? (
        <ErrorState message={error} onRetry={() => setReload((n) => n + 1)} />
      ) : items === null ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: 12 }} aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 112, borderRadius: 10 }} />)}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<ScrollText size={22} />}
          title={items.length ? "Nothing matches those filters" : scope === "public" ? "No community prompts yet" : "No prompts yet"}
          body={items.length ? "Try another use case, or turn off Low danger only." :
            <>Paste a prompt you use every week, or <Link to="/prompts/new?example=1">try an example</Link>.</>}
          action={items.length ? undefined : <Button onClick={() => navigate("/prompts/new")}>New prompt</Button>}
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: 12 }}>
          {shown.map((p) => <PromptCard key={p.id} p={p} onOpen={() => navigate(`/prompts/${p.id}`)} />)}
        </div>
      )}
    </div>
  )
}
