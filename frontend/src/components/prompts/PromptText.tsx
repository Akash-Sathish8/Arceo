/**
 * A prompt's text for reading: each {{blank}} shows as a soft pill,
 * [customer email], so people see where their own words go.
 */

import { VAR_RE, blankName } from "@/lib/promptFormat"

/** The prompt's text with each {{blank}} shown as a soft pill: [customer email]. */
export default function PromptText({ body: raw }: { body: string }) {
  // "<email>{{email}}</email>" reads as just [email]: the tags are for the AI, not for people.
  const body = raw.replace(/<([A-Za-z_][\w-]*)>\s*(\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\})\s*<\/\1>/g, "$2")
  const parts: React.ReactNode[] = []
  let last = 0
  for (const m of body.matchAll(VAR_RE)) {
    const at = m.index ?? 0
    if (at > last) parts.push(body.slice(last, at))
    parts.push(
      <span key={`${at}-${m[1]}`} style={{
        background: "var(--accent-soft)", color: "var(--accent-ink)", borderRadius: 4, padding: "0 4px",
        fontWeight: 600, whiteSpace: "nowrap",
      }}>
        [{blankName(m[1])}]
      </span>,
    )
    last = at + m[0].length
  }
  if (last < body.length) parts.push(body.slice(last))
  return (
    <div style={{
      whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "var(--fs-body)", lineHeight: 1.6, color: "var(--ink-800)",
    }}>
      {parts}
    </div>
  )
}

