/**
 * Agent risk-score card.
 *
 * Design contract — every card in a row renders to identical internal
 * geometry so cards align horizontally regardless of which capabilities
 * the agent uses:
 *
 *   - 24px padding on all four sides.
 *   - Five capability rows always rendered (zero-value rows show the
 *     dimmed track + "0" in muted ink). This stabilizes card height and
 *     keeps the spend / footer at the same vertical position across the row.
 *   - Fixed grid columns inside each cap row: [label 128px | bar 1fr | count 24px].
 *     The right column reserves space for two-digit counts so the bar tracks
 *     end at the same x across every card.
 *   - Card itself is a `display:grid` with a `1fr` body row, so the spend +
 *     footer rows are pinned to the bottom. CSS-grid's default
 *     `align-items: stretch` on the outer agents grid handles equal-height.
 *
 * Tokens used: var(--card), var(--line), var(--line-soft), var(--ink-*),
 * var(--paper-2), var(--accent), var(--safe|caution|critical*).
 */

import { Bot, Check, ChevronRight, Clock, Lock } from "lucide-react";
import { Link } from "react-router-dom";
import RiskRing from "@/components/shared/RiskRing";
import { scoreBand } from "@/lib/utils";
import { formatMoney } from "@/lib/format";
import { countLabel } from "@/lib/strings";

export interface AgentCardData {
  id: string;
  name: string;
  description: string;
  tools: string[];
  /** 0-100, higher = riskier. */
  score: number;
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
  const unguarded = agent.policies === 0;
  // Enforced coverage = BLOCK or ALLOW. A REQUIRE_APPROVAL policy is a *pending*
  // human gate, not an approval — it must not paint a green "approved" check.
  const byEffect = agent.policiesByEffect ?? {};
  const enforcedCount = (byEffect.BLOCK ?? 0) + (byEffect.ALLOW ?? 0);
  const approvalOnly = !unguarded && enforcedCount === 0;

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
        borderRadius: 12,
        padding: 24,
        boxShadow: "var(--shadow-card-new)",
        display: "grid",
        gridTemplateRows: "auto auto 1fr auto auto",
        rowGap: 20,
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        height: "100%",
      }}
    >
      {/* Row 1 — Header (icon + name/desc + risk dial) */}
      <div style={{ display: "grid", gridTemplateColumns: "38px 1fr auto", alignItems: "start", columnGap: 15 }}>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 9,
            background: "var(--accent-soft)",
            color: "var(--accent)",
            border: "1px solid var(--accent-line)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Bot size={19} strokeWidth={1.6} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            title={agent.name}
            style={{
              fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--ink-900)",
              letterSpacing: -0.2, lineHeight: 1.2,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {agent.name}
          </div>
          <div
            style={{
              fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 4, lineHeight: 1.45,
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
            }}
          >
            {agent.description}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
          <RiskRing
            value={agent.score}
            size={58}
            stroke={5.5}
            color={b.ring}
            label={Math.round(agent.score)}
          />
          <span
            style={{
              fontSize: "var(--fs-micro)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: b.color,
            }}
          >
            {b.label}
          </span>
        </div>
      </div>

      {/* Row 2 — Tool chips (uniform pill style) */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {agent.tools.map((t) => (
          <span
            key={t}
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "var(--ink-600)",
              background: "var(--paper-2)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              padding: "3px 9px",
              lineHeight: 1.4,
            }}
          >
            {fmtTool(t)}
          </span>
        ))}
      </div>

      {/* Row 3 — Metrics. Always 5 rows so cards align horizontally.
          Divider above for clarity. */}
      <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 18 }}>
        <CapBars caps={agent.caps} gap={9} showZeros />
      </div>

      {/* Row 4 — Spend (top border separates from metrics) */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          borderTop: "1px solid var(--line-soft)",
          paddingTop: 16,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "var(--ink-400)",
          }}
        >
          Est. spend / mo
        </span>
        {/* Direct, obvious link to the per-agent Cost Portfolio. stopPropagation
            so it navigates instead of also opening the card's drawer. */}
        <Link
          to={`/agent/${agent.id}/spend`}
          onClick={(e) => e.stopPropagation()}
          className="ag-spend-cta"
          style={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: 5,
            textDecoration: "none",
            color: agent.spend !== null ? "var(--ink-900)" : "var(--accent)",
          }}
          title="View spend forecast"
        >
          {agent.spend !== null ? (
            <span className="mono" style={{ fontSize: 20, fontWeight: 700, letterSpacing: -0.4 }}>
              {fmtMoney(agent.spend)}
            </span>
          ) : (
            <span style={{ fontSize: 13, fontWeight: 600 }}>View forecast</span>
          )}
          <ChevronRight size={14} strokeWidth={2} style={{ alignSelf: "center", color: "var(--accent)" }} />
        </Link>
      </div>

      {/* Row 5 — Policy + chains footer (consistent badge size across cards) */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {unguarded ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--critical)",
              background: "var(--critical-bg)",
              border: "1px solid var(--critical-line)",
              borderRadius: 7,
              padding: "4px 10px",
              lineHeight: 1.3,
            }}
          >
            <Lock size={13} strokeWidth={1.8} /> No policy
          </span>
        ) : approvalOnly ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--caution)",
              background: "var(--caution-bg)",
              border: "1px solid var(--caution-line)",
              borderRadius: 7,
              padding: "4px 10px",
              lineHeight: 1.3,
            }}
          >
            <Clock size={13} strokeWidth={1.8} /> {countLabel(agent.policies, 'approval gate')}
          </span>
        ) : (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--safe)",
              background: "var(--safe-bg)",
              border: "1px solid var(--safe-line)",
              borderRadius: 7,
              padding: "4px 10px",
              lineHeight: 1.3,
            }}
          >
            <Check size={13} strokeWidth={1.8} /> {agent.policies} {agent.policies === 1 ? "policy" : "policies"}
          </span>
        )}
        <span
          className="ag-cardcta"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            whiteSpace: "nowrap",
            fontSize: 12.5,
            color: "var(--ink-500)",
          }}
        >
          {agent.critical > 0 ? (
            <span style={{ color: "var(--critical)", fontWeight: 600 }}>
              {agent.critical} critical {agent.critical === 1 ? "chain" : "chains"}
            </span>
          ) : (
            <span>{agent.chains} risk chains</span>
          )}
          <span style={{ color: "var(--ink-300)", display: "flex" }}>
            <ChevronRight size={15} />
          </span>
        </span>
      </div>
    </div>
  );
}
