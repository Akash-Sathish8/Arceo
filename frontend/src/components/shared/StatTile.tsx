import type { CSSProperties, ReactNode } from "react";

interface StatTileProps {
  label: string;
  value: ReactNode;
  valueColor?: string;
  note?: string;
  onClick?: () => void;
  style?: CSSProperties;
}

/**
 * The one page-level stat tile — extracted from the Authority overview tiles
 * so every page's stats read identically: --fs-micro uppercase label, 28px
 * mono value, optional --fs-small note. Clickable tiles render as buttons
 * with the ag-card hover; static tiles render as divs (nothing to press).
 */
export default function StatTile({ label, value, valueColor, note, onClick, style }: StatTileProps) {
  const chrome: CSSProperties = {
    textAlign: "left",
    width: "100%",
    font: "inherit",
    background: "var(--card)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-lg)",
    padding: "18px 20px",
    boxShadow: "var(--shadow-card-new)",
    ...style,
  };

  const body = (
    <>
      <div
        style={{
          fontSize: "var(--fs-micro)",
          fontWeight: 600,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: "var(--ink-400)",
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 28,
          fontWeight: 600,
          color: valueColor ?? "var(--ink-900)",
          letterSpacing: -0.6,
          marginTop: 8,
        }}
      >
        {value}
      </div>
      {note && (
        <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 6 }}>
          {note}
        </div>
      )}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="ag-card" style={{ ...chrome, cursor: "pointer" }}>
        {body}
      </button>
    );
  }
  return <div style={chrome}>{body}</div>;
}
