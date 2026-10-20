/** Battle leaderboard: rating, record, cost per run on the battle model, danger. */

import DangerBadge from "@/components/prompts/DangerBadge"
import { SegControl, TD, TH } from "@/components/prompts/ui"
import { formatRunCost, type BattleSort, type LeaderRow } from "@/lib/promptsApi"

export const SORTS = [
  { value: "best", label: "Best" },
  { value: "cheapest_good", label: "Cheapest that's good" },
  { value: "safest", label: "Safest" },
] as const

export default function Leaderboard({ rows, sort, onSort, showBodies }: {
  rows: LeaderRow[]
  sort: BattleSort
  onSort: (s: BattleSort) => void
  showBodies: boolean
}) {
  return (
    <div>
      <SegControl options={SORTS} value={sort} onChange={onSort} />
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
          <thead>
            <tr>
              <th style={TH}>#</th><th style={TH}>Creator</th>
              <th style={{ ...TH, textAlign: "right" }}>Rating</th><th style={{ ...TH, textAlign: "right" }}>W-L-T</th>
              <th style={{ ...TH, textAlign: "right" }}>Per run</th><th style={TH}>Danger</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ ...TD, fontFamily: "var(--font-num)" }}>{r.rank}</td>
                <td style={TD}>
                  <span style={{ fontWeight: r.mine ? 600 : 400 }}>{r.mine ? "You" : (r.author_name ?? "creator")}</span>
                  {showBodies && r.body && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: "pointer", fontSize: "var(--fs-micro)", color: "var(--ink-500)" }}>Prompt</summary>
                      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-code)", fontSize: 12, background: "var(--paper-2)", padding: 8, borderRadius: "var(--radius-md)" }}>{r.body}</pre>
                    </details>
                  )}
                </td>
                <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)", fontWeight: 600 }}>{r.elo}</td>
                <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)", color: "var(--ink-600)" }}>{r.wins}-{r.losses}-{r.ties}</td>
                <td style={{ ...TD, textAlign: "right", fontFamily: "var(--font-num)" }}>
                  {formatRunCost(r.cost?.usd_per_run)}
                  <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)", fontFamily: "var(--font-sans)" }}>measured</div>
                </td>
                <td style={TD}><DangerBadge danger={r.danger} size={30} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
