"use client";

import { useEffect, useState } from "react";
import { useArmed } from "@/lib/useArmed";
import { RISK } from "@/lib/labels";
import { BorderTrail } from "./motion/border-trail";

/* Cross-agent chain detection.
 *
 * This slot used to hold a cost-against-exposure scatter. The exposure axis
 * was a dollar figure Arceo does not produce, so the whole chart was arguing
 * from a number that does not exist. What replaces it is a feature that does:
 * sandbox/multi_runner.py follows `dispatch_agent` handoffs and runs the chain
 * detector ACROSS agents, not just within one.
 *
 * The idea is easy to say and hard to draw: each agent is clean on its own,
 * and the dangerous sequence only exists once you follow the handoff. So the
 * picture shows exactly that and nothing else — two agents, one action lit in
 * each, both still reporting clear, and a bracket underneath that spans both
 * of them. The reader watches the chain assemble in the order it happens:
 * read a record, hand off, send mail. Five beats, then it resets.
 *
 * Every verdict on screen is simultaneously true, which is the whole point:
 * "no chain on its own" and "PII exfiltration" are not in conflict. */

/* ── The two agents, as faces ─────────────────────────────────────────────
 *
 * One construction language, two jobs. Both robots are the same head — same
 * rounded square, same eyes, same 1.6 stroke — so they read as a matched pair
 * rather than two pieces of clipart. What differs is the thing bolted to it:
 * Support wears a headset, Ops carries a bell. That is the whole gag, and it
 * is enough, because a reader has to tell these two apart in about a second.
 *
 * They come alive when the run reaches them: eyes brighten, and the part that
 * names the job animates — Support's mic capsule pulses like an open line,
 * Ops's bell actually rings. Nothing moves until that agent is working. */

function SupportBot() {
  return (
    <svg viewBox="0 0 48 48" width="66" height="66" fill="none" aria-hidden="true">
      {/* headband */}
      <path d="M8 29A16 16 0 0 1 40 29" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      {/* ear cups */}
      <rect x="4.4" y="26" width="6.6" height="11.5" rx="3.3" fill="currentColor" opacity=".9" />
      <rect x="37" y="26" width="6.6" height="11.5" rx="3.3" fill="currentColor" opacity=".9" />
      {/* head */}
      <rect
        x="11.5" y="17" width="25" height="23" rx="7.5"
        className="bot-face" stroke="currentColor" strokeWidth="1.7"
      />
      <circle className="bot-eye" cx="19.5" cy="27" r="2.6" />
      <circle className="bot-eye" cx="28.5" cy="27" r="2.6" />
      {/* a smile — this one talks to customers */}
      <path d="M20.4 32.4Q24 35 27.6 32.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      {/* boom mic */}
      <g className="bot-mic">
        <path d="M40.3 37C40.3 42 36 44.4 32.2 43.9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="30.8" cy="43.6" r="2.7" fill="currentColor" />
        <circle className="bot-mic-ring" cx="30.8" cy="43.6" r="2.7" />
      </g>
    </svg>
  );
}

function OpsBot() {
  return (
    <svg viewBox="0 0 48 48" width="66" height="66" fill="none" aria-hidden="true">
      {/* the bell it wears, sitting straight on its head like an alarm clock */}
      <g className="bot-bell">
        <path
          d="M17 13.6C17 8 19.8 4.4 24 4.4S31 8 31 13.6c0 1.2 1 1.9 1.6 2.4H15.4c.6-.5 1.6-1.2 1.6-2.4Z"
          fill="currentColor"
        />
        <path className="bot-ring" d="M10.4 7.4A7 7 0 0 0 10.4 14.6" strokeWidth="1.6" strokeLinecap="round" />
        <path className="bot-ring" d="M37.6 7.4A7 7 0 0 1 37.6 14.6" strokeWidth="1.6" strokeLinecap="round" />
      </g>
      {/* side panels, so the silhouette rhymes with Support's ear cups */}
      <rect x="7.4" y="26.5" width="4.2" height="8.5" rx="2.1" fill="currentColor" opacity=".9" />
      <rect x="36.4" y="26.5" width="4.2" height="8.5" rx="2.1" fill="currentColor" opacity=".9" />
      {/* head — same box, same eyes, same baseline as Support */}
      <rect
        x="11.5" y="17" width="25" height="23" rx="7.5"
        className="bot-face" stroke="currentColor" strokeWidth="1.7"
      />
      <circle className="bot-eye" cx="19.5" cy="27" r="2.6" />
      <circle className="bot-eye" cx="28.5" cy="27" r="2.6" />
      {/* a flat mouth — this one does not chat, it dispatches */}
      <path d="M21 33.2h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

type Action = { name: string; label?: string; color?: string; fill?: string };

const SUPPORT: Action[] = [
  { name: "zendesk.get_ticket" },
  {
    name: "salesforce.get_contact",
    label: RISK.touches_pii.plain,
    color: "var(--label-pii)",
    fill: "var(--label-pii-fill)",
  },
  { name: "zendesk.add_note" },
];

const OPS: Action[] = [
  { name: "pagerduty.get_oncall" },
  {
    name: "sendgrid.send_email",
    label: RISK.sends_external.plain,
    color: "var(--label-external)",
    fill: "var(--label-external-fill)",
  },
  { name: "slack.post_message" },
];

/* Which row lights in each card. */
const LIT = 1;

/* One sentence per beat. The animation is legible on its own, but a caption
   removes the last bit of guesswork — and it means the section still explains
   itself in a screenshot, where nothing is moving at all. */
const NARRATION = [
  "Two agents, each doing their own job",
  "Support reads a customer record",
  "It hands the job over to Ops",
  "Ops emails the customer",
  "Arceo flags the pair as one chain",
];

/* Beat lengths, in ms. The chain holds for three seconds so it can be read,
   then the whole thing resets and runs again. */
const BEATS = [900, 1100, 1200, 800, 3200];
const FINAL = BEATS.length - 1;

export default function CrossAgent() {
  const [ref, armed] = useArmed<HTMLElement>(0.25);
  const [still, setStill] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!armed) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setStill(true);
      setStep(FINAL);
      return;
    }
    const id = setTimeout(() => setStep((s) => (s + 1) % BEATS.length), BEATS[step]);
    return () => clearTimeout(id);
  }, [armed, step]);

  const litA = step >= 1;
  const dispatching = step === 2;
  const delivered = step >= 3;
  const litB = step >= 3;
  const chained = step >= 4;

  const card = (
    title: string,
    role: string,
    score: number,
    actions: Action[],
    lit: boolean,
    avatar: React.ReactNode,
    scanning: boolean,
  ) => (
    <div className={`xa-card${lit ? " lit" : ""}`}>
      {/* The scan runs only while this agent is the one acting. Graphite,
          not red — this is Arceo looking, not Arceo finding. */}
      {scanning && (
        <BorderTrail
          size={80}
          transition={{ repeat: Infinity, duration: 2.8, ease: "linear" }}
          style={{
            background:
              "radial-gradient(circle at 50% 50%, rgba(17,24,39,0.35), rgba(17,24,39,0) 70%)",
          }}
        />
      )}
      <span className="mono xa-score">{score} / 100</span>

      <span className="xa-avatar">{avatar}</span>
      <span className="xa-name">{title}</span>
      <span className="mono xa-role">{role}</span>

      <div className="xa-actions">
        {actions.map((a, i) => (
          <div key={a.name} className={`xa-action${lit && i === LIT ? " on" : ""}`}>
            <span className="mono xa-action-name">{a.name}</span>
            {a.label && (
              <span
                className="xa-chip"
                style={
                  lit && i === LIT
                    ? { color: a.color, background: a.fill, borderColor: a.color }
                    : undefined
                }
              >
                {a.label}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Stays clear the whole way through. That is the finding. */}
      <div className="xa-verdict-own">
        <span className="xa-tick" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6.2l2.4 2.4L9.5 4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        No chain on its own
      </div>
    </div>
  );

  return (
    <section
      ref={ref}
      style={{
        padding: "104px 0 112px",
        background: "var(--ground)",
        borderTop: "1px solid var(--rule)",
      }}
    >
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 32px" }}>
        <div className="xa-intro">
          <span className="eyebrow">Cross-agent chains</span>
          <h2
            style={{
              fontSize: "clamp(28px, 3.3vw, 42px)",
              fontWeight: 600,
              letterSpacing: "-0.034em",
              color: "var(--ink)",
              lineHeight: 1.08,
              textWrap: "balance",
              maxWidth: 620,
              marginBottom: 18,
            }}
          >
            Two safe agents. One dangerous chain.
          </h2>
          <p style={{ fontSize: 17, color: "var(--muted)", lineHeight: 1.6, maxWidth: 540 }}>
            Agents hand work to each other. Arceo follows the handoff, so a
            sequence that is only dangerous across two agents still gets caught.
          </p>
        </div>

        <div className="xa-stage">
          <div className="xa-caption">
            <span className="xa-beats" aria-hidden="true">
              {NARRATION.map((_, i) => (
                <span key={i} className={`xa-beat${i <= step ? " on" : ""}`} />
              ))}
            </span>
            <span className="xa-caption-text" key={step}>
              {NARRATION[step]}
            </span>
          </div>

          <div className="xa-grid">
            {card("Support agent", "answers tickets", 34, SUPPORT, litA, <SupportBot />, step === 1 || step === 2)}

            {/* The handoff. */}
            <div className="xa-link">
              <span className="mono xa-link-label">dispatch_agent</span>
              <span className={`xa-rail${dispatching ? " flow" : ""}`}>
                {/* The record itself crosses the wire. A bare dot travelling a
                    line says "something happened"; a labelled payload says
                    what was handed over, which is the entire point. */}
                <span className={`xa-payload${step >= 2 ? " go" : ""}${delivered ? " gone" : ""}`}>
                  <span className="xa-payload-dot" />
                  customer record
                </span>
                <span className="xa-head-arrow" aria-hidden="true">
                  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                    <path
                      d="M1.5 1.2 5.6 4.5 1.5 7.8"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </span>
            </div>

            {card("Ops agent", "pages on-call", 41, OPS, litB, <OpsBot />, step === 3)}
          </div>

          {/* The bracket spanning both agents. It is the only red on the
              panel, and it only exists once both ends have lit. */}
          <div className={`xa-bracket${chained ? " on" : ""}`} aria-hidden="true">
            <span className="xa-stub xa-stub-l" />
            <span className="xa-stub xa-stub-r" />
            <span className="xa-railing" />
          </div>

          <div className={`xa-verdict${chained ? " on" : ""}`}>
            <span className="mono xa-sev">CRITICAL</span>
            <span className="xa-verdict-text">
              One agent reads customer data, the other sends it outside the
              company
            </span>
          </div>
        </div>
      </div>

      <style>{`
        .xa-intro { margin-bottom: 44px; }

        .xa-caption {
          display: flex; align-items: center; gap: 14px;
          padding-bottom: 18px; margin-bottom: 26px;
          border-bottom: 1px solid var(--rule);
        }
        .xa-beats { display: inline-flex; gap: 5px; flex-shrink: 0; }
        .xa-beat {
          width: 16px; height: 3px; border-radius: 2px;
          background: var(--ground-3);
          transition: background .35s ease;
        }
        .xa-beat.on { background: var(--ink); }
        .xa-caption-text {
          font-size: 14px; color: var(--ink); font-weight: 500;
          animation: xa-cap .4s cubic-bezier(.16,1,.3,1);
        }
        @keyframes xa-cap {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: none; }
        }

        .xa-stage {
          background: var(--paper);
          border: 1px solid var(--rule);
          border-radius: var(--r-lg);
          box-shadow: var(--shadow-md);
          padding: 34px 34px 30px;
        }

        .xa-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 196px minmax(0, 1fr);
          align-items: stretch;
          gap: 0;
        }

        /* ── Agent card ───────────────────────────────────────── */
        .xa-card {
          position: relative;
          display: flex; flex-direction: column; align-items: center;
          border: 1px solid var(--rule);
          border-radius: var(--r-md);
          padding: 26px 20px 18px;
          background: var(--paper);
          transition: border-color .4s ease, box-shadow .4s ease;
        }
        .xa-card.lit {
          border-color: var(--muted-2);
          box-shadow: var(--shadow-sm);
        }
        .xa-score {
          position: absolute; top: 14px; right: 16px;
          font-size: 11px; color: var(--muted-2);
        }
        .xa-name {
          font-size: 18px; font-weight: 600; color: var(--ink);
          letter-spacing: -0.015em; margin-top: 16px;
        }
        .xa-role { font-size: 11px; color: var(--muted-2); margin-top: 3px; }

        /* ── The robots ───────────────────────────────────────────
           Big, centred, and the first thing in the card, because the
           two characters ARE the story — the handoff between them is
           what the section is about. Everything else is evidence. */
        .xa-avatar {
          flex-shrink: 0;
          width: 92px; height: 92px;
          display: inline-flex; align-items: center; justify-content: center;
          border-radius: 24px;
          border: 1px solid var(--rule);
          background: var(--ground);
          color: var(--muted-2);
          transition:
            color .4s ease, background .4s ease,
            border-color .4s ease, box-shadow .45s ease, transform .45s cubic-bezier(.16,1,.3,1);
        }
        .xa-card.lit .xa-avatar {
          color: var(--ink);
          background: var(--paper);
          border-color: var(--muted-2);
          /* A quiet halo, so the working agent lifts off the card. */
          box-shadow: 0 0 0 7px var(--ground-2);
          transform: translateY(-2px);
        }
        .bot-face { fill: var(--paper); transition: fill .4s ease; }
        .xa-card.lit .bot-face { fill: var(--ground); }
        .bot-eye {
          fill: currentColor; transition: fill .4s ease;
          transform-box: fill-box; transform-origin: center;
          animation: bot-blink 5.4s infinite;
        }
        /* Offset so the two never blink in unison — that reads as a glitch
           rather than as two separate machines. */
        .xa-grid > :last-child .bot-eye { animation-delay: 2.3s; }
        @keyframes bot-blink {
          0%, 93%, 100% { transform: scaleY(1); }
          96%           { transform: scaleY(.1); }
        }

        /* Idle, the ring marks and the mic pulse are simply absent. */
        .bot-ring { stroke: currentColor; opacity: 0; transition: opacity .3s ease; }
        .bot-mic-ring { stroke: currentColor; fill: none; opacity: 0; }

        /* The line opens: a single ring off the mic capsule. */
        .xa-card.lit .bot-mic-ring { animation: bot-ping 1.9s ease-out infinite; }
        @keyframes bot-ping {
          0%   { opacity: .55; transform: scale(1); }
          70%  { opacity: 0;   transform: scale(2.6); }
          100% { opacity: 0;   transform: scale(2.6); }
        }
        .bot-mic-ring { transform-origin: 30.8px 43.6px; }

        /* The bell actually rings when Ops is paged. */
        .bot-bell { transform-origin: 24px 16px; }
        .xa-card.lit .bot-bell { animation: bot-shake 1.6s ease-in-out infinite; }
        .xa-card.lit .bot-ring { opacity: .75; }
        @keyframes bot-shake {
          0%, 62%, 100% { transform: rotate(0deg); }
          68%  { transform: rotate(9deg); }
          74%  { transform: rotate(-7deg); }
          80%  { transform: rotate(5deg); }
          86%  { transform: rotate(-3deg); }
          92%  { transform: rotate(1deg); }
        }

        .xa-actions {
          width: 100%;
          display: flex; flex-direction: column; gap: 2px;
          margin-top: 22px;
          padding-bottom: 14px; margin-bottom: 12px;
          border-bottom: 1px solid var(--rule-light);
        }
        .xa-action {
          display: flex; align-items: center; justify-content: space-between;
          gap: 10px; height: 30px; padding: 0 9px;
          border-radius: var(--r-xs);
          transition: background .35s ease;
        }
        .xa-action.on { background: var(--ground); }
        .xa-action-name {
          font-size: 11.5px; color: var(--muted);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          transition: color .35s ease;
        }
        .xa-action.on .xa-action-name { color: var(--ink); font-weight: 500; }
        .xa-chip {
          font-size: 10.5px; font-weight: 500; flex-shrink: 0;
          padding: 2px 7px; border-radius: var(--r-xs);
          color: var(--muted-2); background: var(--ground-2);
          border: 1px solid transparent;
          transition: color .35s ease, background .35s ease, border-color .35s ease;
        }

        .xa-verdict-own {
          width: 100%;
          display: flex; align-items: center; gap: 7px;
          font-size: 11.5px; color: var(--muted);
        }
        .xa-tick {
          display: inline-flex; color: var(--risk-clear); flex-shrink: 0;
        }

        /* ── The handoff ──────────────────────────────────────── */
        .xa-link {
          display: flex; flex-direction: column;
          align-items: center; justify-content: flex-start;
          gap: 10px; padding: 52px 12px 0; position: relative; z-index: 3;
        }
        .xa-link-label {
          font-size: 9.5px; color: var(--muted-2); letter-spacing: 0.04em;
          white-space: nowrap;
        }
        .xa-rail {
          position: relative; width: 100%; height: 1px;
          overflow: visible;
          background: repeating-linear-gradient(
            to right, var(--rule) 0 4px, transparent 4px 8px
          );
          background-size: 8px 1px;
          transition: background-color .3s ease;
        }
        /* Dashes march while something is actually crossing. */
        .xa-rail.flow {
          background-image: repeating-linear-gradient(
            to right, var(--muted-2) 0 4px, transparent 4px 8px
          );
          animation: xa-flow .5s linear infinite;
        }
        @keyframes xa-flow { to { background-position: 8px 0; } }

        .xa-payload {
          position: absolute; top: 50%; left: 0;
          transform: translate(-50%, -50%) scale(.9);
          display: inline-flex; align-items: center; gap: 6px;
          white-space: nowrap;
          font-size: 9.5px; font-weight: 500; color: var(--label-pii);
          background: var(--paper);
          border: 1px solid var(--label-pii);
          padding: 4px 9px; border-radius: 999px;
          box-shadow: var(--shadow-sm);
          opacity: 0; pointer-events: none;
          transition:
            left 1.05s cubic-bezier(.45,0,.35,1),
            opacity .28s ease,
            transform .28s cubic-bezier(.16,1,.3,1);
        }
        /* It leaves one card and is absorbed by the other, so it is allowed
           to overhang the gutter at both ends. */
        .xa-payload.go {
          opacity: 1; left: 100%;
          transform: translate(-50%, -50%) scale(1);
        }
        /* Absorbed by Ops rather than left hanging on the wire. */
        .xa-payload.gone {
          opacity: 0;
          transform: translate(-50%, -50%) scale(.86);
        }
        .xa-payload-dot {
          width: 5px; height: 5px; border-radius: 50%;
          background: var(--label-pii); flex-shrink: 0;
        }
        .xa-head-arrow {
          position: absolute; right: -2px; top: 50%;
          transform: translateY(-50%);
          display: inline-flex; color: var(--muted-2);
        }

        /* ── The bracket ──────────────────────────────────────── */
        .xa-bracket {
          position: relative; height: 34px; margin-top: 4px;
        }
        .xa-stub {
          position: absolute; top: 0; width: 1.5px; height: 22px;
          background: var(--risk);
          transform: scaleY(0); transform-origin: top;
          transition: transform .3s cubic-bezier(.16,1,.3,1);
        }
        /* Centres of the two cards: each card is (100% - 148px) / 2 wide, so
           its centre sits a quarter of that in from each edge. */
        .xa-stub-l { left: calc((100% - 196px) / 4); }
        .xa-stub-r { right: calc((100% - 196px) / 4); }
        .xa-railing {
          position: absolute; top: 21.5px;
          left: calc((100% - 196px) / 4);
          right: calc((100% - 196px) / 4);
          height: 1.5px; background: var(--risk);
          box-shadow: 0 0 10px rgba(220,38,38,0.35);
          transform: scaleX(0);
          transition: transform .5s cubic-bezier(.16,1,.3,1) .22s;
        }
        .xa-bracket.on .xa-stub { transform: scaleY(1); }
        .xa-bracket.on .xa-stub-r { transition-delay: .1s; }
        .xa-bracket.on .xa-railing { transform: scaleX(1); }

        .xa-verdict {
          display: flex; align-items: center; justify-content: center;
          gap: 11px; flex-wrap: wrap;
          opacity: 0; transform: translateY(6px);
          transition: opacity .4s ease .55s, transform .4s cubic-bezier(.16,1,.3,1) .55s;
        }
        .xa-verdict.on { opacity: 1; transform: none; }
        .xa-sev {
          font-size: 9px; font-weight: 600; letter-spacing: 0.08em;
          color: #fff; background: var(--risk);
          padding: 3px 8px; border-radius: var(--r-xs); flex-shrink: 0;
        }
        .xa-verdict-text { font-size: 13.5px; color: var(--risk); }
        .xa-verdict-text .mono { font-size: 12.5px; }
        .xa-to { color: var(--risk-soft); }

        @media (max-width: 860px) {
          .xa-grid { grid-template-columns: 1fr; gap: 0; }
          /* Stacked, the handoff runs downward instead of across. */
          .xa-link { flex-direction: row; justify-content: center; padding: 16px 0 0; gap: 10px; }
          .xa-rail { width: 60px; }
          .xa-caption {
          display: flex; align-items: center; gap: 14px;
          padding-bottom: 18px; margin-bottom: 26px;
          border-bottom: 1px solid var(--rule);
        }
        .xa-beats { display: inline-flex; gap: 5px; flex-shrink: 0; }
        .xa-beat {
          width: 16px; height: 3px; border-radius: 2px;
          background: var(--ground-3);
          transition: background .35s ease;
        }
        .xa-beat.on { background: var(--ink); }
        .xa-caption-text {
          font-size: 14px; color: var(--ink); font-weight: 500;
          animation: xa-cap .4s cubic-bezier(.16,1,.3,1);
        }
        @keyframes xa-cap {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: none; }
        }

        .xa-stage { padding: 22px 20px 24px; }
          .xa-bracket { display: none; }
          .xa-verdict {
            margin-top: 18px; padding-top: 18px;
            border-top: 1px solid var(--rule);
            justify-content: flex-start;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .xa-token, .xa-stub, .xa-railing, .xa-verdict { transition: none; }
          .bot-bell, .bot-mic-ring, .bot-eye, .xa-rail.flow { animation: none !important; }
          .xa-caption-text { animation: none; }
        }
      `}</style>
    </section>
  );
}
