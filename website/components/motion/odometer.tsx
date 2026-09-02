"use client";

import { useEffect, useState } from "react";
import { SlidingNumber } from "./sliding-number";

/* A figure that rolls when it can and is simply correct when it cannot.
 *
 * SlidingNumber is a spring: each digit is a column of 0–9 that settles into
 * place on rAF. That is the right effect for this page — every number here is
 * the product — but a spring frozen halfway is not a number, it is two digits
 * on top of each other. Browsers stop rAF in a hidden tab, so a page opened in
 * a background tab renders its headline figures as garbage until it is looked
 * at, and a screenshot or a print of that page keeps the garbage.
 *
 * So the odometer only exists while the document is visible. Everywhere else
 * the figure is plain text at its true value, which is what a number is for. */
export function Odometer({ value }: { value: number }) {
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    if (document.visibilityState === "visible") {
      setLive(true);
      return;
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") setLive(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  if (!live) return <span>{value}</span>;
  return <SlidingNumber value={value} />;
}
