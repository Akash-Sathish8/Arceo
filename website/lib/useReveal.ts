"use client";

import { useEffect, useRef } from "react";

/* Staggered scroll reveal.
 *
 * Observes a container once, then adds `.in` to every `.rise` descendant. The
 * cascade comes from each child's own `--i` index in CSS, so the JS stays a
 * single class flip rather than a timer per element.
 *
 * Unobserves on first entry: these are entrance animations, and replaying them
 * every time the user scrolls back up is the thing that makes a page feel like
 * a demo reel instead of a product.
 *
 * There is also a deadline. `.rise` starts at opacity 0, which means anything
 * that stops the observer from firing — a page painted in a background tab, a
 * viewport quirk, an ancestor that never lays out — does not delay the copy,
 * it deletes it. A landing page whose paragraphs can silently fail to appear
 * is worse than one that never animates, so after a few seconds the reveal
 * runs whether or not the section was ever seen. */
export function useReveal<T extends HTMLElement = HTMLDivElement>(
  threshold = 0.15,
  deadlineMs = 3200,
) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const show = () => {
      root.querySelectorAll<HTMLElement>(".rise").forEach((el) => el.classList.add("in"));
    };

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      show();
      return;
    }

    const deadline = setTimeout(show, deadlineMs);

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          show();
          io.disconnect();
          clearTimeout(deadline);
        }
      },
      { threshold, rootMargin: "0px 0px -8% 0px" },
    );

    io.observe(root);
    return () => {
      io.disconnect();
      clearTimeout(deadline);
    };
  }, [threshold, deadlineMs]);

  return ref;
}
