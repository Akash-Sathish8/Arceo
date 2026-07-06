/**
 * Fleet summary strip from the design handoff (`app/AppShell.jsx`'s
 * FleetStrip). Single white card, 4 horizontal cells separated by 1px
 * soft dividers. Sits above the Agents grid.
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
        display: "flex",
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: 12,
        boxShadow: "var(--shadow-card-new)",
        padding: "4px 0",
        marginBottom: 24,
      }}
    >
      {cells.map((c, i) => (
        <div
          key={c.label}
          style={{
            flex: 1,
            padding: "14px 22px",
            borderLeft: i ? "1px solid var(--line-soft)" : "none",
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
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: -0.5,
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
