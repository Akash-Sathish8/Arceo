export default function HeroGraphic() {
  return (
    <div style={{
      position: "absolute",
      inset: 0,
      overflow: "hidden",
    }}>
      <svg
        viewBox="0 0 900 720"
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "100%", display: "block" }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Halftone dot patterns at varying densities */}
          <pattern id="ht-dense" width="6" height="6" patternUnits="userSpaceOnUse">
            <circle cx="3" cy="3" r="1.6" fill="#0f172a" />
          </pattern>
          <pattern id="ht-med" width="9" height="9" patternUnits="userSpaceOnUse">
            <circle cx="4.5" cy="4.5" r="1.4" fill="#0f172a" />
          </pattern>
          <pattern id="ht-sparse" width="14" height="14" patternUnits="userSpaceOnUse">
            <circle cx="7" cy="7" r="1.2" fill="#0f172a" />
          </pattern>

          {/* Radial fade overlay, light vignette */}
          <radialGradient id="vignette" cx="50%" cy="50%" r="65%">
            <stop offset="60%" stopColor="#0f172a" stopOpacity="0" />
            <stop offset="100%" stopColor="#0f172a" stopOpacity="0.12" />
          </radialGradient>

          {/* Soft drop shadow */}
          <filter id="soft-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="6" />
            <feOffset dx="0" dy="6" result="offBlur" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.2" />
            </feComponentTransfer>
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Mask to fade halftone background toward center for the agent disc */}
          <radialGradient id="centerMask" cx="50%" cy="50%" r="22%">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Base, light cream-ish */}
        <rect width="900" height="720" fill="#f1f5f9" />

        {/* Sparse halftone field across the whole thing */}
        <rect width="900" height="720" fill="url(#ht-sparse)" opacity="0.22" />

        {/* Decorative halftone orbs (background depth) */}
        <circle cx="780" cy="120" r="70" fill="url(#ht-med)" opacity="0.45" />
        <circle cx="820" cy="600" r="95" fill="url(#ht-sparse)" opacity="0.55" />
        <circle cx="120" cy="640" r="55" fill="url(#ht-med)" opacity="0.4" />
        <circle cx="90" cy="120" r="38" fill="url(#ht-dense)" opacity="0.45" />
        <circle cx="650" cy="80" r="22" fill="#0f172a" opacity="0.85" />

        {/* Concentric blast-radius rings emanating from the agent */}
        <g transform="translate(450, 360)" opacity="0.35">
          <circle r="220" fill="none" stroke="#0f172a" strokeWidth="1" strokeDasharray="2 6" />
          <circle r="290" fill="none" stroke="#0f172a" strokeWidth="1" strokeDasharray="2 8" opacity="0.6" />
        </g>

        {/* Connector lines, risk-colored */}
        <g strokeWidth="2" fill="none">
          {/* Stripe (top, critical) */}
          <line x1="450" y1="360" x2="450" y2="110" stroke="#dc2626" strokeDasharray="4 6" opacity="0.7" />
          {/* GitHub (right, critical) */}
          <line x1="450" y1="360" x2="730" y2="240" stroke="#dc2626" strokeDasharray="4 6" opacity="0.7" />
          {/* SendGrid (lower-right, warn) */}
          <line x1="450" y1="360" x2="730" y2="510" stroke="#eab308" strokeDasharray="4 6" opacity="0.65" />
          {/* Slack (lower-left, safe) */}
          <line x1="450" y1="360" x2="170" y2="510" stroke="#64748b" strokeDasharray="4 6" opacity="0.5" />
          {/* Zendesk (left, warn) */}
          <line x1="450" y1="360" x2="170" y2="240" stroke="#eab308" strokeDasharray="4 6" opacity="0.65" />
        </g>

        {/* Center disc, agent */}
        <g transform="translate(450, 360)">
          {/* outer ring */}
          <circle r="142" fill="#fff" filter="url(#soft-shadow)" />
          {/* dark inner */}
          <circle r="130" fill="#0f172a" />
          {/* halftone overlay inside the disc */}
          <circle r="130" fill="url(#ht-dense)" opacity="0.25" />

          <text textAnchor="middle" y="-55" fontSize="10" fontWeight="700"
            fill="rgba(255,255,255,0.55)" letterSpacing="3"
            fontFamily="system-ui, sans-serif">
            AI AGENT
          </text>
          <text textAnchor="middle" y="20" fontSize="74" fontWeight="800"
            fill="#fff" letterSpacing="-3"
            fontFamily="system-ui, sans-serif">
            71
          </text>
          <text textAnchor="middle" y="50" fontSize="12" fontWeight="600"
            fill="rgba(255,255,255,0.55)" letterSpacing="0.5"
            fontFamily="system-ui, sans-serif">
            / 100 RISK
          </text>
        </g>

        {/* Service nodes */}
        <g fontFamily="system-ui, sans-serif">
          {/* Stripe, top */}
          <g transform="translate(450, 110)" filter="url(#soft-shadow)">
            <rect x="-70" y="-24" width="140" height="48" rx="24" fill="#fff" stroke="#0f172a" strokeWidth="1.5" />
            <circle cx="-48" cy="0" r="5" fill="#dc2626" />
            <text x="-36" y="5" fontSize="14" fontWeight="700" fill="#0f172a">Stripe</text>
            <text x="-36" y="22" fontSize="9" fontWeight="600" fill="#94a3b8" letterSpacing="0.5">3 ACTIONS</text>
          </g>

          {/* GitHub, right */}
          <g transform="translate(730, 240)" filter="url(#soft-shadow)">
            <rect x="-75" y="-24" width="150" height="48" rx="24" fill="#fff" stroke="#0f172a" strokeWidth="1.5" />
            <circle cx="-55" cy="0" r="5" fill="#dc2626" />
            <text x="-42" y="5" fontSize="13" fontWeight="700" fill="#0f172a">GitHub</text>
            <text x="-42" y="22" fontSize="9" fontWeight="600" fill="#94a3b8" letterSpacing="0.5">4 ACTIONS</text>
          </g>

          {/* SendGrid, bottom-right */}
          <g transform="translate(730, 510)" filter="url(#soft-shadow)">
            <rect x="-70" y="-24" width="140" height="48" rx="24" fill="#fff" stroke="#0f172a" strokeWidth="1.5" />
            <circle cx="-50" cy="0" r="5" fill="#eab308" />
            <text x="-38" y="5" fontSize="13" fontWeight="700" fill="#0f172a">SendGrid</text>
            <text x="-38" y="22" fontSize="9" fontWeight="600" fill="#94a3b8" letterSpacing="0.5">2 ACTIONS</text>
          </g>

          {/* Slack, bottom-left */}
          <g transform="translate(170, 510)" filter="url(#soft-shadow)">
            <rect x="-65" y="-24" width="130" height="48" rx="24" fill="#fff" stroke="#0f172a" strokeWidth="1.5" />
            <circle cx="-46" cy="0" r="5" fill="#94a3b8" />
            <text x="-34" y="5" fontSize="14" fontWeight="700" fill="#0f172a">Slack</text>
            <text x="-34" y="22" fontSize="9" fontWeight="600" fill="#94a3b8" letterSpacing="0.5">1 ACTION</text>
          </g>

          {/* Zendesk, top-left */}
          <g transform="translate(170, 240)" filter="url(#soft-shadow)">
            <rect x="-65" y="-24" width="130" height="48" rx="24" fill="#fff" stroke="#0f172a" strokeWidth="1.5" />
            <circle cx="-46" cy="0" r="5" fill="#eab308" />
            <text x="-34" y="5" fontSize="13" fontWeight="700" fill="#0f172a">Zendesk</text>
            <text x="-34" y="22" fontSize="9" fontWeight="600" fill="#94a3b8" letterSpacing="0.5">3 ACTIONS</text>
          </g>
        </g>

        {/* Critical badge floating near Stripe */}
        <g transform="translate(560, 65)" fontFamily="system-ui, sans-serif">
          <rect x="-40" y="-13" width="80" height="26" rx="13" fill="#dc2626" filter="url(#soft-shadow)" />
          <text textAnchor="middle" y="5" fontSize="11" fontWeight="800" fill="#fff" letterSpacing="1">CRITICAL</text>
        </g>

        {/* Vignette */}
        <rect width="900" height="720" fill="url(#vignette)" />
      </svg>

      {/* Grain overlay */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        opacity: 0.12,
        mixBlendMode: "multiply",
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        backgroundRepeat: "repeat",
        backgroundSize: "256px 256px",
      }} />
    </div>
  );
}
