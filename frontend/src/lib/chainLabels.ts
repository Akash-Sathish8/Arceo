/**
 * Plain-language labels for risk-chain identifiers.
 *
 * Backend identifies chains by short kebab-case id ("pii-exfil"). The UI
 * should never show the raw id — it reads as dev-facing. Use these helpers
 * to render either a short chip label or a narrative sentence.
 *
 * Keys mirror backend/authority/chain_detector.py LABEL_TRANSITIONS (32
 * rules); chainLabels.test.ts pins the two lists together, so a backend
 * rename fails the frontend test instead of silently falling back to
 * humanize(). Callers should pass `chain_id` (with `chain_name` as a
 * fallback for older payloads) — the API sends both.
 */

export const CHAIN_SHORT: Record<string, string> = {
  // PII escalation paths
  "pii-exfil":        "PII → Sent Externally",
  "pii-financial":    "PII → Moves Money",
  "pii-delete":       "PII → Deleted",
  "pii-prod":         "PII → Prod Change",

  // Financial escalation paths
  "money-external":   "Moves Money → External Send",
  "money-money":      "Money → More Money",
  "money-delete":     "Moves Money → Deletes Records",

  // Production/infrastructure escalation paths
  "prod-prod":        "Prod Change → Prod Change",
  "prod-delete":      "Prod Change → Deletes Data",
  "prod-external":    "Prod Change → External Notify",

  // Deletion escalation paths
  "delete-delete":    "Delete → Delete",
  "delete-external":  "Deletes Data → External Send",

  // External send escalation
  "external-money":   "External Send → Moves Money",
  "external-prod":    "External Send → Prod Change",

  // Privilege escalation
  "access-money":     "Access Grant → Moves Money",
  "access-delete":    "Access Grant → Deletes Data",
  "access-prod":      "Access Grant → Prod Change",
  "access-external":  "Access Grant → External Send",

  // Credential access
  "secrets-external": "Reads Secrets → Sent Externally",
  "secrets-access":   "Reads Secrets → Access Change",
  "secrets-money":    "Reads Secrets → Moves Money",
  "secrets-prod":     "Reads Secrets → Prod Change",

  // Defense evasion
  "delete-evade":     "Delete → Disables Logging",
  "money-evade":      "Moves Money → Disables Logging",
  "evade-delete":     "Disables Logging → Delete",
  "evade-external":   "Disables Monitoring → External Send",
  "prod-evade":       "Prod Change → Disables Logging",
  "access-evade":     "Access Grant → Disables Logging",

  // Bulk collection / staging
  "bulk-external":    "Bulk Export → Sent Externally",
  "bulk-delete":      "Bulk Export → Delete",
  "pii-bulk":         "PII → Bulk Export",

  // Arbitrary code execution
  "code-external":    "Runs Code → Sent Externally",
}

export const CHAIN_NARRATIVE: Record<string, string> = {
  "pii-exfil":        "Read customer data → send it outside your organization",
  "pii-financial":    "Read customer PII → initiate a financial transaction",
  "pii-delete":       "Look up customer records → permanently delete them",
  "pii-prod":         "Read customer data → modify production systems",

  "money-external":   "Move money → send an external notification",
  "money-money":      "Chain multiple money-moving actions in sequence",
  "money-delete":     "Move money → delete the records of it",

  "prod-prod":        "Make cascading production changes in sequence",
  "prod-delete":      "Change production config → delete data permanently",
  "prod-external":    "Change production → notify external systems",

  "delete-delete":    "Delete data across multiple systems",
  "delete-external":  "Delete data → send it outside your organization",

  "external-money":   "Send externally → move money without approval",
  "external-prod":    "Send externally → modify production systems",

  "access-money":     "Elevate access → move money with the new privileges",
  "access-delete":    "Elevate access → delete data with the new privileges",
  "access-prod":      "Elevate access → modify production systems",
  "access-external":  "Elevate access → send data outside your organization",

  "secrets-external": "Read credentials or keys → send them outside your organization",
  "secrets-access":   "Read credentials → change who has access",
  "secrets-money":    "Read credentials → move money with them",
  "secrets-prod":     "Read credentials → modify production with them",

  "delete-evade":     "Delete data → disable the logging that would show it",
  "money-evade":      "Move money → tamper with the audit trail",
  "evade-delete":     "Disable logging → delete data unobserved",
  "evade-external":   "Disable monitoring → send data out unobserved",
  "prod-evade":       "Change production → disable the monitoring that would show it",
  "access-evade":     "Elevate access → disable the logging that would show it",

  "bulk-external":    "Export data in bulk → send it outside your organization",
  "bulk-delete":      "Export data in bulk → delete the originals",
  "pii-bulk":         "Read customer PII → export it in bulk",

  "code-external":    "Run arbitrary code → send data outside your organization",
}

// Multi-agent detections arrive as "cross-agent-<id>" (sandbox/analyzer.py);
// the surrounding UI section already communicates cross-agent-ness, so the
// label is the underlying chain's.
function normalizeKey(key: string): string {
  return key.startsWith("cross-agent-") ? key.slice("cross-agent-".length) : key
}

function humanize(key: string | undefined | null): string {
  if (!key) return "Unnamed chain"
  return key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export function chainShortLabel(key: string | undefined | null): string {
  if (!key) return "Unnamed chain"
  return CHAIN_SHORT[normalizeKey(key)] ?? humanize(key)
}

export function chainNarrative(key: string | undefined | null): string {
  if (!key) return "Unnamed chain"
  return CHAIN_NARRATIVE[normalizeKey(key)] ?? humanize(key)
}
