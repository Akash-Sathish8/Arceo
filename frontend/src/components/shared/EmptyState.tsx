interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  /** Tighter padding for inline/in-card empties. */
  compact?: boolean;
}

/**
 * The one empty state. Replaces ~8 bespoke treatments (circular-icon,
 * inline-SVG-in-table, panel-card, plain-text) with a consistent centered
 * block used whenever a list/section genuinely has no data.
 */
export default function EmptyState({ icon, title, body, action, compact }: EmptyStateProps) {
  return (
    <div
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        textAlign: "center", gap: 8,
        padding: compact ? "28px 20px" : "56px 24px",
      }}
    >
      {icon && (
        <div
          style={{
            display: "grid", placeItems: "center",
            width: 44, height: 44, borderRadius: "var(--radius-full)",
            background: "var(--paper-2)", color: "var(--ink-400)", marginBottom: 4,
          }}
        >
          {icon}
        </div>
      )}
      <div style={{ fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--ink-800)" }}>{title}</div>
      {body && (
        <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", maxWidth: 380, lineHeight: 1.55 }}>
          {body}
        </div>
      )}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}
