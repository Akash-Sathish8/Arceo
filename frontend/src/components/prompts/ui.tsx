/**
 * Small shared pieces for the prompt pages, styled from the same tokens and
 * shapes as the rest of the app (History's segmented control, the card
 * surface and table headers used across Spend and Authority).
 */

export const PAGE_PAD = "34px clamp(16px, 4vw, 40px) 64px"

export const CARD: React.CSSProperties = {
  background: "var(--card)",
  borderRadius: 10,
  boxShadow: "var(--shadow-card-new)",
  padding: "16px 18px",
}

export const EYEBROW: React.CSSProperties = {
  fontSize: "var(--fs-micro)",
  fontWeight: 600,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  color: "var(--ink-400)",
}

export const TH: React.CSSProperties = {
  ...EYEBROW,
  textAlign: "left",
  padding: "9px 12px",
  borderBottom: "1px solid var(--line)",
  whiteSpace: "nowrap",
}

export const TD: React.CSSProperties = {
  padding: "9px 12px",
  fontSize: "var(--fs-small)",
  color: "var(--ink-800)",
  borderBottom: "1px solid var(--line-soft)",
  verticalAlign: "top",
}

export const FIELD: React.CSSProperties = {
  width: "100%",
  background: "var(--paper)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-md)",
  fontSize: "var(--fs-small)",
  padding: "8px 10px",
  color: "var(--ink-900)",
  outline: "none",
  boxSizing: "border-box",
  fontFamily: "inherit",
}

export function SegControl<T extends string>({
  options, value, onChange,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div role="tablist" style={{
      display: "inline-flex", gap: 2, padding: 3, flexWrap: "wrap",
      background: "var(--bg-sunken)", borderRadius: "var(--radius-md)",
    }}>
      {options.map((o) => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            style={{
              border: "none", borderRadius: "var(--radius-btn)", padding: "5px 12px",
              cursor: "pointer", whiteSpace: "nowrap",
              fontFamily: "var(--font-num)", fontSize: 12,
              background: active ? "var(--card)" : "transparent",
              color: active ? "var(--ink-900)" : "var(--ink-500)",
              boxShadow: active ? "0 1px 2px rgba(15,15,15,.06)" : "none",
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "accent" }) {
  return (
    <span style={{
      fontSize: "var(--fs-micro)", fontWeight: 600, padding: "2px 8px", borderRadius: "var(--radius-full)",
      whiteSpace: "nowrap",
      background: tone === "accent" ? "var(--accent-soft)" : "var(--bg-sunken)",
      color: tone === "accent" ? "var(--accent-ink)" : "var(--ink-600)",
    }}>
      {children}
    </span>
  )
}

export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} style={{ ...EYEBROW, display: "block", marginBottom: 6 }}>
      {children}
    </label>
  )
}
