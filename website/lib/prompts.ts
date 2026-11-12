/**
 * Server-side reads of the app's public prompt and comparison data, for the
 * server-rendered share pages (/p/[id], /c/[id]), the /prompts landing and
 * their link previews. Only the backend's PUBLIC endpoints are used: nothing
 * private can render.
 *
 * Also a small mirror of the app's send targets (frontend/src/lib/agentTargets.ts)
 * and warning rules (frontend/src/lib/promptFormat.ts importantWarnings), the
 * same way modelName below mirrors the app's table.
 */

import LZString from "lz-string";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";
export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? (process.env.NODE_ENV === "development" ? "http://localhost:5173" : null);
/** Where the browser reaches the API. On a deploy the app domain serves /api
 *  (Vercel rewrite), so this defaults to APP_URL; set NEXT_PUBLIC_API_URL when
 *  the API lives elsewhere (local dev: the backend port). */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? APP_URL;

export type Severity = "low" | "medium" | "high" | "critical";

export interface CostRow {
  model: string; model_key: string | null; available: boolean;
  usd_per_run?: number; usd_per_1k_runs?: number; is_floor?: boolean;
}
export interface Reason {
  id: string; title: string; detail: string; severity: Severity;
  dismissed?: boolean; dismissable?: boolean; fixable?: boolean;
}
/** What the backend sends about the prompt's risks. The score and band are
 *  never shown: only plain warnings, via importantWarnings(). */
export interface DangerSummary {
  reasons?: Reason[]; publish_blockers?: string[];
}
export interface VariableSpec { sample?: string | null; expected_tokens?: number | null; untrusted?: boolean | null }
export interface PublicPrompt {
  id: string; title: string; description: string | null; use_case: string | null; body: string;
  variables: Record<string, VariableSpec> | null;
  author_id: string | null; author_name: string | null; published_version: number; use_count: number;
  runs_per_day: number | null; model: string | null;
  cost_summary: { models: CostRow[]; cheapest_model: string | null } | null;
  danger_summary: DangerSummary | null;
}
/** One row of GET /api/public/prompts (the library list). */
export interface PromptListRow {
  id: string; title: string; description: string | null; use_case: string | null;
  author_name: string | null; use_count: number;
}
/** A similar prompt (the app's Match contract). `level`/`score` order the list
 *  and are never shown. */
export interface SimilarPrompt {
  id: string; title: string; description: string | null; use_case: string | null;
  author_name: string | null;
}
export interface ComparisonEntry {
  id: string; author_name: string | null; cost: { usd_per_run: number } | null;
}
export interface PublicComparison {
  id: string; title: string; task: string; model: string; status: "open" | "closed";
  entry_count: number; leaderboard: ComparisonEntry[];
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${BACKEND}${path}`, { next: { revalidate: 30 } });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export const fetchPrompt = (id: string) => get<PublicPrompt>(`/api/public/prompts/${encodeURIComponent(id)}`);
export const fetchComparison = (id: string) => get<PublicComparison>(`/api/public/battles/${encodeURIComponent(id)}`);

/** Up to k public prompts that do a similar job. Empty when there are none or
 *  the backend can't be reached: the page then shows no Similar section. */
export async function fetchSimilar(id: string, k = 6): Promise<SimilarPrompt[]> {
  const r = await get<{ matches?: SimilarPrompt[] }>(`/api/public/prompts/${encodeURIComponent(id)}/similar?k=${k}`);
  return Array.isArray(r?.matches) ? r.matches.filter((m) => m && m.id && m.id !== id) : [];
}

/** The most-used public prompts, for the landing page. Empty on any failure. */
export async function fetchPopular(n = 6): Promise<PromptListRow[]> {
  const r = await get<{ prompts?: PromptListRow[] }>("/api/public/prompts");
  const rows = Array.isArray(r?.prompts) ? r.prompts : [];
  return [...rows].sort((a, b) => (b.use_count ?? 0) - (a.use_count ?? 0)).slice(0, n);
}

export function runCost(usd: number | null | undefined): string {
  if (usd == null) return "n/a";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`;
  return `$${usd.toPrecision(1)}`;
}

export function monthly(usd: number | null | undefined, perDay: number | null | undefined): string | null {
  if (usd == null || !perDay) return null;
  const m = usd * perDay * 30;
  if (m > 0 && m < 0.01) return "<$0.01/mo";
  return `$${m.toLocaleString("en-US", { minimumFractionDigits: m < 100 ? 2 : 0, maximumFractionDigits: m < 100 ? 2 : 0 })}/mo`;
}

// Display names for AI models (same table as the app's lib/promptFormat.ts).
// Catalog keys are IDs; people know these as "Claude Haiku 4.5", "GPT-4o mini".
const MODEL_NAMES: Record<string, string> = {
  "claude-sonnet-4-6": "Claude Sonnet 4.6", "claude-haiku-4-5": "Claude Haiku 4.5",
  "gpt-5": "GPT-5", "gpt-5-mini": "GPT-5 mini", "gpt-4o-mini": "GPT-4o mini",
  "gemini-2-5-pro": "Gemini 2.5 Pro", "gemini-2-5-flash": "Gemini 2.5 Flash",
};

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


/** The headline cost: the author's model if priced, else the cheapest. */
export function headline(p: PublicPrompt): { model: string; perRun: number; perMonth: string | null } | null {
  const priced = (p.cost_summary?.models ?? []).filter((m) => m.available && m.usd_per_run != null);
  const row = priced.find((m) => m.model_key === p.model) ?? priced.find((m) => m.model_key === p.cost_summary?.cheapest_model) ?? priced[0];
  if (!row || row.usd_per_run == null) return null;
  return { model: modelName(row.model_key ?? row.model), perRun: row.usd_per_run, perMonth: monthly(row.usd_per_run, p.runs_per_day) };
}

/** One line for link previews: what it costs and who made it. Never mentions risk. */
export function summaryLine(p: PublicPrompt): string {
  const h = headline(p);
  const cost = h ? (h.perMonth ? `${h.perMonth} at ${p.runs_per_day}× a day on ${h.model}` : `${runCost(h.perRun)} each time on ${h.model}`) : null;
  return [cost, p.author_name ? `by ${p.author_name}` : null].filter(Boolean).join(" · ");
}

// ── Blanks ────────────────────────────────────────────────────────────────

/** A `{{blank}}`; group 1 is its name. Same pattern as the app's VAR_RE and the
 *  backend's template.VAR_RE. Global: use with matchAll / split / replace only. */
export const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Blank names in first-appearance order, each once. */
export function variablesIn(body: string | null | undefined): string[] {
  const seen: string[] = [];
  for (const m of (body ?? "").matchAll(VAR_RE)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

/** A blank's name as people read it: "customer_email" → "customer email". */
export const blankName = (name: string): string => name.replace(/_/g, " ");

/** The prompt with each blank filled in. A blank left empty reads "[customer
 *  email]", the way this page shows blanks, so the agent shows what's missing
 *  instead of a raw {{template}}. Same rule as the app's Send dialog. */
export function fillBlanks(body: string, values: Record<string, string>): string {
  return body.replace(VAR_RE, (_, name: string) => (values[name]?.trim() ? values[name] : `[${blankName(name)}]`));
}

/** The body cut into plain text and blanks, for showing blanks highlighted. */
export function bodyParts(body: string): { text: string; blank: string | null }[] {
  const out: { text: string; blank: string | null }[] = [];
  let at = 0;
  for (const m of body.matchAll(VAR_RE)) {
    if (m.index! > at) out.push({ text: body.slice(at, m.index), blank: null });
    out.push({ text: m[0], blank: m[1] });
    at = m.index! + m[0].length;
  }
  if (at < body.length) out.push({ text: body.slice(at), blank: null });
  return out;
}

// ── Warnings (mirror of the app's importantWarnings) ──────────────────────

/** One warning worth showing. No score, band or points: just plain words. */
export interface Warning {
  id: string; title: string; detail: string; severity: "high" | "critical";
  /** True when this problem stops the prompt from being shared publicly. */
  blocksSharing: boolean;
}

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
};

const BLOCKER_REASON: Record<string, (r: Reason) => boolean> = {
  secret_in_prompt: (r) => (r.id ?? "").startsWith("data_exposure:secret:"),
  pii_in_prompt: (r) => r.id === "data_exposure:pii:prompt",
};

/** The warnings to show: high and critical reasons that aren't dismissed, plus
 *  anything that blocks sharing. Critical first. Empty means show nothing. */
export function importantWarnings(danger: DangerSummary | null | undefined): Warning[] {
  if (!danger) return [];
  const reasons = danger.reasons ?? [];
  const blockers = danger.publish_blockers ?? [];
  const blocks = (r: Reason) => blockers.some((b) => BLOCKER_REASON[b]?.(r) ?? false);
  const out: Warning[] = reasons
    .filter((r) => !r.dismissed && (r.severity === "high" || r.severity === "critical" || blocks(r)))
    .map((r) => ({
      id: r.id, title: r.title, detail: r.detail,
      severity: r.severity === "critical" ? "critical" : "high",
      blocksSharing: blocks(r),
    }));
  for (const b of blockers) {
    if (reasons.some((r) => BLOCKER_REASON[b]?.(r))) continue;
    const text = BLOCKER_TEXT[b] ?? {
      title: "This can't be shared yet",
      detail: "Something in the prompt needs to come out before others can see it.",
      severity: "high" as const,
    };
    out.push({ id: `blocker:${b}`, ...text, blocksSharing: true });
  }
  const rank = { critical: 0, high: 1 } as const;
  return out
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank[a.w.severity] - rank[b.w.severity] || a.i - b.i)
    .map(({ w }) => w);
}

// ── Send targets (small mirror of the app's agentTargets) ─────────────────

export type TargetGroup = "Coding agents" | "App builders" | "Chat apps";

export interface SendTarget {
  id: string;
  name: string;
  group: TargetGroup;
  /** The link that opens the agent with the prompt typed in. */
  build: (text: string) => string;
  /** Whether the text fits in that link. When it doesn't, we copy it and open
   *  `openUrl` (if any) so the person can paste it. */
  fits: (text: string) => boolean;
  /** Where to go when the prompt is too long for a link. */
  openUrl: string | null;
  /** A custom app link (not a web page): opens in place, not in a new tab. */
  app: boolean;
  /** Shown after a send, in case nothing happened. */
  help: string;
  /** Also copy the text when sending by link, for links known to lose part of it. */
  copyAlso?: (text: string) => boolean;
}

/** Half an emoji (a lone surrogate, left behind when text is cut) becomes
 *  "\uFFFD": encodeURIComponent throws on it, which would break the page. */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : "\uFFFD"));
}

const enc = (t: string) => encodeURIComponent(wellFormed(t));
// Browsers and servers start refusing links somewhere past 8,000 characters.
const URL_LIMIT = 8000;
const urlFits = (build: (t: string) => string, limit = URL_LIMIT) => (t: string) => build(t).length <= limit;

const claudeCode = (t: string) => `claude-cli://open?q=${enc(t)}`;
const cursor = (t: string) => `https://cursor.com/link/prompt?text=${enc(t)}`;
const lovable = (t: string) => `https://lovable.dev/#prompt=${enc(t)}`;
const replit = (t: string) => `https://replit.com/?stack=Build&prompt=${LZString.compressToEncodedURIComponent(t)}`;
const chatgpt = (t: string) => `https://chatgpt.com/?q=${enc(t)}`;
const claudeAi = (t: string) => `https://claude.ai/new?q=${enc(t)}`;

export const SEND_TARGETS: SendTarget[] = [
  {
    id: "claude-code", name: "Claude Code", group: "Coding agents", build: claudeCode, app: true,
    // Claude Code's documented limit for q is 5,000 characters.
    fits: (t) => t.length <= 5000, openUrl: "claude-cli://open",
    help: "Nothing happened? Open Claude Code once and send it any message, then try again.",
  },
  {
    id: "cursor", name: "Cursor", group: "Coding agents", build: cursor, app: false,
    fits: urlFits(cursor), openUrl: "https://cursor.com/",
    help: "Click Open in Cursor on the page that opens.",
    // Forum reports say Cursor drops text after "&" even when it's sent as %26
    // (same rule as the app's agentTargets).
    copyAlso: (t) => t.includes("&"),
  },
  {
    id: "lovable", name: "Lovable", group: "App builders", build: lovable, app: false,
    fits: (t) => t.length <= 50000, openUrl: "https://lovable.dev/",
    help: "Sign in to Lovable if it asks, and the prompt will be waiting.",
  },
  {
    id: "replit", name: "Replit", group: "App builders", build: replit, app: false,
    fits: (t) => t.length <= 50000, openUrl: "https://replit.com/",
    help: "Sign in to Replit if it asks, and the prompt will be waiting.",
  },
  {
    id: "chatgpt", name: "ChatGPT", group: "Chat apps", build: chatgpt, app: false,
    fits: urlFits(chatgpt), openUrl: "https://chatgpt.com/",
    help: "Sign in to ChatGPT if it asks.",
  },
  {
    id: "claude-ai", name: "Claude.ai", group: "Chat apps", build: claudeAi, app: false,
    fits: urlFits(claudeAi), openUrl: "https://claude.ai/new",
    help: "Sign in to Claude if it asks.",
  },
];

export const TARGET_GROUPS: TargetGroup[] = ["Coding agents", "App builders", "Chat apps"];
