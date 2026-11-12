/**
 * "Send to your agent" client: agent connections (tokens), the send inbox,
 * and the MCP address agents connect to. Contracts: docs/prompts-rework-plan.md §5.
 *
 *   GET    /api/prompts/agent-tokens          -> { tokens: AgentToken[] }
 *   POST   /api/prompts/agent-tokens {label}  -> { id, label, token }   (token shown ONCE)
 *   DELETE /api/prompts/agent-tokens/{id}
 *   POST   /api/prompts/{id}/send {values}    -> { id, expires_at }
 *   GET    /api/prompts/sends                 -> { sends: PromptSend[] }
 *
 * The plain token is only in createAgentToken's answer. Never store it
 * (no localStorage): show it, let the person copy it, then drop it.
 */

import { apiBase, apiFetch } from "@/lib/api"

export interface AgentToken {
  id: string
  label: string | null
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface NewAgentToken {
  id: string
  label: string | null
  /** The full `ap_...` value. Returned once; the server keeps only a hash. */
  token: string
}

export interface PromptSend {
  id: string
  prompt_id: string | null
  title: string | null
  created_at: string
  /** Set when the agent picked it up; null while it waits. */
  delivered_at: string | null
  expires_at: string
}

// Accept a bare array too, so a list endpoint's envelope can't silently empty the page.
const unwrap = <T>(r: T[] | Record<string, T[] | undefined>, key: string): T[] =>
  Array.isArray(r) ? r : (r?.[key] ?? [])

export const listAgentTokens = (): Promise<AgentToken[]> =>
  apiFetch<AgentToken[] | { tokens?: AgentToken[] }>("/api/prompts/agent-tokens").then((r) => unwrap(r, "tokens"))

export const createAgentToken = (label: string): Promise<NewAgentToken> =>
  apiFetch<NewAgentToken>("/api/prompts/agent-tokens", { method: "POST", body: JSON.stringify({ label }) })

export const revokeAgentToken = (id: string): Promise<void> =>
  apiFetch<unknown>(`/api/prompts/agent-tokens/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => undefined)

/** Put a filled-in prompt in the person's inbox for their connected agent (kept 24 hours). */
export const sendToAgent = (promptId: string, values: Record<string, string>): Promise<{ id: string; expires_at: string }> =>
  apiFetch<{ id: string; expires_at: string }>(`/api/prompts/${encodeURIComponent(promptId)}/send`, {
    method: "POST", body: JSON.stringify({ values }),
  })

export const listSends = (): Promise<PromptSend[]> =>
  apiFetch<PromptSend[] | { sends?: PromptSend[] }>("/api/prompts/sends").then((r) => unwrap(r, "sends"))

/** The address agents connect to: the backend's origin + "/mcp". Same origin as
 *  the app unless VITE_API_URL points elsewhere (dev: Vite proxies /mcp). */
export function mcpUrl(): string {
  const base = apiBase()
  if (base) return `${base}/mcp`
  const origin = typeof window !== "undefined" ? window.location.origin : ""
  return `${origin}/mcp`
}

/** Queue a harmless sample prompt so the Connect page can check an agent picks it up. */
export const sendTestToAgent = (): Promise<{ id: string; expires_at: string }> =>
  apiFetch<{ id: string; expires_at: string }>("/api/prompts/sends/test", { method: "POST" })

/** Sends still waiting for an agent to pick them up. */
export function waitingSends(list: readonly PromptSend[], now: number = Date.now()): PromptSend[] {
  return list.filter((s) => !s.delivered_at && !(Date.parse(s.expires_at) <= now))
}

/** What the Connect page's test learned from the latest send list. An agent
 *  gets the NEWEST waiting send first, so it normally picks up the test itself.
 *  A send that was already waiting being picked up instead (the agent asked
 *  twice, or a second agent got the test) still proves the connection. */
export function testOutcome(list: readonly PromptSend[], testId: string, earlierIds: readonly string[]): "waiting" | "got-test" | "got-earlier" {
  const delivered = (id: string) => list.some((s) => s.id === id && !!s.delivered_at)
  if (delivered(testId)) return "got-test"
  return earlierIds.some(delivered) ? "got-earlier" : "waiting"
}
