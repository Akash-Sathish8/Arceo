"use client";

import { useEffect, useState } from "react";
import { useArmed } from "@/lib/useArmed";
import AuthorityGraph from "./AuthorityGraph";

/* Cross-agent chain detection.
 *
 * The idea is easy to say and hard to draw: each agent is clean on its own,
 * and the dangerous sequence only exists once you follow the handoff.
 *
 * An earlier version of this panel tried to prove that with evidence — tool
 * names, risk chips, blast-radius scores, a verdict per card. All of it was
 * true and all of it was noise: a reader spent their attention parsing
 * `salesforce.get_contact` instead of watching the one thing that matters,
 * which is a record crossing a gap and two agents changing because of it.
 *
 * So the panel is now two faces and a wire. The agents are the subject, at
 * the size of a subject. Nothing is named in tool syntax. The record crosses,
 * and both agents turn amber and lose their expression — the same "attention"
 * amber the rest of the site uses for something that needs review. Two
 * pictures, one before and one after, is the entire argument. */

type BotProps = { worried: boolean };

/* One construction language, two jobs. Both robots are the same head — same
   rounded square, same eyes, same 1.7 stroke — so they read as a matched pair
   rather than two pieces of clipart. What differs is the thing bolted to it:
   Support wears a headset, Ops carries a bell.

   Each carries BOTH mouths and cross-fades between them. SVG path `d` does not
   animate reliably across browsers, so swapping opacity on two stacked paths
   is what makes the expression change rather than snap. */
function Mouths({ calm, worried }: { calm: string; worried: boolean }) {
  return (
    <>
      <path
        className="bot-mouth bot-mouth-calm"
        d={calm}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity={worried ? 0 : 1}
      />
      <path
        className="bot-mouth bot-mouth-worried"
        d="M20.4 34.4Q24 31.5 27.6 34.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity={worried ? 1 : 0}
      />
    </>
  );
}

function SupportBot({ worried }: BotProps) {
  return (
    <svg viewBox="0 0 48 48" width="100%" height="100%" fill="none" aria-hidden="true">
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
      {/* a smile — this one talks to customers — until it does not */}
      <Mouths calm="M20.4 32.4Q24 35 27.6 32.4" worried={worried} />
      {/* boom mic */}
      <g className="bot-mic">
        <path d="M40.3 37C40.3 42 36 44.4 32.2 43.9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="30.8" cy="43.6" r="2.7" fill="currentColor" />
        <circle className="bot-mic-ring" cx="30.8" cy="43.6" r="2.7" />
      </g>
    </svg>
  );
}

function OpsBot({ worried }: BotProps) {
  return (
    <svg viewBox="0 0 48 48" width="100%" height="100%" fill="none" aria-hidden="true">
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
      <Mouths calm="M21 33.2h6" worried={worried} />
    </svg>
  );
}

/* One sentence per beat, in plain words. The animation is legible on its own,
   but a caption removes the last of the guesswork — and it means the section
   still explains itself in a screenshot, where nothing is moving at all. */
const NARRATION = [
  "Two agents, each doing their own job",
  "Support looks up a customer",
  "It hands that customer's details to Ops",
  "Ops emails them outside the company",
];

/* Beat lengths, in ms. The last beat holds so the flagged state can be read,
   then the whole thing resets and runs again. */
const BEATS = [1500, 1600, 1500, 4400];
const FINAL = BEATS.length - 1;

export default function CrossAgent() {
  const [ref, armed] = useArmed<HTMLElement>(0.25);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!armed) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setStep(FINAL);
      return;
    }
    const id = setTimeout(() => setStep((s) => (s + 1) % BEATS.length), BEATS[step]);
    return () => clearTimeout(id);
  }, [armed, step]);

  const dispatching = step === 2;
  /* Both agents change at the same moment, because that is the finding: the
     problem is not either one of them, it is the pair. */
  const flagged = step >= FINAL;

  const agent = (
    name: string,
    does: string,
    avatar: React.ReactNode,
  ) => (
    <div className={`xa-agent${flagged ? " flagged" : ""}`}>
      <span className="xa-avatar">{avatar}</span>
      <span className="xa-name">{name}</span>
      <span className="xa-does">{does}</span>
      <span className="xa-state">
        {flagged ? "Now part of a chain" : "Safe on its own"}
      </span>
    </div>
  );

  return (
    <section
      id="cross-agent"
      ref={ref}
      style={{
        padding: "104px 0 112px",
        background: "var(--band-aqua)",
        borderTop: "1px solid var(--rule)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* A handoff between two agents is a path through the authority graph,
          so the network runs behind the section that explains it. */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.5 }}>
        <AuthorityGraph variant="ambient" packets={2} maskAt="50% 42%" />
      </div>

      <div style={{ position: "relative", zIndex: 2, maxWidth: 1240, margin: "0 auto", padding: "0 32px" }}>
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
            {agent("Support agent", "Answers customer tickets", <SupportBot worried={flagged} />)}

            {/* The handoff, drawn as one edge of the authority graph: two
                endpoint nodes and a hop between them, in the same aquamarine
                the network uses everywhere else on the page. */}
            <div className="xa-link">
              <span
                className={`xa-rail${dispatching ? " flow" : ""}${flagged ? " flagged" : ""}`}
              >
                <span className="xa-node xa-node-a" aria-hidden="true" />
                <span className="xa-node xa-node-mid" aria-hidden="true" />
                <span className="xa-node xa-node-b" aria-hidden="true" />

                {/* The record itself crosses. The outer element carries the
                    horizontal travel and the inner one the lift, so together
                    they arc OVER the gap — a thing handed across, rather than
                    a label dragged along a line. */}
                <span className={`xa-fly${dispatching ? " go" : ""}`}>
                  <span className="xa-payload">
                    <span className="xa-payload-dot" />
                    customer details
                  </span>
                </span>
              </span>
            </div>

            {agent("Ops agent", "Emails and pages on-call", <OpsBot worried={flagged} />)}
          </div>

          {/* The tie. It only exists once the handoff has happened, and it is
              what turns two agents into one thing worth reviewing. */}
          <div className={`xa-bracket${flagged ? " on" : ""}`} aria-hidden="true">
            <span className="xa-stub xa-stub-l" />
            <span className="xa-stub xa-stub-r" />
            <span className="xa-railing" />
          </div>

          <div className={`xa-verdict${flagged ? " on" : ""}`}>
            <span className="mono xa-sev">CHAIN DETECTED</span>
            <span className="xa-verdict-text">
              Neither agent is dangerous alone. Together they move customer
              details outside the company.
            </span>
          </div>
        </div>
      </div>

      <style>{`
        .xa-intro { margin-bottom: 44px; }

        .xa-caption {
          display: flex; align-items: center; gap: 14px;
          padding-bottom: 20px; margin-bottom: 8px;
          border-bottom: 1px solid var(--rule);
        }
        .xa-beats { display: inline-flex; gap: 5px; flex-shrink: 0; }
        .xa-beat {
          width: 18px; height: 3px; border-radius: 2px;
          background: var(--ground-3);
          transition: background .35s ease;
        }
        .xa-beat.on { background: var(--brand); }
        .xa-caption-text {
          font-size: 16px; color: var(--ink); font-weight: 500;
          letter-spacing: -0.01em;
          animation: xa-cap .4s cubic-bezier(.16,1,.3,1);
        }
        @keyframes xa-cap {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: none; }
        }

        /* The handoff gutter. Referenced by the grid AND by the bracket
           geometry below, so it lives in one place. */
        .xa-stage {
          --xa-gutter: 260px;
          background: var(--paper);
          border: none;
          border-radius: var(--r-lg);
          padding: 30px 34px 30px;
        }

        .xa-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) var(--xa-gutter) minmax(0, 1fr);
          align-items: stretch;
          gap: 0;
        }

        /* ── The agents ───────────────────────────────────────────
           The subject of the panel, so they get the space of one. No border
           and no shadow: a tinted well on the white stage, the way the
           product separates planes. The well is the state — aquamarine while
           each agent is fine on its own, amber once the pair is a chain. */
        .xa-agent {
          display: flex; flex-direction: column; align-items: center;
          text-align: center;
          padding: 40px 24px 34px;
          border-radius: var(--r-md);
          background: var(--aqua-soft);
          color: var(--aqua-deep);
          transition: background .55s ease, color .55s ease;
        }
        .xa-agent.flagged {
          background: rgba(245, 158, 11, 0.15);
          color: var(--amber-ink);
        }

        .xa-avatar {
          width: 116px; height: 116px;
          display: flex; align-items: center; justify-content: center;
          margin-bottom: 20px;
        }
        /* The face plate reads as the head, so it takes the well's tint back
           out of the fill rather than sitting on a second surface. */
        .bot-face { fill: var(--paper); }
        .bot-eye  { fill: currentColor; transition: fill .55s ease; }
        .bot-mouth { transition: opacity .45s ease; }

        .xa-name {
          font-size: 21px; font-weight: 600; letter-spacing: -0.02em;
          color: var(--ink); margin-bottom: 5px;
        }
        .xa-does {
          font-size: 14.5px; color: var(--muted); line-height: 1.45;
          margin-bottom: 18px;
        }
        .xa-state {
          font-size: 12px; font-weight: 600; letter-spacing: 0.01em;
          color: currentColor;
          transition: color .55s ease;
        }

        /* ── The handoff ──────────────────────────────────────────── */
        .xa-link {
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          padding: 0 14px; position: relative; z-index: 3;
        }
        .xa-rail {
          position: relative; width: 100%; height: 2px;
          overflow: visible;
          background: repeating-linear-gradient(
            to right, var(--aqua-line) 0 4px, transparent 4px 8px
          );
          background-size: 8px 2px;
          transition: background-image .45s ease;
        }
        /* Dashes march while something is actually crossing. */
        .xa-rail.flow {
          background-image: repeating-linear-gradient(
            to right, var(--amber) 0 4px, transparent 4px 8px
          );
          animation: xa-flow .5s linear infinite;
        }
        .xa-rail.flagged {
          background-image: repeating-linear-gradient(
            to right, var(--amber) 0 4px, transparent 4px 8px
          );
          animation: none;
        }
        @keyframes xa-flow { to { background-position: 8px 0; } }

        /* The three nodes of the hop — same construction as the authority
           graph's own nodes, so this reads as one edge lifted out of the
           network rather than a decorative arrow. */
        .xa-node {
          position: absolute; top: 50%;
          border-radius: 50%;
          background: var(--aqua);
          border: 1.5px solid var(--aqua-ink);
          transform: translate(-50%, -50%);
          transition: background .45s ease, border-color .45s ease;
        }
        .xa-node-a, .xa-node-b { width: 10px; height: 10px; }
        .xa-node-a { left: 0; }
        .xa-node-b { left: 100%; }
        .xa-node-mid {
          left: 50%; width: 7px; height: 7px;
          background: var(--paper);
        }
        .xa-rail.flow .xa-node-mid,
        .xa-rail.flagged .xa-node,
        .xa-rail.flagged .xa-node-mid {
          background: var(--amber); border-color: var(--amber);
        }

        /* ── The record in flight ─────────────────────────────────── */
        .xa-fly {
          position: absolute; top: 50%; left: 0;
          opacity: 0; pointer-events: none; z-index: 6;
        }
        .xa-fly.go { animation: xa-cross 1.35s cubic-bezier(.42,0,.3,1) both; }
        @keyframes xa-cross {
          0%   { left: 0%;   opacity: 0; }
          14%  { opacity: 1; }
          82%  { opacity: 1; }
          100% { left: 100%; opacity: 0; }
        }
        .xa-payload {
          display: inline-flex; align-items: center; gap: 9px;
          white-space: nowrap;
          font-size: 13px; font-weight: 600; color: var(--ink);
          /* Cyan: the brand's one colour with no severity meaning. Nothing
             has gone wrong at the moment the record is handed over. */
          background: var(--cyan-soft);
          border: 1.5px solid var(--cyan-ring);
          padding: 9px 16px; border-radius: 999px;
          transform: translate(-50%, -50%);
        }
        .xa-fly.go .xa-payload {
          animation: xa-arc 1.35s cubic-bezier(.42,0,.3,1) both;
        }
        @keyframes xa-arc {
          0%   { transform: translate(-50%, -50%) scale(.9); }
          50%  { transform: translate(-50%, calc(-50% - 42px)) scale(1.06); }
          100% { transform: translate(-50%, -50%) scale(.9); }
        }
        .xa-payload-dot {
          width: 9px; height: 9px; border-radius: 50%;
          background: var(--cyan-ink); flex-shrink: 0;
        }

        /* ── The tie ──────────────────────────────────────────────── */
        .xa-bracket { position: relative; height: 30px; margin-top: 2px; }
        .xa-stub {
          position: absolute; top: 0; width: 2px; height: 20px;
          background: var(--amber);
          transform: scaleY(0); transform-origin: top;
          transition: transform .32s cubic-bezier(.16,1,.3,1);
        }
        /* Centres of the two agent wells: each is (100% - gutter) / 2 wide,
           so its centre sits a quarter of that in from each edge. */
        .xa-stub-l { left: calc((100% - var(--xa-gutter)) / 4); }
        .xa-stub-r { right: calc((100% - var(--xa-gutter)) / 4); }
        .xa-railing {
          position: absolute; top: 18px; height: 2px;
          left: calc((100% - var(--xa-gutter)) / 4);
          right: calc((100% - var(--xa-gutter)) / 4);
          background: var(--amber);
          transform: scaleX(0);
          transition: transform .45s cubic-bezier(.16,1,.3,1) .22s;
        }
        .xa-bracket.on .xa-stub { transform: scaleY(1); }
        .xa-bracket.on .xa-railing { transform: scaleX(1); }

        /* ── The verdict ──────────────────────────────────────────── */
        .xa-verdict {
          display: flex; align-items: center; justify-content: center;
          gap: 12px; flex-wrap: wrap;
          margin-top: 14px; text-align: center;
          opacity: 0; transform: translateY(4px);
          transition: opacity .4s ease .3s, transform .4s cubic-bezier(.16,1,.3,1) .3s;
        }
        .xa-verdict.on { opacity: 1; transform: none; }
        .xa-sev {
          font-size: 10px; font-weight: 600; letter-spacing: 0.12em;
          /* The amber surface takes graphite, not the amber text tone —
             --amber-ink on brand amber is 2.3:1 and unreadable. */
          color: var(--on-amber); background: var(--amber);
          padding: 5px 10px; border-radius: var(--r-xs);
          flex-shrink: 0;
        }
        .xa-verdict-text {
          font-size: 15px; color: var(--ink); font-weight: 500;
          line-height: 1.45; text-wrap: balance;
        }

        /* ── Stacked ──────────────────────────────────────────────── */
        @media (max-width: 900px) {
          .xa-grid { grid-template-columns: 1fr; }
          /* Stacked, the handoff runs downward instead of across. */
          .xa-link { padding: 22px 0; }
          .xa-rail { width: 70px; }
          .xa-bracket { display: none; }
          .xa-agent { padding: 32px 20px 28px; }
          .xa-avatar { width: 96px; height: 96px; }
        }

        @media (prefers-reduced-motion: reduce) {
          .xa-fly.go, .xa-fly.go .xa-payload, .xa-rail.flow { animation: none; }
          .xa-caption-text { animation: none; }
          .xa-agent, .xa-node, .xa-bot-mouth, .xa-verdict,
          .xa-stub, .xa-railing { transition: none !important; }
        }
      `}</style>
    </section>
  );
}
