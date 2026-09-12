"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import Lenis from "lenis";

/* Heavy scroll, then a snap.
 *
 * Two things the CSS alone cannot do: make the wheel feel weighted, and settle
 * the page onto a chapter once the reader stops. Lenis gives the scroll its
 * weight — each wheel input eases out over 1.4 seconds instead of landing at
 * once, and a reduced wheel multiplier keeps one flick from covering a whole
 * chapter. The snap is our own, not Lenis's plugin:
 * that plugin only hears the wheel, and a reader who pages with the keyboard
 * or drags the scrollbar would never be settled. This one listens to every
 * scroll Lenis reports, waits for the page to come to rest, and if a chapter
 * top is within half a viewport eases onto it. The middle of a tall chapter
 * stays a place you can stop.
 *
 * Lenis puts a `lenis` class on <html>. globals.css uses it to stand the
 * browser's own snap and smooth-scroll down while Lenis runs, so nothing
 * fights over the scroll position. When Lenis does not run — reduced motion,
 * a touch screen, no JS — the native proximity snap in globals.css is the
 * fallback and the page still works.
 *
 * Chapters are the direct children of <main data-chapters> on the home page.
 * Other pages get the heavy scroll and no snap points. */

const NAV = 72; // the sticky nav plus breathing room; same as globals.css
const REST_MS = 260; // how long the page must be still before it settles
const REACH = 0.5; // snap when a chapter top is within this fraction of the viewport
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export default function SmoothScroll() {
  const pathname = usePathname();

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const touch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    if (reduced || touch) return;

    const lenis = new Lenis({
      /* Duration, not lerp: every wheel input plays out over the same 1.4s
         curve whatever the frame rate, so the weight feels identical on a
         60Hz laptop and a 144Hz monitor. */
      duration: 1.4,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      wheelMultiplier: 0.7,
      smoothWheel: true,
      syncTouch: false,
      allowNestedScroll: true,
      autoRaf: true,
      anchors: true, // Lenis honours the chapters' scroll-margin, so no offset here
    });

    const deck = document.querySelector<HTMLElement>("main[data-chapters]");
    const chapters = deck
      ? Array.from(deck.querySelectorAll<HTMLElement>(":scope > section:not(.belt)"))
      : [];

    let tops: number[] = [];
    const measure = () => {
      tops = chapters.map((el) =>
        Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY - NAV)),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);

    let timer: number | undefined;
    let lastY = -1;
    let still = 0;
    const settle = () => {
      const y = window.scrollY;
      still = y === lastY ? still + 1 : 0;
      lastY = y;
      /* Still moving (wheel inertia, an anchor scroll, our own snap): look
         again shortly. Lenis can leave isScrolling set after a native scroll
         that moved nothing — a scrollbar drag held at the end of the page —
         so a page that has not moved for two checks counts as at rest
         whatever the flag says. */
      if (lenis.isScrolling && still < 2) {
        timer = window.setTimeout(settle, 100);
        return;
      }
      if (!tops.length) return;
      const target = tops.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a));
      const gap = Math.abs(target - y);
      if (gap <= 1 || gap > window.innerHeight * REACH) return;
      lenis.scrollTo(target, { duration: 1.1, easing: easeOut });
    };
    const off = lenis.on("scroll", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, REST_MS);
    });

    return () => {
      window.clearTimeout(timer);
      off();
      observer.disconnect();
      lenis.destroy();
    };
  }, [pathname]);

  return null;
}
