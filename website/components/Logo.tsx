import { C } from "@/lib/palette";
export function LogoIcon({ size = 24, color = C.ink }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <line x1="16" y1="5"  x2="10" y2="18" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="16" y1="5"  x2="22" y2="18" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="10" y1="18" x2="22" y2="18" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="10" y1="18" x2="5"  y2="27" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="22" y1="18" x2="27" y2="27" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <circle cx="16" cy="5"  r="2.5" fill={color} />
      <circle cx="10" cy="18" r="2.5" fill={color} />
      <circle cx="22" cy="18" r="2.5" fill={color} />
      <circle cx="5"  cy="27" r="2.5" fill={color} />
      <circle cx="27" cy="27" r="2.5" fill={color} />
    </svg>
  );
}

export default function Logo({
  size = 24,
  color = C.ink,
  showWord = true,
  wordSize,
}: {
  size?: number;
  color?: string;
  showWord?: boolean;
  wordSize?: number;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 1, color }}>
      <LogoIcon size={size} color={color} />
      {showWord && (
        <span style={{
          fontFamily: "var(--font-sans), system-ui, sans-serif",
          fontSize: wordSize ?? Math.round(size * 0.85),
          fontWeight: 800,
          letterSpacing: "-0.02em",
          color,
          lineHeight: 1,
          marginLeft: -2,
        }}>
          rceo
        </span>
      )}
    </span>
  );
}
