/**
 * "Connect your agent" (docs/prompts-rework-plan.md §5): one click makes a
 * key, then each agent gets its own setup (a one-click install link where the
 * agent has one, otherwise a command or a settings snippet to paste). After
 * that, "Send to… → My connected agent" puts a prompt in the person's inbox and
 * their agent fetches it when they say "run my Arceo prompt".
 *
 * The key is shown once and never stored in the browser. Test it sends a
 * harmless sample and watches until the agent picks it up.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Copy, ExternalLink, KeyRound, Plug, Send } from "lucide-react"
import PageHeader from "@/components/shared/PageHeader"
import ErrorState from "@/components/shared/ErrorState"
import { toast } from "@/components/shared/Toast"
import { Button } from "@/components/ui/Button"
import { CopyLine } from "@/components/prompts/SendDialog"
import { CARD, EYEBROW, FIELD, Label, PAGE_PAD, Pill, SegControl } from "@/components/prompts/ui"
import {
  createAgentToken, listAgentTokens, listSends, mcpUrl, revokeAgentToken, sendTestToAgent, testOutcome, waitingSends,
  type AgentToken, type NewAgentToken,
} from "@/lib/agentApi"
import { CONNECTED_SAY, CONNECTED_SLASH, connectSetups, copyText, type ConnectSetup } from "@/lib/agentTargets"
import { timeAgo } from "@/lib/utils"

const POLL_MS = 2_000
const TEST_WAIT_MS = 5 * 60_000

function CodeBlock({ code, label }: { code: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <div style={{ position: "relative", minWidth: 0 }}>
      <pre style={{
        margin: 0, padding: "10px 12px", paddingRight: 92, background: "var(--paper-2)", border: "1px solid var(--line)",
        borderRadius: "var(--radius-md)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-small)", lineHeight: 1.5,
        color: "var(--ink-800)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 260, overflow: "auto",
      }}>
        {code}
      </pre>
      <div style={{ position: "absolute", top: 6, right: 6 }}>
        <Button size="sm" variant="secondary" aria-label={label} icon={done ? <Check size={13} /> : <Copy size={13} />}
          onClick={() => {
            void copyText(code).then((ok) => {
              if (ok) { setDone(true); window.setTimeout(() => setDone(false), 1600) } else toast("Couldn't copy. Select it and copy it.", "error")
            })
          }}>
          {done ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  )
}

function SetupSteps({ setup }: { setup: ConnectSetup }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-700)", margin: 0, lineHeight: 1.5 }}>{setup.where}</p>
      {setup.installUrl && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <a href={setup.installUrl} className="btn btn--primary" style={{ textDecoration: "none" }}>
            <Plug size={14} aria-hidden /> Add to {setup.name}
          </a>
          <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)" }}>Opens {setup.name} and asks you to confirm.</span>
        </div>
      )}
      {setup.code && <CodeBlock code={setup.code} label={`Copy the ${setup.name} setup`} />}
      <a href={setup.docs} target="_blank" rel="noopener noreferrer"
        style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", display: "inline-flex", gap: 4, alignItems: "center", width: "fit-content" }}>
        {setup.name}'s own instructions <ExternalLink size={12} aria-hidden />
      </a>
    </div>
  )
}

type TestState =
  | { phase: "idle" }
  // `earlier`: sends that were already waiting. The agent gets the test first
  // (newest first), but one of these being picked up proves the connection too.
  | { phase: "waiting"; id: string; since: number; earlier: string[] }
  | { phase: "got-it"; earlier: boolean }
  | { phase: "timed-out" }

export default function PromptsConnect() {
  const [tokens, setTokens] = useState<AgentToken[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [label, setLabel] = useState("")
  const [creating, setCreating] = useState(false)
  const [fresh, setFresh] = useState<NewAgentToken | null>(null)
  const [agent, setAgent] = useState("claude-code")
  const [test, setTest] = useState<TestState>({ phase: "idle" })
  const [confirmOff, setConfirmOff] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  const load = useCallback(() => {
    listAgentTokens()
      .then((t) => { setTokens(t); setLoadError(null) })
      .catch((e: Error) => setLoadError(e.message))
  }, [])
  useEffect(load, [load])

  // Watch for the test send being picked up.
  useEffect(() => {
    if (test.phase !== "waiting") return
    const tick = () => {
      if (Date.now() - test.since > TEST_WAIT_MS) { setTest({ phase: "timed-out" }); return }
      listSends()
        .then((list) => {
          const got = testOutcome(list, test.id, test.earlier)
          if (got !== "waiting") { setTest({ phase: "got-it", earlier: got === "got-earlier" }); load() }
        })
        .catch(() => { /* keep waiting; a blip shouldn't end the test */ })
    }
    pollRef.current = window.setInterval(tick, POLL_MS)
    return () => { if (pollRef.current) window.clearInterval(pollRef.current) }
  }, [test, load])

  async function create() {
    setCreating(true)
    try {
      const t = await createAgentToken(label.trim() || "My agent")
      setFresh(t)
      setLabel("")
      load()
    } catch (e) {
      toast((e as Error).message, "error")
    } finally {
      setCreating(false)
    }
  }

  async function runTest() {
    try {
      // Note what's already waiting: if the agent picks one of those up, it's connected too.
      const earlier = await listSends().then((l) => waitingSends(l).map((x) => x.id), () => [] as string[])
      const r = await sendTestToAgent()
      setTest({ phase: "waiting", id: r.id, since: Date.now(), earlier })
    } catch (e) {
      toast((e as Error).message, "error")
    }
  }

  async function turnOff(id: string) {
    if (confirmOff !== id) { setConfirmOff(id); return }
    try {
      await revokeAgentToken(id)
      if (fresh?.id === id) setFresh(null)
      setConfirmOff(null)
      toast("Turned off. That agent can't fetch prompts any more.")
      load()
    } catch (e) {
      toast((e as Error).message, "error")
    }
  }

  const active = (tokens ?? []).filter((t) => !t.revoked_at)
  const setups = fresh ? connectSetups(mcpUrl(), fresh.token) : []
  const popular = setups.filter((s) => s.popular)
  const current = setups.find((s) => s.id === agent) ?? popular[0]

  return (
    <div style={{ padding: PAGE_PAD, maxWidth: 920 }}>
      <PageHeader
        title="Connect your agent"
        description="Send prompts from Arceo straight to Claude Code, Cursor or another coding agent. Set it up once, then pick “My connected agent” when you send."
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* 1. Make a key */}
        <section style={CARD} aria-labelledby="connect-1">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Pill tone="accent">Step 1</Pill>
            <h2 id="connect-1" style={{ fontSize: "var(--fs-title)", fontWeight: 600, margin: 0 }}>Make a key for your agent</h2>
          </div>
          {!fresh ? (
            <>
              <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: "8px 0 12px", lineHeight: 1.5 }}>
                The key lets your agent fetch the prompts you send it, and nothing else. You can turn it off any time.
              </p>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 220px", maxWidth: 320 }}>
                  <Label htmlFor="key-label">Name it (optional)</Label>
                  <input id="key-label" style={FIELD} value={label} maxLength={60} placeholder="My laptop"
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void create() }} />
                </div>
                <Button icon={<KeyRound size={14} />} loading={creating} onClick={() => void create()}>Make a key</Button>
              </div>
            </>
          ) : (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-700)", margin: 0, lineHeight: 1.5 }}>
                Here's your key. <b>Copy it now: you won't see it again.</b> Keep it private, like a password.
              </p>
              <CopyLine text={fresh.token} label="Copy the key" />
            </div>
          )}
        </section>

        {/* 2. Add it to your agent */}
        <section style={{ ...CARD, opacity: fresh ? 1 : 0.6 }} aria-labelledby="connect-2">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Pill tone={fresh ? "accent" : "neutral"}>Step 2</Pill>
            <h2 id="connect-2" style={{ fontSize: "var(--fs-title)", fontWeight: 600, margin: 0 }}>Add it to your agent</h2>
          </div>
          {!fresh ? (
            <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: "8px 0 0", lineHeight: 1.5 }}>
              Make a key first. Then you'll get a one-click link or a line to paste for Claude Code, Cursor, VS Code, Codex,
              Windsurf, Gemini, Zed, Cline, Kiro and others.
            </p>
          ) : (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <SegControl options={popular.map((s) => ({ value: s.id, label: s.name }))}
                  value={popular.some((s) => s.id === agent) ? agent : ("" as string)} onChange={setAgent} />
                <select aria-label="Other agents" style={{ ...FIELD, width: "auto", minWidth: 170 }}
                  value={popular.some((s) => s.id === agent) ? "" : agent}
                  onChange={(e) => { if (e.target.value) setAgent(e.target.value) }}>
                  <option value="">Other agents…</option>
                  {setups.filter((s) => !s.popular).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              {current && <SetupSteps setup={current} />}
              <p style={{ fontSize: "var(--fs-micro)", color: "var(--ink-400)", margin: 0, lineHeight: 1.5 }}>
                Claude.ai and the Claude desktop app need a different kind of sign-in, so they can't connect yet.
                For those, use Send to… and pick Claude.
              </p>
            </div>
          )}
        </section>

        {/* 3. Test it */}
        <section style={{ ...CARD, opacity: active.length ? 1 : 0.6 }} aria-labelledby="connect-3">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Pill tone={active.length ? "accent" : "neutral"}>Step 3</Pill>
            <h2 id="connect-3" style={{ fontSize: "var(--fs-title)", fontWeight: 600, margin: 0 }}>Test it</h2>
          </div>
          <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: "8px 0 12px", lineHeight: 1.5 }}>
            We'll send your agent a harmless sample. Then, in your agent, say:
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 520 }}>
            <CopyLine text={CONNECTED_SAY} label="Copy what to say" />
            <span style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)" }}>In Claude Code you can also type:</span>
            <CopyLine text={CONNECTED_SLASH} label="Copy the Claude Code shortcut" />
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 14 }} role="status" aria-live="polite">
            <Button icon={<Send size={14} />} disabled={!active.length || test.phase === "waiting"} onClick={() => void runTest()}>
              {test.phase === "idle" ? "Send a test" : "Send another test"}
            </Button>
            {test.phase === "waiting" && (
              <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)", lineHeight: 1.5 }}>
                Sent. Waiting for your agent to pick it up…
              </span>
            )}
            {test.phase === "got-it" && (
              <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-800)", display: "inline-flex", gap: 6, alignItems: "center" }}>
                <Check size={15} aria-hidden /> {test.earlier ? "Your agent picked up a prompt you sent earlier. You're connected." : "Your agent got it. You're connected."}
              </span>
            )}
            {test.phase === "timed-out" && (
              <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-600)" }}>
                Nothing yet. Check step 2, restart your agent, then try again.
              </span>
            )}
          </div>
        </section>

        {/* Connections */}
        <section style={CARD} aria-labelledby="connect-list">
          <h2 id="connect-list" style={{ ...EYEBROW, margin: "0 0 10px" }}>Your connected agents</h2>
          {loadError ? <ErrorState message={loadError} onRetry={load} /> : tokens === null ? (
            <div className="skeleton" style={{ height: 40 }} aria-busy="true" />
          ) : active.length === 0 ? (
            <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: 0 }}>None yet.</p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
              {active.map((t) => (
                <li key={t.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 0", borderTop: "1px solid var(--line-soft)" }}>
                  <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: "var(--fs-body)", overflowWrap: "anywhere" }}>{t.label || "My agent"}</div>
                    <div style={{ fontSize: "var(--fs-micro)", color: "var(--ink-500)", marginTop: 2 }}>
                      Made {timeAgo(t.created_at)} · {t.last_used_at ? `last used ${timeAgo(t.last_used_at)}` : "not used yet"}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void turnOff(t.id)}>
                    {confirmOff === t.id ? "Click again to turn off" : "Turn off"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
