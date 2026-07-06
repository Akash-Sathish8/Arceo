import { useLocation } from "react-router-dom";
import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Sidebar from "./Sidebar";
import ErrorBoundary from "./ErrorBoundary";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  // Scroll the content region back to top on every route change — <main> is the
  // scroll container, so navigating from the bottom of a long list used to land
  // you mid-page on the next route.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.pathname]);

  if (location.pathname === "/login") {
    // Login gets its own boundary too — a crash here used to blank the screen.
    return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
  }

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "var(--paper)",
        fontFamily: "var(--font-sans)",
        color: "var(--ink-900)",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <Sidebar />
      <main
        ref={mainRef}
        style={{ flex: 1, minWidth: 0, overflowY: "auto" }}
        aria-label="Main content"
      >
        {/* resetKey clears a crashed boundary as soon as the user navigates,
            so one render error no longer bricks the whole app until reload. */}
        <ErrorBoundary resetKey={location.pathname}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              style={{ minHeight: "100%" }}
            >
              {/* Centered content column so pages don't sprawl across ultra-wide
                  viewports. Pages keep their own padding. */}
              <div style={{ maxWidth: 1240, margin: "0 auto", width: "100%" }}>
                {children}
              </div>
            </motion.div>
          </AnimatePresence>
        </ErrorBoundary>
      </main>
    </div>
  );
}
