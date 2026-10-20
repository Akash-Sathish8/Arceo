/**
 * One battle: enter a prompt, vote blind on pairs of outputs, and watch the
 * leaderboard. Entry text stays hidden until the organiser closes it.
 */

import { useCallback, useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import { Link2 } from "lucide-react"
import PageHeader from "@/components/shared/PageHeader"
import ErrorState from "@/components/shared/ErrorState"
import { toast } from "@/components/shared/Toast"
import { Button } from "@/components/ui/Button"
import Leaderboard from "@/components/prompts/Leaderboard"
import { CARD, EYEBROW, FIELD, Label, PAGE_PAD, Pill } from "@/components/prompts/ui"
import {
  castVote, closeBattle, enterBattle, getBattle, getMatchup,
  type Battle, type BattleSort, type Matchup,
} from "@/lib/promptsApi"

function Output({ label, text, onPick, disabled }: { label: string; text: string; onPick: () => void; disabled: boolean }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-md)", padding: 12, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={EYEBROW}>{label}</div>
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-sans)", fontSize: "var(--fs-small)", color: "var(--ink-800)", margin: 0, flex: 1, lineHeight: 1.55 }}>{text}</pre>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={onPick}>{label} is better</Button>
    </div>
  )
}

export default function BattleDetail() {
  const { battleId } = useParams()
  const [b, setB] = useState<Battle | null>(null)
  const [sort, setSort] = useState<BattleSort>("best")
  const [error, setError] = useState<string | null>(null)
  const [entry, setEntry] = useState("")
  const [entering, setEntering] = useState(false)
  const [m, setM] = useState<Matchup | null | undefined>(undefined)
  const [voting, setVoting] = useState(false)

  const load = useCallback(() => {
    getBattle(battleId!, sort).then((x) => { setB(x); setError(null) }).catch((e: Error) => setError(e.message))
  }, [battleId, sort])
  const nextMatchup = useCallback(() => {
    getMatchup(battleId!).then((r) => setM(r.matchup)).catch(() => setM(null))
  }, [battleId])

  useEffect(load, [load])
  useEffect(nextMatchup, [nextMatchup])

  async function vote(winner: string) {
    if (!m) return
    setVoting(true)
    try {
      await castVote(battleId!, { entry_a: m.left.id, entry_b: m.right.id, input_index: m.input_index, winner })
      nextMatchup(); load()
    } catch (e) { toast((e as Error).message, "error") } finally { setVoting(false) }
  }

  async function submitEntry() {
    setEntering(true)
    try { await enterBattle(battleId!, entry); toast("Entered. Your prompt ran on every input."); setEntry(""); load(); nextMatchup() }
    catch (e) { toast((e as Error).message, "error") } finally { setEntering(false) }
  }

  if (error) return <div style={{ padding: PAGE_PAD }}><ErrorState message={error} onRetry={load} /></div>
  if (!b) return <div style={{ padding: PAGE_PAD }} aria-busy="true"><div className="skeleton" style={{ height: 30, width: 260 }} /></div>

  const open = b.status === "open"
  const entered = b.leaderboard.some((r) => r.mine)
  const share = `${window.location.origin}/b/${b.id}`

  return (
    <div style={{ padding: PAGE_PAD }}>
      <PageHeader
        back={{ to: "/battles", label: "Battles" }}
        title={b.title}
        description={`${b.task} · runs on ${b.model} · ${b.entry_count} entries · ${b.vote_count} votes`}
        actions={<>
          <Pill tone={open ? "accent" : "neutral"}>{open ? "Open" : "Closed"}</Pill>
          {b.is_creator && open && <Button variant="secondary" size="sm" onClick={() => closeBattle(b.id).then(setB)}>Close battle</Button>}
        </>}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          {open && (
            <div style={CARD}>
              <div style={EYEBROW}>Vote</div>
              {m === undefined ? <div className="skeleton" style={{ height: 80, marginTop: 10 }} /> : m === null ? (
                <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 8 }}>
                  {b.entry_count < 2 ? "Voting starts once there are two entries." : "You've judged every matchup. Check back as entries come in."}
                </p>
              ) : (
                <>
                  <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)", marginTop: 8 }}>
                    Input: <span style={{ color: "var(--ink-900)" }}>{Object.values(m.input.values).join(" · ")}</span>
                  </p>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginTop: 10 }}>
                    <Output label="A" text={m.left.output} disabled={voting} onPick={() => vote(m.left.id)} />
                    <Output label="B" text={m.right.output} disabled={voting} onPick={() => vote(m.right.id)} />
                  </div>
                  <div style={{ marginTop: 8 }}><Button variant="ghost" size="sm" disabled={voting} onClick={() => vote("tie")}>It's a tie</Button></div>
                </>
              )}
            </div>
          )}
          {open && !entered && (
            <div style={CARD}>
              <Label htmlFor="b-entry">Your entry</Label>
              <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginBottom: 8 }}>
                Use {b.variables.map((v) => `{{${v}}}`).join(", ")} where the hidden input goes. It runs on {b.model} for every input.
              </p>
              <textarea id="b-entry" rows={6} style={{ ...FIELD, fontFamily: "var(--font-code)", resize: "vertical" }} value={entry}
                placeholder={`Write a punchy opener for {{${b.variables[0] ?? "input"}}}…`} onChange={(e) => setEntry(e.target.value)} />
              <div style={{ marginTop: 8 }}><Button loading={entering} disabled={!entry.trim()} onClick={() => void submitEntry()}>Enter battle</Button></div>
            </div>
          )}
          {b.inputs && (
            <div style={CARD}>
              <div style={{ ...EYEBROW, marginBottom: 6 }}>Inputs {open ? "(only you can see these)" : ""}</div>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: "var(--fs-small)", color: "var(--ink-700)" }}>
                {b.inputs.map((i, k) => <li key={k}>{Object.values(i.values).join(" · ")}</li>)}
              </ol>
            </div>
          )}
        </div>
        <div style={{ ...CARD, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <div style={EYEBROW}>Leaderboard</div>
            <Button variant="ghost" size="sm" icon={<Link2 size={13} />}
              onClick={() => navigator.clipboard?.writeText(share).then(() => toast("Share link copied"))}>
              Share
            </Button>
          </div>
          {b.leaderboard.length === 0
            ? <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)" }}>No entries yet.</p>
            : <Leaderboard rows={b.leaderboard} sort={sort} onSort={setSort} showBodies />}
        </div>
      </div>
    </div>
  )
}
