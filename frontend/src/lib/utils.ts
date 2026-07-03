import type { RiskLabel, Severity } from "./types";

export function timeAgo(ts: string): string {
  const normalized = ts.endsWith("Z") ? ts : ts + "Z";
  const diffMs = Date.now() - new Date(normalized).getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export interface ScoreBand {
  key: Severity;
  label: "Critical" | "High" | "Medium" | "Low";
  color: string;
  bg: string;
}

/**
 * The single authoritative band scale — mirrors backend `score_band()` in
 * authority/graph.py: low <40, medium 40–59, high 60–79, critical ≥80.
 * Prefer the backend-provided `blast_radius.band` when available; the local
 * computation is the fallback for older payloads. An agent with critical
 * chains never reads below Medium (the score rates actions individually,
 * chains rate combinations — "Low" next to "2 critical chains" reads as the
 * product contradicting itself).
 */
export function scoreBand(score: number, criticalChains = 0, backendBand?: string): ScoreBand {
  const k = backendBand
    ?? (score >= 80 ? "critical"
      : score >= 60 ? "high"
      : score >= 40 || criticalChains > 0 ? "medium"
      : "low");
  switch (k) {
    case "critical": return { key: "critical", label: "Critical", color: "#dc2626", bg: "#fef2f2" };
    case "high":     return { key: "high",     label: "High",     color: "#ea580c", bg: "#fff7ed" };
    case "medium":   return { key: "medium",   label: "Medium",   color: "#d97706", bg: "#fffbeb" };
    default:         return { key: "safe",     label: "Low",      color: "#16a34a", bg: "#f0fdf4" };
  }
}

export function bandDescription(key: Severity): string {
  switch (key) {
    case "critical": return "Critical — can cause irreversible real-world damage";
    case "high":     return "High risk — can move money, delete data, or affect production";
    case "medium":   return "Medium risk — can send emails, modify records, or form dangerous chains";
    default:         return "Low risk — read-only actions, no irreversible capabilities";
  }
}

export function scoreToColor(score: number): string {
  return scoreBand(score).color;
}

export function scoreToBg(score: number): string {
  return scoreBand(score).bg;
}

export function scoreSeverity(score: number): Severity {
  return scoreBand(score).key;
}

export function agentIcon(agentType: string | null | undefined): string {
  const t = (agentType ?? "").toLowerCase();
  if (t.includes("support") || t.includes("customer")) return "Headset";
  if (t.includes("devops") || t.includes("infra") || t.includes("deploy")) return "Terminal";
  if (t.includes("sales") || t.includes("crm")) return "BarChart2";
  if (t.includes("ops") || t.includes("operations")) return "Settings2";
  return "Bot";
}

const RISK_LABEL_COLORS: Record<RiskLabel, string> = {
  moves_money:        "#dc2626",
  touches_pii:        "#7c3aed",
  deletes_data:       "#ea580c",
  sends_external:     "#0891b2", // cyan-600 — resolves collision with accent blue
  changes_production: "#b45309", // amber-700 — raises severity signal vs. calm teal
};

const RISK_LABEL_BGS: Record<RiskLabel, string> = {
  moves_money:        "#fef2f2",
  touches_pii:        "#f5f3ff",
  deletes_data:       "#fff7ed",
  sends_external:     "#ecfeff",
  changes_production: "#fffbeb",
};

export function riskLabelColor(label: RiskLabel): string {
  return RISK_LABEL_COLORS[label];
}

export function riskLabelBg(label: RiskLabel): string {
  return RISK_LABEL_BGS[label];
}

export function formatDate(ts: string): string {
  const normalized = ts.endsWith("Z") ? ts : ts + "Z";
  return new Date(normalized).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
