"use client";

import { useEffect, useRef, useState } from "react";

export function useFadeInOnScroll<T extends HTMLElement = HTMLDivElement>(delayMs = 0) {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          if (delayMs > 0) timer = setTimeout(() => setVisible(true), delayMs);
          else setVisible(true);
          obs.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    obs.observe(el);

    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setVisible(true);
    };
    window.addEventListener("pageshow", onPageShow);

    return () => {
      obs.disconnect();
      if (timer) clearTimeout(timer);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [delayMs]);

  return { ref, visible, className: `fade-up ${visible ? "visible" : ""}` };
}
