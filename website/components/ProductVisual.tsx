"use client";

import { Fragment, useState } from "react";
import { useFadeInOnScroll } from "../lib/useFadeIn";

/* ── Data model ──────────────────────────────────────────────────
   Fully static (no API / props), so the data lives here.
   Tier drives every edge + node style via tierStyle below — no more
   hex-string comparisons.                                            */
type Tier = "critical" | "risky" | "safe";

type Tool = {
  id: string;
  label: string;
  tier: Tier;
  blast: number; // worst-case exposure, USD
  note: string;  // one-line "what could go wrong"
};

// TODO: wire to real blast-radius scoring output (Akash)
const TOOLS: Tool[] = [
  { id: "stripe",     label: "Stripe",     tier: "critical", blast: 250000, note: "Issues refunds and payouts, so one bad call moves real money." },
  { id: "salesforce", label: "Salesforce", tier: "risky",    blast: 85000,  note: "Reads and writes customer records, including PII." },
  { id: "zendesk",    label: "Zendesk",    tier: "risky",    blast: 40000,  note: "Emails customers and can expose support ticket data." },
  { id: "sendgrid",   label: "SendGrid",   tier: "safe",     blast: 8000,   note: "Sends transactional email on your behalf." },
  { id: "slack",      label: "Slack",      tier: "safe",     blast: 5000,   note: "Posts messages into internal channels." },
];

/* One lookup keyed by tier. Node labels are neutral (--clay-heading);
   tier is carried by the edge + a matching dot. Edge weight is stepped
   so tiers read at a glance.                                          */
type TierStyle = { line: string; fill: string; border: string; dash: string; width: number };

const tierStyle: Record<Tier, TierStyle> = {
  critical: { line: "var(--risk-critical)", fill: "var(--risk-critical-fill)", border: "var(--risk-critical-border)", dash: "none", width: 3 },
  risky:    { line: "var(--risk-risky)",    fill: "var(--risk-risky-fill)",    border: "var(--risk-risky-border)",    dash: "7 4", width: 2 },
  safe:     { line: "var(--risk-safe)",     fill: "var(--clay-cream-2)",       border: "var(--clay-border)",          dash: "none", width: 1.25 },
};

/* ── Layout ──────────────────────────────────────────────────────
   Positions computed radially (even angles, constant radius) around
   CENTER — no eyeballed coordinates. The SVG scales uniformly, so the
   layout never collides; narrow screens just shrink it.              */
const VB_W = 650;
const VB_H = 365;
const CENTER = { x: 325, y: 185 };
const RADIUS = 140;
const START_ANGLE = -90; // first node at top
const NODE_W = 132;
const NODE_H = 58;
const HUB_W = 124;
const HUB_H = 62;
const DIM = 0.22; // opacity of non-focused elements on hover

function nodePos(i: number, n: number) {
  const a = ((START_ANGLE + (360 / n) * i) * Math.PI) / 180;
  return { x: CENTER.x + RADIUS * Math.cos(a), y: CENTER.y + RADIUS * Math.sin(a) };
}

/* Compact USD for the worst-case figures (all seeds are ≥ $1K). */
function formatUSD(n: number) {
  return n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`;
}

/* Point on an axis-aligned rect's border along the direction toward (tx,ty). */
function rectEdge(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number) {
  const dx = tx - cx, dy = ty - cy;
  const t = Math.min(hw / (Math.abs(dx) || 1e-6), hh / (Math.abs(dy) || 1e-6));
  return { x: cx + dx * t, y: cy + dy * t };
}

/* Quadratic bezier with a gentle, consistent perpendicular bow. */
function edgePath(S: { x: number; y: number }, E: { x: number; y: number }) {
  const mx = (S.x + E.x) / 2, my = (S.y + E.y) / 2;
  const dx = E.x - S.x, dy = E.y - S.y;
  const len = Math.hypot(dx, dy) || 1;
  const k = 0.09;
  const cx = mx + (-dy / len) * len * k;
  const cy = my + (dx / len) * len * k;
  return `M ${S.x.toFixed(1)} ${S.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${E.x.toFixed(1)} ${E.y.toFixed(1)}`;
}

const totalBlast = TOOLS.reduce((sum, t) => sum + t.blast, 0);

function AuthorityGraph() {
  const positions = TOOLS.map((_, i) => nodePos(i, TOOLS.length));
  const [hovered, setHovered] = useState<string | null>(null);

  const activeIdx = hovered ? TOOLS.findIndex((t) => t.id === hovered) : -1;
  const active = activeIdx >= 0 ? TOOLS[activeIdx] : null;
  const activePos = activeIdx >= 0 ? positions[activeIdx] : null;
  const tipBelow = activePos ? activePos.y < 110 : false; // top node opens downward

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} fill="none" xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "auto", display: "block" }}>

        <defs>
          <filter id="pvNodeShadow" x="-25%" y="-25%" width="150%" height="160%">
            <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#2C2215" floodOpacity="0.16" />
          </filter>
        </defs>

        {/* Edges — bezier curves, terminate on the card boundaries */}
        {TOOLS.map((t, i) => {
          const p = positions[i];
          const s = tierStyle[t.tier];
          const S = rectEdge(CENTER.x, CENTER.y, HUB_W / 2, HUB_H / 2, p.x, p.y);
          const E = rectEdge(p.x, p.y, NODE_W / 2, NODE_H / 2, CENTER.x, CENTER.y);
          const faded = hovered ? hovered !== t.id : false;
          return (
            <path key={t.id} d={edgePath(S, E)} fill="none"
              stroke={s.line} strokeWidth={hovered === t.id ? s.width + 0.75 : s.width}
              strokeDasharray={s.dash} strokeLinecap="round"
              opacity={faded ? DIM : 1}
              style={{ transition: "opacity 0.2s ease, stroke-width 0.2s ease" }} />
          );
        })}

        {/* Tool nodes — neutral label + tier dot + worst-case figure */}
        {TOOLS.map((t, i) => {
          const p = positions[i];
          const s = tierStyle[t.tier];
          const left = p.x - NODE_W / 2;
          const top = p.y - NODE_H / 2;
          const faded = hovered ? hovered !== t.id : false;
          return (
            <g key={t.id}
              onMouseEnter={() => setHovered(t.id)}
              onMouseLeave={() => setHovered(null)}
              opacity={faded ? DIM : 1}
              style={{ cursor: "pointer", transition: "opacity 0.2s ease" }}>
              <rect
                x={left} y={top}
                width={NODE_W} height={NODE_H} rx={14}
                fill={s.fill} stroke={s.border} strokeWidth={1.5}
                filter="url(#pvNodeShadow)"
              />
              <circle cx={left + 17} cy={top + 21} r={5} fill={s.line} />
              <text x={left + 30} y={top + 21} textAnchor="start" dominantBaseline="middle"
                fontSize={16} fontWeight="700" fill="var(--clay-heading)"
                fontFamily="var(--font-poppins)">
                {t.label}
              </text>
              <text x={left + 17} y={top + 41} textAnchor="start" dominantBaseline="middle"
                fontSize={12} fontFamily="var(--font-poppins)">
                <tspan fill="var(--clay-body-subtle)" fontWeight="500">Worst case </tspan>
                <tspan fill={s.line} fontWeight="800">{formatUSD(t.blast)}</tspan>
              </text>
            </g>
          );
        })}

        {/* Center hub — the anchor */}
        <g style={{ filter: "drop-shadow(0 8px 18px rgba(44,34,21,0.30))" }}>
          <rect
            x={CENTER.x - HUB_W / 2} y={CENTER.y - HUB_H / 2}
            width={HUB_W} height={HUB_H}
            style={{ rx: "var(--r-md)", ry: "var(--r-md)" }}
            fill="var(--clay-dark)" stroke="var(--clay-brand)" strokeWidth={2}
          />
          <text x={CENTER.x} y={CENTER.y} textAnchor="middle" dominantBaseline="middle"
            fontSize={18} fontWeight="700" fill="#fff" fontFamily="var(--font-poppins)">
            AI Agent
          </text>
        </g>
      </svg>

      {/* Hover tooltip (HTML, crisp text, scales-independent) */}
      {active && activePos && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: `${(activePos.x / VB_W) * 100}%`,
            top: `${((activePos.y + (tipBelow ? NODE_H / 2 : -NODE_H / 2)) / VB_H) * 100}%`,
            transform: tipBelow ? "translate(-50%, 8px)" : "translate(-50%, calc(-100% - 8px))",
            width: 220,
            maxWidth: "70vw",
            background: "var(--clay-cream)",
            border: "1px solid var(--clay-border)",
            borderRadius: "var(--r-sm)",
            boxShadow: "var(--shadow-md)",
            padding: "11px 13px",
            pointerEvents: "none",
            zIndex: 3,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: tierStyle[active.tier].line, flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--clay-heading)" }}>{active.label}</span>
            <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 800, color: tierStyle[active.tier].line }}>{formatUSD(active.blast)}</span>
          </div>
          <p style={{ fontSize: 12, lineHeight: 1.5, color: "var(--clay-body)" }}>{active.note}</p>
        </div>
      )}
    </div>
  );
}

export default function ProductVisual() {
  const { ref: textRef, className: textClass } = useFadeInOnScroll(0);

  return (
    <section style={{ padding: "112px 0", background: "var(--clay-cream-2)", borderTop: "1px solid var(--clay-border)" }}>
      <div className="container">
        <div style={{ display: "grid", gridTemplateColumns: "5fr 7fr", gap: 64, alignItems: "center" }} className="pv-grid">

          {/* Text column */}
          <div ref={textRef} className={textClass}>
            <span className="eyebrow">Authority Mapping</span>
            <h2 style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.4px", color: "var(--clay-heading)", marginBottom: 20, lineHeight: 1.15 }}>
              One view of everything your agent can reach
            </h2>
            <p style={{ fontSize: 20, color: "var(--clay-body)", lineHeight: 1.75, marginBottom: 36 }}>
              Arceo maps every tool, API, and data source your agent can reach, then puts a dollar figure on the worst thing that happens if one of them gets misused.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 16, rowGap: 16, alignItems: "center" }}>
              {[
                { color: "#dc2626", bg: "#fef2f2", b: "#fecaca", label: "Critical / Irreversible", desc: "Actions that can't be undone: payments, bulk deletes, infrastructure" },
                { color: "#f59e0b", bg: "#fffbeb", b: "#fde68a", label: "Risky",                   desc: "External messaging, PII access, code execution" },
                { color: "#87786A", bg: "#F3EDE4", b: "#E0D7C9", label: "Safe",                    desc: "Read-only access, internal lookups, no side-effects" },
              ].map((item) => (
                <Fragment key={item.label}>
                  <span className="chip" style={{ color: item.color, background: item.bg, borderColor: item.b, justifySelf: "start" }}>{item.label}</span>
                  <span style={{ fontSize: 14, color: "var(--clay-body)", lineHeight: 1.5 }}>{item.desc}</span>
                </Fragment>
              ))}
            </div>
          </div>

          {/* Graph column */}
          <div style={{
            background: "var(--clay-cream)",
            border: "1px solid var(--clay-border)",
            borderRadius: "var(--r-lg)",
            padding: "48px 24px 28px",
            position: "relative",
            boxShadow: "var(--shadow-lg)",
          }}>
            <div className="halftone" style={{ position: "absolute", inset: 0, opacity: 0.45, borderRadius: "var(--r-lg)", pointerEvents: "none" }}/>

            {/* Fleet-level total */}
            <div style={{ position: "absolute", top: 20, right: 24, textAlign: "right", zIndex: 2 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "var(--clay-body-subtle)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Total worst-case exposure
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, color: "var(--clay-heading)", letterSpacing: "-0.5px", lineHeight: 1.1 }}>
                {formatUSD(totalBlast)}
              </div>
            </div>

            <div style={{ position: "relative", zIndex: 1 }}>
              <AuthorityGraph />
            </div>
          </div>

        </div>
      </div>
      <style>{`@media (max-width: 860px) { .pv-grid { grid-template-columns: 1fr !important; gap: 48px !important; } }`}</style>
    </section>
  );
}
