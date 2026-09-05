import { useEffect, useState, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  GitBranch,
  FlaskConical,
  Clock,
  GitCompare,
  CheckSquare,
  Settings,
  Search,
  User,
  Plus,
  Banknote,
} from "lucide-react";
import { useCommandPaletteStore } from "@/store/commandPalette";
import { apiFetch, isLoggedIn } from "@/lib/api";
import { scoreBand } from "@/lib/utils";

interface Agent {
  id: string;
  name: string;
  blast_radius?: { score?: number; band?: string };
}

const NAV_ITEMS = [
  { label: "Agents", to: "/", icon: <LayoutDashboard size={14} /> },
  { label: "Spend", to: "/spend", icon: <Banknote size={14} /> },
  { label: "Workflows", to: "/workflows", icon: <GitBranch size={14} /> },
  { label: "Sandbox", to: "/sandbox", icon: <FlaskConical size={14} /> },
  { label: "History", to: "/history", icon: <Clock size={14} /> },
  { label: "Compare", to: "/compare", icon: <GitCompare size={14} /> },
  { label: "Approvals", to: "/approvals", icon: <CheckSquare size={14} /> },
  { label: "Settings", to: "/settings", icon: <Settings size={14} /> },
];

// [cmdk-item][data-selected] styling lives in index.css so keyboard nav is
// visible — no more onMouseEnter/onMouseLeave style mutation (which the
// keyboard never triggers).
const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderRadius: 6,
  fontSize: 13,
  color: "var(--ink-700)",
  cursor: "pointer",
  outline: "none",
  border: "none",
  background: "transparent",
  width: "100%",
  textAlign: "left",
};

const groupHeadingStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--ink-400)",
  padding: "8px 10px 3px",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

export default function CommandPalette() {
  const { open, setOpen } = useCommandPaletteStore();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentError, setAgentError] = useState(false);

  // Global Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setOpen]);

  // Load agents when palette opens
  useEffect(() => {
    if (!open || !isLoggedIn()) return;
    setAgentError(false);
    apiFetch<{ agents: Agent[] }>("/api/authority/agents")
      .then((data) => setAgents(data.agents ?? []))
      .catch(() => setAgentError(true));
  }, [open]);

  const go = useCallback(
    (to: string) => {
      setOpen(false);
      navigate(to);
    },
    [setOpen, navigate]
  );

  return (
    <AnimatePresence>
      {open && (
      <>
      {/* Backdrop */}
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-50"
        style={{ backgroundColor: "var(--bg-overlay)" }}
        onClick={() => setOpen(false)}
      />

      {/* Palette panel */}
      <div
        className="fixed inset-x-0 z-50 px-4"
        style={{ top: 112 }}
      >
        <div className="mx-auto max-w-xl">
        <motion.div
          key="panel"
          initial={{ opacity: 0, scale: 0.97, y: -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -8 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
        >
          <Command
            style={{
              backgroundColor: "var(--card)",
              borderRadius: 12,
              boxShadow: "var(--shadow-lg)",
              overflow: "hidden",
            }}
          >
            {/* Input row */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 12px",
                height: 48,
                borderBottom: "1px solid var(--line-soft)",
              }}
            >
              <Search size={14} style={{ color: "var(--ink-400)", flexShrink: 0 }} />
              <Command.Input
                autoFocus
                placeholder="Search pages and agents…"
                style={{
                  flex: 1,
                  fontSize: 14,
                  outline: "none",
                  border: "none",
                  background: "transparent",
                  color: "var(--ink-900)",
                  fontFamily: "inherit",
                }}
              />
              <kbd
                style={{
                  fontSize: 10,
                  color: "var(--ink-400)",
                  backgroundColor: "var(--paper-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  padding: "1px 5px",
                  fontFamily: "inherit",
                  lineHeight: "16px",
                  flexShrink: 0,
                }}
              >
                Esc
              </kbd>
            </div>

            {/* Results list */}
            <Command.List style={{ maxHeight: 340, overflowY: "auto", padding: 6 }}>
              <Command.Empty
                style={{
                  padding: "24px 0",
                  textAlign: "center",
                  fontSize: 13,
                  color: "var(--ink-400)",
                }}
              >
                No results found.
              </Command.Empty>

              {/* Navigation */}
              <Command.Group>
                <div style={groupHeadingStyle}>Navigation</div>
                {NAV_ITEMS.map((item) => (
                  <Command.Item
                    key={item.to}
                    value={item.label}
                    onSelect={() => go(item.to)}
                    style={itemStyle}
                  >
                    <span style={{ color: "var(--ink-400)" }}>{item.icon}</span>
                    {item.label}
                  </Command.Item>
                ))}
              </Command.Group>

              {/* Quick actions */}
              <Command.Group>
                <div style={groupHeadingStyle}>Quick Actions</div>
                {[
                  { label: "Connect new agent", to: "/?connect=true", icon: <Plus size={14} /> },
                  { label: "Run simulation", to: "/sandbox", icon: <FlaskConical size={14} /> },
                ].map((action) => (
                  <Command.Item
                    key={action.label}
                    value={action.label}
                    onSelect={() => go(action.to)}
                    style={itemStyle}
                  >
                    <span style={{ color: "var(--ink-400)" }}>{action.icon}</span>
                    {action.label}
                  </Command.Item>
                ))}
              </Command.Group>

              {/* Agents */}
              {agentError && (
                <Command.Group>
                  <div style={groupHeadingStyle}>Agents</div>
                  <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--ink-400)" }}>
                    Could not load agents.
                  </div>
                </Command.Group>
              )}
              {!agentError && agents.length > 0 && (
                <Command.Group>
                  <div style={groupHeadingStyle}>Agents</div>
                  {agents.slice(0, 8).map((agent) => {
                    const score = Math.round(agent.blast_radius?.score ?? 0);
                    const band = scoreBand(score, 0, agent.blast_radius?.band);
                    return (
                      <Command.Item
                        key={agent.id}
                        value={agent.name}
                        onSelect={() => go(`/agent/${agent.id}`)}
                        style={itemStyle}
                      >
                        <span style={{ color: "var(--ink-400)" }}><User size={14} /></span>
                        <span style={{ flex: 1 }}>{agent.name}</span>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: band.color,
                            backgroundColor: band.bg,
                            borderRadius: 4,
                            padding: "1px 6px",
                          }}
                        >
                          {score}
                        </span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </motion.div>
        </div>
      </div>
      </>
      )}
    </AnimatePresence>
  );
}
