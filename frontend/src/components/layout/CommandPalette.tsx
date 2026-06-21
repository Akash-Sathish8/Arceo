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
} from "lucide-react";
import { useCommandPaletteStore } from "@/store/commandPalette";
import { apiFetch, isLoggedIn } from "@/lib/api";

interface Agent {
  id: string;
  name: string;
  blast_score?: number;
}

const NAV_ITEMS = [
  { label: "Agents", to: "/", icon: <LayoutDashboard size={14} /> },
  { label: "Workflows", to: "/workflows", icon: <GitBranch size={14} /> },
  { label: "Sandbox", to: "/sandbox", icon: <FlaskConical size={14} /> },
  { label: "History", to: "/history", icon: <Clock size={14} /> },
  { label: "Compare", to: "/compare", icon: <GitCompare size={14} /> },
  { label: "Approvals", to: "/approvals", icon: <CheckSquare size={14} /> },
  { label: "Settings", to: "/settings", icon: <Settings size={14} /> },
];

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderRadius: 6,
  fontSize: 13,
  color: "#374151",
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
  color: "#9ca3af",
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
        style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
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
              backgroundColor: "#ffffff",
              borderRadius: 12,
              border: "1px solid #e5e7eb",
              boxShadow: "0 25px 50px -12px rgba(0,0,0,0.3)",
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
                borderBottom: "1px solid #f3f4f6",
              }}
            >
              <Search size={14} style={{ color: "#9ca3af", flexShrink: 0 }} />
              <Command.Input
                autoFocus
                placeholder="Search pages and agents…"
                style={{
                  flex: 1,
                  fontSize: 14,
                  outline: "none",
                  border: "none",
                  background: "transparent",
                  color: "#111827",
                  fontFamily: "inherit",
                }}
              />
              <kbd
                style={{
                  fontSize: 10,
                  color: "#9ca3af",
                  backgroundColor: "#f3f4f6",
                  border: "1px solid #e5e7eb",
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
                  color: "#9ca3af",
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
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor = "#eff6ff";
                      (e.currentTarget as HTMLElement).style.color = "#1d4ed8";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
                      (e.currentTarget as HTMLElement).style.color = "#374151";
                    }}
                  >
                    <span style={{ color: "#9ca3af" }}>{item.icon}</span>
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
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor = "#eff6ff";
                      (e.currentTarget as HTMLElement).style.color = "#1d4ed8";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
                      (e.currentTarget as HTMLElement).style.color = "#374151";
                    }}
                  >
                    <span style={{ color: "#9ca3af" }}>{action.icon}</span>
                    {action.label}
                  </Command.Item>
                ))}
              </Command.Group>

              {/* Agents */}
              {agentError && (
                <Command.Group>
                  <div style={groupHeadingStyle}>Agents</div>
                  <div style={{ padding: "8px 10px", fontSize: 12, color: "#9ca3af" }}>
                    Could not load agents.
                  </div>
                </Command.Group>
              )}
              {!agentError && agents.length > 0 && (
                <Command.Group>
                  <div style={groupHeadingStyle}>Agents</div>
                  {agents.slice(0, 8).map((agent) => {
                    const score = agent.blast_score ?? 0;
                    const scoreColor =
                      score >= 70 ? "#dc2626" : score >= 40 ? "#d97706" : "#16a34a";
                    return (
                      <Command.Item
                        key={agent.id}
                        value={agent.name}
                        onSelect={() => go(`/agent/${agent.id}`)}
                        style={itemStyle}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.backgroundColor = "#eff6ff";
                          (e.currentTarget as HTMLElement).style.color = "#1d4ed8";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
                          (e.currentTarget as HTMLElement).style.color = "#374151";
                        }}
                      >
                        <span style={{ color: "#9ca3af" }}><User size={14} /></span>
                        <span style={{ flex: 1 }}>{agent.name}</span>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: scoreColor,
                            backgroundColor: scoreColor + "18",
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
