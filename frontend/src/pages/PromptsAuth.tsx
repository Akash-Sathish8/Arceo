/**
 * Sign in / create account for people who came for the prompt library
 * (/login?for=prompts, linked from the website's /prompts page). No agent
 * onboarding: one form, then straight to /prompts in a prompts workspace.
 */

import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { AlertCircle } from "lucide-react"
import LogoMark, { ArceoWordmark } from "@/components/shared/LogoMark"
import { Button } from "@/components/ui/Button"
import { FIELD, Label } from "@/components/prompts/ui"
import { apiFetch, setToken, setUser } from "@/lib/api"
import type { User } from "@/lib/types"
import { useWorkspaceStore } from "@/store/workspace"

interface AuthResponse { token: string; user: User & { workspace?: "agents" | "prompts" } }

export default function PromptsAuth() {
  const navigate = useNavigate()
  const prime = useWorkspaceStore((s) => s.prime)
  const load = useWorkspaceStore((s) => s.load)
  const [mode, setMode] = useState<"signup" | "signin">("signup")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!email.trim() || !password) { setError("Enter your email and a password."); return }
    if (mode === "signup" && password.length < 8) { setError("Use at least 8 characters for your password."); return }
    setBusy(true)
    try {
      if (mode === "signup") {
        const r = await apiFetch<AuthResponse>("/api/auth/signup", {
          method: "POST", skipLogoutOn401: true,
          body: JSON.stringify({ email: email.trim(), password, name: email.split("@")[0], workspace: "prompts" }),
        })
        setToken(r.token); setUser(r.user); prime("prompts")
        navigate("/prompts/new?example=1")
      } else {
        const r = await apiFetch<AuthResponse>("/api/auth/login", {
          method: "POST", skipLogoutOn401: true, body: JSON.stringify({ email: email.trim(), password }),
        })
        setToken(r.token); setUser(r.user)
        const ws = await load()
        navigate(ws === "prompts" ? "/prompts" : "/")
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : ""
      setError(mode === "signin" && /expired|log in again/i.test(msg) ? "That email and password don't match."
        : /already registered/i.test(msg) ? "That email already has an account. Sign in instead." : msg || "Something went wrong.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-page)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "var(--font-sans)" }}>
      <div style={{ width: "100%", maxWidth: 420, background: "var(--card)", borderRadius: 16, boxShadow: "var(--shadow-card-new)", padding: "36px clamp(20px, 6vw, 40px)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 24 }}>
          <LogoMark size={28} /><ArceoWordmark height={12} />
          <span style={{ fontSize: "var(--fs-small)", color: "var(--ink-400)", marginLeft: 4 }}>Prompts</span>
        </div>
        <h1 style={{ fontSize: "var(--fs-page)", fontWeight: 600, color: "var(--ink-900)", lineHeight: 1.25 }}>
          {mode === "signup" ? "Ready-made AI prompts that are safe to use and priced up front" : "Welcome back"}
        </h1>
        <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 8, lineHeight: 1.5 }}>
          {mode === "signup"
            ? "Free to start. Paste in something you ask ChatGPT or Claude to do and see what it costs and whether it's safe, in seconds."
            : "Sign in to your prompt library."}
        </p>
        {error && (
          <div role="alert" style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 16, padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--critical-bg)", color: "var(--critical)", fontSize: "var(--fs-small)" }}>
            <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} /> {error}
          </div>
        )}
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 20 }}>
          <div>
            {/* Sign-in takes whatever the account was created with (an email, or a
                plain username for invited accounts); sign-up needs a real email. */}
            <Label htmlFor="pa-email">{mode === "signup" ? "Work email" : "Email or username"}</Label>
            <input id="pa-email" type={mode === "signup" ? "email" : "text"} inputMode="email" autoComplete="username"
              style={{ ...FIELD, height: 42 }} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pa-pw">Password</Label>
            <input id="pa-pw" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} style={{ ...FIELD, height: 42 }} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <Button type="submit" loading={busy} size="lg">{mode === "signup" ? "Create free account" : "Sign in"}</Button>
        </form>
        <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 18, textAlign: "center" }}>
          {mode === "signup" ? "Already have an account? " : "New here? "}
          <button type="button" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(null) }}
            style={{ border: 0, background: "none", padding: 0, color: "var(--ink-900)", fontWeight: 600, textDecoration: "underline", cursor: "pointer", fontSize: "inherit" }}>
            {mode === "signup" ? "Sign in" : "Create an account"}
          </button>
        </p>
      </div>
    </div>
  )
}
