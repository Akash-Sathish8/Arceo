/**
 * Agent risk-score card.
 *
 * Deliberately minimal — two rows only: header (icon + name/desc + risk
 * dial) and tool chips. Everything deeper (capability bars, spend, policy
 * coverage, chains) lives in the drawer the card opens. The chips row is
 * pinned to the card's bottom edge so it aligns across a 2-up grid row
 * (CSS-grid's default `align-items: stretch` handles equal-height).
 *
 * CapBars renders those capability rows for the drawer; it is exported
 * from here but no longer used by the card itself.
 *
 * Tokens used: var(--card), var(--line), var(--ink-*), var(--paper-2),
 * var(--accent), var(--safe|caution|critical*).
 */

import RiskRing from "@/components/shared/RiskRing";
import { scoreBand } from "@/lib/utils";
import { formatMoney } from "@/lib/format";

export interface AgentCardData {
  id: string;
  name: string;
  description: string;
  tools: string[];
  /** 0-100, higher = riskier. The INHERENT score — the capability ceiling.
   *  Policy-blind by design (graph.py), so it never moves when gates are added. */
  score: number;
  /** What's left after the agent's policies gate its actions. Only rendered
   *  when the agent actually has policies: an agent with none can still report
   *  residual < score, because `score` is floored to its band minimum
   *  (graph.py display_score) and residual isn't — a 2-point display artifact,
   *  not mitigation. */
  residual?: number;
  /** Backend-authoritative band (low|medium|high|critical); local fallback if absent. */
  band?: string;
  /** Actions with no classifiable risk signal (score 0, true risk unknown). */
  unclassified?: number;
  caps: {
    money?: number;
    pii?: number;
    delete?: number;
    external?: number;
    prod?: number;
  };
  /** Estimated monthly spend in USD. Pass null when no forecast. */
  spend: number | null;
  actions: number;
  irreversible: number;
  chains: number;
  critical: number;
  policies: number;
  /** Per-effect policy counts. Lets the footer badge distinguish enforced
   *  coverage (BLOCK/ALLOW → green) from a still-pending REQUIRE_APPROVAL gate
   *  (amber — NOT a green "approved" check). */
  policiesByEffect?: { BLOCK?: number; REQUIRE_APPROVAL?: number; ALLOW?: number };
  lastActive?: string;
}

interface RiskBand {
  key: "critical" | "high" | "caution" | "safe";
  label: "Critical" | "High" | "Medium" | "Low";
  color: string;
  ring: string;
}

/** Delegates to the shared 4-band scale (lib/utils.ts scoreBand — mirrors the
 *  backend's authoritative `blast_radius.band`: low <40, medium 40–59, high
 *  60–79, critical ≥80). Chain floor: an agent with critical chains never
 *  reads below Medium — the score rates actions individually, chains rate
 *  combinations, and "Low" next to "N critical chains" reads as the product
 *  contradicting itself. */
export function band(score: number, criticalChains = 0, backendBand?: string): RiskBand {
  const b = scoreBand(score, criticalChains, backendBand);
  // Reuse the shared band's token colors directly (b.color/b.ring/b.label); the
  // legacy "caution" key alias is kept for the medium band.
  const key = b.key === "medium" ? "caution" : b.key;
  return { key, label: b.label as RiskBand["label"], color: b.color, ring: b.ring };
}

const CAP_ORDER = ["money", "pii", "delete", "external", "prod"] as const;
type CapKey = (typeof CAP_ORDER)[number];

const CAP_LABEL: Record<CapKey, string> = {
  money: "Moves Money",
  pii: "Touches PII",
  delete: "Deletes Data",
  external: "Sends External",
  prod: "Changes Production",
};

/** One shade per capability, sourced from the --label-* design tokens so bars
 *  match the risk-label chips everywhere else and carry real visual weight
 *  (the old pastels washed out to near-invisible on white). */
const CAP_FILL: Record<CapKey, string> = {
  money:    "var(--label-moves-money)",
  pii:      "var(--label-touches-pii)",
  delete:   "var(--label-deletes-data)",
  external: "var(--label-sends-external)",
  prod:     "var(--label-changes-production)",
};

const UP_TOOL: Record<string, string> = {
  aws: "AWS", cicd: "CI/CD", ci: "CI", cd: "CD",
  s3: "S3", rds: "RDS", ecs: "ECS", ecr: "ECR", iam: "IAM", po: "PO",
};

/** "Google_workspace" → "Google Workspace"; keep known acronyms upper. */
export function fmtTool(t: string): string {
  return t.split("_").map((w) => UP_TOOL[w.toLowerCase()] ?? (w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

// Alias kept for existing importers; the impl lives in lib/format.
export const fmtMoney = formatMoney;

interface CapBarsProps {
  caps: AgentCardData["caps"];
  gap?: number;
  /** Default true on cards (all 5 rows always rendered for alignment); the
   *  drawer passes false because vertical space is tight. */
  showZeros?: boolean;
}

export function CapBars({ caps, gap = 9, showZeros = true }: CapBarsProps): React.ReactElement {
  const rows = showZeros ? CAP_ORDER : CAP_ORDER.filter((k) => caps[k]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap }}>
      {rows.map((k) => {
        const n = caps[k] ?? 0;
        const empty = n === 0;
        const fillPct = Math.min(100, (n / 6) * 100);
        return (
          <div
            key={k}
            style={{
              display: "grid",
              gridTemplateColumns: "128px 1fr 24px",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: empty ? "var(--ink-400)" : "var(--ink-600)",
                whiteSpace: "nowrap",
              }}
            >
              {CAP_LABEL[k]}
            </span>
            <div
              style={{
                height: 6,
                borderRadius: 6,
                background: "var(--paper-2)",
                overflow: "hidden",
              }}
            >
              {!empty && (
                <div
                  style={{
                    height: "100%",
                    width: `${fillPct}%`,
                    background: CAP_FILL[k],
                    borderRadius: 6,
                  }}
                />
              )}
            </div>
            <span
              className="mono"
              style={{
                fontSize: 12,
                color: empty ? "var(--ink-400)" : "var(--ink-800)",
                textAlign: "right",
                fontWeight: 600,
              }}
            >
              {n}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface AgentCardProps {
  agent: AgentCardData;
  onOpen?: (agent: AgentCardData) => void;
}

export default function AgentCard({ agent, onOpen }: AgentCardProps): React.ReactElement {
  const b = band(agent.score, agent.critical, agent.band);

  return (
    <div
      className="ag-card"
      onClick={() => onOpen?.(agent)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(agent);
        }
      }}
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        // Severity reads before anything else is parsed — the eye should land
        // on the riskiest row without reading a number first.
        borderLeft: `3px solid ${b.ring}`,
        borderRadius: 10,
        padding: "14px 18px",
        boxShadow: "var(--shadow-card-new)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        height: "100%",
      }}
    >
      <RiskRing
        value={agent.score}
        size={48}
        stroke={3}
        color={b.ring}
        label={Math.round(agent.score)}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          title={agent.name}
          style={{
            fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--ink-900)",
            letterSpacing: -0.2, lineHeight: 1.3,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {agent.name}
        </div>
        {/* Band word and number always travel together — colour alone is never
            allowed to carry severity. */}
        <div style={{ marginTop: 3, display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span
            style={{
              fontSize: "var(--fs-micro)", fontWeight: 700, textTransform: "uppercase",
              letterSpacing: 0.5, color: b.color, flexShrink: 0,
            }}
          >
            {b.label}
          </span>
          <span style={{ color: "var(--ink-300)", flexShrink: 0 }}>·</span>
          <span
            title={agent.tools.map(fmtTool).join(", ")}
            style={{
              fontSize: "var(--fs-small)", color: "var(--ink-500)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {agent.tools.map(fmtTool).join(", ")}
          </span>
        </div>
      </div>
    </div>
  );
}
