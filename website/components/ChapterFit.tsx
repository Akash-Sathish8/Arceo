"use client";

import { useEffect } from "react";

/* Every chapter is one screen.
 *
 * The home page's chapters are the direct children of <main data-chapters>
 * (the belt excepted). Each one is given the height of the viewport minus the
 * nav, and its content is centred inside that. A chapter whose natural height
 * is shorter than a screen expands to fill it; one that is taller is scaled
 * down with CSS `zoom` until it fits, so the whole chapter is on screen at
 * once and nothing has to be scrolled inside a snap point.
 *
 * `zoom`, not `transform`, because zoom reflows: hit targets, hover states and
 * the layout width all follow the scale, so the chapter stays interactive.
 *
 * The scale is written as `--fit` and the available height as `--avail` on
 * each section; globals.css turns them into zoom and min-height. Below the
 * desktop breakpoint the stylesheet ignores both and the page stacks. */

const NAV = 64;
const MIN_WIDTH = 900;
const MIN_FIT = 0.55; // below this, text stops being readable — let it scroll

export default function ChapterFit() {
  useEffect(() => {
    const deck = document.querySelector<HTMLElement>("main[data-chapters]");
    if (!deck) return;
    const chapters = Array.from(
      deck.querySelectorAll<HTMLElement>(":scope > section:not(.belt)"),
    );
    if (!chapters.length) return;

    const beltHeight = () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--belt-h");
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    };

    let raf = 0;
    const fit = () => {
      raf = 0;
      if (window.innerWidth < MIN_WIDTH) {
        chapters.forEach((el) => {
          el.style.removeProperty("--fit");
          el.style.removeProperty("--avail");
        });
        return;
      }
      const belt = beltHeight();
      chapters.forEach((el) => {
        const avail = window.innerHeight - NAV - (el.classList.contains("hero-fill") ? belt : 0);
        el.style.setProperty("--avail", `${avail}px`);
        el.style.setProperty("--fit", "1");
        let scale = 1;
        // Natural height at scale 1, then converge: a narrower zoom reflows the
        // content wider, which usually makes it shorter again.
        for (let i = 0; i < 4; i++) {
          const natural = el.scrollHeight;
          const visual = natural * scale;
          if (visual <= avail + 1) break;
          scale = Math.max(MIN_FIT, (avail / natural) * 0.995);
          el.style.setProperty("--fit", scale.toFixed(4));
          if (scale === MIN_FIT) break;
        }
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(fit);
    };

    fit();
    // Fonts and lazy content shift heights after first paint.
    document.fonts?.ready.then(schedule);
    const t = window.setTimeout(schedule, 600);
    window.addEventListener("resize", schedule);
    return () => {
      window.clearTimeout(t);
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      chapters.forEach((el) => {
        el.style.removeProperty("--fit");
        el.style.removeProperty("--avail");
      });
    };
  }, []);

  return null;
}
