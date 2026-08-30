import { useSyncExternalStore } from "react";

const cache = new Map<string, MediaQueryList>();

function mql(query: string): MediaQueryList {
  let m = cache.get(query);
  if (!m) {
    m = window.matchMedia(query);
    cache.set(query, m);
  }
  return m;
}

/** Reactive matchMedia — re-renders when the query flips. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = mql(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => mql(query).matches,
  );
}

/** Below the desktop rail breakpoint: the sidebar becomes an overlay drawer. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 1023px)");
}
