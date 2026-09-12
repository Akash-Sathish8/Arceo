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

const POINT = 2840; // $/mo point estimate — matches the hero card's figure
const X_MAX = 9000;

/* Band ends compress to k-notation so the captions stay short. */
const fmt = (v: number) =>
  v >= 1000 ? `$${(v / 1000).toFixed(1).replace(/\.0$/, "")}k` : `$${Math.round(v)}`;

/* Three stages of ONE agent's forecast, not three agents. The multipliers are
   cost_defaults_operational.yaml's confidence_bands and they are NOT adjusted
   for the website: LOW is x0.50-x3.00, MEDIUM x0.70-x2.00, HIGH x0.85-x1.15.
   They are asymmetric on purpose, because a capability-only estimate
   under-predicts far more often than it over-predicts. A symmetric MEDIUM was
   tried and retired in July 2026 — it held on 3 of 8 hand-checked agents.

   What this panel leads with is the CEILING, not the spread, and that is the
   difference between the graphic reading as an admission and reading as the
   product. A CFO approving a launch does not need a tight point estimate; they
   need a worst case they can put in a budget and defend afterwards. Arceo has
   one on day one, before a single call has run, and it drops from $60 to $23
   as evidence arrives. That fall is the story — the band closing underneath it
   is the evidence for it.

   The colour carries the same arc: amber is the brand's "attention —
   uncertainty" tone, aquamarine its "controlled — bounded outcome" tone. */
const STAGES = [
  {
    name: "LOW",
    lo: 0.5,
    hi: 3.0,
    evidence: "Day one",
    headline: "A ceiling you can budget against, before it runs",
    detail:
      "Nothing has executed yet, so the range is wide — but the worst case is already a real number, not a guess.",
    tone: "amber",
  },
  {
    name: "MEDIUM",
    lo: 0.7,
    hi: 2.0,
    evidence: "After a sandbox run",
    headline: "A sandbox run cuts the worst case by a third",
    detail:
      "Real calls and real token counts, still before you deploy. This is the number most launch decisions get made on.",
    tone: "blue",
  },
  {
    name: "HIGH",
    lo: 0.85,
    hi: 1.15,
    evidence: "After a week of live traffic",
    headline: "A week of live traffic closes it to \u00b115%",
    detail:
      "Now the ceiling and the estimate are almost the same number. This is the figure your finance team signs.",
    tone: "aqua",
  },
];

const pct = (v: number) => `${(v / X_MAX) * 100}%`;

/* How long each stage holds before the band tightens again. The last one
   holds longest so the finished range can actually be read. */
const HOLD = [2600, 2600, 4200];

function ConfidenceBands() {
  const [ref, armed] = useArmed<HTMLDivElement>(0.4);

  /* One band, three stages, on a loop. The previous version handed the reader
     three finished bars stacked up and asked them to compare widths; watching
     a single band close is the same information without the comparison. */
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (!armed) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setStage(STAGES.length - 1);
      return;
    }
    const id = setTimeout(
      () => setStage((v) => (v + 1) % STAGES.length),
      HOLD[stage],
    );
    return () => clearTimeout(id);
  }, [armed, stage]);

  const st = STAGES[stage];
  const lo = POINT * st.lo;
  const hi = POINT * st.hi;

  return (
    <div ref={ref} className="surface" style={{ padding: "20px 22px 24px" }}>
      <div className="surface-head">
        <span className="surface-title">How the range tightens</span>
        <span className="mono surface-meta">BEACON SUPPORT</span>
      </div>

      {/* Where we are, in words, at the size of a sentence someone reads
          rather than a caption they skip. */}
      <div className="fb-steps" role="list">
        {STAGES.map((t, i) => (
          <span
            key={t.name}
            role="listitem"
            className={`fb-step${i === stage ? " on" : ""}${i < stage ? " done" : ""}`}
          >
            <span className="fb-step-dot" aria-hidden="true" />
            {t.evidence}
          </span>
        ))}
      </div>

      <p className="fb-headline" key={`h-${stage}`}>
        {st.headline}
      </p>
      <p className="fb-detail" key={`d-${stage}`}>
        {st.detail}
      </p>

      {/* The ceiling is the figure a CFO actually acts on, so it is the one
          set at display size. $60 -> $40 -> $23 as the evidence lands. */}
      <div className={`fb-readout fb-${st.tone}`}>
        <span className="fb-ceiling">
          <span className="fb-ceiling-lead">Budget for</span>
          <span className="num fb-ceiling-n">{fmt(hi)}</span>
          <span className="fb-ceiling-unit">/mo</span>
        </span>
        <span className="fb-readout-meta">
          <span className="mono fb-conf">{st.name} CONFIDENCE</span>
          <span className="num fb-range">
            range {fmt(lo)}&ndash;{fmt(hi)}
          </span>
        </span>
      </div>

      <div className={`fb-plot fb-${st.tone}`}>
        <div className="fb-track">
          <span className="fb-point" style={{ left: pct(POINT) }} aria-hidden="true" />
          {/* One element. `left` and `width` are transitioned, so the band
              physically closes in on the estimate instead of being redrawn. */}
          <span
            className="fb-band"
            style={{ left: pct(lo), width: pct(hi - lo) }}
          />
          <span className="mono fb-point-tag" style={{ left: pct(POINT) }}>
            ${POINT.toLocaleString("en-US")}/mo estimate
          </span>
        </div>

        <div className="fb-axis">
          {[0, 3000, 6000, 9000].map((v) => (
            <span key={v} className="mono fb-tickmark" style={{ left: pct(v) }}>
              {v === 0 ? "$0" : `$${v / 1000}k`}
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
              "radial-gradient(circle at 50% 50%, rgba(245,158,11,0.48), rgba(245,158,11,0) 70%)",
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
    body: "Day one you get a number and a wide range. Watch a week of real traffic and the range closes to ±15%.",
    surface: <ConfidenceBands />,
  },
  {
    headline: "Know which lever actually moves the bill",
    body: "Arceo nudges each input and ranks what moves. Call volume wins by a distance; a daily call cap is the control that holds a budget.",
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
      style={{ padding: "88px 0 96px", background: "var(--ground)", borderTop: "1px solid var(--rule)" }}
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
        /* No border, no shadow. On the paper section a surface is a tinted
           well; the product separates planes by tone, never by a hairline. */
        .surface {
          position: relative;
          background: var(--paper);
          border: none;
          border-radius: var(--r-md);
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

        /* ── The forecast band ─────────────────────────────────────
           One agent, one band, three stages. Amber (uncertainty) closes to
           aquamarine (a bounded outcome) as the evidence arrives — the hue
           and the width tell the same story, so neither has to be read
           alone. Type is deliberately at reading size, not caption size:
           this panel has to be understood by someone who has never seen
           the product. */
        .fb-steps {
          display: flex; flex-wrap: wrap; gap: 6px;
          margin: 4px 0 16px;
        }
        .fb-step {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 11.5px; font-weight: 500;
          color: var(--muted-2);
          background: var(--ground-2);
          padding: 5px 10px; border-radius: var(--r-xs);
          transition: color .35s ease, background .35s ease;
        }
        .fb-step-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--disabled); flex-shrink: 0;
          transition: background .35s ease;
        }
        .fb-step.done { color: var(--aqua-deep); background: var(--aqua-soft); }
        .fb-step.done .fb-step-dot { background: var(--aqua-ink); }
        .fb-step.on {
          color: var(--brand); background: var(--brand-soft); font-weight: 600;
        }
        .fb-step.on .fb-step-dot { background: var(--brand); }

        .fb-headline {
          font-size: 19px; font-weight: 600; line-height: 1.3;
          color: var(--ink); letter-spacing: -0.015em;
          margin-bottom: 6px; text-wrap: balance;
          animation: fb-in .4s cubic-bezier(.16,1,.3,1);
        }
        .fb-detail {
          font-size: 14.5px; line-height: 1.5; color: var(--muted);
          margin-bottom: 20px; max-width: 46ch;
          animation: fb-in .4s cubic-bezier(.16,1,.3,1) 40ms backwards;
        }
        @keyframes fb-in {
          from { opacity: 0; transform: translateY(5px); }
          to   { opacity: 1; transform: none; }
        }

        .fb-readout {
          display: flex; align-items: flex-end; gap: 16px;
          flex-wrap: wrap; margin-bottom: 20px;
        }
        .fb-ceiling { display: flex; align-items: baseline; gap: 7px; }
        .fb-ceiling-lead {
          font-size: 14px; font-weight: 500; color: var(--muted);
        }
        .fb-ceiling-n {
          font-size: 40px; font-weight: 600; letter-spacing: -0.035em;
          line-height: 1; color: var(--fb-ink);
          transition: color .5s ease;
        }
        .fb-ceiling-unit {
          font-size: 15px; font-weight: 500; color: var(--muted-2);
        }
        .fb-readout-meta {
          display: flex; flex-direction: column; gap: 5px; padding-bottom: 3px;
        }
        .fb-conf {
          font-size: 10px; font-weight: 600; letter-spacing: 0.12em;
          color: var(--fb-ink); background: var(--fb-soft);
          padding: 4px 9px; border-radius: var(--r-xs);
          align-self: flex-start;
          transition: color .5s ease, background .5s ease;
        }
        .fb-range {
          font-size: 12.5px; color: var(--muted-2);
          font-variant-numeric: tabular-nums;
        }

        /* The three tones. Set on the wrapper so the readout and the band
           always move together. */
        .fb-amber { --fb-ink: var(--amber-ink); --fb-fill: var(--amber);    --fb-soft: var(--amber-soft); }
        .fb-blue  { --fb-ink: var(--brand);     --fb-fill: var(--brand);    --fb-soft: var(--brand-soft); }
        .fb-aqua  { --fb-ink: var(--aqua-deep); --fb-fill: var(--aqua-ink); --fb-soft: var(--aqua-soft); }

        .fb-plot { position: relative; margin-top: 24px; }
        .fb-track {
          position: relative; height: 46px;
          background: var(--ground-2); border-radius: var(--r-xs);
        }
        .fb-track::after { content: none; }
        .fb-band {
          position: absolute; top: 13px; height: 20px;
          background: var(--fb-fill);
          border-radius: 3px;
          /* left + width are what tighten. Transitioning them (rather than
             re-rendering three bars) is the whole point of the graphic. */
          transition:
            left .9s cubic-bezier(.5,0,.2,1),
            width .9s cubic-bezier(.5,0,.2,1),
            background .5s ease;
        }
        .fb-point {
          position: absolute; top: 6px; bottom: 6px; width: 2px;
          background: var(--ink); opacity: .55; z-index: 2; border-radius: 1px;
        }
        .fb-point-tag {
          position: absolute; top: -19px;
          font-size: 10px; font-weight: 500; color: var(--ink);
          white-space: nowrap; transform: translateX(-50%);
        }
        .fb-axis { position: relative; height: 18px; margin-top: 7px; }
        .fb-tickmark {
          position: absolute; top: 0; font-size: 10px; color: var(--muted-2);
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
        .tm-cell.tm-high { background: var(--amber); opacity: 0; }
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
        .tm-swatch.tm-high { background: var(--amber); }
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
          .fb-band, .sn-bar, .tm-cell, .fb-step { transition: none !important; }
          .cb-row { opacity: 1; }
          .fb-headline, .fb-detail { animation: none; }
          .tm-cell { opacity: 1; transform: none; }
          .tm-cell.tm-high { opacity: .72; }
          .tm-cell.tm-critical { opacity: 1; }
        }
      `}</style>
    </section>
  );
}
