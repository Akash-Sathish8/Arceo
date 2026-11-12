/**
 * Prompt library (docs/prompts-rework-plan.md §3): ready-made prompts you can
 * send to your coding agent or AI app in one click.
 *
 * Each card shows the title, one line on what it does, its category, what it
 * costs a month (the same basis on every card: see cardCost), and a Send button
 * that reuses the agent you picked last. Category
 * chips and the search box (which understands rewording: "summarize email"
 * finds "Client email to 3 bullets") narrow a long list.
 */

import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Plug, Plus, Search, ScrollText, Sparkles } from "lucide-react"
import PageHeader from "@/components/shared/PageHeader"
import EmptyState from "@/components/shared/EmptyState"
import ErrorState from "@/components/shared/ErrorState"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"
import SendButton from "@/components/prompts/SendButton"
import { CARD, FIELD, PAGE_PAD, Pill, SegControl } from "@/components/prompts/ui"
import { listPrompts, type PromptListItem } from "@/lib/promptsApi"
import { CATEGORIES } from "@/lib/promptFormat"
import { OTHER, cardCost, categoryLabel, categoryOf, orderForView, type LibrarySort } from "@/lib/promptLibrary"
import { useIsMobile } from "@/lib/useIsMobile"

type Scope = "all" | "mine" | "public"
type Sort = LibrarySort

const SCOPES = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "public", label: "Community" },
] as const

// A click on one of these inside a card is that control's, not the card's.
const INTERACTIVE = "a, button, input, textarea, select, summary, [role='button']"

function PromptCard({ p, href, onOpen }: { p: PromptListItem; href: string; onOpen: () => void }) {
  const c = cardCost(p)
  const label = categoryLabel(p.use_case)
  return (
    // The title is the real link (keyboard and screen readers); a click anywhere
    // else on the card is a mouse shortcut to the same place. No role on the
    // card itself, so the Send buttons inside aren't nested in a link.
    <div
      className="ag-card"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(INTERACTIVE)) return
        if (window.getSelection?.()?.toString()) return   // they were selecting text
        onOpen()
      }}
      style={{
        ...CARD, padding: "14px 16px", cursor: "pointer",
        display: "flex", flexDirection: "column", gap: 8, minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
        <Link to={href} title={p.title} style={{
          flex: 1, minWidth: 0, fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--ink-900)", letterSpacing: -0.2, textDecoration: "none",
          lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere",
        }}>
          {p.title}
        </Link>
        {p.owned && p.status === "draft" && <Pill>Only you</Pill>}
        {p.owned && p.status === "published" && <Pill tone="accent">{p.visibility === "org" ? "Team" : "Shared"}</Pill>}
      </div>
      {p.description && (
        <p title={p.description} style={{
          fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: 0, lineHeight: 1.45,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere",
        }}>
          {p.description}
        </p>
      )}
      {(label || (!p.owned && p.author_name)) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: "var(--fs-small)", color: "var(--ink-400)", minWidth: 0 }}>
          {label && <Pill>{label}</Pill>}
          {!p.owned && p.author_name && <span style={{ overflowWrap: "anywhere" }}>By {p.author_name}</span>}
        </div>
      )}
      {/* Pinned to the bottom with a fixed shape (one cost line, then Send) so
          every card in a grid row lines up, however long its text above is. */}
      <div style={{ marginTop: "auto", paddingTop: 4, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div title={c.note || undefined} style={{
          fontSize: "var(--fs-small)", lineHeight: "18px", minHeight: 18, color: "var(--ink-500)", fontFamily: "var(--font-num)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {c.text}
        </div>
        <div style={{ display: "flex", minWidth: 0 }}>
          <SendButton promptId={p.id} title={p.title} compact hasBlanks={p.has_blanks} dangerSummary={p.danger_summary} />
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
  const mobile = useIsMobile()

  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      listPrompts(scope, q.trim() || undefined)
        .then((r) => { if (live) { setItems(r.prompts); setError(null) } })
        .catch((e: Error) => { if (live) setError(e.message) })
    }, q ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [scope, q, reload])

  // The library's categories in their usual order, each only when a prompt in
  // view has it, then "Other" for anything that doesn't fit one.
  const useCases = useMemo(() => {
    const present = new Set((items ?? []).map((p) => categoryOf(p.use_case)))
    return [...CATEGORIES, OTHER].filter((c) => present.has(c))
  }, [items])
  // Filter only by a chip that's on screen: a category with nothing left in view
  // (after switching tabs or searching) stops filtering, as does a hidden chip row.
  const category = useCase && useCases.length > 1 && useCases.includes(useCase) ? useCase : null

  const searching = q.trim().length > 0
  const shown = useMemo(() => {
    const rows = (items ?? []).filter((p) => !category || categoryOf(p.use_case) === category)
    return orderForView(rows, sort, searching, (p) => cardCost(p).value)
  }, [items, category, sort, searching])

  const hasOwn = (items ?? []).some((p) => p.owned)

  return (
    <div style={{ padding: PAGE_PAD }}>
      <PageHeader
        title="Prompts"
        description="Ready-to-use prompts. Pick one, fill in the blanks, and send it to your coding agent or AI app in one click."
        actions={(
          <>
            <Button variant="secondary" icon={<Plug size={14} />} onClick={() => navigate("/prompts/connect")}>Connect your agent</Button>
            <Button icon={<Plus size={14} />} onClick={() => navigate("/prompts/new")}>New prompt</Button>
          </>
        )}
      />

      {items !== null && !hasOwn && scope !== "public" && !searching && (
        <div style={{ ...CARD, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginBottom: 18, background: "var(--accent-soft)" }}>
          <Sparkles size={18} style={{ color: "var(--accent-ink)", flexShrink: 0 }} />
          <div style={{ flex: "1 1 260px", fontSize: "var(--fs-small)", color: "var(--accent-ink)", lineHeight: 1.5 }}>
            <b>New here?</b> Press <b>Send</b> on any prompt below to open it in Claude Code, Cursor, Lovable, ChatGPT and more.
            Or paste in something you already ask an AI to do, and we'll tell you if it's already here.
          </div>
          <Button variant="secondary" size="sm" onClick={() => navigate("/prompts/new")}>Add my own prompt</Button>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <SegControl options={SCOPES} value={scope} onChange={setScope} />
        <div style={{ flex: "1 1 220px", maxWidth: 420 }}>
          <Input icon={<Search size={14} />} placeholder="What do you want to do? e.g. fix a bug, sum up an email" aria-label="Search prompts"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!searching && (
          <select aria-label="Sort" style={{ ...FIELD, width: 170 }} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="recent">Newest first</option>
            <option value="used">Most used</option>
            <option value="cheapest">Cheapest first</option>
          </select>
        )}
      </div>
      {useCases.length > 1 && (
        // Phones: one swipeable row instead of five rows of chips above the first prompt.
        <div role="group" aria-label="Categories" style={{
          display: "flex", gap: 6, marginBottom: 18,
          ...(mobile
            ? { flexWrap: "nowrap", overflowX: "auto", overscrollBehaviorX: "contain", margin: "0 -16px 18px", padding: "0 16px 4px", scrollbarWidth: "none" }
            : { flexWrap: "wrap" }),
        }}>
          {[null, ...useCases].map((u) => (
            <button key={u ?? "all"} type="button" onClick={() => setUseCase(u)} aria-pressed={category === u}
              style={{
                border: "1px solid var(--line)", borderRadius: "var(--radius-full)", padding: "4px 12px", cursor: "pointer",
                fontSize: "var(--fs-small)", whiteSpace: "nowrap", flexShrink: 0, background: category === u ? "var(--ink-900)" : "var(--card)",
                color: category === u ? "var(--paper)" : "var(--ink-700)",
              }}>
              {u ?? "Everything"}
            </button>
          ))}
        </div>
      )}

      {error ? (
        <ErrorState message={error} onRetry={() => setReload((n) => n + 1)} />
      ) : items === null ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: 12 }} aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 150, borderRadius: 10 }} />)}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<ScrollText size={22} />}
          title={searching ? "No prompts match that" : items.length ? "Nothing in that category" : scope === "public" ? "No community prompts yet" : "No prompts yet"}
          body={searching ? "Try fewer or different words, or write your own." : items.length ? "Try another category." :
            <>Paste in something you ask an AI to do every week, or <Link to="/prompts/new?example=1">try an example</Link>.</>}
          action={items.length && !searching ? undefined : <Button onClick={() => navigate("/prompts/new")}>New prompt</Button>}
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: 12 }}>
          {shown.map((p) => <PromptCard key={p.id} p={p} href={`/prompts/${p.id}`} onOpen={() => navigate(`/prompts/${p.id}`)} />)}
        </div>
      )}
    </div>
  )
}
