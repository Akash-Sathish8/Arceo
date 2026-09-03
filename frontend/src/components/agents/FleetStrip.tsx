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
}

interface Cell {
  label: string;
  value: React.ReactNode;
  color?: string;
}

export default function FleetStrip({
  total,
  spend,
  criticalChains,
  unguarded,
}: FleetStripProps): React.ReactElement {
  const cells: Cell[] = [
    { label: "Agents",           value: total },
    { label: "Forecast / mo",    value: spend !== null ? formatMoney(spend) : "—" },
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
            border: "1px solid var(--line)",
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
        </div>
      ))}
    </div>
  );
}
