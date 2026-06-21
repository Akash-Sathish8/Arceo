interface RiskRingProps {
  /** 0–100. Higher = riskier. */
  value: number;
  size?: number;
  stroke?: number;
  color: string;
  /** Track stroke color. Defaults to a warm-neutral so it reads on paper. */
  track?: string;
  /** Center label — usually the score number. */
  label?: React.ReactNode;
  /** Optional small line below the score. */
  sub?: React.ReactNode;
  /** Font for the center label — falls back to mono. */
  numFont?: string;
}

/**
 * Donut arc that visualizes a 0-100 risk score. Source: design handoff
 * `lib/chrome.jsx`. The stroke is sized so the arc sweeps clockwise from 12
 * o'clock as `value` increases.
 */
export default function RiskRing({
  value,
  size = 64,
  stroke = 5,
  color,
  track = "#eceae3",
  label,
  sub,
  numFont,
}: RiskRingProps): React.ReactElement {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value)) / 100;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
        }}
      >
        <span
          style={{
            fontFamily: numFont ?? "var(--font-mono)",
            fontWeight: 600,
            fontSize: size * 0.27,
            color,
          }}
        >
          {label}
        </span>
        {sub && (
          <span style={{ fontSize: size * 0.12, color: "var(--ink-400)", marginTop: 2 }}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}
