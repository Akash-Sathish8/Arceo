"use client";

import { Odometer } from "./motion/odometer";
import { useArmed } from "@/lib/useArmed";

/* Three figures, under the fold, as their own band.
 *
 * All three are real: the band is the high-confidence forecast tier, the rule
 * count is LABEL_TRANSITIONS in authority/chain_detector.py on dev, and the
 * sources are the four ingestion paths the backend accepts.
 *
 * Each cell carries a measure rule along its top that draws in when the band
 * is reached. The rule is the channel: graphite for the two figures about
 * cost and coverage, red for the one about danger. Nothing else here is
 * coloured, and the counters roll rather than fade — a figure that arrives
 * the way a meter arrives is the house style of this page. */

const METRICS = [
  {
    prefix: "±",
    value: 15,
    suffix: "%",
    channel: "var(--cost)",
    title: "Forecast band",
    note: "Once Arceo has watched enough live calls, the monthly number lands inside this range.",
  },
  {
    prefix: "",
    value: 32,
    suffix: "",
    channel: "var(--risk)",
    title: "Dangerous chain rules",
    note: "Sequences Arceo flags as dangerous, not just single actions in isolation.",
  },
  {
    prefix: "",
    value: 95,
    suffix: "",
    channel: "var(--cost)",
    title: "Actions in the catalog",
    note: "Already classified across 11 services. Anything new gets classified automatically.",
  },
];

export default function MetricStrip() {
  const [ref, armed] = useArmed<HTMLElement>(0.35);

  return (
    <section
      ref={ref}
      style={{
        background: "var(--ground)",
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <div
        className="metric-grid"
        style={{
          maxWidth: 1240,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
        }}
      >
        {METRICS.map((m, i) => (
          <div
            key={m.title}
            className="metric-cell"
            style={
              {
                "--i": i,
                position: "relative",
                padding: "42px 40px 46px",
                borderLeft: i === 0 ? "1px solid var(--rule)" : "none",
                borderRight: "1px solid var(--rule)",
              } as React.CSSProperties
            }
          >
            <span
              className="metric-rule"
              aria-hidden="true"
              style={{
                background: m.channel,
                transform: armed ? "scaleX(1)" : "scaleX(0)",
              }}
            />

            <div
              className="num"
              style={{
                display: "flex",
                alignItems: "baseline",
                fontSize: 42,
                fontWeight: 600,
                color: "var(--ink)",
                lineHeight: 1,
                marginBottom: 16,
              }}
            >
              {m.prefix && <span>{m.prefix}</span>}
              <Odometer value={armed ? m.value : 0} />
              {m.suffix && <span>{m.suffix}</span>}
            </div>

            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", marginBottom: 7 }}>
              {m.title}
            </div>
            <p style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.55, maxWidth: 300 }}>
              {m.note}
            </p>
          </div>
        ))}
      </div>

      <style>{`
        .metric-rule {
          position: absolute;
          top: -1px; left: 0; right: 0; height: 2px;
          transform-origin: left;
          transition: transform .9s cubic-bezier(.16,1,.3,1);
          transition-delay: calc(var(--i, 0) * 120ms);
        }

        @media (max-width: 860px) {
          .metric-grid { grid-template-columns: 1fr !important; }
          .metric-cell {
            border-left: none !important;
            border-right: none !important;
            border-bottom: 1px solid var(--rule);
            padding: 32px 24px !important;
          }
          .metric-cell:last-child { border-bottom: none; }
        }

        @media (prefers-reduced-motion: reduce) {
          .metric-rule { transition: none; }
        }
      `}</style>
    </section>
  );
}
