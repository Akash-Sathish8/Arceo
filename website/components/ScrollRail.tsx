"use client";

import { useEffect, useState } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";

/* How far down the page you are, drawn as a wire being walked — and used to
 * get around.
 *
 * This replaces a plain graphite bar that filled left to right. The bar was
 * accurate and said nothing. This says the same thing in the page's own
 * language: one edge of the authority graph laid across the top of the
 * window, with a station for every chapter. An aquamarine line grows as you
 * scroll, each station lights the moment the line reaches it, and clicking a
 * station jumps to that chapter.
 *
 * The stations are MEASURED, not hardcoded. Each one sits at the scroll
 * fraction where its section actually starts, so the rail stays honest when a
 * section is added, removed or resized — and so the lit node is always the
 * chapter you are genuinely in. Hardcoded percentages drift the moment
 * anybody edits a section's padding.
 *
 * The fill and the stations are driven off the scroll MotionValue through
 * useTransform, so scrolling never re-renders React. Only a resize does.
 */

/* The chapters, in page order. `id` must match a <section id> in app/page.tsx's
   children; anything missing from the DOM is skipped rather than throwing. */
const SECTIONS = [
  { id: "problem", label: "The problem" },
  { id: "blast-radius", label: "Blast radius" },
  { id: "how-it-works", label: "How it works" },
  { id: "cross-agent", label: "Cross-agent chains" },
  { id: "features", label: "What you get" },
  { id: "pull-request", label: "The CI check" },
  { id: "proof", label: "Proof" },
];

/* Motion interpolates between literal colours, so these cannot be var().
   They mirror --brand-border and --aqua-ink in app/globals.css. */
const DIM = "#CBD8EE";
const LIT = "#0E9B7D";

type Stop = { id: string; label: string; at: number };

function Station({ stop, progress }: { stop: Stop; progress: MotionValue<number> }) {
  const { at } = stop;
  /* Lights just before the line physically arrives, so the fill never appears
     to overtake the node it is about to reach. */
  const background = useTransform(progress, [at - 0.03, at], [DIM, LIT]);
  /* Overshoot, then settle — a node taking a hit, not a switch flipping. */
  const scale = useTransform(progress, [at - 0.03, at, at + 0.05], [0.8, 1.5, 1]);
  const boxShadow = useTransform(
    progress,
    [at - 0.03, at, at + 0.09],
    [
      "0 0 0 0 rgba(14,155,125,0)",
      "0 0 0 4px rgba(14,155,125,0.24)",
      "0 0 0 0 rgba(14,155,125,0)",
    ],
  );

  return (
    <a
      className="rail-stop"
      href={`#${stop.id}`}
      style={{ left: `${at * 100}%` }}
      aria-label={`Jump to ${stop.label}`}
    >
      {/* The hit area is 22px square; the dot it contains is 5px. A 5px
          target is not clickable by anybody, and is not a target at all on
          a touch screen. */}
      <motion.span className="rail-station" style={{ background, scale, boxShadow }} />
      <span className="rail-tip">{stop.label}</span>
    </a>
  );
}

export default function ScrollRail({ progress }: { progress: MotionValue<number> }) {
  const [stops, setStops] = useState<Stop[]>([]);

  useEffect(() => {
    const measure = () => {
      /* The same denominator useScroll() divides by, so a station's fraction
         and the fill's scaleX are on one scale. */
      const scrollable =
        document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) {
        setStops([]);
        return;
      }
      setStops(
        SECTIONS.flatMap(({ id, label }) => {
          const el = document.getElementById(id);
          if (!el) return [];
          const top = el.getBoundingClientRect().top + window.scrollY;
          const at = Math.min(0.985, Math.max(0.015, top / scrollable));
          return [{ id, label, at }];
        }),
      );
    };

    measure();
    /* Web fonts and the hero's entrance both change the page height after
       first paint, and a station measured against the wrong height sits in
       the wrong place for the rest of the session. */
    const settle = setTimeout(measure, 600);
    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => {
      clearTimeout(settle);
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, []);

  const left = useTransform(progress, [0, 1], ["0%", "100%"]);
  /* Hidden at the very top: a node parked in the corner of an unscrolled page
     reads as a stray dot rather than as a position. */
  const opacity = useTransform(progress, [0, 0.015], [0, 1]);

  return (
    <nav className="rail" aria-label="Page sections">
      <motion.span className="rail-fill" style={{ scaleX: progress }} aria-hidden="true" />
      {stops.map((s) => (
        <Station key={s.id} stop={s} progress={progress} />
      ))}
      {/* The call itself, riding the leading edge. */}
      <motion.span
        className="rail-head"
        style={{ left, x: "-50%", y: "-50%", opacity }}
        aria-hidden="true"
      />
    </nav>
  );
}
