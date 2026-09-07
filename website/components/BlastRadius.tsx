"use client";

import { Odometer } from "./motion/odometer";
import { useEffect, useState } from "react";
import { useArmed } from "@/lib/useArmed";
import { BorderTrail } from "./motion/border-trail";
import { RISK } from "@/lib/labels";

/* Blast radius: one score, and what it is made of.
 *
 * This started as a three-stage bench — weights, then a column of multipliers
 * (× 2.0, × 0.15, "normalise against 265"), then the score. All true, all
 * lifted from authority/graph.py, and all of it asking a CFO to read arithmetic
 * on a landing page. The middle column was the jargon, so the middle column is
 * gone. What is left reads at a glance: ten bars in order, one big number, and
 * a scale showing where this agent lands. The one rule worth saying out loud —
 * irreversible counts double — is a sentence under the number, not a table. */

const WEIGHTS = [
  { label: RISK.deletes_data.plain, w: 15 },
  { label: RISK.changes_access.plain, w: 14 },
  { label: RISK.executes_code.plain, w: 13 },
  { label: RISK.moves_money.plain, w: 12 },
  { label: RISK.changes_production.plain, w: 12 },
  { label: RISK.reads_secrets.plain, w: 10 },
  { label: RISK.evades_detection.plain, w: 10 },
  { label: RISK.bulk_export.plain, w: 9 },
  { label: RISK.touches_pii.plain, w: 8 },
  { label: RISK.sends_external.plain, w: 7 },
];

const W_MAX = 15;

/* low <40 · medium 40–59 · high 60–79 · critical ≥80 */
const BANDS = [
  { span: 40, name: "Low" },
  { span: 20, name: "Medium" },
  { span: 20, name: "High" },
  { span: 20, name: "Critical" },
];

const SCORE = 67;

export default function BlastRadius() {
  const [ref, armed] = useArmed<HTMLElement>(0.2);

  /* Two stages, because the section is an argument with an order to it: the
     weights land first, THEN the number appears. Firing both at once reads as
     two unrelated things animating; firing them in sequence reads as "add
     these up and you get that", which is the sentence above the panel. */
  const [totalled, setTotalled] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setTotalled(true), 1050);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <section
      ref={ref}
      style={{
        padding: "104px 0 112px",
        background: "var(--ground)",
        borderTop: "1px solid var(--rule)",
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 32px" }}>
        <div className="br-intro">
          <span className="eyebrow">Blast radius</span>
          <h2
            style={{
              fontSize: "clamp(28px, 3.3vw, 42px)",
              fontWeight: 600,
              letterSpacing: "-0.034em",
              color: "var(--ink)",
              lineHeight: 1.08,
              textWrap: "balance",
              maxWidth: 640,
              marginBottom: 18,
            }}
          >
            One score for how much damage an agent could do.
          </h2>
          <p style={{ fontSize: 17, color: "var(--muted)", lineHeight: 1.6, maxWidth: 520 }}>
            Every action carries a weight. Add them up, double anything you
            cannot undo, and you get a number out of 100.
          </p>
        </div>

        <div className="bench">
          <div className="bench-cell">
            <span className="mono bench-title">What each action is worth</span>

            <div className="wt-list">
              {WEIGHTS.map((w, i) => (
                <div key={w.label} className="wt-row">
                  <span className="wt-label">{w.label}</span>
                  <span className="wt-track">
                    <span
                      className="wt-bar"
                      style={{
                        width: armed ? `${(w.w / W_MAX) * 100}%` : 0,
                        transitionDelay: `${i * 55}ms`,
                      }}
                    />
                  </span>
                  <span className="mono num wt-val">{w.w}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bench-cell bench-score">
            {/* The scan runs while the weights are still being added up, and
                stops the moment the score lands. */}
            {armed && !totalled && (
              <BorderTrail
                size={90}
                transition={{ repeat: Infinity, duration: 2.4, ease: "linear" }}
                style={{
                  background:
                    "radial-gradient(circle at 50% 50%, rgba(17,24,39,0.3), rgba(17,24,39,0) 70%)",
                }}
              />
            )}
            <span className="mono bench-title">Beacon Support</span>

            <div className="sc-figure">
              <span className="num sc-num">
                <Odometer value={totalled ? SCORE : 0} />
              </span>
              <span className="sc-of">/ 100</span>
            </div>

            <span className={`mono sc-band${totalled ? " on" : ""}`}>HIGH</span>

            {/* Four zones because the engine has four bands, and only the top
                one gets the risk colour. */}
            <div className="sc-scale">
              <div className="sc-track">
                {BANDS.map((b) => (
                  <span
                    key={b.name}
                    className={`sc-zone${b.name === "Critical" ? " sc-zone-crit" : ""}`}
                    style={{ flex: b.span }}
                  />
                ))}
                <span
                  className="sc-marker"
                  style={{ left: totalled ? `${SCORE}%` : "0%" }}
                  aria-hidden="true"
                />
              </div>
              <div className="sc-ticks">
                {BANDS.map((b) => (
                  <span key={b.name} className="mono sc-tick" style={{ flex: b.span }}>
                    {b.name}
                  </span>
                ))}
              </div>
            </div>

            <p className="sc-note">
              Anything a delete or a payment touches counts double, because you
              cannot take it back. Above 60, an agent needs a policy before it
              ships.
            </p>
          </div>
        </div>
      </div>

      <style>{`
        .br-intro { margin-bottom: 48px; }

        /* Two panels, one instrument. */
        .bench {
          display: grid;
          grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
          background: var(--paper);
          border: 1px solid var(--rule);
          border-radius: var(--r-lg);
          box-shadow: var(--shadow-md);
          overflow: hidden;
        }
        .bench-cell { padding: 30px 34px 34px; min-width: 0; }
        .bench-score {
          position: relative;
          border-left: 1px solid var(--rule);
          background: var(--ground);
          display: flex; flex-direction: column;
        }
        .bench-title {
          display: block;
          font-size: 10px; font-weight: 500; letter-spacing: 0.14em;
          text-transform: uppercase; color: var(--muted-2);
          padding-bottom: 16px; margin-bottom: 22px;
          border-bottom: 1px solid var(--rule);
        }

        .wt-list { display: flex; flex-direction: column; gap: 10px; }
        .wt-row {
          display: grid;
          grid-template-columns: minmax(0, 148px) 1fr 20px;
          gap: 12px; align-items: center;
        }
        .wt-label {
          font-size: 13px; color: var(--muted);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .wt-track {
          height: 8px; background: var(--ground-2);
          border-radius: 999px; overflow: hidden;
        }
        .wt-bar {
          display: block; height: 100%; width: 0;
          background: var(--cost); border-radius: 999px;
          transition: width .85s cubic-bezier(.16,1,.3,1);
        }
        .wt-val { font-size: 11.5px; color: var(--ink); text-align: right; font-weight: 500; }

        .sc-figure { display: flex; align-items: baseline; gap: 9px; margin-bottom: 14px; }
        .sc-num {
          display: flex; font-size: 86px; font-weight: 600;
          color: var(--ink); line-height: 1; letter-spacing: -0.04em;
        }
        .sc-of { font-size: 16px; color: var(--muted-2); }

        .sc-band {
          align-self: flex-start;
          opacity: 0; transform: translateY(4px);
          transition: opacity .45s ease .25s, transform .45s cubic-bezier(.16,1,.3,1) .25s;
          font-size: 10px; font-weight: 600; letter-spacing: 0.12em;
          color: var(--risk); background: var(--label-money-fill);
          border: 1px solid var(--risk-critical-border);
          padding: 4px 10px; border-radius: var(--r-xs);
          margin-bottom: 32px;
        }
        .sc-band.on { opacity: 1; transform: none; }

        .sc-scale { margin-bottom: 24px; }
        .sc-track {
          position: relative; display: flex; gap: 2px;
          height: 9px; margin-bottom: 9px;
        }
        .sc-zone { background: var(--ground-3); border-radius: 2px; }
        .sc-zone-crit { background: var(--risk-soft); }
        .sc-marker {
          position: absolute; top: -4px;
          width: 3px; height: 17px; border-radius: 2px;
          background: var(--ink);
          box-shadow: 0 0 0 3px var(--ground);
          transform: translateX(-50%);
          transition: left 1.1s cubic-bezier(.16,1,.3,1) .2s;
        }
        .sc-ticks { display: flex; gap: 2px; }
        .sc-tick {
          font-size: 9px; color: var(--muted-2);
          letter-spacing: 0.07em; text-transform: uppercase;
        }

        .sc-note {
          font-size: 14px; color: var(--muted); line-height: 1.6;
          margin-top: auto; padding-top: 20px; border-top: 1px solid var(--rule);
        }

        @media (max-width: 860px) {
          .bench { grid-template-columns: 1fr; }
          .bench-score { border-left: none; border-top: 1px solid var(--rule); }
          .bench-cell { padding: 26px 24px 30px; }
          .sc-num { font-size: 68px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .wt-bar, .sc-marker { transition: none; }
        }
      `}</style>
    </section>
  );
}
