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

export function scoreToColor(score: number): string {
  if (score >= 70) return "#dc2626";
  if (score >= 40) return "#d97706";
  return "#16a34a";
}

export function scoreToBg(score: number): string {
  if (score >= 70) return "#fef2f2";
  if (score >= 40) return "#fffbeb";
  return "#f0fdf4";
}

export function scoreSeverity(score: number): Severity {
  if (score >= 70) return "critical";
  if (score >= 40) return "high";
  return "safe";
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
