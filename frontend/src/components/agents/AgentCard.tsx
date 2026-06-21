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

import { Bot, Check, ChevronRight, Lock } from "lucide-react";
import RiskRing from "@/components/shared/RiskRing";

export interface AgentCardData {
  id: string;
  name: string;
  description: string;
  tools: string[];
  /** 0-100, higher = riskier. */
  score: number;
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
  lastActive?: string;
}

interface RiskBand {
  key: "critical" | "caution" | "safe";
  label: "Critical" | "Caution" | "Low";
  color: string;
  ring: string;
}

/** Label floor: an agent with critical chains never reads below Caution,
 *  even when its per-action score is low — the score rates actions
 *  individually, chains rate combinations, and "Low" next to "N critical
 *  chains" reads as the product contradicting itself. */
export function band(score: number, criticalChains = 0): RiskBand {
  if (score >= 67) return { key: "critical", label: "Critical", color: "var(--critical)", ring: "var(--critical-ring)" };
  if (score >= 40 || criticalChains > 0)
    return { key: "caution", label: "Caution", color: "var(--caution)", ring: "var(--caution-ring)" };
  return { key: "safe", label: "Low", color: "var(--safe)", ring: "var(--safe-ring)" };
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

/** Pastel hue per capability — one shade per semantic category, not a
 *  monochrome blue scale. Each color maps to the handoff's CAPS taxonomy:
 *  money/financial = coral, PII = lavender, delete = peach, external = sage,
 *  production = amber. Saturation is held down so all five read as one
 *  family even though the hues differ. */
const CAP_FILL: Record<CapKey, string> = {
  money:    "#F4A6A6", // coral — financial risk
  pii:      "#C8B8E8", // lavender — privacy
  delete:   "#F4C499", // peach — destructive
  external: "#9FCCCC", // sage teal — outbound
  prod:     "#F0D49C", // amber — production warning
};

const UP_TOOL: Record<string, string> = {
  aws: "AWS", cicd: "CI/CD", ci: "CI", cd: "CD",
  s3: "S3", rds: "RDS", ecs: "ECS", ecr: "ECR", iam: "IAM", po: "PO",
};

/** "Google_workspace" → "Google Workspace"; keep known acronyms upper. */
export function fmtTool(t: string): string {
  return t.split("_").map((w) => UP_TOOL[w.toLowerCase()] ?? (w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

export function fmtMoney(n: number): string {
  return "$" + n.toLocaleString("en-US");
}

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
                height: 5,
                borderRadius: 5,
                background: "var(--line-soft)",
                overflow: "hidden",
              }}
            >
              {!empty && (
                <div
                  style={{
                    height: "100%",
                    width: `${fillPct}%`,
                    background: CAP_FILL[k],
                    borderRadius: 5,
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
  const b = band(agent.score, agent.critical);
  const unguarded = agent.policies === 0;

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
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink-900)", letterSpacing: -0.2, lineHeight: 1.2 }}>
            {agent.name}
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-500)", marginTop: 4, lineHeight: 1.45 }}>
            {agent.description}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
          <RiskRing
            value={agent.score}
            size={58}
            stroke={4.5}
            color={b.ring}
            label={Math.round(agent.score)}
          />
          <span
            style={{
              fontSize: 10.5,
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
        {agent.spend !== null ? (
          <span
            className="mono"
            style={{ fontSize: 20, fontWeight: 700, color: "var(--ink-900)", letterSpacing: -0.4 }}
          >
            {fmtMoney(agent.spend)}
          </span>
        ) : (
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--accent)" }}>Run a sim</span>
        )}
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
