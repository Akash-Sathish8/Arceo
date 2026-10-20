/**
 * Prompt battles: one task, hidden inputs, every entry run on the same model.
 * The community votes blind; the leaderboard ranks by quality, by the cheapest
 * entry that's still good, or by the safest.
 */

import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Plus, Swords, X } from "lucide-react"
import PageHeader from "@/components/shared/PageHeader"
import EmptyState from "@/components/shared/EmptyState"
import ErrorState from "@/components/shared/ErrorState"
import { toast } from "@/components/shared/Toast"
import { Button } from "@/components/ui/Button"
import { CARD, FIELD, Label, PAGE_PAD, Pill } from "@/components/prompts/ui"
import { createBattle, listBattles, type BattleInput, type BattleSummary } from "@/lib/promptsApi"
import { timeAgo } from "@/lib/utils"

function CreateBattle({ onDone }: { onDone: (id: string) => void }) {
  const [title, setTitle] = useState("")
  const [task, setTask] = useState("")
  const [variable, setVariable] = useState("input")
  const [model, setModel] = useState("claude-haiku-4-5")
  const [inputs, setInputs] = useState<string[]>([""])
  const [busy, setBusy] = useState(false)

  async function submit() {
    const filled = inputs.map((v) => v.trim()).filter(Boolean)
    if (!title.trim() || !task.trim() || filled.length === 0) { toast("Add a title, the task, and at least one input.", "error"); return }
    setBusy(true)
    try {
      const body: BattleInput[] = filled.map((v, i) => ({ label: `input ${i + 1}`, values: { [variable]: v } }))
      const b = await createBattle({ title, task, model, inputs: body })
      onDone(b.id)
    } catch (e) { toast((e as Error).message, "error") } finally { setBusy(false) }
  }

  return (
    <div style={{ ...CARD, marginBottom: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <div><Label htmlFor="b-title">Title</Label><input id="b-title" style={FIELD} value={title} placeholder="Best cold-email opener" onChange={(e) => setTitle(e.target.value)} /></div>
        <div><Label htmlFor="b-var">Variable name</Label><input id="b-var" style={FIELD} value={variable} onChange={(e) => setVariable(e.target.value.replace(/[^A-Za-z0-9_]/g, "") || "input")} /></div>
        <div>
          <Label htmlFor="b-model">Model</Label>
          <select id="b-model" style={FIELD} value={model} onChange={(e) => setModel(e.target.value)}>
            {["claude-haiku-4-5", "claude-sonnet-4-6", "gpt-5-mini", "gpt-4o-mini"].map((m) => <option key={m}>{m}</option>)}
          </select>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <Label htmlFor="b-task">Task</Label>
        <textarea id="b-task" rows={2} style={{ ...FIELD, resize: "vertical" }} value={task}
          placeholder="Write a 2-sentence cold email opener for the product described." onChange={(e) => setTask(e.target.value)} />
      </div>
      <div style={{ marginTop: 12 }}>
        <Label>Hidden inputs for {`{{${variable}}}`} (entrants can't see these)</Label>
        {inputs.map((v, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <input aria-label={`Input ${i + 1}`} style={FIELD} value={v} onChange={(e) => setInputs(inputs.map((x, j) => j === i ? e.target.value : x))} />
            {inputs.length > 1 && <button type="button" aria-label="Remove input" onClick={() => setInputs(inputs.filter((_, j) => j !== i))}
              style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--ink-400)" }}><X size={14} /></button>}
          </div>
        ))}
        {inputs.length < 5 && <Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={() => setInputs([...inputs, ""])}>Add input</Button>}
      </div>
      <div style={{ marginTop: 12 }}><Button loading={busy} onClick={() => void submit()}>Start battle</Button></div>
    </div>
  )
}

export default function Battles() {
  const navigate = useNavigate()
  const [items, setItems] = useState<BattleSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => { listBattles().then((r) => setItems(r.battles)).catch((e: Error) => setError(e.message)) }, [])

  return (
    <div style={{ padding: PAGE_PAD }}>
      <PageHeader
        title="Battles"
        description="Same task, same hidden inputs, same model. Vote blind. Rank by quality, by the cheapest prompt that's still good, or by the safest."
        actions={<Button icon={<Plus size={14} />} onClick={() => setCreating((c) => !c)}>{creating ? "Cancel" : "New battle"}</Button>}
      />
      {creating && <CreateBattle onDone={(id) => navigate(`/battles/${id}`)} />}
      {error ? <ErrorState message={error} /> : items === null ? (
        <div className="skeleton" style={{ height: 80, borderRadius: 10 }} aria-busy="true" />
      ) : items.length === 0 ? (
        <EmptyState icon={<Swords size={22} />} title="No battles yet" body="Start one with a task and a few hidden inputs." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((b) => (
            <div key={b.id} className="ag-card" role="button" tabIndex={0} onClick={() => navigate(`/battles/${b.id}`)}
              onKeyDown={(e) => { if (e.key === "Enter") navigate(`/battles/${b.id}`) }}
              style={{ ...CARD, cursor: "pointer", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "var(--fs-title)" }}>{b.title}</div>
                <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.task}</div>
              </div>
              <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", fontFamily: "var(--font-num)" }}>
                {b.entry_count} entries · {b.vote_count} votes · {b.model} · {timeAgo(b.created_at)}
              </span>
              <Pill tone={b.status === "open" ? "accent" : "neutral"}>{b.status === "open" ? "Open" : "Closed"}</Pill>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
