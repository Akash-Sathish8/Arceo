"use client";

import { useEffect, useState } from "react";
import AuthorityGraph from "./AuthorityGraph";
import { useReveal } from "@/lib/useReveal";
import { useArmed } from "@/lib/useArmed";

/* The dark act.
 *
 * One committed dark chapter in the middle of a light page, not a stray dark
 * band. It carries its own full token set (.act-dark), runs full bleed, and is
 * where the authority graph stops being wallpaper and becomes the subject —
 * labelled, full size, with three calls in flight instead of two.
 *
 * The steps are a timeline on a rule, not three more cards. The rule draws
 * itself when the act is reached, left to right, and ends in red: the process
 * runs from "connect an agent" to "here is the number somebody has to sign",
 * and the colour arrives exactly where the risk figure does. */

const STEPS = [
  {
    n: "01",
    title: "Connect any agent",
    body: "Point Arceo at an agent built on the Anthropic SDK, OpenAI, an MCP server, or a public GitHub repo. It reads only. No code changes, nothing leaves your stack.",
  },
  {
    n: "02",
    title: "Map what it can reach",
    body: "Arceo lists every tool the agent can call, sorts each by risk, and works out the monthly cost from the model, the call volume, and real traces.",
  },
  {
    n: "03",
    title: "Hand the CFO one number",
    body: "A monthly cost with a confidence range, a blast-radius score out of 100, and every dangerous chain the agent can run — including the ones that cross between agents.",
  },
];

export default function HowItWorks() {
  const ref = useReveal<HTMLElement>(0.1);
  const [railRef, drawn] = useArmed<HTMLDivElement>(0.4);

  /* The rule takes 1.25s to cross. Rather than lighting all three markers
     with it, each one wakes as the line reaches it — so the timeline reads
     left to right the way the process actually runs. */
  const [reached, setReached] = useState(-1);
  useEffect(() => {
    if (!drawn) return;
    const timers = [0, 1, 2].map((i) =>
      setTimeout(() => setReached(i), 260 + i * 400),
    );
    return () => timers.forEach(clearTimeout);
  }, [drawn]);

  return (
    <section
      ref={ref}
      className="act-dark ruled-dark"
      style={{ position: "relative", overflow: "hidden", padding: "108px 0 116px" }}
    >
      <div className="wash-dark" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />

      {/* The graph as subject: unmasked, labelled, filling the act. */}
      <div style={{ position: "absolute", inset: 0, opacity: 0.5, pointerEvents: "none" }}>
        <AuthorityGraph tone="dark" mask={false} packets={3} variant="subject" />
      </div>

      <div style={{ position: "relative", zIndex: 2, maxWidth: 1240, margin: "0 auto", padding: "0 32px" }}>
        <div style={{ maxWidth: 640, marginBottom: 76 }}>
          <span className="eyebrow rise" style={{ "--i": 0 } as React.CSSProperties}>
            How it works
          </span>
          <h2
            className="rise"
            style={
              {
                "--i": 1,
                fontSize: "clamp(30px, 3.6vw, 46px)",
                fontWeight: 600,
                letterSpacing: "-0.034em",
                lineHeight: 1.08,
                textWrap: "balance",
              } as React.CSSProperties
            }
          >
            From connected agent to a signed-off number, in minutes.
          </h2>
        </div>

        {/* Timeline. The rule runs behind the markers and ties the three beats
            into one movement instead of three separate boxes. */}
        <div className="tl" ref={railRef}>
          <div className="tl-rail" aria-hidden="true">
            <span className="tl-rule" style={{ transform: drawn ? "scaleX(1)" : "scaleX(0)" }} />
          </div>

          {STEPS.map((s, i) => (
            <div
              key={s.n}
              className={`tl-step rise${i <= reached ? " lit" : ""}`}
              style={{ "--i": i + 2 } as React.CSSProperties}
            >
              <div className="tl-marker">
                <span className="tl-dot" />
                <span className="mono tl-n">{s.n}</span>
              </div>
              <h3 className="tl-title">{s.title}</h3>
              <p className="tl-body">{s.body}</p>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .tl {
          position: relative;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 56px;
        }

        .tl-rail {
          position: absolute;
          top: 5px; left: 0; right: 0; height: 1px;
          overflow: hidden;
        }
        .tl-rule {
          display: block; height: 100%; width: 100%;
          transform-origin: left;
          transition: transform 1.25s cubic-bezier(.22,1,.36,1) .1s;
          background: linear-gradient(
            to right,
            rgba(255,255,255,0.24) 0%,
            rgba(255,255,255,0.24) 62%,
            rgba(220,38,38,0.75) 100%
          );
        }

        .tl-marker { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
        .tl-dot {
          width: 11px; height: 11px; border-radius: 50%;
          background: #0E131C;
          box-shadow: inset 0 0 0 2px rgba(255,255,255,0.28);
          flex-shrink: 0;
          transition: box-shadow .45s ease, transform .45s cubic-bezier(.16,1,.3,1);
        }
        /* Reached: the marker fills and takes a ring, the way a station on a
           line lights as the train passes it. */
        .tl-step.lit .tl-dot {
          box-shadow: inset 0 0 0 3px rgba(255,255,255,0.85), 0 0 0 4px rgba(255,255,255,0.07);
          transform: scale(1.1);
        }
        /* The last beat is the one that produces the risk number, so its
           marker carries the money red. */
        .tl-step:last-child .tl-dot { box-shadow: inset 0 0 0 2px rgba(220,38,38,0.4); }
        .tl-step:last-child.lit .tl-dot {
          box-shadow: inset 0 0 0 3px #dc2626, 0 0 0 4px rgba(220,38,38,0.15);
        }

        .tl-n, .tl-title { transition: color .45s ease; }
        .tl-step:not(.lit) .tl-title { color: var(--muted); }
        .tl-step.lit .tl-n { color: var(--ink); }

        .tl-n {
          font-size: 11px; font-weight: 500; letter-spacing: 0.18em;
          color: var(--muted-2);
        }

        .tl-title {
          font-size: 19px; font-weight: 600; letter-spacing: -0.016em;
          margin-bottom: 12px;
        }
        .tl-body {
          font-size: 14.5px; line-height: 1.62; color: var(--muted);
          max-width: 42ch;
        }

        @media (max-width: 900px) {
          .tl { grid-template-columns: 1fr; gap: 40px; }
          .tl-rail { display: none; }
          .tl-step { border-top: 1px solid var(--rule); padding-top: 26px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .tl-rule { transition: none; transform: scaleX(1) !important; }
          .tl-dot, .tl-n, .tl-title { transition: none; }
        }
      `}</style>
    </section>
  );
}
