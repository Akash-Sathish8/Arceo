"use client";

import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";

/* "Armed" means: show the real value now.
 *
 * Every counter and bar on this site animates from an empty state to its true
 * figure when you scroll to it. That is fine until the animation never runs —
 * a tab restored in the background stops rAF, an IntersectionObserver in a
 * page that is never painted may not fire, a library can fail to load — and
 * then the empty state is what the reader gets. For a headline that means a
 * blank line. For a page whose entire argument is its numbers, it means a
 * fleet forecast that says $0 and a chain count that says 0. That is worse
 * than no animation at all; it is a wrong number.
 *
 * So arming is a race between the reveal and a deadline. Whichever comes
 * first wins, and the deadline always comes. Scrolling to the section is the
 * normal path and still gets the full transition; everything else degrades to
 * the figures simply being correct. */
export function useArmed<T extends HTMLElement = HTMLDivElement>(
  amount = 0.3,
  deadlineMs = 2600,
) {
  const ref = useRef<T>(null);
  const inView = useInView(ref, { once: true, amount });
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    /* One frame's grace so a bar has a zero-width state to grow from. */
    if (inView) {
      const t = setTimeout(() => setArmed(true), 60);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setArmed(true), deadlineMs);
    return () => clearTimeout(t);
  }, [inView, deadlineMs]);

  return [ref, armed] as const;
}
