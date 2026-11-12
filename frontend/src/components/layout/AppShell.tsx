import { useLocation } from "react-router-dom";
import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Sidebar from "./Sidebar";
import { useIsMobile } from "@/lib/useIsMobile";
import { useSidebarStore } from "@/store/sidebar";
import TopBar from "./TopBar";
import ErrorBoundary from "./ErrorBoundary";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const mobile = useIsMobile();
  const mobileOpen = useSidebarStore((s) => s.mobileOpen);
  const setMobileOpen = useSidebarStore((s) => s.setMobileOpen);

  // The drawer closes whenever the route changes (a nav tap) or the layout widens.
  useEffect(() => { setMobileOpen(false); }, [location.pathname, mobile, setMobileOpen]);

  // Scroll the content region back to top on every route change — <main> is the
  // scroll container, so navigating from the bottom of a long list used to land
  // you mid-page on the next route.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.pathname]);

  // Public share pages (/p/:id prompts, /c/:id comparisons) render without app chrome.
  const chromeless = location.pathname === "/login"
    || location.pathname.startsWith("/p/") || location.pathname.startsWith("/c/")
    || location.pathname.startsWith("/u/");
  if (chromeless) {
    // Login gets its own boundary too — a crash here used to blank the screen.
    return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
  }

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "var(--bg-page)",
        fontFamily: "var(--font-sans)",
        color: "var(--ink-900)",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      {mobile ? (
        mobileOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex" }}
          >
            <Sidebar drawer />
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
              style={{ flex: 1, border: 0, background: "rgba(15,15,15,0.32)", cursor: "pointer" }}
            />
          </div>
        )
      ) : (
        <Sidebar />
      )}
      <main
        ref={mainRef}
        style={{ flex: 1, minWidth: 0, overflowY: "auto", background: "var(--bg-page)" }}
        aria-label="Main content"
      >
        <TopBar />
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
