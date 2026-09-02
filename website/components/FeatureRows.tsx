"use client";

import { useEffect, useState } from "react";
import { useReveal } from "@/lib/useReveal";
import { useArmed } from "@/lib/useArmed";
import { RISK } from "@/lib/labels";
import { BorderTrail } from "./motion/border-trail";

/* Three features, three purpose-built surfaces.
 *
 * The first version of this section illustrated cost forecasting with a fake
 * terminal — green monospace on near-black, window chrome, three traffic-light
 * dots. That picture says "a developer tool made in 2024" and nothing about
 * Arceo; it also breaks the one colour rule this site keeps, which is that
 * saturated colour means risk.
 *
 * Every number on these surfaces is read out of the engine on dev, not
 * invented: the band multipliers are cost_defaults_operational.yaml's
 * confidence_bands, the sensitivity ranking is its sensitivity_ranking block,
 * and the matrix is LABEL_TRANSITIONS from authority/chain_detector.py, all 32
 * of them, with the same 19/13 critical/high split. */

/* ═══════════════════════════════════════════════════════════════
   1 · The confidence bands
   ═══════════════════════════════════════════════════════════════
   A cone widening into the future is the wrong picture — Arceo's uncertainty
   is not about the horizon, it is about how much evidence it has. Three tiers,
   three bands, each one narrower than the last, and every one of them
   asymmetric: a capability-only estimate under-predicts far more often than it
   over-predicts, so the band runs to 3× above and only half below. Drawing it
   symmetric would be flattering and wrong. */

const POINT = 20; // $/mo point estimate
const X_MAX = 66;

const TIERS = [
  {
    name: "LOW",
    lo: 0.5,
    hi: 3.0,
    need: "Just the agent's tools",
  },
  {
    name: "MEDIUM",
    lo: 0.7,
    hi: 2.0,
    need: "+ a sandbox run",
  },
  {
    name: "HIGH",
    lo: 0.85,
    hi: 1.15,
    need: "+ a week of real traffic",
  },
];

const pct = (v: number) => `${(v / X_MAX) * 100}%`;

function ConfidenceBands() {
  const [ref, armed] = useArmed<HTMLDivElement>(0.4);

  /* Evidence does not arrive all at once in real life and it should not here.
     Each tier wakes in turn, so you watch the band close rather than being
     handed three finished bars. */
  const [tier, setTier] = useState(-1);
  useEffect(() => {
    if (!armed) return;
    const timers = [0, 1, 2].map((i) => setTimeout(() => setTier(i), 120 + i * 620));
    return () => timers.forEach(clearTimeout);
  }, [armed]);

  return (
    <div ref={ref} className="surface" style={{ padding: "20px 22px 22px" }}>
      <div className="surface-head">
        <span className="surface-title">How the range tightens</span>
        <span className="mono surface-meta">BEACON SUPPORT</span>
      </div>

      <div className="cb-plot">
        {/* The point estimate is marked once at the top and repeated inside
            each track, rather than drawn as one full-height rule — a rule
            spanning the whole plot struck through every tier's caption. */}
        <div className="cb-head-scale">
          <span className="mono cb-point-tag" style={{ left: pct(POINT) }}>
            ${POINT}/mo estimate
          </span>
        </div>

        {TIERS.map((t, i) => {
          const lo = POINT * t.lo;
          const hi = POINT * t.hi;
          return (
            <div key={t.name} className={`cb-row${i <= tier ? " lit" : ""}`}>
              <div className="cb-meta">
                <span className="mono cb-tier">{t.name}</span>
                <span className="cb-need">{t.need}</span>
                <span className="cb-got" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2.5 6.2l2.4 2.4L9.5 4"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </div>

              <div className="cb-track">
                <span className="cb-point" style={{ left: pct(POINT) }} aria-hidden="true" />
                <span
                  className={`cb-band${i <= tier ? " in" : ""}`}
                  style={{
                    left: pct(lo),
                    width: pct(hi - lo),
                    /* Grows out of the point estimate, because that is what
                       uncertainty does — it spreads from the number. */
                    transformOrigin: `${((POINT - lo) / (hi - lo)) * 100}% 50%`,

                  }}
                />
                <span className="mono cb-lo" style={{ left: pct(lo) }}>
                  ${Math.round(lo)}
                </span>
                <span className="mono cb-hi" style={{ left: pct(hi) }}>
                  ${Math.round(hi)}
                </span>
              </div>

            </div>
          );
        })}

        <div className="cb-axis">
          {[0, 20, 40, 60].map((v) => (
            <span key={v} className="mono cb-tickmark" style={{ left: pct(v) }}>
              ${v}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   2 · What actually moves the bill
   ═══════════════════════════════════════════════════════════════
   Straight out of the engine's sensitivity_ranking. One hue, ordered by
   magnitude — a sequential ramp, not five decorative colours. */

const SENSITIVITY = [
  { label: "Calls per day", pct: 76 },
  { label: "Model choice", pct: 42 },
  { label: "Cache hit rate", pct: 23 },
  { label: "Runtime per call", pct: 18 },
  { label: "Retry rate", pct: 10 },
];

function Sensitivity() {
  const [ref, armed] = useArmed<HTMLDivElement>(0.4);

  return (
    <div ref={ref} className="surface" style={{ padding: "20px 22px 22px" }}>
      <div className="surface-head">
        <span className="surface-title">What moves the monthly number</span>
        <span className="mono surface-meta">RANKED BY IMPACT</span>
      </div>

      <div className="sn-list">
        {SENSITIVITY.map((s, i) => (
          <div key={s.label} className={`sn-row${i === 0 ? " top" : ""}`}>
            <span className="sn-label">
              <span className="sn-label-text">{s.label}</span>
              {i === 0 && <span className="sn-flag">biggest lever</span>}
            </span>
            <span className="sn-track">
              <span
                className="sn-bar"
                style={{
                  width: armed ? `${s.pct}%` : 0,
                  /* One hue, stepped by rank: the ramp encodes the ordering
                     instead of five unrelated colours pretending to. */
                  opacity: 1 - i * 0.15,
                  transitionDelay: `${i * 70}ms`,
                }}
              />
            </span>
            <span className="mono num sn-val">{s.pct}%</span>
          </div>
        ))}
      </div>

      <p className="sn-foot">
        Call volume swamps everything else. Cap it and you have capped the
        bill.
      </p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   3 · The transition matrix
   ═══════════════════════════════════════════════════════════════
   Every rule in the detector is a transition from one risk label to another,
   so the honest picture of "32 rules" is the 10 × 10 grid of every label pair
   with those 32 cells marked. You can count them. */

/* The grid keys stay the engine's short names — the rule tables below are
   written against them — but nothing on screen shows a key. Every axis label
   is the plain-English name from lib/labels.ts, because a reader should not
   need a glossary to count red squares. */
const LABELS = [
  "money", "pii", "delete", "external", "prod",
  "access", "secrets", "evade", "export", "code",
] as const;

const SHORT: Record<(typeof LABELS)[number], string> = {
  money: RISK.moves_money.short,
  pii: RISK.touches_pii.short,
  delete: RISK.deletes_data.short,
  external: RISK.sends_external.short,
  prod: RISK.changes_production.short,
  access: RISK.changes_access.short,
  secrets: RISK.reads_secrets.short,
  evade: RISK.evades_detection.short,
  export: RISK.bulk_export.short,
  code: RISK.executes_code.short,
};
const CRITICAL: [string, string][] = [
  ["pii", "external"], ["pii", "money"], ["pii", "delete"],
  ["money", "money"], ["money", "delete"], ["money", "evade"],
  ["prod", "delete"],
  ["delete", "delete"], ["delete", "evade"],
  ["access", "money"], ["access", "delete"],
  ["secrets", "external"], ["secrets", "access"], ["secrets", "money"],
  ["evade", "delete"], ["evade", "external"],
  ["export", "external"], ["export", "delete"],
  ["code", "external"],
];

const HIGH: [string, string][] = [
  ["pii", "prod"], ["pii", "export"],
  ["money", "external"],
  ["prod", "prod"], ["prod", "external"], ["prod", "evade"],
  ["delete", "external"],
  ["external", "money"], ["external", "prod"],
  ["access", "prod"], ["access", "external"], ["access", "evade"],
  ["secrets", "prod"],
];

const RULES = new Map<string, "critical" | "high">();
CRITICAL.forEach(([f, t]) => RULES.set(`${f}|${t}`, "critical"));
HIGH.forEach(([f, t]) => RULES.set(`${f}|${t}`, "high"));


function TransitionMatrix() {
  const [ref, armed] = useArmed<HTMLDivElement>(0.25);

  return (
    <div ref={ref} className="surface tm-surface">
      {/* The scan runs twice when the matrix is reached, then stops. A light
          that circles forever is decoration; this one is the sweep. */}
      {armed && (
        <BorderTrail
          size={120}
          transition={{ repeat: 2, duration: 2.8, ease: "linear" }}
          style={{
            background:
              "radial-gradient(circle at 50% 50%, rgba(220,38,38,0.42), rgba(220,38,38,0) 70%)",
          }}
        />
      )}

      <div className="tm-grid">
        <div style={{ minWidth: 0 }}>
          <div className="surface-head" style={{ marginBottom: 20 }}>
            <span className="surface-title">Every pair of actions</span>
            <span className="mono surface-meta">32 OF 100 PAIRS FLAGGED</span>
          </div>

          <div className="tm-plot">
            <div className="tm-corner">first ↓ / then →</div>
            {LABELS.map((l) => (
              <div key={`c-${l}`} className="tm-colhead">
                {SHORT[l]}
              </div>
            ))}

            {LABELS.map((from, r) => (
              <div key={from} style={{ display: "contents" }}>
                <div className="tm-rowhead">{SHORT[from]}</div>
                {LABELS.map((to, c) => {
                  const kind = RULES.get(`${from}|${to}`);
                  const id = `${from}|${to}`;
                  return (
                    <div
                      key={id}
                      className={`tm-cell${kind ? ` tm-${kind}` : ""}${armed ? " in" : ""}`}
                      style={{ "--i": r + c } as React.CSSProperties}
                      title={kind ? `${SHORT[from]} → ${SHORT[to]}` : undefined}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="tm-side">
          <div className="tm-key">
            <span className="tm-key-item">
              <span className="tm-swatch tm-critical" />
              <span>
                Critical <span className="mono num">19</span>
              </span>
            </span>
            <span className="tm-key-item">
              <span className="tm-swatch tm-high" />
              <span>
                High <span className="mono num">13</span>
              </span>
            </span>
            <span className="tm-key-item">
              <span className="tm-swatch" />
              <span>
                Not flagged <span className="mono num">68</span>
              </span>
            </span>
          </div>

          <p className="tm-note">
            Each red cell is a sequence that has already gone wrong at a real
            company. Read a record then email it out, and you have the shape of
            the Copilot data leak.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */

const FEATURES = [
  {
    headline: "The forecast tells you how much to trust it",
    body: "Day one you get a number and a wide range. Watch a week of real traffic and the range closes to ±15%. Arceo never claims more confidence than it has earned.",
    surface: <ConfidenceBands />,
  },
  {
    headline: "Know which lever actually moves the bill",
    body: "Arceo nudges each input and ranks what moves. It is almost always call volume, by a distance — so a cap on calls is the control that holds a budget, and switching model is the one that does not.",
    surface: <Sensitivity />,
  },
  {
    headline: "Catch the risks that only show up in sequence",
    body: "Reading a customer record is fine. Sending an email is fine. Doing both in a row is a data leak. Arceo watches for 32 of these pairs across 10 kinds of risk.",
    surface: <TransitionMatrix />,
    wide: true,
  },
];

function FeatureRow({ f, index }: { f: (typeof FEATURES)[0]; index: number }) {
  const even = index % 2 === 0;

  const copy = (
    <>
      <h3
        style={{
          fontSize: "clamp(24px, 2.6vw, 32px)",
          fontWeight: 600,
          letterSpacing: "-0.03em",
          color: "var(--ink)",
          marginBottom: 14,
          lineHeight: 1.15,
          textWrap: "balance",
        }}
      >
        {f.headline}
      </h3>
      <p style={{ fontSize: 16.5, color: "var(--muted)", lineHeight: 1.65, maxWidth: "62ch" }}>
        {f.body}
      </p>
    </>
  );

  /* Final beat: full-width stack, so the section does not read as three
     identical rows. */
  if (f.wide) {
    return (
      <div className="feature-row rise" style={{ "--i": index, padding: "56px 0 8px" } as React.CSSProperties}>
        <div style={{ maxWidth: 720, marginBottom: 36 }}>{copy}</div>
        <div>{f.surface}</div>
      </div>
    );
  }

  return (
    <div
      className="feature-row rise"
      style={
        {
          "--i": index,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 72,
          alignItems: "center",
          padding: "56px 0",
          borderBottom: "1px solid var(--rule)",
        } as React.CSSProperties
      }
    >
      <div style={{ order: even ? 0 : 1, minWidth: 0 }}>{copy}</div>
      <div style={{ order: even ? 1 : 0, minWidth: 0 }}>{f.surface}</div>
    </div>
  );
}

export default function FeatureRows() {
  const ref = useReveal<HTMLElement>(0.08);

  return (
    <section
      ref={ref}
      id="features"
      style={{ padding: "88px 0 96px", background: "var(--paper)", borderTop: "1px solid var(--rule)" }}
    >
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 32px" }}>
        <div style={{ marginBottom: 12 }}>
          <span className="eyebrow">What you get</span>
          <h2
            style={{
              fontSize: "clamp(28px, 3.4vw, 42px)",
              fontWeight: 600,
              letterSpacing: "-0.033em",
              color: "var(--ink)",
              maxWidth: 640,
              textWrap: "balance",
            }}
          >
            Cost and risk, in one report your CFO will sign.
          </h2>
        </div>

        {FEATURES.map((f, i) => (
          <FeatureRow key={f.headline} f={f} index={i} />
        ))}
      </div>

      <style>{`
        /* One surface treatment, used by all three. */
        .surface {
          position: relative;
          background: var(--paper);
          border: 1px solid var(--rule);
          border-radius: var(--r-md);
          box-shadow: var(--shadow-sm);
          overflow: hidden;
        }
        .surface-head {
          display: flex; align-items: baseline; justify-content: space-between;
          gap: 12px; margin-bottom: 16px;
          padding-bottom: 12px; border-bottom: 1px solid var(--rule);
        }
        .surface-title { font-size: 13px; font-weight: 600; color: var(--ink); }
        .surface-meta {
          font-size: 9.5px; color: var(--muted-2);
          letter-spacing: 0.1em; white-space: nowrap;
        }

        /* ── Confidence bands ──────────────────────────────────── */
        .cb-plot { position: relative; }
        .cb-head-scale { position: relative; height: 18px; }
        .cb-point-tag {
          position: absolute; top: 0;
          font-size: 9.5px; font-weight: 500; color: var(--ink);
          white-space: nowrap; padding-left: 6px;
          border-left: 1px solid var(--ink);
        }
        /* Inside each track only, so the estimate never crosses a caption. */
        .cb-point {
          position: absolute; top: 0; bottom: 0; width: 1px;
          background: var(--ink); opacity: .35; z-index: 2;
        }
        .cb-row {
          padding: 14px 0; border-bottom: 1px solid var(--rule-light);
          opacity: .38; transition: opacity .45s ease;
        }
        .cb-row.lit { opacity: 1; }
        .cb-got {
          display: inline-flex; margin-left: auto;
          color: var(--risk-clear);
          opacity: 0; transform: scale(.6);
          transition: opacity .35s ease .25s, transform .35s cubic-bezier(.16,1,.3,1) .25s;
        }
        .cb-row.lit .cb-got { opacity: 1; transform: none; }
        .cb-row:last-of-type { border-bottom: none; }
        .cb-meta {
          display: flex; align-items: center; gap: 10px; margin-bottom: 9px;
        }
        .cb-tier {
          font-size: 9.5px; font-weight: 600; letter-spacing: 0.12em;
          color: var(--ink);
          background: var(--ground-2); border: 1px solid var(--rule);
          padding: 2px 7px; border-radius: var(--r-xs);
        }
        .cb-need { font-size: 12px; color: var(--muted); }
        .cb-track { position: relative; height: 22px; }
        .cb-band {
          position: absolute; top: 5px; height: 10px;
          background: var(--cost-wash);
          border-left: 2px solid var(--cost);
          border-right: 2px solid var(--cost);
          border-radius: 2px;
          transform: scaleX(0);
          transition: transform .85s cubic-bezier(.16,1,.3,1);
        }
        .cb-band.in { transform: scaleX(1); }
        .cb-lo, .cb-hi {
          position: absolute; top: 19px;
          font-size: 9.5px; color: var(--muted-2); white-space: nowrap;
        }
        .cb-lo { transform: translateX(-100%); padding-right: 5px; }
        .cb-hi { padding-left: 5px; }
        .cb-axis { position: relative; height: 16px; margin-top: 6px; }
        .cb-tickmark {
          position: absolute; top: 0; font-size: 9px; color: var(--disabled);
          transform: translateX(-50%);
        }

        /* ── Sensitivity ───────────────────────────────────────── */
        .sn-list { display: flex; flex-direction: column; gap: 12px; }
        .sn-row {
          display: grid; grid-template-columns: minmax(0, 132px) 1fr 34px;
          gap: 12px; align-items: center;
        }
        /* The flag sits UNDER the label, not beside it — inline it squeezed
           "Calls per day" into two lines and broke the phrase. */
        .sn-label {
          font-size: 13px; color: var(--muted);
          display: flex; flex-direction: column; align-items: flex-start; gap: 5px;
        }
        .sn-label-text { white-space: nowrap; }
        .sn-row.top .sn-label { color: var(--ink); font-weight: 500; }
        .sn-flag {
          font-family: var(--font-mono), monospace;
          font-size: 8.5px; font-weight: 500; letter-spacing: 0.08em;
          text-transform: uppercase; color: var(--muted-2);
          border: 1px solid var(--rule); border-radius: var(--r-xs);
          padding: 2px 6px; white-space: nowrap;
        }
        .sn-track {
          height: 9px; background: var(--ground-2);
          border-radius: 999px; overflow: hidden;
        }
        .sn-bar {
          display: block; height: 100%; width: 0;
          background: var(--cost); border-radius: 999px;
          transition: width .9s cubic-bezier(.16,1,.3,1);
        }
        .sn-val { font-size: 11.5px; color: var(--ink); text-align: right; font-weight: 500; }
        .sn-foot {
          font-size: 12.5px; color: var(--muted); line-height: 1.6;
          margin-top: 18px; padding-top: 15px; border-top: 1px solid var(--rule);
        }

        /* ── Transition matrix ─────────────────────────────────── */
        .tm-surface { padding: 22px 26px 26px; }
        /* Bounded, and centred as a pair. Left to fill a 1fr column the cells
           blow out to nearly 60px each and the matrix eats a whole screen —
           a 10 × 10 grid wants to be read at a glance, not scrolled. */
        .tm-grid {
          display: grid;
          grid-template-columns: minmax(0, 510px) minmax(0, 330px);
          gap: 64px;
          justify-content: center;
          align-items: start;
        }
        .tm-plot {
          display: grid;
          grid-template-columns: 86px repeat(10, minmax(0, 1fr));
          gap: 3px;
          align-items: center;
        }
        .tm-corner {
          font-size: 9px; color: var(--muted-2); letter-spacing: 0.01em;
          text-align: right; padding-right: 6px; white-space: nowrap;
          align-self: end; padding-bottom: 4px;
        }
        .tm-colhead {
          font-size: 9.5px; color: var(--muted-2);
          writing-mode: vertical-rl; transform: rotate(180deg);
          height: 78px; justify-self: center; letter-spacing: 0.01em;
        }
        .tm-rowhead {
          font-size: 11px; color: var(--muted);
          text-align: right; padding-right: 9px; white-space: nowrap;
        }
        .tm-cell {
          aspect-ratio: 1; border-radius: 2px;
          background: var(--ground-2);
          opacity: 0; transform: scale(.7);
          transition:
            opacity .4s ease,
            transform .4s cubic-bezier(.16,1,.3,1),
            box-shadow .15s ease;
          transition-delay: calc(var(--i, 0) * 32ms);
        }
        .tm-cell.in { opacity: 1; transform: scale(1); }
        .tm-cell.tm-high { background: var(--cost); opacity: 0; }
        .tm-cell.tm-high.in { opacity: .72; }
        .tm-cell.tm-critical { background: var(--risk); opacity: 0; }
        .tm-cell.tm-critical.in { opacity: 1; }
        .tm-cell.tm-high, .tm-cell.tm-critical { cursor: pointer; }

        .tm-side { padding-top: 2px; }
        .tm-key { display: flex; flex-direction: column; gap: 10px; margin-bottom: 22px; }
        .tm-key-item {
          display: flex; align-items: center; gap: 10px;
          font-size: 12.5px; color: var(--muted);
        }
        .tm-key-item .num { color: var(--ink); font-weight: 500; }
        .tm-swatch {
          width: 11px; height: 11px; border-radius: 2px;
          background: var(--ground-2); flex-shrink: 0;
        }
        .tm-swatch.tm-critical { background: var(--risk); }
        .tm-swatch.tm-high { background: var(--cost); opacity: .72; }
        .tm-note {
          font-size: 13px; color: var(--muted); line-height: 1.6;
          padding-top: 20px; border-top: 1px solid var(--rule);
        }

        @media (max-width: 940px) {
          .feature-row { grid-template-columns: 1fr !important; gap: 32px !important; }
          .feature-row > div { order: unset !important; }
          .tm-grid { grid-template-columns: 1fr !important; gap: 32px !important; }
          .tm-plot { grid-template-columns: 74px repeat(10, minmax(0, 1fr)); }
          .tm-colhead { height: 70px; font-size: 8.5px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .cb-band, .sn-bar, .tm-cell, .cb-row, .cb-got { transition: none !important; }
          .cb-row { opacity: 1; }
          .cb-band { transform: scaleX(1); }
          .tm-cell { opacity: 1; transform: none; }
          .tm-cell.tm-high { opacity: .72; }
          .tm-cell.tm-critical { opacity: 1; }
        }
      `}</style>
    </section>
  );
}
