import { AlertTriangle } from "lucide-react";

interface ErrorStateProps {
  title?: string;
  message: string;
  /** The page's load function — retries in place. NEVER window.location.reload. */
  onRetry?: () => void;
  /** Tighter inline variant for a failed panel inside an otherwise-fine page. */
  compact?: boolean;
}

/**
 * The one error state. A fetch failure must land here — never on a cheerful
 * empty/onboarding/"not found" state that makes an outage look like a clean
 * account (the systemic silent-catch bug across ~30 sites).
 */
export default function ErrorState({ title = "Couldn't load this", message, onRetry, compact }: ErrorStateProps) {
  return (
    <div
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        textAlign: "center", gap: 10,
        padding: compact ? "24px 20px" : "56px 24px",
      }}
    >
      <div
        style={{
          display: "grid", placeItems: "center",
          width: 44, height: 44, borderRadius: "var(--radius-full)",
          background: "var(--critical-bg)", color: "var(--critical)",
        }}
      >
        <AlertTriangle size={20} />
      </div>
      <div style={{ fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--ink-800)" }}>{title}</div>
      <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", maxWidth: 420, lineHeight: 1.55 }}>
        {message}
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="ag-btn"
          style={{
            marginTop: 6,
            fontSize: "var(--fs-small)", fontWeight: 600,
            color: "var(--ink-700)", background: "var(--card)",
            border: "1px solid var(--line)", borderRadius: "var(--radius-md)",
            padding: "7px 16px", cursor: "pointer",
          }}
        >
          Try again
        </button>
      )}
    </div>
  );
}
