"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { motion } from "motion/react";
import { Odometer } from "./motion/odometer";
import { BorderTrail } from "./motion/border-trail";
import { ProgressiveBlur } from "./motion/progressive-blur";
import { RISK } from "@/lib/labels";

/* The hero asset: an audit tape.
 *
 * Arceo's whole claim is that the two halves of an agent — what it costs and
 * what it can break — come from the same stream of calls. Cost accrues one
 * line at a time. Risk does not: it emerges from the ORDER of the lines, and
 * you cannot see it by looking at any single one.
 *
 * So the panel runs a real tape. Each call posts with its label and its
 * fraction of a cent. Nothing is alarming on its own. Then a call lands that
 * completes a flagged transition with one further up the tape — read customer
 * records, then send mail outside the company — and Arceo brackets the pair,
 * names the chain, and the blast-radius score above climbs.
 *
 * That moment is the product. It is the only place on the page where a number
 * changes on its own, and it is the only place red arrives unprompted. */

type Call = {
  action: string;
  label: string | null;
  color?: string;
  fill?: string;
  cost: number;
  /* Set on the call that completes the chain. */
  closes?: boolean;
};

/* A support agent's working loop. Real action names, real risk labels, real
   per-call token costs — the figures are fractions of a cent, which is the
   point: nothing here looks expensive or dangerous in isolation. */
const CALLS: Call[] = [
  { action: "zendesk.get_ticket", label: null, cost: 0.0008 },
  {
    action: "salesforce.get_contact",
    label: RISK.touches_pii.plain,
    color: "var(--label-pii)",
    fill: "var(--label-pii-fill)",
    cost: 0.0012,
  },
  { action: "zendesk.add_note", label: null, cost: 0.0006 },
  { action: "stripe.get_charge", label: null, cost: 0.0009 },
  {
    action: "sendgrid.send_email",
    label: RISK.sends_external.plain,
    color: "var(--label-external)",
    fill: "var(--label-external-fill)",
    cost: 0.0021,
    closes: true,
  },
  { action: "zendesk.close_ticket", label: null, cost: 0.0007 },
  { action: "salesforce.log_task", label: null, cost: 0.0005 },
  { action: "zendesk.list_queue", label: null, cost: 0.0004 },
];

const OPENS = 1; // index of the call the chain starts from
const CLOSES = 4; // index of the call that completes it
const WINDOW = 5; // rows visible on the tape
const ROW = 30; // px per row
const TICK = 1050; // ms between calls

/* The tape opens part-filled with two quiet calls, so the panel is never an
   empty box on load and the chain still fires several seconds in — late
   enough that a reader has finished the headline before it does. */
const SEED = [CALLS[6], CALLS[7]];

type Row = Call & { key: number; index: number };

const eyebrow: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 9.5,
  fontWeight: 500,
  color: "var(--muted-2)",
  textTransform: "uppercase",
  letterSpacing: "0.13em",
};

/* The chain bracket, drawn in the tape's left gutter.
 *
 * A row is either where the chain opens, a step in between, or where it
 * closes. Three glyph states, one per role, so the pair reads as linked
 * rather than as two separately-highlighted rows. */
function Gutter({ role, live }: { role: "open" | "mid" | "close" | null; live: boolean }) {
  const stroke = live ? "var(--label-money)" : "transparent";
  return (
    <span style={{ width: 13, flexShrink: 0, alignSelf: "stretch", position: "relative" }}>
      <svg
        width="13"
        height="100%"
        viewBox="0 0 13 30"
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
        aria-hidden="true"
      >
        {role === "open" && (
          <line x1="4" y1="15" x2="4" y2="30" stroke={stroke} strokeWidth="1.25" />
        )}
        {role === "mid" && <line x1="4" y1="0" x2="4" y2="30" stroke={stroke} strokeWidth="1.25" />}
        {role === "close" && (
          <line x1="4" y1="0" x2="4" y2="15" stroke={stroke} strokeWidth="1.25" />
        )}
      </svg>
      {(role === "open" || role === "close") && (
        <span
          style={{
            position: "absolute",
            left: 1.6,
            top: "50%",
            width: 5,
            height: 5,
            marginTop: -2.5,
            borderRadius: "50%",
            background: live ? "var(--label-money)" : "transparent",
            transition: "background .25s",
          }}
        />
      )}
    </span>
  );
}

export default function HeroGraphic({
  /* Raised whenever a chain is bracketed on the tape, so the hero can light
     the authority graph behind the headline at the same instant. */
  onChain,
}: {
  onChain?: (live: boolean) => void;
} = {}) {
  const [cursor, bump] = useReducer((n: number) => n + 1, 0);
  const [started, setStarted] = useState(false);
  const [still, setStill] = useState(false);
  const keyRef = useRef(0);
  const [rows, setRows] = useState<Row[]>([]);

  /* Spin the forecast up on mount so the meter reads as a meter. */
  const [monthly, setMonthly] = useState(0);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      /* Reduced motion still gets the finished picture: the tape at the
         moment the chain closes, held still. */
      setStill(true);
      setMonthly(20);
      setRows(
        CALLS.slice(0, CLOSES + 1)
          .slice(-WINDOW)
          .map((c, i) => ({ ...c, key: i, index: CALLS.indexOf(c) })),
      );
      return;
    }

    setRows(SEED.map((c, i) => ({ ...c, key: keyRef.current++, index: CALLS.indexOf(c) })));
    setStarted(true);
    const spin = setTimeout(() => setMonthly(20), 420);
    const id = setInterval(bump, TICK);
    return () => {
      clearTimeout(spin);
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!started) return;
    const call = CALLS[cursor % CALLS.length];
    setRows((prev) =>
      [...prev, { ...call, key: keyRef.current++, index: cursor % CALLS.length }].slice(-(WINDOW + 1)),
    );
  }, [cursor, started]);

  /* The chain is live while both of its ends are still on the tape. */
  const visible = rows.map((r) => r.index);
  const openAt = visible.lastIndexOf(OPENS);
  const closeAt = visible.lastIndexOf(CLOSES);
  const chainLive = still || (openAt !== -1 && closeAt !== -1 && closeAt > openAt);

  useEffect(() => {
    onChain?.(chainLive);
  }, [chainLive, onChain]);

  const roleFor = (i: number): "open" | "mid" | "close" | null => {
    if (!chainLive) return null;
    if (i === openAt) return "open";
    if (i === closeAt) return "close";
    if (i > openAt && i < closeAt) return "mid";
    return null;
  };

  return (
    <div
      style={{
        position: "relative",
        background: "var(--paper)",
        border: "1px solid var(--rule)",
        borderRadius: "var(--r-lg)",
        boxShadow: chainLive
          ? "0 8px 40px rgba(17,24,39,0.10), 0 0 0 3px rgba(220,38,38,0.07)"
          : "var(--shadow-lg)",
        transition: "box-shadow .5s ease",
        width: "100%",
        maxWidth: 468,
        marginLeft: "auto",
        overflow: "hidden",
      }}
    >
      {/* The scan only runs while a chain is on the tape. A light that
          circles forever is decoration; a light that circles when something
          is wrong is an instrument. */}
      {chainLive && !still && (
        <BorderTrail
          size={90}
          transition={{ repeat: Infinity, duration: 3.4, ease: "linear" }}
          style={{
            background:
              "radial-gradient(circle at 50% 50%, rgba(220,38,38,0.55), rgba(220,38,38,0) 68%)",
          }}
        />
      )}

      {/* ── Header ─────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "13px 18px",
          borderBottom: "1px solid var(--rule)",
          background: "var(--ground)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--risk-clear)",
              boxShadow: "0 0 0 3px rgba(22,163,74,0.14)",
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>Beacon Support</span>
        </span>
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            fontWeight: 500,
            color: "var(--muted)",
            background: "var(--paper)",
            border: "1px solid var(--rule)",
            padding: "3px 8px",
            borderRadius: "var(--r-xs)",
            whiteSpace: "nowrap",
            letterSpacing: "0.04em",
          }}
        >
          ±15% · HIGH
        </span>
      </div>

      {/* ── The two numbers ────────────────────────────────────────
          Cost on the left in graphite, blast radius on the right in red.
          Every graphic on this page uses those two channels and only those
          two, so a reader learns the code once.

          The right-hand figure used to be a dollar "worst case". Arceo does
          not produce that number today, so it is the blast-radius score
          instead — and it moves for a real reason: a detected chain adds up
          to 12 points (the engine's chain uplift), which is exactly what
          takes this agent from 55 to 67. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
        <div style={{ padding: "18px 18px 16px" }}>
          <div style={{ ...eyebrow, marginBottom: 9 }}>Monthly cost</div>
          <div
            className="num"
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 4,
              fontSize: 38,
              fontWeight: 600,
              color: "var(--ink)",
              lineHeight: 1,
            }}
          >
            <span>$</span>
            <Odometer value={monthly} />
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--muted-2)", marginTop: 9 }}>
            $17–$23 projected
          </div>
        </div>

        <div
          style={{
            padding: "18px 18px 16px",
            borderLeft: "1px solid var(--rule)",
            background: chainLive ? "var(--label-money-fill)" : "transparent",
            transition: "background .45s ease",
          }}
        >
          <div style={{ ...eyebrow, marginBottom: 9 }}>Blast radius</div>
          <div
            className="num"
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 4,
              fontSize: 38,
              fontWeight: 600,
              color: chainLive ? "var(--label-money)" : "var(--ink)",
              lineHeight: 1,
              transition: "color .45s ease",
            }}
          >
            <Odometer value={chainLive ? 67 : 55} />
            <span style={{ fontSize: 18, color: "var(--muted-2)" }}>/ 100</span>
          </div>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              marginTop: 9,
              color: chainLive ? "var(--label-money)" : "var(--muted-2)",
              transition: "color .45s ease",
            }}
          >
            {chainLive ? "+12 chain uplift" : "no chain yet"}
          </div>
        </div>
      </div>

      {/* ── The tape ───────────────────────────────────────────── */}
      <div
        style={{
          borderTop: "1px solid var(--rule)",
          background: "var(--ground)",
          padding: "12px 18px 6px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={eyebrow}>Live calls</span>
          <span className="mono" style={{ fontSize: 9.5, color: "var(--muted-2)", letterSpacing: "0.04em" }}>
            {chainLive ? "chain detected" : "watching"}
          </span>
        </div>
      </div>

      <div style={{ position: "relative", background: "var(--ground)" }}>
        {/* A tape scrolls; it does not shuffle. Animating each row
            independently let them overlap mid-flight, so the whole column
            moves by exactly one line instead: the strip is bottom-anchored,
            holds one row more than it shows, and slides up a row per call.
            The overflowing top line is caught by the blur above. */}
        <div
          style={{
            height: WINDOW * ROW,
            overflow: "hidden",
            padding: "0 18px 10px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
          }}
        >
          <motion.div
            key={rows.length > WINDOW ? cursor : "filling"}
            initial={still ? false : { y: ROW }}
            animate={{ y: 0 }}
            transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
            style={{ display: "flex", flexDirection: "column" }}
          >
            {rows.map((r, i) => {
              const role = roleFor(i);
              return (
                <div
                  key={r.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    height: ROW,
                    flexShrink: 0,
                    opacity: role ? 1 : 0.92,
                    transition: "opacity .3s",
                  }}
                >
                  <Gutter role={role} live={chainLive} />

                  <span
                    className="mono"
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: role ? "var(--ink)" : "var(--muted)",
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      transition: "color .3s",
                    }}
                  >
                    {r.action}
                  </span>

                  {r.label && (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 500,
                        color: r.color,
                        background: r.fill,
                        padding: "2px 6px",
                        borderRadius: "var(--r-xs)",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {r.label}
                    </span>
                  )}

                  <span
                    className="mono num"
                    style={{
                      fontSize: 10.5,
                      color: "var(--muted-2)",
                      width: 52,
                      textAlign: "right",
                      flexShrink: 0,
                    }}
                  >
                    ${r.cost.toFixed(4)}
                  </span>
                </div>
              );
            })}
          </motion.div>
        </div>

        {/* Lines enter and leave the strip rather than being clipped by a hard
            edge. Both ends are softened: the tape holds one row more than it
            shows, so a row is always part-way in at the bottom and part-way
            out at the top. Without these it reads as two cut-off rows. */}
        <ProgressiveBlur
          direction="top"
          blurLayers={5}
          blurIntensity={0.55}
          style={{ position: "absolute", top: 0, left: 0, right: 0, height: 32, pointerEvents: "none" }}
        />
        <ProgressiveBlur
          direction="bottom"
          blurLayers={5}
          blurIntensity={0.55}
          style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 26, pointerEvents: "none" }}
        />
      </div>

      {/* ── The verdict ────────────────────────────────────────── */}
      <div
        style={{
          borderTop: "1px solid var(--rule)",
          padding: "11px 18px",
          minHeight: 44,
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: chainLive ? "var(--label-money-fill)" : "var(--paper)",
          transition: "background .45s ease",
        }}
      >
        {/* Plain conditional, cross-faded in CSS. An exit-then-enter
            AnimatePresence here can strand the bar on the wrong state if its
            exit never completes, which is exactly the state a reader must
            never see: "nothing flagged" sitting under a $50K readout. */}
        {chainLive ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              animation: still ? "none" : "verdict-in .34s cubic-bezier(.16,1,.3,1)",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 9,
                fontWeight: 600,
                color: "#fff",
                background: "var(--label-money)",
                padding: "2px 6px",
                borderRadius: "var(--r-xs)",
                letterSpacing: "0.06em",
                flexShrink: 0,
              }}
            >
              CRITICAL
            </span>
            <span style={{ fontSize: 12, color: "var(--label-money)", fontWeight: 500 }}>
              Customer data could be sent outside the company
            </span>
          </div>
        ) : (
          <span style={{ fontSize: 12, color: "var(--muted-2)" }}>
            32 chain rules armed · nothing flagged yet
          </span>
        )}
        <style>{`
          @keyframes verdict-in {
            from { opacity: 0; transform: translateY(5px); }
            to   { opacity: 1; transform: none; }
          }
        `}</style>
      </div>
    </div>
  );
}
