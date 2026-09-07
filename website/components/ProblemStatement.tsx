"use client";

import { useReveal } from "@/lib/useReveal";
import { useArmed } from "@/lib/useArmed";
import { RISK } from "@/lib/labels";

/* The problem, as a ledger.
 *
 * The heading claims every capability is two things at once — a line on the
 * bill and a way things go wrong — so the layout shows both, in the same row,
 * in the two inks the rest of the page uses. Graphite: what the call costs.
 * Red: how much of the blast radius it accounts for.
 *
 * The red column used to be a dollar "worst case" — a number Arceo does not
 * produce today. These are the engine's real weights instead: LABEL_WEIGHTS
 * from authority/graph.py with the 2.0 irreversible multiplier and the 0.15
 * read-only floor already applied. contacts.read scoring 1 against
 * db.delete_records scoring 30 makes the read-only floor visible without a
 * word of explanation.
 *
 * Each row used to carry a paragraph explaining itself. They were true and
 * nobody was going to read them: the whole argument is the distance between a
 * third of a cent and a 30-point contribution to the blast radius, and a wall
 * of prose underneath only buries it. Four lines, two columns, one point. */

const CAPABILITIES = [
  {
    action: "payments.refund",
    label: RISK.moves_money.plain,
    color: "var(--label-money)",
    fill: "var(--label-money-fill)",
    perCall: "$0.0034",
    weight: 24,
    note: "irreversible",
  },
  {
    action: "db.delete_records",
    label: RISK.deletes_data.plain,
    color: "var(--label-delete)",
    fill: "var(--label-delete-fill)",
    perCall: "$0.0018",
    weight: 30,
    note: "irreversible",
  },
  {
    action: "contacts.read",
    label: RISK.touches_pii.plain,
    color: "var(--label-pii)",
    fill: "var(--label-pii-fill)",
    perCall: "$0.0012",
    weight: 1,
    note: "read-only",
  },
  {
    action: "email.send",
    label: RISK.sends_external.plain,
    color: "var(--label-external)",
    fill: "var(--label-external-fill)",
    perCall: "$0.0021",
    weight: 14,
    note: "irreversible",
  },
];

/* The heaviest action on the list. Bars are drawn against this, so the
   read-only row's single point stays visibly, almost comically, short. */
const W_MAX = 30;

export default function ProblemStatement() {
  const ref = useReveal<HTMLElement>(0.12);
  const [barsRef, armed] = useArmed<HTMLDivElement>(0.3);

  return (
    <section id="problem" ref={ref} style={{ padding: "104px 0 112px", background: "var(--paper)" }}>
      <div
        className="prob-shell"
        style={{
          maxWidth: 1240,
          margin: "0 auto",
          padding: "0 32px",
          display: "grid",
          gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)",
          gap: 80,
          alignItems: "center",
        }}
      >
        <div className="rise" style={{ "--i": 0 } as React.CSSProperties}>
          <span className="eyebrow">The problem</span>
          <h2
            style={{
              fontSize: "clamp(28px, 3.3vw, 42px)",
              fontWeight: 600,
              letterSpacing: "-0.034em",
              color: "var(--ink)",
              lineHeight: 1.08,
              marginBottom: 20,
              textWrap: "balance",
            }}
          >
            Pennies a call. Some of them you can't take back.
          </h2>
          <p style={{ fontSize: 17, color: "var(--muted)", lineHeight: 1.6, maxWidth: 420 }}>
            Every tool your agent can reach costs a fraction of a cent and
            carries a weight. Reading barely counts. Anything you cannot undo
            counts double.
          </p>
        </div>

        <div ref={barsRef}>
          <div className="cap-head rise" style={{ "--i": 1 } as React.CSSProperties}>
            <span className="mono cap-col">Capability</span>
            <span className="mono cap-col cap-right">Per call</span>
            <span className="mono cap-col cap-right">Blast weight</span>
          </div>

          {CAPABILITIES.map((c, i) => (
            <div
              key={c.action}
              className="cap-row rise"
              style={{ "--i": i + 2, "--edge": c.color } as React.CSSProperties}
            >
              <span className="cap-name">
                <span className="mono cap-action">{c.action}</span>
                <span className="cap-label" style={{ color: c.color, background: c.fill }}>
                  {c.label}
                </span>
              </span>
              <span className="mono num cap-cost">{c.perCall}</span>
              <span className="cap-weight">
                <span className="mono num cap-weight-n">{c.weight}</span>
                <span className="cap-weight-track">
                  <span
                    className="cap-weight-bar"
                    style={{
                      width: armed ? `${(c.weight / W_MAX) * 100}%` : 0,
                      transitionDelay: `${i * 90}ms`,
                    }}
                  />
                </span>
                <span className="mono cap-weight-note">{c.note}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .cap-head, .cap-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 92px 112px;
          gap: 16px;
          align-items: center;
        }
        .cap-head { padding: 0 0 12px 22px; border-bottom: 1px solid var(--rule); }
        .cap-col {
          font-size: 10px; font-weight: 500; letter-spacing: 0.13em;
          text-transform: uppercase; color: var(--muted-2);
        }
        .cap-right { text-align: right; }

        .cap-row {
          position: relative;
          padding: 24px 0 24px 22px;
          border-bottom: 1px solid var(--rule);
          transition: background .25s ease;
        }
        /* Leading edge carries the label hue. It grows on hover — the only
           motion in the row. */
        .cap-row::before {
          content: "";
          position: absolute;
          left: 0; top: 0; bottom: -1px;
          width: 2px;
          background: var(--edge);
          transform: scaleY(0.3);
          transform-origin: top;
          transition: transform .35s cubic-bezier(.16,1,.3,1);
        }
        .cap-row:hover::before { transform: scaleY(1); }
        .cap-row:hover { background: var(--ground); }

        .cap-name { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
        .cap-action {
          font-size: 16px; font-weight: 500; color: var(--ink);
          letter-spacing: -0.01em;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .cap-label {
          align-self: flex-start;
          font-size: 11.5px; font-weight: 500;
          padding: 3px 9px; border-radius: var(--r-xs);
        }
        .cap-cost { font-size: 14px; color: var(--cost-soft); text-align: right; }
        .cap-weight {
          display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
        }
        .cap-weight-n { font-size: 22px; font-weight: 600; color: var(--risk); }
        .cap-weight-track {
          width: 100%; height: 4px; margin: 5px 0 4px;
          background: var(--ground-2); border-radius: 999px; overflow: hidden;
        }
        .cap-weight-bar {
          display: block; height: 100%; width: 0;
          background: var(--risk); border-radius: 999px;
          transition: width .8s cubic-bezier(.16,1,.3,1);
        }
        .cap-weight-note {
          font-size: 9.5px; color: var(--muted-2); white-space: nowrap;
        }

        @media (prefers-reduced-motion: reduce) {
          .cap-weight-bar { transition: none; }
        }
        @media (max-width: 1000px) {
          .prob-shell { grid-template-columns: 1fr !important; gap: 44px !important; }
        }
        @media (max-width: 560px) {
          .cap-head, .cap-row { grid-template-columns: minmax(0, 1fr) 84px; }
          .cap-cost { display: none; }
          .cap-head .cap-col:nth-child(2) { display: none; }
        }
      `}</style>
    </section>
  );
}
