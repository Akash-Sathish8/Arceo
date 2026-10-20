/**
 * Settings → Model keys: a team's own Anthropic / OpenAI key for prompt QA,
 * comparisons and workflow runs. Stored in the credential vault (encrypted,
 * never shown again). With a key, runs bill to the team's account and have no
 * allowance; without one, runs use Arceo's key and the free monthly allowance.
 */

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/Button"
import { toast } from "@/components/shared/Toast"
import { FIELD, Label } from "@/components/prompts/ui"
import { apiFetch } from "@/lib/api"
import { getQaBudget, type QaBudget } from "@/lib/promptsApi"

const PROVIDERS = [
  { id: "llm_anthropic", name: "Anthropic", placeholder: "sk-ant-…", help: "console.anthropic.com → API keys" },
  { id: "llm_openai", name: "OpenAI", placeholder: "sk-…", help: "platform.openai.com → API keys" },
] as const

export default function ModelKeysSection() {
  const [stored, setStored] = useState<Record<string, string | null>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [budget, setBudget] = useState<QaBudget | null>(null)
  const [forbidden, setForbidden] = useState(false)

  const load = useCallback(() => {
    apiFetch<{ credentials: { provider: string; updated_at: string | null }[] }>("/api/credentials")
      .then((r) => setStored(Object.fromEntries(r.credentials.map((c) => [c.provider, c.updated_at]))))
      .catch((e: Error) => { if (/permission|admin|403/i.test(e.message)) setForbidden(true) })
    getQaBudget().then(setBudget).catch(() => {})
  }, [])

  useEffect(load, [load])

  async function save(id: string) {
    const secret = (drafts[id] ?? "").trim()
    if (!secret) return
    setBusy(id)
    try {
      await apiFetch(`/api/credentials/${id}`, { method: "PUT", body: JSON.stringify({ secret }) })
      setDrafts((d) => ({ ...d, [id]: "" }))
      toast("Key saved. Runs now use your own key.")
      load()
    } catch (e) { toast((e as Error).message, "error") } finally { setBusy(null) }
  }

  async function remove(id: string) {
    setBusy(id)
    try {
      await apiFetch(`/api/credentials/${id}`, { method: "DELETE" })
      toast("Key removed.")
      load()
    } catch (e) { toast((e as Error).message, "error") } finally { setBusy(null) }
  }

  return (
    <div id="model-keys">
      <h2 style={{ fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--ink-900)" }}>Model keys</h2>
      <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 4, maxWidth: 560, lineHeight: 1.5 }}>
        Add your own key to run prompt QA, comparisons and workflows on your account, with no monthly limit from us.
        Keys are encrypted and never shown again.
        {budget && !budget.own_keys.anthropic && !budget.own_keys.openai && budget.free_providers.length > 0 &&
          ` Without one you get ${budget.free_runs} free runs a month (${budget.remaining} left).`}
      </p>
      {forbidden && <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-700)", marginTop: 12 }}>Only an admin on your team can add model keys.</p>}
      {!forbidden && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16, maxWidth: 560 }}>
          {PROVIDERS.map((p) => (
            <div key={p.id}>
              <Label htmlFor={`key-${p.id}`}>{p.name} key</Label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input id={`key-${p.id}`} type="password" autoComplete="off" style={{ ...FIELD, flex: "1 1 240px" }}
                  placeholder={stored[p.id] !== undefined ? "Saved. Paste a new key to replace it." : p.placeholder}
                  value={drafts[p.id] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))} />
                <Button size="sm" loading={busy === p.id} disabled={!(drafts[p.id] ?? "").trim()} onClick={() => void save(p.id)}>Save</Button>
                {stored[p.id] !== undefined && (
                  <Button variant="ghost" size="sm" disabled={busy === p.id} onClick={() => void remove(p.id)}>Remove</Button>
                )}
              </div>
              <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)", marginTop: 4 }}>
                {stored[p.id] !== undefined ? "Saved" : "Not set"} · get one at {p.help}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
