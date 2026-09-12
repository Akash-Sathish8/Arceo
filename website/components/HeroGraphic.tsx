"use client";

import { useEffect, useRef, useState } from "react";
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

type Agent = {
  name: string;
  chip: string;
  monthly: number;
  projected: string;
  radius: number; // declared-capability score
  radiusChain: number; // with the +12 chain uplift
  opens: number; // index of the call the chain starts from
  closes: number; // index of the call that completes it
  verdict: string;
  calls: Call[];
};

/* Three agents from three archetypes, each with its own working loop, its own
   forecast and its own flagged chain. The card cycles through them: the cost
   and blast-radius odometers roll to the next agent's figures, the tape
   reseeds, and that agent's chain fires a few calls in.

   Per-call costs are at the scale an LLM turn actually costs: a few cents.
   Each loop's sum times a realistic daily volume is the monthly figure above
   the tape. Every agent's last two calls are quiet ones; they seed the next
   tape so the panel is never an empty box. */
const AGENTS: Agent[] = [
  {
    name: "Beacon Support",
    chip: "±15% · HIGH",
    monthly: 2840,
    projected: "$2,410–$3,270 projected",
    radius: 81,
    radiusChain: 93,
    opens: 1,
    closes: 4,
    verdict: "Customer data could be sent outside the company",
    calls: [
      { action: "zendesk.get_ticket", label: null, cost: 0.014 },
      {
        action: "salesforce.get_contact",
        label: RISK.touches_pii.plain,
        color: "var(--label-pii)",
        fill: "var(--label-pii-fill)",
        cost: 0.021,
      },
      { action: "zendesk.add_note", label: null, cost: 0.011 },
      { action: "stripe.get_charge", label: null, cost: 0.016 },
      {
        action: "sendgrid.send_email",
        label: RISK.sends_external.plain,
        color: "var(--label-external)",
        fill: "var(--label-external-fill)",
        cost: 0.024,
        closes: true,
      },
      { action: "zendesk.close_ticket", label: null, cost: 0.012 },
      { action: "salesforce.log_task", label: null, cost: 0.009 },
      { action: "zendesk.list_queue", label: null, cost: 0.008 },
    ],
  },
  {
    name: "Atlas DevOps",
    chip: "±15% · HIGH",
    monthly: 1260,
    projected: "$1,070–$1,450 projected",
    radius: 74,
    radiusChain: 86,
    opens: 1,
    closes: 4,
    verdict: "Production could change with no backup left to restore",
    calls: [
      { action: "github.get_pr", label: null, cost: 0.012 },
      {
        action: "aws_ec2.scale_group",
        label: RISK.changes_production.plain,
        color: "var(--label-prod)",
        fill: "var(--label-prod-fill)",
        cost: 0.019,
      },
      { action: "pagerduty.get_incident", label: null, cost: 0.011 },
      { action: "slack.post_message", label: null, cost: 0.008 },
      {
        action: "db.delete_backup",
        label: RISK.deletes_data.plain,
        color: "var(--label-delete)",
        fill: "var(--label-delete-fill)",
        cost: 0.017,
        closes: true,
      },
      { action: "github.close_issue", label: null, cost: 0.009 },
      { action: "aws_ec2.describe_instances", label: null, cost: 0.01 },
      { action: "slack.read_channel", label: null, cost: 0.007 },
    ],
  },
  {
    name: "Quota Sales",
    chip: "±15% · HIGH",
    monthly: 4150,
    projected: "$3,530–$4,770 projected",
    radius: 66,
    radiusChain: 78,
    opens: 1,
    closes: 4,
    verdict: "The same customer could be charged twice in one run",
    calls: [
      { action: "hubspot.get_deal", label: null, cost: 0.013 },
      {
        action: "stripe.create_invoice",
        label: RISK.moves_money.plain,
        color: "var(--label-money)",
        fill: "var(--label-money-fill)",
        cost: 0.022,
      },
      { action: "salesforce.update_opportunity", label: null, cost: 0.015 },
      { action: "calendly.get_event", label: null, cost: 0.009 },
      {
        action: "stripe.charge_customer",
        label: RISK.moves_money.plain,
        color: "var(--label-money)",
        fill: "var(--label-money-fill)",
        cost: 0.024,
        closes: true,
      },
      { action: "hubspot.log_activity", label: null, cost: 0.01 },
      { action: "gmail.get_thread", label: null, cost: 0.011 },
      { action: "salesforce.get_account", label: null, cost: 0.012 },
    ],
  },
];

const WINDOW = 5; // rows visible on the tape
const ROW = 30; // px per row
const TICK = 1050; // ms between calls
const HOLD = 4; // extra ticks after a loop completes before the next agent

type Row = Call & { key: number; index: number };

const eyebrow: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--muted-2)",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};

/* The chain bracket, drawn in the tape's left gutter.
 *
 * A row is either where the chain opens, a step in between, or where it
 * closes. Three glyph states, one per role, so the pair reads as linked
 * rather than as two separately-highlighted rows. */
function Gutter({ role, live }: { role: "open" | "mid" | "close" | null; live: boolean }) {
  const stroke = live ? "var(--amber)" : "transparent";
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
            background: live ? "var(--amber)" : "transparent",
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
  const [agentIdx, setAgentIdx] = useState(0);
  const agent = AGENTS[agentIdx];
  const [started, setStarted] = useState(false);
  const [still, setStill] = useState(false);
  const keyRef = useRef(0);
  const [rows, setRows] = useState<Row[]>([]);

  /* Spins up per agent so the meter reads as a meter. */
  const [monthly, setMonthly] = useState(0);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      /* Reduced motion still gets the finished picture: the first agent's
         tape at the moment the chain closes, held still. */
      const a = AGENTS[0];
      setStill(true);
      setMonthly(a.monthly);
      setRows(
        a.calls
          .slice(0, a.closes + 1)
          .slice(-WINDOW)
          .map((c, i) => ({ ...c, key: i, index: a.calls.indexOf(c) })),
      );
      return;
    }
    setStarted(true);
  }, []);

  /* One interval per agent: seed the tape with the agent's two quiet closing
     calls, post the loop one call at a time, hold a few beats after it
     completes, then hand the card to the next agent. Resetting rows on the
     hand-off also clears the chain, so the blast radius rolls to the next
     agent's base score on its own. */
  useEffect(() => {
    if (!started) return;
    const a = AGENTS[agentIdx];
    setRows(
      a.calls
        .slice(-2)
        .map((c) => ({ ...c, key: keyRef.current++, index: a.calls.indexOf(c) })),
    );
    const spin = setTimeout(() => setMonthly(a.monthly), 420);
    let t = 0;
    const id = setInterval(() => {
      if (t >= a.calls.length + HOLD) {
        setAgentIdx((i) => (i + 1) % AGENTS.length);
        return;
      }
      const idx = t % a.calls.length;
      setRows((prev) =>
        [...prev, { ...a.calls[idx], key: keyRef.current++, index: idx }].slice(-(WINDOW + 1)),
      );
      t++;
    }, TICK);
    return () => {
      clearTimeout(spin);
      clearInterval(id);
    };
  }, [agentIdx, started]);

  /* The chain is live while both of its ends are still on the tape. */
  const visible = rows.map((r) => r.index);
  const openAt = visible.lastIndexOf(agent.opens);
  const closeAt = visible.lastIndexOf(agent.closes);
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
        border: "none",
        borderRadius: "var(--r-lg)",
        /* No border, no shadow: the product separates planes by TONE, and the
           hero ground is tinted so this white plane reads as raised without
           anything drawn around it. When the chain fires the ENTIRE card
           warms to amber rather than one panel inside it changing colour —
           the finding is about the agent, not about one number on it. */
        ...({
          "--card-bg": chainLive ? "#FDF4E3" : "var(--paper)",
          "--card-well": chainLive ? "rgba(245,158,11,0.13)" : "var(--ground)",
          "--card-rule": chainLive ? "rgba(245,158,11,0.30)" : "var(--rule)",
        } as React.CSSProperties),
        background: "var(--card-bg)",
        boxShadow: "none",
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
              "radial-gradient(circle at 50% 50%, rgba(245,158,11,0.60), rgba(245,158,11,0) 68%)",
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
          borderBottom: "1px solid var(--card-rule)",
          background: "var(--card-well)",
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
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{agent.name}</span>
        </span>
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            fontWeight: 500,
            color: "var(--muted)",
            background: "var(--paper)",
            border: "1px solid var(--card-rule)",
            padding: "3px 8px",
            borderRadius: "var(--r-xs)",
            whiteSpace: "nowrap",
            letterSpacing: "0.04em",
          }}
        >
          {agent.chip}
        </span>
      </div>

      {/* ── The two numbers ────────────────────────────────────────
          Cost on the left in graphite, blast radius on the right in red.
          Every graphic on this page uses those two channels and only those
          two, so a reader learns the code once.

          The right-hand figure used to be a dollar "worst case". Arceo does
          not produce that number today, so it is the blast-radius score
          instead — and it moves for a real reason: a detected chain adds
          12 points (the engine's chain uplift) to whichever agent is on the
          card. The figure is red at every state: every agent shown here is
          already in policy territory. */}
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
            {agent.projected}
          </div>
        </div>

        <div
          style={{
            padding: "18px 18px 16px",
            borderLeft: "1px solid var(--card-rule)",
            background: chainLive ? "rgba(245,158,11,0.13)" : "transparent",
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
              color: "var(--amber-ink)",
              lineHeight: 1,
            }}
          >
            <Odometer value={chainLive ? agent.radiusChain : agent.radius} />
            <span style={{ fontSize: 18, color: "var(--muted-2)" }}>/ 100</span>
          </div>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              marginTop: 9,
              color: chainLive ? "var(--amber-ink)" : "var(--muted-2)",
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
          borderTop: "1px solid var(--card-rule)",
          background: "var(--card-well)",
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

      <div style={{ position: "relative", background: "var(--card-well)", transition: "background .55s ease" }}>
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
            key={rows.length > WINDOW ? rows[rows.length - 1].key : "filling"}
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
                    ${r.cost.toFixed(3)}
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
          borderTop: "1px solid var(--card-rule)",
          padding: "11px 18px",
          minHeight: 44,
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: chainLive ? "rgba(245,158,11,0.18)" : "var(--card-bg)",
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
                /* Graphite on amber: white is 1.9:1 there, --amber-ink 2.3:1;
                   the brand pairs its amber fill with graphite for this reason. */
                color: "var(--on-amber)",
                background: "var(--amber)",
                padding: "2px 6px",
                borderRadius: "var(--r-xs)",
                letterSpacing: "0.06em",
                flexShrink: 0,
              }}
            >
              CHAIN
            </span>
            <span style={{ fontSize: 12, color: "var(--amber-ink)", fontWeight: 500 }}>
              {agent.verdict}
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
