"use client";

import Link from "next/link";
import { useReveal } from "@/lib/useReveal";

/* The close.
 *
 * The page has spent its boldness on the tape, the bench and the matrix. This
 * is the accessory that comes off before leaving the house: a dark band, the
 * right type, two buttons, and one line of proof underneath. Nothing moves
 * except the entrance. */

export default function CTABanner() {
  const ref = useReveal<HTMLElement>(0.2);

  return (
    <section
      ref={ref}
      className="act-dark ruled-dark"
      style={{ position: "relative", overflow: "hidden", padding: "104px 0 108px" }}
    >
      <div
        className="wash-dark"
        style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.7 }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 2,
          maxWidth: 780,
          margin: "0 auto",
          padding: "0 32px",
          textAlign: "center",
        }}
      >
        <span className="eyebrow rise" style={{ "--i": 0 } as React.CSSProperties}>
          Book a walkthrough
        </span>

        <h2
          className="rise"
          style={
            {
              "--i": 1,
              fontSize: "clamp(30px, 3.8vw, 46px)",
              fontWeight: 600,
              letterSpacing: "-0.035em",
              lineHeight: 1.08,
              marginBottom: 18,
              textWrap: "balance",
            } as React.CSSProperties
          }
        >
          Ship your agents with a number you can defend.
        </h2>

        <p
          className="rise"
          style={
            {
              "--i": 2,
              fontSize: 17.5,
              color: "var(--muted)",
              lineHeight: 1.6,
              maxWidth: 520,
              margin: "0 auto 34px",
            } as React.CSSProperties
          }
        >
          Bring your own agent. We will run it through Arceo live and show you
          the monthly cost, the confidence band, and every dangerous chain it
          can run.
        </p>

        <div
          className="rise"
          style={
            {
              "--i": 3,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              flexWrap: "wrap",
            } as React.CSSProperties
          }
        >
          <Link href="/book-demo" className="btn-white">
            Book a demo
          </Link>
          <Link href="/pricing" className="btn-white-outline">
            See pricing
          </Link>
        </div>

        <p
          className="mono rise cta-proof"
          style={{ "--i": 4 } as React.CSSProperties}
        >
          30 minutes · read-only · no code changes
        </p>
      </div>

      <style>{`
        .cta-proof {
          margin-top: 26px;
          font-size: 11px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--muted-2);
        }
      `}</style>
    </section>
  );
}
