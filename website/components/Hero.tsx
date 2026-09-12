"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import HeroGraphic from "./HeroGraphic";
import AuthorityGraph from "./AuthorityGraph";

/* The hero states the thesis in words on the left and demonstrates it on the
   right. The graph behind both is the same picture the product draws on its
   own sign-in screen, running the same calls the tape is posting. */

const SOURCES = ["Anthropic SDK", "OpenAI", "MCP", "GitHub"];

export default function Hero() {
  const [visible, setVisible] = useState(false);

  /* The tape and the graph are two views of one event. When the tape brackets
     a chain, every flagged edge in the graph behind the headline lights. */
  const [chain, setChain] = useState(false);
  const onChain = useCallback((live: boolean) => setChain(live), []);

  /* The graph sits behind the type, so it should not travel with it. A little
     lag on scroll gives the fold depth without anything sliding around. */
  const sectionRef = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end start"],
  });
  const graphY = useTransform(scrollYProgress, [0, 1], [0, reduced ? 0 : 64]);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 80);
    /* Safari and Chrome restore a bfcache page with fade-in elements stuck
       at opacity 0. Reload on restore. Do not remove. */
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      className="ruled"
      style={{
        /* The hero ground does the work the card's border used to. With no
           hairline and no shadow on the panel, TONE is the only thing left
           to separate it — so the ground is a real blue-neutral rather than
           a near-white, and the white card reads as a plane sitting on it.
           Straight out of the product: tinted page, white surfaces. */
        background: "linear-gradient(180deg, #E5EBF7 0%, #E9EFF9 58%, #EFF3FB 100%)",
        position: "relative",
        overflow: "hidden",
        padding: "80px 0 100px",
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <div className="wash-light" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />

      <motion.div style={{ position: "absolute", inset: 0, y: graphY, pointerEvents: "none" }}>
        <AuthorityGraph packets={2} variant="ambient" alert={chain} />
      </motion.div>

      <div
        className="hero-shell"
        style={{
          position: "relative",
          zIndex: 2,
          maxWidth: 1240,
          margin: "0 auto",
          padding: "0 32px",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.38fr) minmax(0, 1fr)",
          gap: 64,
          alignItems: "center",
        }}
      >
        <div className={visible ? "hero-left" : "hero-left pre"} style={{ minWidth: 0 }}>
          <div
            className="mono hero-el"
            style={
              {
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                fontWeight: 500,
                color: "var(--muted)",
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                marginBottom: 26,
                "--d": "0ms",
              } as React.CSSProperties
            }
          >
            <span className="pulse-dot" />
            Cost and risk, before production
          </div>

          {/* Per line, not per character. A sentence this long revealed one
              letter at a time reads as a typing gimmick; two lines settling
              in sequence reads as a statement being made.

              Driven by CSS rather than by the JS animation library the rest
              of the page uses. A headline is the one element that must be
              legible even when no animation ever runs — a page restored into
              a background tab freezes rAF, and a JS-driven reveal leaves the
              masthead blank until the tab is looked at. The end state here is
              a plain class, so the worst case is that it appears without
              having moved. */}
          <h1
            style={{
              fontSize: "clamp(32px, 3.7vw, 49px)",
              fontWeight: 600,
              lineHeight: 1.06,
              letterSpacing: "-0.04em",
              color: "var(--ink)",
              marginBottom: 24,
              maxWidth: 700,
            }}
          >
            {/* The two halves of the product are the two halves of the
                sentence, so the sentence is coded the same way the rest of
                the page is: deep blue is what it costs, red is what it can
                break. A node runs the underline the way a call runs an edge
                of the authority graph, then parks at the end of the word. */}
            <span className="hero-el hero-line" style={{ "--d": "120ms" } as React.CSSProperties}>
              Know what your{" "}
              <span className="hl hl-cost" style={{ "--hl-d": "1.05s" } as React.CSSProperties}>
                agent costs
                <span className="hl-node" aria-hidden="true" />
              </span>
              ,
            </span>
            <span className="hero-el hero-line" style={{ "--d": "260ms" } as React.CSSProperties}>
              and what it can{" "}
              <span className="hl hl-risk" style={{ "--hl-d": "1.6s" } as React.CSSProperties}>
                break
                <span className="hl-node" aria-hidden="true" />
              </span>
              .
            </span>
          </h1>

          <p
            className="hero-el"
            style={
              {
                fontSize: 18.5,
                color: "var(--muted)",
                lineHeight: 1.55,
                marginBottom: 34,
                maxWidth: 460,
                "--d": "420ms",
              } as React.CSSProperties
            }
          >
            Point Arceo at your agent and get one report your finance team can
            read, before you deploy.
          </p>

          <div
            className="hero-el"
            style={
              {
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                "--d": "500ms",
              } as React.CSSProperties
            }
          >
            <Link href="/book-demo" className="btn-black">
              Book a demo
            </Link>
            <Link href="/pricing" className="btn-outline">
              See pricing
            </Link>
          </div>

          {/* The objection a CIO raises in the first thirty seconds, answered
              in the fold rather than three sections down. */}
          <div
            className="hero-el hero-proof"
            style={{ "--d": "580ms" } as React.CSSProperties}
          >
            <span className="mono hero-proof-lead">Read-only</span>
            <span className="hero-proof-rule" aria-hidden="true" />
            {SOURCES.map((s) => (
              <span key={s} className="mono hero-proof-item">
                {s}
              </span>
            ))}
          </div>
        </div>

        <div
          className={visible ? "hero-right" : "hero-right pre"}
          style={{ position: "relative", minWidth: 0, marginTop: 20 }}
        >
          <HeroGraphic onChain={onChain} />
        </div>
      </div>

      <style>{`
        .hero-el {
          opacity: 0;
          transform: translate3d(0, 16px, 0);
          transition: opacity .8s cubic-bezier(.16,1,.3,1), transform .8s cubic-bezier(.16,1,.3,1);
          transition-delay: var(--d, 0ms);
        }
        .hero-left:not(.pre) .hero-el { opacity: 1; transform: none; }

        /* Each line is its own block so the two settle in sequence. The
           slight blur is the only ornament: the sentence comes into focus,
           which is what the product does to an agent. */
        .hero-line {
          display: block;
          filter: blur(5px);
          transition:
            opacity .75s cubic-bezier(.16,1,.3,1),
            transform .75s cubic-bezier(.16,1,.3,1),
            filter .75s cubic-bezier(.16,1,.3,1);
          transition-delay: var(--d, 0ms);
        }
        .hero-left:not(.pre) .hero-line { filter: blur(0); }

        /* ── The coded keywords ───────────────────────────────────────
           "agent costs" and "break" are the two things Arceo answers, and
           they take the two channel inks the whole page uses: deep blue for
           cost, red for consequence. Each is underlined by a node that runs
           the width of the word and then parks at its end, the same way a
           call walks an edge of the authority graph behind the headline —
           the ornament is the product's own motif, not a highlighter.

           The word stays ink-coloured until the node has almost finished its
           run, so the colour arrives as a result of the sweep rather than
           being there from the start. */
        .hl {
          position: relative;
          display: inline-block;
          color: inherit;
          animation: hl-ink .45s ease forwards;
          /* --hl paints the line and the node; --hl-text paints the word. */
          animation-delay: calc(var(--hl-d) + .34s);
          white-space: nowrap;
        }
        .hl-cost { --hl: var(--cost);  --hl-text: var(--cost); }
        /* Amber, not red. Red is held back on this page for the agents that
           genuinely fail a build — an 82/100 in the PR check, an irreversible
           delete. The headline is naming a category, not raising an alarm. */
        .hl-risk { --hl: var(--amber); --hl-text: var(--amber-ink); }
        @keyframes hl-ink { to { color: var(--hl-text); } }

        /* The line the node leaves behind it. */
        .hl::after {
          content: "";
          position: absolute;
          left: 0; right: 0; bottom: -0.04em;
          height: 0.055em; min-height: 3px;
          border-radius: 2px;
          background: var(--hl);
          transform: scaleX(0); transform-origin: left center;
          animation: hl-draw .78s cubic-bezier(.45,0,.2,1) forwards;
          animation-delay: var(--hl-d);
        }
        @keyframes hl-draw { to { transform: scaleX(1); } }

        /* The node itself. Rides the leading edge of the underline, then
           holds — a terminal on the graph, breathing the way the live dot
           on the tape does. */
        .hl-node {
          position: absolute;
          left: 0; bottom: -0.04em;
          width: 0.17em; height: 0.17em;
          min-width: 9px; min-height: 9px;
          border-radius: 50%;
          background: var(--hl);
          transform: translate(-50%, 32%);
          opacity: 0;
          animation:
            hl-run .78s cubic-bezier(.45,0,.2,1) forwards,
            hl-breathe 2.6s ease-in-out infinite;
          animation-delay: var(--hl-d), calc(var(--hl-d) + .78s);
        }
        @keyframes hl-run {
          0%   { left: 0;    opacity: 0; }
          10%  { opacity: 1; }
          100% { left: 100%; opacity: 1; }
        }
        @keyframes hl-breathe {
          0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--hl) 38%, transparent); }
          50%      { box-shadow: 0 0 0 5px color-mix(in srgb, var(--hl) 0%, transparent); }
        }

        /* Two lines is the composition, so above the breakpoint each line is
           held on one line. Below it they wrap like ordinary text rather than
           overflowing — a nowrap headline on a phone is a horizontal scrollbar. */
        @media (min-width: 1060px) {
          .hero-line { white-space: nowrap; }
        }

        .hero-right {
          opacity: 0;
          transform: translate3d(0, 24px, 0) scale(.985);
          transition: opacity .9s cubic-bezier(.16,1,.3,1) .22s, transform .9s cubic-bezier(.16,1,.3,1) .22s;
        }
        .hero-right:not(.pre) { opacity: 1; transform: none; }

        /* The live dot. Same signal as the header dot on the tape: something
           is running right now. */
        .pulse-dot {
          width: 5px; height: 5px; border-radius: 50%;
          background: var(--amber);
          box-shadow: 0 0 0 0 rgba(245,158,11,0.5);
          animation: pulse-ring 2.6s cubic-bezier(.16,1,.3,1) infinite;
          flex-shrink: 0;
        }
        @keyframes pulse-ring {
          0%   { box-shadow: 0 0 0 0 rgba(245,158,11,0.45); }
          70%  { box-shadow: 0 0 0 7px rgba(245,158,11,0); }
          100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); }
        }

        .hero-proof {
          display: flex; align-items: center; gap: 10px;
          flex-wrap: wrap; margin-top: 30px;
        }
        .hero-proof-lead {
          font-size: 10px; font-weight: 500; letter-spacing: 0.12em;
          text-transform: uppercase; color: var(--ink);
          border: 1px solid var(--rule); background: var(--ground);
          padding: 3px 8px; border-radius: var(--r-xs);
        }
        .hero-proof-rule {
          width: 18px; height: 1px; background: var(--rule); flex-shrink: 0;
        }
        .hero-proof-item {
          font-size: 11px; color: var(--muted-2); letter-spacing: 0.02em;
        }
        .hero-proof-item + .hero-proof-item::before {
          content: "·"; margin-right: 10px; color: var(--disabled);
        }

        @media (max-width: 1000px) {
          .hero-shell { grid-template-columns: 1fr !important; gap: 48px !important; }
          .hero-right { margin-top: 0 !important; }
        }

        @media (prefers-reduced-motion: reduce) {
          .hero-el, .hero-right { opacity: 1 !important; transform: none !important; transition: none !important; }
          .hl { animation: none; color: var(--hl-text); }
          .hl::after { animation: none; transform: scaleX(1); }
          .hl-node { animation: none; opacity: 1; left: 100%; }
          .hero-line { filter: none !important; }
          .pulse-dot { animation: none; }
        }
      `}</style>
    </section>
  );
}
