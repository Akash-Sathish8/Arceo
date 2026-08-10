"use client";

/* Hero product showcase — slanted, floating UI "screens" sharing one 3D
   perspective, claymorphism-styled. The deck auto-rotates: each panel cycles
   to the front large/centered while the others sit back smaller.
   No real screenshots — each panel is a crafted mini product surface. */

import { useEffect, useState } from "react";

const RISK = {
  red:    "#dc2626",
  orange: "#ea580c",
  amber:  "#d97706",
  blue:   "#2563eb",
  purple: "#7c3aed",
  green:  "#16a34a",
};

function Dots() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "9px 13px", borderBottom: "1px solid #EBE4D8", background: "#F3EDE4" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#E0A89A" }} />
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#E6CE9A" }} />
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#A8C9A2" }} />
      <span style={{ marginLeft: 8, height: 6, width: 72, borderRadius: 999, background: "#E0D7C9" }} />
    </div>
  );
}

function Screen({
  children,
  active,
  style,
}: {
  children: React.ReactNode;
  active: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: 268,
        background: "#FAF6F0",
        border: "1px solid #E0D7C9",
        borderRadius: 18,
        boxShadow: active
          ? "26px 40px 80px rgba(44,34,21,0.28), inset 3px 4px 8px rgba(255,255,255,0.6)"
          : "14px 22px 44px rgba(44,34,21,0.16), inset 3px 4px 8px rgba(255,255,255,0.5)",
        overflow: "hidden",
        transition: "transform 0.95s cubic-bezier(0.22,1,0.36,1), opacity 0.95s ease, box-shadow 0.95s ease",
        ...style,
      }}
    >
      <Dots />
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  color: "#87786A",
  textTransform: "uppercase",
  letterSpacing: "0.09em",
  marginBottom: 12,
};

/**
 * Marks sample figures as illustrative. Every number in these mockups is a
 * worked example, not a live reading — saying so up front is cheaper than
 * being asked "whose numbers are these?" in an evaluation call.
 */
const exampleTagStyle: React.CSSProperties = {
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  color: "#A99880",
  background: "#F3EDE4",
  border: "1px solid #E0D7C9",
  borderRadius: 999,
  padding: "1px 6px",
  textTransform: "uppercase",
};

/* ── Panel 1: Cost forecast (the money shot) ───────────────────── */
function CostScreen() {
  return (
    <>
      <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 6 }}>
        <span>Cost Portfolio</span>
        <span style={exampleTagStyle}>Example</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginBottom: 5 }}>
        <span style={{ fontSize: 42, fontWeight: 800, color: "#2C6E9E", letterSpacing: "-1.5px", lineHeight: 1 }}>$20</span>
        <span style={{ fontSize: 14, color: "#C9BBA8" }}>/mo</span>
      </div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#2C6E9E", letterSpacing: "0.04em", marginBottom: 16 }}>±15% · HIGH CONFIDENCE</div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#87786A", marginBottom: 6 }}>
        <span>Projected range</span><span>$17 to $23 / mo</span>
      </div>
      <div style={{ height: 7, background: "#EBE4D8", borderRadius: 999, overflow: "hidden", marginBottom: 16, position: "relative" }}>
        <div style={{ position: "absolute", left: "20%", width: "32%", top: 0, bottom: 0, background: "linear-gradient(90deg,#7BC0E8,#2C6E9E)", borderRadius: 999 }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 12, borderTop: "1px solid #EBE4D8" }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "#BE123C" }}>Worst case if it breaks</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: "#BE123C" }}>up to $50k</span>
      </div>
    </>
  );
}

/* ── Panel 2: Fleet blast radius ───────────────────────────────── */
function FleetScreen() {
  const rows = [
    { name: "Atlas Cloud Operator", score: 87, c: RISK.red },
    { name: "Helix Data Sync",      score: 56, c: RISK.orange },
    { name: "Beacon Support",       score: 37, c: RISK.amber },
    { name: "Orbit Scheduler",      score: 14, c: RISK.green },
  ];
  return (
    <>
      <div style={labelStyle}>Fleet Risk</div>
      {rows.map((r) => (
        <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#2C2215", width: 96, flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
          <div style={{ flex: 1, height: 6, background: "#EBE4D8", borderRadius: 999, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${r.score}%`, background: r.c, borderRadius: 999 }} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 800, color: r.c, width: 20, textAlign: "right" }}>{r.score}</span>
        </div>
      ))}
    </>
  );
}

/* ── Panel 3: Chain detection ──────────────────────────────────── */
function ChainScreen() {
  return (
    <>
      <div style={labelStyle}>Chain Detected</div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
        <div style={{ flex: 1, padding: "9px 6px", background: "#faf5ff", border: "1px solid #d8b4fe", borderRadius: 9, textAlign: "center" }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, color: "#7c3aed", fontFamily: '"SF Mono", monospace' }}>contacts.read</div>
          <div style={{ fontSize: 8, color: "#a855f7", fontWeight: 600 }}>touches_pii</div>
        </div>
        <svg width="24" height="14" viewBox="0 0 24 14" fill="none" style={{ flexShrink: 0 }}>
          <line x1="1" y1="7" x2="18" y2="7" stroke="#dc2626" strokeWidth="2" strokeDasharray="3 2" />
          <path d="M15 2l6 5-6 5" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        <div style={{ flex: 1, padding: "9px 6px", background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 9, textAlign: "center" }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, color: "#2563eb", fontFamily: '"SF Mono", monospace' }}>email.send</div>
          <div style={{ fontSize: 8, color: "#3b82f6", fontWeight: 600 }}>sends_external</div>
        </div>
      </div>
      <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 9, padding: "9px 11px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#dc2626" }}>PII exfiltration</span>
        <span style={{ fontSize: 8, fontWeight: 700, color: "#fff", background: "#dc2626", padding: "2px 7px", borderRadius: 4, letterSpacing: "0.04em" }}>CRITICAL</span>
      </div>
    </>
  );
}

/* ── Panel 4: Capability inventory ─────────────────────────────── */
function CapabilityScreen() {
  const rows = [
    { a: "payments.refund",   l: "moves_money",    c: RISK.red,    st: "BLOCK" },
    { a: "db.delete_records", l: "deletes_data",   c: RISK.orange, st: "BLOCK" },
    { a: "email.send",        l: "sends_external", c: RISK.blue,   st: "WARN" },
  ];
  return (
    <>
      <div style={labelStyle}>Capabilities</div>
      {rows.map((r) => (
        <div key={r.a} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 0", borderBottom: "1px solid #EBE4D8" }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: "#2C2215", fontFamily: '"SF Mono", monospace', minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.a}</span>
          <span style={{ fontSize: 8, fontWeight: 700, color: r.c, background: "rgba(0,0,0,0.03)", padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap", flexShrink: 0 }}>{r.l}</span>
          <span style={{ fontSize: 8, fontWeight: 800, color: r.c, width: 32, textAlign: "right", flexShrink: 0 }}>{r.st}</span>
        </div>
      ))}
    </>
  );
}

/* The four cyclic slots. Index 0 is the focused (front, large) slot; the rest
   sit back and smaller. Each transform is relative to the centered anchor. */
const SLOTS = [
  { t: "translate3d(6px, 26px, 130px) scale(1.04)",    o: 1,    z: 40 }, // FRONT — focus
  { t: "translate3d(176px, -84px, -10px) scale(0.74)", o: 0.9,  z: 20 }, // top-right
  { t: "translate3d(-150px, -126px, -44px) scale(0.7)", o: 0.82, z: 10 }, // top-left
  { t: "translate3d(-168px, 138px, 12px) scale(0.76)", o: 0.9,  z: 30 }, // bottom-left
];

const PANELS = [
  <CostScreen key="cost" />,
  <FleetScreen key="fleet" />,
  <CapabilityScreen key="cap" />,
  <ChainScreen key="chain" />,
];

export default function HeroGraphic() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setActive((a) => (a + 1) % PANELS.length), 3200);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      position: "absolute",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      perspective: "2000px",
      perspectiveOrigin: "55% 42%",
      overflow: "visible",
    }}>
      {/* soft warm glow behind the stack */}
      <div style={{
        position: "absolute",
        width: "70%",
        height: "70%",
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(75,156,211,0.20), transparent 70%)",
        filter: "blur(20px)",
      }} />

      {/* rotated stage — all panels share this one transform.
         --deck-scale shrinks the whole deck on narrower screens so it never
         overflows the viewport (see <style> below). */}
      <div className="clay-deck" style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        width: 560,
        height: 500,
        transformStyle: "preserve-3d",
        transform: "translate(-50%, -50%) rotateX(8deg) rotateY(-26deg) rotateZ(2deg) scale(var(--deck-scale, 0.95))",
      }}>
        {PANELS.map((panel, i) => {
          const slot = SLOTS[(i - active + PANELS.length) % PANELS.length];
          return (
            <Screen
              key={i}
              active={(i - active + PANELS.length) % PANELS.length === 0}
              style={{
                transform: `translate(-50%, -50%) ${slot.t}`,
                opacity: slot.o,
                zIndex: slot.z,
              }}
            >
              {panel}
            </Screen>
          );
        })}
      </div>

      <style>{`
        .clay-deck { --deck-scale: 0.95; }
        @media (max-width: 1100px) { .clay-deck { --deck-scale: 0.82; } }
        @media (max-width: 960px)  { .clay-deck { --deck-scale: 0.72; } }
        @media (max-width: 640px)  { .clay-deck { --deck-scale: 0.56; } }
        @media (max-width: 420px)  { .clay-deck { --deck-scale: 0.48; } }
      `}</style>
    </div>
  );
}
