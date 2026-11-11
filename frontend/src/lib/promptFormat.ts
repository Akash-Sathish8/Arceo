/**
 * Pure formatting for prompt cost read-outs. Kept free of the API client so
 * it can be unit-tested without a browser (api.ts reads localStorage on load).
 */

import type { CostBasis, CostRow, CostSummary } from "./promptsApi"

/** Per-run prices are routinely fractions of a cent, so formatMoney's whole
 *  dollars would print $0 for every prompt. Show enough digits to compare. */
export function formatRunCost(usd: number | null | undefined): string {
  if (usd == null || isNaN(usd)) return "Unavailable"
  if (usd === 0) return "$0"
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`
  return `$${usd.toPrecision(1)}`
}

/** The basis word to show for one cost row. A floor whose output IS known
 *  (only a variable is unsized) is a "floor", not "input only". */
export function rowBasis(row: Pick<CostRow, "basis" | "is_floor" | "output_basis">): CostBasis | "floor" {
  if (row.output_basis === "unavailable") return "unavailable"
  if (row.is_floor) return "floor"
  return row.basis ?? "heuristic"
}

// Plain words for how sure a cost figure is. The audience doesn't think in
// tokens, tokenizers or "input vs output": only "how sure is this number".
export const BASIS_LABEL: Record<CostBasis | "floor", string> = {
  floor: "at least this",
  measured: "from real tests",
  exact: "exact",
  declared: "based on your answer length",
  heuristic: "estimate",
  unavailable: "pick an answer length",
}

export const BASIS_HELP: Record<CostBasis | "floor", string> = {
  floor: "At least this much. A blank has no example text yet, so its length isn't counted.",
  measured: "Based on real answers from testing this prompt.",
  exact: "Counted exactly, the same way the AI company bills it.",
  declared: "Based on the answer length you picked. Test the prompt to get a real figure.",
  heuristic: "A close estimate from the length of the prompt.",
  unavailable: "This only counts the prompt, not the answer. Pick how long answers are, or test the prompt.",
}

// Display names for AI models. The catalog keys ("claude-haiku-4-5") are IDs,
// not names; people know these as "Claude Haiku 4.5" or "GPT-4o mini".
const MODEL_NAMES: Record<string, string> = {
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gpt-5": "GPT-5",
  "gpt-5-mini": "GPT-5 mini",
  "gpt-4o-mini": "GPT-4o mini",
  "gemini-2-5-pro": "Gemini 2.5 Pro",
  "gemini-2-5-flash": "Gemini 2.5 Flash",
}

const BRAND: Record<string, string> = { claude: "Claude", gpt: "GPT", gemini: "Gemini", grok: "Grok", deepseek: "DeepSeek", llama: "Llama", mistral: "Mistral" }

/** "claude-haiku-4-5" → "Claude Haiku 4.5". Unknown keys get the same treatment
 *  (brand capitalised, version digits joined with dots) rather than showing the ID. */
export function modelName(key: string | null | undefined): string {
  if (!key) return "AI model"
  if (MODEL_NAMES[key]) return MODEL_NAMES[key]
  const parts = key.split(/[-_]/).filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    const prev = out[out.length - 1]
    if (/^\d+$/.test(p) && prev && /\d$/.test(prev) && !/\./.test(prev.split(/[\s-]/).pop() ?? "")) {
      out[out.length - 1] = `${prev}.${p}`                 // 4-5 → 4.5
    } else if (prev === "GPT" && /^\d/.test(p)) {
      out[out.length - 1] = `GPT-${p}`                     // gpt-5 → GPT-5
    } else if (BRAND[p.toLowerCase()]) {
      out.push(BRAND[p.toLowerCase()])
    } else if (/^\d/.test(p) || out.length === 0) {
      out.push(/^\d/.test(p) ? p : p[0].toUpperCase() + p.slice(1))
    } else {
      out.push(prev?.startsWith("GPT") ? p : p[0].toUpperCase() + p.slice(1))  // GPT-5 mini, Claude Opus
    }
  }
  return out.join(" ")
}

/** A blank's name as people read it: "customer_email" → "customer email". */
export const blankName = (name: string): string => name.replace(/_/g, " ")

/** The headline cost for a prompt: the author's own model if priced, else the cheapest. */
export function headlineCost(cost: CostSummary | null | undefined, preferred?: string | null): CostRow | null {
  if (!cost) return null
  const priced = cost.models.filter((m) => m.available && m.usd_per_run != null)
  return (preferred ? priced.find((m) => m.model_key === preferred || m.model === preferred) : undefined)
    ?? priced.find((m) => m.model_key === cost.cheapest_model) ?? priced[0] ?? null
}


/** Monthly cost at the author's volume (30-day month). null when either is unknown. */
export function monthlyCost(usdPerRun: number | null | undefined, runsPerDay: number | null | undefined): number | null {
  if (usdPerRun == null || runsPerDay == null || runsPerDay <= 0) return null
  return usdPerRun * runsPerDay * 30
}

/** "$3.10/mo", "$1,240/mo", "<$0.01/mo". */
export function formatMonthly(usd: number | null | undefined): string {
  if (usd == null || isNaN(usd)) return "n/a"
  if (usd > 0 && usd < 0.01) return "<$0.01/mo"
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: usd < 100 ? 2 : 0, maximumFractionDigits: usd < 100 ? 2 : 0 })}/mo`
}

// ~0.75 English words per token. Shown to people as words; stored as tokens.
export const wordsToTokens = (words: number): number => Math.round(words / 0.75)
export const tokensToWords = (tokens: number): number => Math.round(tokens * 0.75)

export const OUTPUT_PRESETS = [
  { key: "short", label: "Short", hint: "about 75 words", tokens: 100 },
  { key: "medium", label: "Medium", hint: "about 250 words", tokens: 330 },
  { key: "long", label: "Long", hint: "about 600 words", tokens: 800 },
] as const

/** The finished prompt: every {{variable}} replaced, missing ones left blank. */
export function fillPrompt(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name: string) => values[name] ?? "")
}
