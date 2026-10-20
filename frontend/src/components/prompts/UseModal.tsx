/**
 * Use a prompt: fill its {{variables}}, then copy the finished text or open it
 * in ChatGPT / Claude. The filled text never leaves the browser; only a use
 * count is sent (recordUse), so pasted client content stays private.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { Copy, ExternalLink, X } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { toast } from "@/components/shared/Toast"
import { EYEBROW, FIELD, Label } from "@/components/prompts/ui"
import { recordUse, type VariableSpec } from "@/lib/promptsApi"
import { fillPrompt } from "@/lib/promptFormat"

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
// Chat apps accept a prefilled prompt in the URL; past this length browsers
// and the apps start truncating, so the person copies instead.
const MAX_URL_PROMPT = 6000

export default function UseModal({ promptId, title, body, variables, signedIn, onClose }: {
  promptId: string
  title: string
  body: string
  variables: Record<string, VariableSpec> | null
  signedIn: boolean
  onClose: () => void
}) {
  const names = useMemo(() => {
    const seen: string[] = []
    for (const m of body.matchAll(VAR_RE)) if (!seen.includes(m[1])) seen.push(m[1])
    return seen
  }, [body])
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(names.map((n) => [n, ""])))
  const counted = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    dialogRef.current?.querySelector<HTMLElement>("textarea, button")?.focus()
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const filled = fillPrompt(body, values)
  const empty = names.filter((n) => !values[n]?.trim())
  const tooLong = filled.length > MAX_URL_PROMPT

  function count() {
    if (counted.current || !promptId) return  // unsaved drafts have nothing to count
    counted.current = true
    void recordUse(promptId, signedIn)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(filled)
      toast("Copied. Paste it into your AI tool.")
      count()
    } catch {
      toast("Couldn't copy automatically. Select the text and copy it.", "error")
    }
  }

  function open(app: "chatgpt" | "claude") {
    const q = encodeURIComponent(filled)
    const url = app === "chatgpt" ? `https://chatgpt.com/?q=${q}` : `https://claude.ai/new?q=${q}`
    window.open(url, "_blank", "noopener,noreferrer")
    count()
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(15,15,15,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Use ${title}`}
        style={{ width: "100%", maxWidth: 640, maxHeight: "90vh", overflow: "auto", background: "var(--card)", borderRadius: 14, boxShadow: "var(--shadow-lg)", padding: "20px clamp(16px, 4vw, 24px)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: "var(--fs-title)", fontWeight: 600, flex: 1, minWidth: 0 }}>Use “{title}”</div>
          <button type="button" aria-label="Close" onClick={onClose} style={{ border: 0, background: "none", cursor: "pointer", color: "var(--ink-400)" }}><X size={18} /></button>
        </div>
        <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 4 }}>
          Fill in the blanks. Your text stays in your browser.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
          {names.map((n) => (
            <div key={n}>
              <Label htmlFor={`use-${n}`}>{n.replace(/_/g, " ")}</Label>
              <textarea id={`use-${n}`} rows={n.length > 0 && /email|message|transcript|notes|document|article|page|review|ticket|post|resume/i.test(n) ? 5 : 2}
                style={{ ...FIELD, resize: "vertical" }} value={values[n]}
                placeholder={variables?.[n]?.sample ? `e.g. ${variables[n].sample!.slice(0, 120)}` : undefined}
                onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))} />
            </div>
          ))}
        </div>
        <div style={{ ...EYEBROW, marginTop: 16 }}>Preview</div>
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-code)", fontSize: 12.5, lineHeight: 1.55, background: "var(--paper-2)", padding: 12, borderRadius: "var(--radius-md)", marginTop: 6, maxHeight: 220, overflow: "auto", color: "var(--ink-800)" }}>
          {filled}
        </pre>
        {empty.length > 0 && (
          <p style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", marginTop: 6 }}>
            Still blank: {empty.map((n) => n.replace(/_/g, " ")).join(", ")}.
          </p>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          <Button icon={<Copy size={14} />} onClick={() => void copy()}>Copy prompt</Button>
          <Button variant="secondary" icon={<ExternalLink size={14} />} disabled={tooLong} onClick={() => open("chatgpt")}>Open in ChatGPT</Button>
          <Button variant="secondary" icon={<ExternalLink size={14} />} disabled={tooLong} onClick={() => open("claude")}>Open in Claude</Button>
        </div>
        {tooLong && <p style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", marginTop: 6 }}>Too long to open directly. Copy it instead.</p>}
      </div>
    </div>
  )
}
