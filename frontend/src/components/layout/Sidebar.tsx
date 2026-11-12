/**
 * Left navigation rail — ported from the Stitch canvas.
 *
 * Stitch's rail: 240px of `neutral-sunken` (#F7F7F5) against a tinted page,
 * a square brand tile beside an `ARCEO` wordmark set in the display mono,
 * uppercase eyebrow group headers, and — the move that reads loudest at a
 * glance — an active item filled with `primary-container` (#0e3c90) rather
 * than the faint grey wash it had before.
 *
 * Classes use Stitch's own token names (registered in index.css `@theme`) so
 * this file stays diffable against the canvas markup.
 *
 * Kept beyond the canvas, because they are real behaviour and not styling:
 * the collapse toggle, the polled pending-approvals badge, org name, sign-out.
 */

import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutGrid,
  ShieldCheck,
  Clock,
  Banknote,
  FlaskConical,
  GitBranch,
  GitCompare,
  Settings as SettingsIcon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  ArrowLeftRight,
  Layers,
  Plug,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import LogoMark, { ArceoWordmark } from "@/components/shared/LogoMark";
import { apiFetch, isLoggedIn, getUser, logout } from "@/lib/api";
import { deriveOrgName } from "@/lib/orgName";
import { useSidebarStore } from "@/store/sidebar";
import { useWorkspaceStore } from "@/store/workspace";

interface NavItem {
  id: string;
  label: string;
  to: string;
  Icon: LucideIcon;
  badge?: number;
  group: string | null;
}

// deriveOrgName (with its demo-session / consumer-domain rules) lives in
// @/lib/orgName so the CFO PDF exports print the same org name as the chrome.

export default function Sidebar({ drawer = false }: { drawer?: boolean }): React.ReactElement {
  const [pendingCount, setPendingCount] = useState(0);
  const { pathname } = useLocation();
  // In the phone drawer the rail is always full width: collapsing makes no sense there.
  const storedCollapsed = useSidebarStore((s) => s.collapsed);
  const collapsed = drawer ? false : storedCollapsed;
  const toggle = useSidebarStore((s) => s.toggle);
  const setMobileOpen = useSidebarStore((s) => s.setMobileOpen);
  const workspace = useWorkspaceStore((s) => s.workspace);
  const loadWorkspace = useWorkspaceStore((s) => s.load);
  const setWorkspace = useWorkspaceStore((s) => s.set);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  const user = getUser() as { email?: string } | null;
  const orgName = deriveOrgName(user?.email);
  const initial = (user?.email?.[0] ?? "A").toUpperCase();

  useEffect(() => {
    if (!isLoggedIn()) return;

    async function fetchPending() {
      if (document.hidden) return;
      try {
        // skipLogoutOn401: a background poll must never yank the user to /login
        // mid-task just because the token lapsed.
        const data = await apiFetch<{ approvals?: { status: string }[] }>(
          "/api/approvals", { skipLogoutOn401: true }
        );
        const items = data?.approvals ?? [];
        // Backend status is PENDING_APPROVAL — the old "PENDING" filter kept the
        // badge permanently at 0.
        setPendingCount(items.filter((a) => a.status === "PENDING_APPROVAL").length);
      } catch {
        /* silent by design — a badge is not worth an error surface */
      }
    }

    fetchPending();
    const interval = setInterval(fetchPending, 30_000);
    const onVisible = () => { if (!document.hidden) fetchPending(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const promptItems: NavItem[] = [
    { id: "prompts",   label: "Library",   to: "/prompts",   Icon: ScrollText,   group: "Prompts" },
    { id: "prompt-connect", label: "Connect your agent", to: "/prompts/connect", Icon: Plug, group: "Prompts" },
    { id: "prompt-workflows", label: "Prompt workflows", to: "/prompt-workflows", Icon: Layers, group: "Prompts" },
  ];
  const agentItems: NavItem[] = [
    { id: "agents",    label: "Agents",    to: "/",          Icon: LayoutGrid,   group: null },
    { id: "approvals", label: "Approvals", to: "/approvals", Icon: ShieldCheck,  group: "Monitor", badge: pendingCount > 0 ? pendingCount : undefined },
    { id: "history",   label: "History",   to: "/history",   Icon: Clock,        group: "Monitor" },
    { id: "spend",     label: "Spend",     to: "/spend",     Icon: Banknote,     group: "Monitor" },
    { id: "sandbox",   label: "Sandbox",   to: "/sandbox",   Icon: FlaskConical, group: "Tools" },
    { id: "workflows", label: "Workflows", to: "/workflows", Icon: GitBranch,    group: "Tools" },
    { id: "compare",   label: "Policy diff", to: "/compare", Icon: GitCompare,  group: "Tools" },
  ];
  // A prompts workspace (founders and agencies) sees only the prompt library;
  // the agent-governance tools are one click away, not in their face.
  const navItems: NavItem[] = workspace === "prompts" ? promptItems : [...agentItems, ...promptItems];

  const groups: { name: string | null; items: NavItem[] }[] = [];
  for (const item of navItems) {
    const existing = groups.find((g) => g.name === item.group);
    if (existing) existing.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    [
      "flex items-center rounded-lg text-body transition-colors no-underline",
      collapsed ? "justify-center px-0 py-2.5" : "px-4 py-2.5",
      isActive
        ? "bg-rail-active text-on-rail-active font-semibold"
        : "text-rail-secondary font-normal hover:bg-rail-hover hover:text-rail-primary",
    ].join(" ");

  const toggleBtn = (
    <button
      type="button"
      onClick={toggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="flex items-center justify-center p-1.5 rounded-lg bg-transparent border-0 cursor-pointer text-rail-muted hover:text-rail-primary hover:bg-rail-hover transition-colors"
    >
      {collapsed ? <PanelLeftOpen size={17} strokeWidth={1.8} /> : <PanelLeftClose size={17} strokeWidth={1.8} />}
    </button>
  );

  return (
    <aside
      // In the phone drawer, any link tap closes it, including the page you're already on.
      onClickCapture={drawer ? (e) => { if ((e.target as HTMLElement).closest("a")) setMobileOpen(false); } : undefined}
      className="shrink-0 h-screen flex flex-col bg-neutral-sunken font-body transition-[width] duration-200"
      style={{ width: drawer ? "min(280px, 85vw)" : collapsed ? 72 : 240, height: drawer ? "100%" : undefined }}
    >
      {/* Brand */}
      <div className={`flex items-center gap-2 ${collapsed ? "px-3 justify-center" : "px-5"} pt-6 pb-5`}>
        <LogoMark size={30} />
        {!collapsed && (
          <>
            <ArceoWordmark height={13} />
            <div className="flex-1" />
            {!drawer && toggleBtn}
          </>
        )}
      </div>
      {collapsed && <div className="flex justify-center pb-3">{toggleBtn}</div>}

      {/* Sections */}
      <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.name && !collapsed && (
              <div className="pt-4 pb-2 px-4 font-eyebrow text-eyebrow text-rail-secondary uppercase">
                {g.name}
              </div>
            )}
            {g.name && collapsed && <div className="h-px bg-neutral-border mx-2 my-2.5" />}
            {g.items.map((item) => (
              <NavLink
                key={item.id}
                to={item.to}
                end={item.to === "/"}
                // /prompts/connect is its own item: don't also light up Library there.
                className={({ isActive }) => linkClass({ isActive: isActive && !(item.id === "prompts" && pathname.startsWith("/prompts/connect")) })}
                title={collapsed ? item.label : undefined}
              >
                <span className={`relative flex ${collapsed ? "" : "mr-3"}`}>
                  <item.Icon size={20} strokeWidth={1.7} />
                  {collapsed && item.badge !== undefined && item.badge > 0 && (
                    <span className="absolute -top-1 -right-1.5 w-2 h-2 rounded-full bg-error ring-2 ring-neutral-sunken" />
                  )}
                </span>
                {!collapsed && <span className="flex-1">{item.label}</span>}
                {!collapsed && item.badge !== undefined && item.badge > 0 && (
                  <span className="font-monospace-label text-[10px] font-bold rounded-full px-1.5 min-w-[18px] text-center bg-error text-on-error">
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        ))}

        <div className="mt-8 pt-4 border-t border-neutral-border">
          {/* Workspace switch: a real button (bordered card, icon, two lines) so
              it doesn't read as a nav link or a caption. Icon-only when collapsed. */}
          <button
            type="button"
            onClick={() => void setWorkspace(workspace === "prompts" ? "agents" : "prompts")}
            title={collapsed ? (workspace === "prompts" ? "Show agent governance tools" : "Switch to prompts only") : undefined}
            aria-label={workspace === "prompts" ? "Show agent governance tools" : "Switch to prompts only"}
            className={`w-full flex items-center gap-3 mb-3 rounded-lg cursor-pointer transition-colors hover:border-rail-active ${collapsed ? "justify-center px-0 py-2.5" : "px-3 py-2.5 text-left"}`}
            style={{ background: "var(--card)", border: "1px solid var(--line)", boxShadow: "var(--shadow-card-new)" }}
          >
            <ArrowLeftRight size={18} strokeWidth={1.8} className="text-rail-primary shrink-0" />
            {!collapsed && (
              <span className="flex flex-col min-w-0">
                <span className="text-body font-semibold text-rail-primary">
                  {workspace === "prompts" ? "Show agent tools" : "Prompts only"}
                </span>
                <span className="text-meta text-rail-secondary">
                  {workspace === "prompts" ? "Agents, approvals, spend" : "Hide the agent tools"}
                </span>
              </span>
            )}
          </button>
          <NavLink
            to="/settings"
            className={linkClass}
            title={collapsed ? "Settings" : undefined}
          >
            <span className={`flex ${collapsed ? "" : "mr-3"}`}>
              <SettingsIcon size={20} strokeWidth={1.7} />
            </span>
            {!collapsed && <span className="flex-1">Settings</span>}
          </NavLink>
        </div>
      </nav>

      {/* Signed-in user — its own tonal panel, as on the canvas */}
      <div className="p-4 border-t border-neutral-border bg-surface-container-low">
        <div className={`flex items-center gap-3 ${collapsed ? "flex-col" : "px-2"}`}>
          <div
            className="w-8 h-8 rounded-full bg-primary text-on-primary flex items-center justify-center text-body font-semibold shrink-0"
            title={user?.email ?? ""}
          >
            {initial}
          </div>
          {!collapsed && (
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-body font-semibold truncate text-rail-primary">{user?.email ?? ""}</span>
              <span className="text-meta text-rail-secondary truncate">{orgName}</span>
            </div>
          )}
          <button
            type="button"
            onClick={logout}
            aria-label="Sign out"
            title="Sign out"
            className="flex items-center p-1 bg-transparent border-0 cursor-pointer text-rail-muted hover:text-rail-primary transition-colors"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
