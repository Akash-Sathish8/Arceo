import { useLocation } from "react-router-dom";
import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import ErrorBoundary from "./ErrorBoundary";
import LogoMark from "@/components/shared/LogoMark";
import { useSidebarStore } from "@/store/sidebar";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const setMobileOpen = useSidebarStore((s) => s.setMobileOpen);

  // Scroll the content region back to top on every route change — <main> is the
  // scroll container, so navigating from the bottom of a long list used to land
  // you mid-page on the next route.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.pathname]);

  // A route change means the drawer's job is done.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname, setMobileOpen]);

  if (location.pathname === "/login") {
    // Login gets its own boundary too — a crash here used to blank the screen.
    return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
  }

  return (
    <div
      className="app-shell"
      style={{
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--paper)",
        fontFamily: "var(--font-sans)",
        color: "var(--ink-900)",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <header className="mobile-topbar">
        <button
          type="button"
          className="mobile-topbar-menu"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation"
        >
          <Menu size={20} strokeWidth={1.8} />
        </button>
        <LogoMark size={24} />
        <span style={{ fontWeight: 600, fontSize: 17, letterSpacing: -0.3 }}>Arceo</span>
      </header>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
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
    </div>
  );
}
