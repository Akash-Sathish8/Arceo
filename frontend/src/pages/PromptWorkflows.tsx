/**
 * Prompt workflows list: prompts stacked into steps, each with a combined cost
 * per run and a compounded danger score. (Agent workflows live at /workflows.)
 */

import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Layers, Plus } from "lucide-react"
import PageHeader from "@/components/shared/PageHeader"
import EmptyState from "@/components/shared/EmptyState"
import ErrorState from "@/components/shared/ErrorState"
import { Button } from "@/components/ui/Button"
import DangerBadge from "@/components/prompts/DangerBadge"
import { PAGE_PAD, Pill, SegControl } from "@/components/prompts/ui"
import { formatRunCost, listWorkflows, type PromptWorkflow } from "@/lib/promptsApi"
import { scoreBand, timeAgo } from "@/lib/utils"

const SCOPES = [{ value: "all", label: "All" }, { value: "mine", label: "Mine" }, { value: "public", label: "Community" }] as const

export default function PromptWorkflows() {
  const navigate = useNavigate()
  const [scope, setScope] = useState<"all" | "mine" | "public">("all")
  const [items, setItems] = useState<PromptWorkflow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setItems(null)
    listWorkflows(scope).then((r) => { setItems(r.workflows); setError(null) }).catch((e: Error) => setError(e.message))
  }, [scope])

  return (
    <div style={{ padding: PAGE_PAD }}>
      <PageHeader
        title="Prompt workflows"
        description="Link prompts into steps, like summarize an email and then draft a reply. See what the whole thing costs and whether it's safe."
        actions={<Button icon={<Plus size={14} />} onClick={() => navigate("/prompt-workflows/new")}>New workflow</Button>}
      />
      <div style={{ marginBottom: 18 }}><SegControl options={SCOPES} value={scope} onChange={setScope} /></div>
      {error ? <ErrorState message={error} /> : items === null ? (
        <div className="skeleton" style={{ height: 112, borderRadius: 10 }} aria-busy="true" />
      ) : items.length === 0 ? (
        <EmptyState icon={<Layers size={22} />} title="No workflows yet"
          body="Link two prompts, like summarize an email and then draft the reply, to see what they cost together and whether it's safe."
          action={<Button onClick={() => navigate("/prompt-workflows/new")}>New workflow</Button>} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {items.map((w) => {
            const ring = w.danger_summary ? scoreBand(w.danger_summary.score, 0, w.danger_summary.band).ring : "var(--line)"
            const cheapest = w.cost_summary?.models.find((m) => m.model_key === w.cost_summary?.cheapest_model)
            return (
              <div key={w.id} className="ag-card" role="button" tabIndex={0}
                onClick={() => navigate(`/prompt-workflows/${w.id}`)}
                onKeyDown={(e) => { if (e.key === "Enter") navigate(`/prompt-workflows/${w.id}`) }}
                style={{ background: "var(--card)", borderLeft: `3px solid ${ring}`, borderRadius: 10, padding: "14px 18px",
                  boxShadow: "var(--shadow-card-new)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--fs-title)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.title}</div>
                    <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 2 }}>
                      {[`${w.step_count ?? 0} steps`, w.owned ? "You" : w.author_name, timeAgo(w.updated_at)].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  {w.owned && <Pill tone={w.status === "published" ? "accent" : "neutral"}>{w.status === "published" ? "Published" : "Draft"}</Pill>}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <DangerBadge danger={w.danger_summary} size={36} />
                  <span style={{ fontFamily: "var(--font-num)", fontWeight: 600 }}>
                    {cheapest ? `${cheapest.is_floor ? "≥ " : ""}${formatRunCost(cheapest.usd_per_run)}` : "n/a"}
                    <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", fontWeight: 400 }}> each time</span>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
