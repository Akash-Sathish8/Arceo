/**
 * "/" opens on the product this org signed up for: the prompt library for a
 * prompts workspace, the agents dashboard otherwise. It waits for the server's
 * answer: the cached value may belong to the previous user on this browser.
 */

import { useEffect, useState } from "react"
import { Navigate } from "react-router-dom"
import Authority from "@/pages/Authority"
import { useWorkspaceStore } from "@/store/workspace"

export default function HomeRoute() {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const load = useWorkspaceStore((s) => s.load)
  const [checked, setChecked] = useState(false)

  useEffect(() => { void load().then(() => setChecked(true)) }, [load])

  if (!checked) return null
  return workspace === "prompts" ? <Navigate to="/prompts" replace /> : <Authority />
}

export function LoginGate({ Login, PromptsAuth }: { Login: React.ComponentType; PromptsAuth: React.ComponentType }) {
  const forPrompts = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("for") === "prompts"
  return forPrompts ? <PromptsAuth /> : <Login />
}
