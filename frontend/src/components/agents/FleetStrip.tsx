/**
 * Fleet summary tiles. Four separate white cards on the tinted page, per the
 * Stitch canvas — the single-card-with-dividers form it replaced read as one
 * object cut into parts rather than four independent figures.
 */

import { formatMoney } from "@/lib/format";

interface FleetStripProps {
  total: number;
  spend: number | null;
  criticalChains: number;
  unguarded: number;
  /** Fleet forecast split by observed deployment state. The headline number is
   *  one figure answering two different CFO questions — what the fleet costs
   *  today, and what it will cost once the rest ships — so the tile shows both.
   *  Omit either to fall back to the undivided total. */
  spendDeployed?: number | null;
  spendPreDeployment?: number | null;
  deployedCount?: number;
  preDeploymentCount?: number;
}

interface Cell {
  label: string;
  value: React.ReactNode;
  color?: string;
  sub?: React.ReactNode;
}

export default function FleetStrip({
  total,
  spend,
  criticalChains,
  unguarded,
  spendDeployed,
  spendPreDeployment,
  deployedCount,
  preDeploymentCount,
}: FleetStripProps): React.ReactElement {
  const split =
    spendDeployed != null && spendPreDeployment != null ? (
      <>
        <span style={{ color: "var(--ink-600)" }}>{formatMoney(spendDeployed)}</span> in production
        <span style={{ color: "var(--ink-300)" }}> · </span>
        <span style={{ color: "var(--ink-600)" }}>{formatMoney(spendPreDeployment)}</span> pending
      </>
    ) : undefined;

  const agentSplit =
    deployedCount != null && preDeploymentCount != null ? (
      <>
        {deployedCount} running
        <span style={{ color: "var(--ink-300)" }}> · </span>
        {preDeploymentCount} not yet
      </>
    ) : undefined;

  const cells: Cell[] = [
    { label: "Agents",           value: total, sub: agentSplit },
    { label: "Forecast / mo",    value: spend !== null ? formatMoney(spend) : "No data", sub: split },
    { label: "Critical chains",  value: criticalChains, color: criticalChains > 0 ? "var(--critical)" : undefined },
    { label: "Unguarded",        value: unguarded,      color: unguarded > 0 ? "var(--caution)" : undefined },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 16,
        marginBottom: 24,
      }}
    >
      {cells.map((c) => (
        <div
          key={c.label}
          style={{
            background: "var(--card)",
            borderRadius: 12,
            boxShadow: "var(--shadow-card-new)",
            padding: "16px 20px",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "var(--ink-400)",
            }}
          >
            {c.label}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: -0.6,
              color: c.color ?? "var(--ink-900)",
              marginTop: 7,
            }}
          >
            {c.value}
          </div>
          {/* Rendered on every tile, empty or not, so the four cards keep a
              shared baseline instead of two growing taller than the others. */}
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-400)",
              marginTop: 5,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {c.sub ?? "\u00a0"}
          </div>
        </div>
      ))}
    </div>
  );
}
