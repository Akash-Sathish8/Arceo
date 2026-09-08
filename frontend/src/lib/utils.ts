import type { RiskLabel, Severity } from "./types";

// Timestamps live in lib/time.ts now (one implementation, offset-safe).
// Re-exported here so existing `@/lib/utils` imports keep working.
export { timeAgo, formatDateTime, formatDateShort, parseTimestamp } from "./time";

export interface ScoreBand {
  key: Severity;
  label: "Critical" | "High" | "Medium" | "Low";
  color: string;   // text/number color (AA on white)
  bg: string;      // tint background
  ring: string;    // graphics-only ring stroke (>=3:1)
  line: string;    // border
}

/**
 * The single authoritative band scale — mirrors backend `score_band()` in
 * authority/graph.py: low <40, medium 40–59, high 60–79, critical ≥80.
 * Prefer the backend-provided `blast_radius.band` when available; the local
 * computation is the fallback for older payloads. An agent with critical
 * chains never reads below Medium (the score rates actions individually,
 * chains rate combinations — "Low" next to "2 critical chains" reads as the
 * product contradicting itself).
 *
 * All colors are CSS-variable references (design tokens), so the same band
 * looks identical everywhere and theming stays central. NOTE: callers must
 * NOT string-concatenate these (e.g. `color + "18"`); use `bg` for tints.
 */
export function scoreBand(score: number, criticalChains = 0, backendBand?: string): ScoreBand {
  const k = backendBand
    ?? (score >= 80 ? "critical"
      : score >= 60 ? "high"
      : score >= 40 || criticalChains > 0 ? "medium"
      : "low");
  switch (k) {
    case "critical": return { key: "critical", label: "Critical", color: "var(--critical)", bg: "var(--critical-bg)", ring: "var(--critical-ring)", line: "var(--critical-line)" };
    case "high":     return { key: "high",     label: "High",     color: "var(--high)",     bg: "var(--high-bg)",     ring: "var(--high-ring)",     line: "var(--high-line)" };
    case "medium":   return { key: "medium",   label: "Medium",   color: "var(--caution)",  bg: "var(--caution-bg)",  ring: "var(--caution-ring)",  line: "var(--caution-line)" };
    default:         return { key: "safe",     label: "Low",      color: "var(--safe)",     bg: "var(--safe-bg)",     ring: "var(--safe-ring)",     line: "var(--safe-line)" };
  }
}

/**
 * Presentation for a single simulated run's risk_score. Deliberately the SAME
 * 0-100 band scale as blast radius (so users don't juggle two mental models),
 * but it's a distinct metric — labelled "Sim risk" at call sites, with its own
 * SIM_RISK_METHODOLOGY tooltip. Rounds so decimals never leak.
 */
export function simRiskBand(score: number): ScoreBand {
  return scoreBand(Math.round(score));
}

export function bandDescription(key: Severity): string {
  switch (key) {
    case "critical": return "Critical. Can cause irreversible real-world damage.";
    case "high":     return "High risk. Can move money, delete data, or change production.";
    case "medium":   return "Medium risk. Can send emails, change records, or form dangerous chains.";
    default:         return "Low risk. Read-only actions, with nothing irreversible.";
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

// Sourced from the --label-* design tokens so every surface agrees.
const RISK_LABEL_COLORS: Record<RiskLabel, string> = {
  moves_money:        "var(--label-moves-money)",
  touches_pii:        "var(--label-touches-pii)",
  deletes_data:       "var(--label-deletes-data)",
  sends_external:     "var(--label-sends-external)",
  changes_production: "var(--label-changes-production)",
  changes_access:     "var(--label-changes-access)",
  reads_secrets:      "var(--label-reads-secrets)",
  evades_detection:   "var(--label-evades-detection)",
  bulk_export:        "var(--label-bulk-export)",
  executes_code:      "var(--label-executes-code)",
};

const RISK_LABEL_BGS: Record<RiskLabel, string> = {
  moves_money:        "var(--label-moves-money-bg)",
  touches_pii:        "var(--label-touches-pii-bg)",
  deletes_data:       "var(--label-deletes-data-bg)",
  sends_external:     "var(--label-sends-external-bg)",
  changes_production: "var(--label-changes-production-bg)",
  changes_access:     "var(--label-changes-access-bg)",
  reads_secrets:      "var(--label-reads-secrets-bg)",
  evades_detection:   "var(--label-evades-detection-bg)",
  bulk_export:        "var(--label-bulk-export-bg)",
  executes_code:      "var(--label-executes-code-bg)",
};

// Clean 1-2 word display names — the ONLY thing users should see. Never render
// the raw snake_case label. Plain-English (no jargon) per the CFO copy rule.
const RISK_LABEL_NAMES: Record<RiskLabel, string> = {
  moves_money:        "Money",
  touches_pii:        "Personal data",
  deletes_data:       "Deletes data",
  sends_external:     "Sends out",
  changes_production: "Production",
  changes_access:     "Access control",
  reads_secrets:      "Secrets",
  evades_detection:   "Log tampering",
  bulk_export:        "Bulk export",
  executes_code:      "Code exec",
};

export function riskLabelColor(label: RiskLabel): string {
  return RISK_LABEL_COLORS[label] ?? "var(--text-muted)";
}

export function riskLabelBg(label: RiskLabel): string {
  return RISK_LABEL_BGS[label] ?? "var(--bg)";
}

// Human display name for a risk label. Falls back to a de-snaked Title Case for
// any unknown/future label so the UI never shows a raw underscore string.
export function riskLabelName(label: string): string {
  return (
    RISK_LABEL_NAMES[label as RiskLabel] ??
    label.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// Legacy alias — delegates to the offset-safe formatter in lib/time.ts.
export { formatDateTime as formatDate } from "./time";
