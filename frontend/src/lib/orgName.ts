/**
 * Org display name, derived from the signed-in user's email domain.
 *
 * Extracted from Sidebar so CFO-facing exports (per-agent and fleet PDFs)
 * print the same name the app chrome shows instead of "your organization".
 */

import { getUser } from "@/lib/api"

const CONSUMER_DOMAINS = new Set([
  "gmail", "googlemail", "yahoo", "outlook", "hotmail", "live", "icloud",
  "me", "aol", "proton", "protonmail", "pm",
])

// Our own domains, current and retired. The seed demo account is
// admin@actiongate.io, so deriving an org name from its domain rendered the
// retired product name — "Actiongate" — in the chrome of every screen, demos
// included. Only the display is mapped: the seed email and the actiongate.db
// filename stay as they are while the rename is mid-flight.
const OWN_DOMAINS = new Set(["arceo", "actiongate"])

export function isDemoSession(): boolean {
  try { return localStorage.getItem("arceo_demo_session") === "1" } catch { return false }
}

export function deriveOrgName(email: string | undefined): string {
  if (isDemoSession()) return "Shared demo account"
  if (!email) return "Arceo"
  const domain = email.split("@")[1] ?? ""
  const root = domain.split(".")[0] ?? ""
  // A personal inbox has no meaningful org name — showing "Gmail" reads as a bug.
  if (!root || CONSUMER_DOMAINS.has(root.toLowerCase())) return "Personal workspace"
  if (OWN_DOMAINS.has(root.toLowerCase())) return "Arceo"
  return root.charAt(0).toUpperCase() + root.slice(1)
}

/** The signed-in user's org display name — the same one the sidebar shows. */
export function currentOrgName(): string {
  const user = getUser() as { email?: string } | null
  return deriveOrgName(user?.email)
}
