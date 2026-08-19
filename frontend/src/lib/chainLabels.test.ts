import { describe, test, expect } from "vitest"
import { CHAIN_SHORT, CHAIN_NARRATIVE, chainShortLabel, chainNarrative } from "./chainLabels"

// Pinned from backend/authority/chain_detector.py LABEL_TRANSITIONS (32 rules).
// If a rule is added or renamed there, this list must change in the same PR.
const BACKEND_CHAIN_IDS = [
  "pii-exfil", "pii-financial", "pii-delete", "pii-prod",
  "money-external", "money-money", "money-delete",
  "prod-prod", "prod-delete", "prod-external",
  "delete-delete", "delete-external",
  "external-money", "external-prod",
  "access-money", "access-delete", "access-prod", "access-external",
  "secrets-external", "secrets-access", "secrets-money", "secrets-prod",
  "delete-evade", "money-evade", "evade-delete", "evade-external",
  "prod-evade", "access-evade",
  "bulk-external", "bulk-delete", "pii-bulk",
  "code-external",
]

describe("chain label maps match the backend chain IDs", () => {
  test("every backend chain ID has a short label and a narrative", () => {
    for (const id of BACKEND_CHAIN_IDS) {
      expect(CHAIN_SHORT[id], `missing short label for ${id}`).toBeDefined()
      expect(CHAIN_NARRATIVE[id], `missing narrative for ${id}`).toBeDefined()
    }
  })

  test("no stale keys: every mapped key is a real backend ID", () => {
    for (const key of Object.keys(CHAIN_SHORT)) expect(BACKEND_CHAIN_IDS).toContain(key)
    for (const key of Object.keys(CHAIN_NARRATIVE)) expect(BACKEND_CHAIN_IDS).toContain(key)
  })

  test("unknown IDs still humanize instead of crashing", () => {
    expect(chainShortLabel("future-chain")).toBe("Future Chain")
    expect(chainNarrative(undefined)).toBe("Unnamed chain")
  })

  test("cross-agent chain IDs resolve to the underlying chain's label", () => {
    // analyzer.py prefixes multi-agent detections with "cross-agent-"
    expect(chainShortLabel("cross-agent-pii-exfil")).toBe(CHAIN_SHORT["pii-exfil"])
    expect(chainNarrative("cross-agent-money-delete")).toBe(CHAIN_NARRATIVE["money-delete"])
  })
})
