import type { Warning } from "../lib/prompts";

/* A plain warning box for the public prompt page. It renders only when a
   warning applies (importantWarnings returned something); a prompt with
   nothing to flag shows nothing at all, not a "safe" badge. No score, band
   or rating: one plain sentence per problem. */

export default function PromptWarnings({ warnings }: { warnings: Warning[] }) {
  if (warnings.length === 0) return null;
  const critical = warnings.some((w) => w.severity === "critical");
  return (
    <div
      role="note"
      aria-label="Read this before you use it"
      style={{
        background: critical ? "var(--risk-critical-fill)" : "var(--risk-high-fill)",
        border: `1px solid ${critical ? "var(--risk-critical-border)" : "var(--risk-high-border)"}`,
        borderRadius: "var(--r-lg)",
        padding: 20,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: critical ? "var(--risk-critical)" : "var(--risk-high)" }}>
        Read this before you use it
      </div>
      <ul style={{ margin: "10px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
        {warnings.map((w) => (
          <li key={w.id}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{w.title}</div>
            <div style={{ fontSize: 13, color: "var(--cyan-ink)", marginTop: 2, lineHeight: 1.5 }}>{w.detail}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
