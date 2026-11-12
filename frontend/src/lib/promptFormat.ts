/**
 * Pure formatting for prompt cost read-outs. Kept free of the API client so
 * it can be unit-tested without a browser (api.ts reads localStorage on load).
 */

import type { CostBasis, CostRow, CostSummary, DangerReason, DangerSummary } from "./promptsApi"

/** A `{{blank}}` in a prompt body; group 1 is the blank's name. Same pattern as
 *  the backend's prompts/template.py VAR_RE. It is global (/g), so use it with
 *  matchAll / replace only: .test() and .exec() keep state between calls. */
export const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/** Blank names in first-appearance order, each once. */
export function variablesIn(body: string | null | undefined): string[] {
  const seen: string[] = []
  for (const m of (body ?? "").matchAll(VAR_RE)) if (!seen.includes(m[1])) seen.push(m[1])
  return seen
}

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
  measured: "from real answers",
  exact: "exact",
  declared: "based on your answer length",
  heuristic: "estimate",
  unavailable: "pick an answer length",
}

export const BASIS_HELP: Record<CostBasis | "floor", string> = {
  floor: "At least this much. A blank has no example text yet, so its length isn't counted.",
  measured: "Based on real answers to this prompt.",
  exact: "Counted exactly, the same way the AI company bills it.",
  declared: "Based on the answer length you picked.",
  heuristic: "A close estimate from the length of the prompt.",
  unavailable: "This only counts the prompt, not the answer. Pick how long answers are to include it.",
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

/** A blank's example as a one-line placeholder: "e.g. …", at most `max` characters
 *  of example, cut at a word (never mid-word) with "…" when it's longer. */
export function exampleHint(sample: string | null | undefined, max = 120): string | undefined {
  const flat = (sample ?? "").split(/\s+/).filter(Boolean).join(" ")
  if (!flat) return undefined
  if (flat.length <= max) return `e.g. ${flat}`
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(" ")
  // One very long word: cut it rather than show nothing.
  const head = (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")
  return `e.g. ${head}…`
}

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

/** "$3.10/mo", "$1,240/mo", "Under $0.01/mo". */
export function formatMonthly(usd: number | null | undefined): string {
  if (usd == null || isNaN(usd)) return "n/a"
  if (usd > 0 && usd < 0.01) return "Under $0.01/mo"
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: usd < 100 ? 2 : 0, maximumFractionDigits: usd < 100 ? 2 : 0 })}/mo`
}

/** A monthly figure that may be a floor ("at least this"): "≥ $3.10/mo". A floor
 *  under a cent reads "Under $0.01/mo", never "≥ Under $0.01/mo". */
export function formatMonthlyFloor(usd: number | null | undefined, isFloor: boolean | null | undefined): string {
  const text = formatMonthly(usd)
  return isFloor && usd != null && usd >= 0.01 ? `≥ ${text}` : text
}

// ~0.75 English words per token. Shown to people as words; stored as tokens.
export const wordsToTokens = (words: number): number => Math.round(words / 0.75)
export const tokensToWords = (tokens: number): number => Math.round(tokens * 0.75)

export const OUTPUT_PRESETS = [
  { key: "short", label: "Short", hint: "about 75 words", tokens: 100 },
  { key: "medium", label: "Medium", hint: "about 250 words", tokens: 330 },
  { key: "long", label: "Long", hint: "about 600 words", tokens: 800 },
] as const

/** The finished prompt: every {{variable}} replaced, missing ones left blank.
 *  With `ifEmpty`, a blank that's missing or only spaces gets ifEmpty(name)
 *  instead, so the reader can see what still needs filling in. */
export function fillPrompt(body: string, values: Record<string, string>, ifEmpty?: (name: string) => string): string {
  return body.replace(VAR_RE, (_, name: string) => {
    const v = values[name]
    if (ifEmpty && !v?.trim()) return ifEmpty(name)
    return v ?? ""
  })
}

/** How an empty blank reads in a sent prompt: "[customer email]". The website
 *  shows blanks the same way. */
export const blankPlaceholder = (name: string): string => `[${blankName(name)}]`

/** One warning worth showing a person. Same fields as a DangerReason, minus the
 *  scoring ones (points, factor, evidence), which the prompts UI never shows. */
export interface Warning {
  id: string
  title: string
  detail: string
  severity: "high" | "critical"
  fixable: boolean
  dismissable: boolean
  dismissed: boolean
  /** True when this problem stops the prompt from being shared publicly. */
  blocksSharing: boolean
}

// What each publish blocker means, for the rare case the matching reason
// isn't in the list (the backend always sends one today).
const BLOCKER_TEXT: Record<string, { title: string; detail: string; severity: Warning["severity"] }> = {
  secret_in_prompt: {
    title: "A password or key is in the prompt",
    detail: "Anyone who copies this prompt could use it to get into your account. Take it out, then change the real password or key.",
    severity: "critical",
  },
  pii_in_prompt: {
    title: "Personal info in the prompt",
    detail: "It contains someone's real personal details. Swap in made-up details before sharing.",
    severity: "high",
  },
}

// Which reason ids already describe each blocker (danger.py: data_exposure reasons
// keyed "secret:<where>" / "pii:prompt").
const BLOCKER_REASON: Record<string, (r: DangerReason) => boolean> = {
  secret_in_prompt: (r) => r.id.startsWith("data_exposure:secret:"),
  pii_in_prompt: (r) => r.id === "data_exposure:pii:prompt",
}

/** The warnings to show: high and critical reasons that aren't dismissed, plus
 *  anything that blocks sharing. Critical first. Empty means show nothing. */
export function importantWarnings(danger: DangerSummary | null | undefined): Warning[] {
  if (!danger) return []
  const blockers = danger.publish_blockers ?? []
  const blocks = (r: DangerReason) => blockers.some((b) => BLOCKER_REASON[b]?.(r) ?? false)
  const out: Warning[] = (danger.reasons ?? [])
    .filter((r) => !r.dismissed && (r.severity === "high" || r.severity === "critical" || blocks(r)))
    .map((r) => ({
      id: r.id,
      title: r.title,
      detail: r.detail,
      severity: r.severity === "critical" ? "critical" : "high",
      fixable: !!r.fixable,
      dismissable: r.dismissable,
      dismissed: false,
      blocksSharing: blocks(r),
    }))
  for (const b of blockers) {
    if ((danger.reasons ?? []).some((r) => BLOCKER_REASON[b]?.(r))) continue
    const text = BLOCKER_TEXT[b] ?? {
      title: "This can't be shared yet",
      detail: "Something in the prompt needs to come out before others can see it.",
      severity: "high" as const,
    }
    out.push({ id: `blocker:${b}`, ...text, fixable: b in BLOCKER_TEXT, dismissable: false, dismissed: false, blocksSharing: true })
  }
  const rank = { critical: 0, high: 1 } as const
  return out
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank[a.w.severity] - rank[b.w.severity] || a.i - b.i)
    .map(({ w }) => w)
}

/** The library's plain categories (backend/prompts/seed/*.yaml use_case values),
 *  coding-agent ones first. A prompt can still carry any other category. */
export const CATEGORIES = [
  "Build something", "Fix & debug", "Look & feel", "Forms, data & accounts", "Launch & share", "Understand & plan",
  "Marketing & social", "Running the business", "Research & summaries", "Sales", "Customer support",
  "Planning & decisions", "Money", "Writing & editing", "Email & messages", "Meetings & notes", "Personal",
] as const
