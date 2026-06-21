/**
 * Plain-language labels for risk-chain identifiers.
 *
 * Backend stores chains by short kebab-case key ("pii-exfiltration"). The UI
 * should never show the key — it reads as dev-facing. Use these helpers to
 * render either a short chip label or a narrative sentence.
 */

const CHAIN_SHORT: Record<string, string> = {
  "pii-exfiltration":           "PII → Sent Externally",
  "unsupervised-refund":        "PII → Moves Money",
  "data-destruction":           "Access → Deletes Data",
  "infrastructure-destruction": "Prod Change → Destroys Infra",
  "financial-destruction":      "Reads Records → Deletes Them",
  "privilege-escalation":       "Prod Change → Deletes Data",
  "external-financial":         "Moves Money → Sends Externally",
  "pii-financial":              "PII → Financial Action",
  "production-external":        "Prod Change → External Notify",
}

const CHAIN_NARRATIVE: Record<string, string> = {
  "pii-exfiltration":           "Read customer data → send it outside your organization",
  "unsupervised-refund":        "Look up customer payment info → issue an unsupervised refund",
  "data-destruction":           "Access data → permanently delete it",
  "infrastructure-destruction": "Change production config → terminate infrastructure",
  "financial-destruction":      "Read financial records → delete them permanently",
  "privilege-escalation":       "Modify production settings → delete sensitive data",
  "external-financial":         "Move money → send confirmation externally without approval",
  "pii-financial":              "Read customer PII → initiate financial transaction",
  "production-external":        "Change production → notify external systems",
}

function humanize(key: string | undefined | null): string {
  if (!key) return "Unnamed chain"
  return key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export function chainShortLabel(key: string | undefined | null): string {
  if (!key) return "Unnamed chain"
  return CHAIN_SHORT[key] ?? humanize(key)
}

export function chainNarrative(key: string | undefined | null): string {
  if (!key) return "Unnamed chain"
  return CHAIN_NARRATIVE[key] ?? humanize(key)
}
