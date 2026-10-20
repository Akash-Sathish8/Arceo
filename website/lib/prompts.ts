/**
 * Server-side reads of the app's public prompt and comparison data, for the
 * server-rendered share pages (/p/[id], /c/[id]) and their link previews.
 * Only the backend's PUBLIC endpoints are used: nothing private can render.
 */

import C from "./palette";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";
export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? (process.env.NODE_ENV === "development" ? "http://localhost:5173" : null);
/** Where the browser reaches the API. On a deploy the app domain serves /api
 *  (Vercel rewrite), so this defaults to APP_URL; set NEXT_PUBLIC_API_URL when
 *  the API lives elsewhere (local dev: the backend port). */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? APP_URL;

export type Band = "low" | "medium" | "high" | "critical";

export interface CostRow {
  model: string; model_key: string | null; available: boolean;
  usd_per_run?: number; usd_per_1k_runs?: number; is_floor?: boolean;
}
export interface Reason { title: string; detail: string; severity: Band; dismissed?: boolean }
export interface PublicPrompt {
  id: string; title: string; description: string | null; use_case: string | null; body: string;
  author_id: string | null; author_name: string | null; published_version: number; use_count: number;
  runs_per_day: number | null; model: string | null;
  cost_summary: { models: CostRow[]; cheapest_model: string | null } | null;
  danger_summary: { score: number; band: Band; status: "static" | "probed"; reasons: Reason[] } | null;
}
export interface LeaderRow {
  id: string; rank: number; author_name: string | null; elo: number; wins: number; losses: number; ties: number;
  cost: { usd_per_run: number } | null; danger: { score: number; band: Band } | null;
}
export interface PublicComparison {
  id: string; title: string; task: string; model: string; status: "open" | "closed";
  entry_count: number; vote_count: number; leaderboard: LeaderRow[];
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${BACKEND}${path}`, { next: { revalidate: 300 } });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export const fetchPrompt = (id: string) => get<PublicPrompt>(`/api/public/prompts/${encodeURIComponent(id)}`);
export const fetchComparison = (id: string) => get<PublicComparison>(`/api/public/battles/${encodeURIComponent(id)}`);

export const BAND: Record<Band, { label: string; ink: string; fill: string; ring: string }> = {
  low: { label: "Low", ink: C.safe, fill: C.safeFill, ring: C.safeRing },
  medium: { label: "Medium", ink: C.elevated, fill: C.elevatedFill, ring: C.elevatedRing },
  high: { label: "High", ink: C.high, fill: C.highFill, ring: C.high },
  critical: { label: "Critical", ink: C.critical, fill: C.criticalFill, ring: C.criticalRing },
};

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

/** The headline cost: the author's model if priced, else the cheapest. */
export function headline(p: PublicPrompt): { model: string; perRun: number; perMonth: string | null } | null {
  const priced = (p.cost_summary?.models ?? []).filter((m) => m.available && m.usd_per_run != null);
  const row = priced.find((m) => m.model_key === p.model) ?? priced.find((m) => m.model_key === p.cost_summary?.cheapest_model) ?? priced[0];
  if (!row || row.usd_per_run == null) return null;
  return { model: row.model_key ?? row.model, perRun: row.usd_per_run, perMonth: monthly(row.usd_per_run, p.runs_per_day) };
}

export function summaryLine(p: PublicPrompt): string {
  const h = headline(p);
  const band = p.danger_summary ? `${BAND[p.danger_summary.band].label} danger` : null;
  const cost = h ? (h.perMonth ? `${h.perMonth} at ${p.runs_per_day}/day on ${h.model}` : `${runCost(h.perRun)} a run on ${h.model}`) : null;
  return [band, cost, p.author_name ? `by ${p.author_name}` : null].filter(Boolean).join(" · ");
}
