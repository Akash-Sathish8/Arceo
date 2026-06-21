import { useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import Sidebar from "./Sidebar";
import ErrorBoundary from "./ErrorBoundary";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  if (location.pathname === "/login") {
    return <>{children}</>;
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
        style={{ flex: 1, minWidth: 0, overflowY: "auto" }}
        aria-label="Main content"
      >
        <ErrorBoundary>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              style={{ minHeight: "100%" }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </ErrorBoundary>
      </main>
    </div>
  );
}
