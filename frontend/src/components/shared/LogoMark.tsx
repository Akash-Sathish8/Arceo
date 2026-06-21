interface LogoMarkProps {
  size?: number;
}

/**
 * Brand mark — the node-graph "A" in white on a light-blue app-icon tile.
 * Node geometry traced from the brand logo (arceo-logo.png): wide-splayed
 * legs, thin strokes, dots at the apex, crossbar junctions, and feet.
 */
export default function LogoMark({ size = 26 }: LogoMarkProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      <rect width="100" height="100" rx="22" fill="var(--accent)" />
      <g transform="translate(50 49) scale(0.68) translate(-50 -49)">
        <g stroke="white" strokeWidth="4.2" strokeLinecap="round">
          <line x1="50" y1="15" x2="18.5" y2="83" />
          <line x1="50" y1="15" x2="81.5" y2="83" />
          <line x1="34.2" y1="49" x2="66.4" y2="49" />
        </g>
        <g fill="white">
          <circle cx="50" cy="15" r="6.5" />
          <circle cx="34.2" cy="49" r="6.1" />
          <circle cx="66.4" cy="49" r="6.1" />
          <circle cx="18.5" cy="83" r="6.3" />
          <circle cx="81.5" cy="83" r="6.3" />
        </g>
      </g>
    </svg>
  );
}
