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
  { id: "llm_anthropic", name: "Anthropic (Claude)", placeholder: "Starts with sk-ant-", help: "console.anthropic.com, under API keys" },
  { id: "llm_openai", name: "OpenAI (GPT)", placeholder: "Starts with sk-", help: "platform.openai.com, under API keys" },
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
      toast("Connected. Tests now run on your own account.")
      load()
    } catch (e) { toast((e as Error).message, "error") } finally { setBusy(null) }
  }

  async function remove(id: string) {
    setBusy(id)
    try {
      await apiFetch(`/api/credentials/${id}`, { method: "DELETE" })
      toast("Disconnected.")
      load()
    } catch (e) { toast((e as Error).message, "error") } finally { setBusy(null) }
  }

  return (
    <div id="model-keys">
      <h2 style={{ fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--ink-900)" }}>Your AI accounts</h2>
      <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 4, maxWidth: 560, lineHeight: 1.5 }}>
        Optional. Tests, comparisons and workflows run free up to a monthly limit. To go past it, connect your own
        Anthropic or OpenAI account: their websites give you an API key (a long code that starts with “sk-”), and you paste it here.
        Usage is then billed to that account. Keys are stored encrypted and never shown again.
        {budget && !budget.own_keys.anthropic && !budget.own_keys.openai && budget.free_providers.length > 0 &&
          ` You have ${budget.remaining} of ${budget.free_runs} free tests left this month.`}
      </p>
      {forbidden && <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-700)", marginTop: 12 }}>Only an admin on your team can connect AI accounts.</p>}
      {!forbidden && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16, maxWidth: 560 }}>
          {PROVIDERS.map((p) => (
            <div key={p.id}>
              <Label htmlFor={`key-${p.id}`}>{p.name} API key</Label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input id={`key-${p.id}`} type="password" autoComplete="off" style={{ ...FIELD, flex: "1 1 240px" }}
                  placeholder={stored[p.id] !== undefined ? "Connected. Paste a new key to replace it." : p.placeholder}
                  value={drafts[p.id] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))} />
                <Button size="sm" loading={busy === p.id} disabled={!(drafts[p.id] ?? "").trim()} onClick={() => void save(p.id)}>Save</Button>
                {stored[p.id] !== undefined && (
                  <Button variant="ghost" size="sm" disabled={busy === p.id} onClick={() => void remove(p.id)}>Remove</Button>
                )}
              </div>
              <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)", marginTop: 4 }}>
                {stored[p.id] !== undefined ? "Connected" : "Not connected"} · get a key at {p.help}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
