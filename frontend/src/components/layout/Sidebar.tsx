import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
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
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import LogoMark from "@/components/shared/LogoMark";
import { apiFetch, isLoggedIn, getUser, logout } from "@/lib/api";
import { deriveOrgName } from "@/lib/orgName";
import { useSidebarStore } from "@/store/sidebar";

interface NavItem {
  id: string;
  label: string;
  to: string;
  Icon: LucideIcon;
  badge?: number;
  group: string | null;
}

const ACCENT = "var(--accent)";

// deriveOrgName (with its demo-session / consumer-domain rules) lives in
// @/lib/orgName so the CFO PDF exports print the same org name as the chrome.

function getUserInitial(email: string | undefined): string {
  if (!email) return "A";
  return email[0].toUpperCase();
}

export default function Sidebar(): React.ReactElement {
  const [pendingCount, setPendingCount] = useState(0);
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggle = useSidebarStore((s) => s.toggle);

  const user = getUser() as { email?: string } | null;
  const orgName = deriveOrgName(user?.email);
  const initial = getUserInitial(user?.email);

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
        const pending = items.filter((a) => a.status === "PENDING_APPROVAL").length;
        setPendingCount(pending);
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

  const navItems: NavItem[] = [
    { id: "agents",    label: "Agents",    to: "/",          Icon: LayoutGrid,    group: null },
    { id: "approvals", label: "Approvals", to: "/approvals", Icon: ShieldCheck,   group: "Monitor", badge: pendingCount > 0 ? pendingCount : undefined },
    { id: "history",   label: "History",   to: "/history",   Icon: Clock,         group: "Monitor" },
    { id: "spend",     label: "Spend",     to: "/spend",     Icon: Banknote,      group: "Monitor" },
    { id: "sandbox",   label: "Sandbox",   to: "/sandbox",   Icon: FlaskConical,  group: "Tools" },
    { id: "workflows", label: "Workflows", to: "/workflows", Icon: GitBranch,     group: "Tools" },
    { id: "compare",   label: "Compare",   to: "/compare",   Icon: GitCompare,    group: "Tools" },
  ];

  // Group items, preserving order.
  const groups: { name: string | null; items: NavItem[] }[] = [];
  for (const item of navItems) {
    const existing = groups.find((g) => g.name === item.group);
    if (existing) existing.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }

  // Dark rail palette — sourced from the --sidebar-* tokens (single source).
  const C = {
    bg: "var(--sidebar-bg)",
    word: "var(--sidebar-text-active)",
    mark: ACCENT,
    grp: "var(--sidebar-text-dim)",
    txt: "var(--sidebar-text)",
    txtOn: "var(--sidebar-text-active)",
    icon: "var(--sidebar-text-dim)",
    iconOn: ACCENT,
    onBg: "var(--sidebar-active)",
    border: "var(--sidebar-border)",
    subA: "rgba(255,255,255,0.09)",
    subT: "#e0e4ea",
    subS: "var(--sidebar-text-dim)",
  };

  const toggleBtn = (
    <button
      onClick={toggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      style={{
        background: "none",
        border: "none",
        color: C.icon,
        cursor: "pointer",
        padding: 5,
        borderRadius: 7,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {collapsed ? <PanelLeftOpen size={17} strokeWidth={1.8} /> : <PanelLeftClose size={17} strokeWidth={1.8} />}
    </button>
  );

  return (
    <aside
      style={{
        width: collapsed ? 72 : 248,
        flexShrink: 0,
        background: C.bg,
        display: "flex",
        flexDirection: "column",
        padding: collapsed ? "22px 10px" : "22px 14px",
        minHeight: "100vh",
        transition: "width 0.18s ease",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: collapsed ? "2px 0 14px" : "2px 8px 24px",
          justifyContent: collapsed ? "center" : "flex-start",
        }}
      >
        <LogoMark size={28} />
        {!collapsed && (
          <span
            style={{
              fontWeight: 600,
              fontSize: 19,
              color: C.word,
              letterSpacing: -0.3,
              fontFamily: "var(--font-sans)",
            }}
          >
            Arceo
          </span>
        )}
        {!collapsed && (
          <>
            <div style={{ flex: 1 }} />
            {toggleBtn}
          </>
        )}
      </div>

      {collapsed && (
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
          {toggleBtn}
        </div>
      )}

      {groups.map((g, gi) => (
        <div key={gi} style={{ marginBottom: 4 }}>
          {g.name && !collapsed && (
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: 1.1,
                textTransform: "uppercase",
                color: C.grp,
                padding: "14px 8px 6px",
              }}
            >
              {g.name}
            </div>
          )}
          {g.name && collapsed && (
            <div
              style={{
                height: 1,
                background: C.border,
                margin: "10px 8px 8px",
              }}
            />
          )}
          {g.items.map((item) => (
            <NavLink
              key={item.id}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => `ag-nav${isActive ? " ag-nav--active" : ""}`}
              title={collapsed ? item.label : undefined}
              style={({ isActive }) => ({
                display: "flex",
                alignItems: "center",
                justifyContent: collapsed ? "center" : "flex-start",
                gap: collapsed ? 0 : 11,
                padding: collapsed ? "9px 0" : "8px 9px",
                borderRadius: 8,
                marginBottom: 1,
                color: isActive ? C.txtOn : C.txt,
                background: isActive ? C.onBg : "transparent",
                fontWeight: isActive ? 600 : 450,
                fontSize: 14,
                textDecoration: "none",
                fontFamily: "var(--font-sans)",
              })}
            >
              {({ isActive }) => (
                <>
                  <span style={{ color: isActive ? C.iconOn : C.icon, display: "flex", position: "relative" }}>
                    <item.Icon size={17} strokeWidth={1.7} />
                    {collapsed && item.badge !== undefined && item.badge > 0 && (
                      <span
                        style={{
                          position: "absolute",
                          top: -3,
                          right: -4,
                          width: 7,
                          height: 7,
                          borderRadius: 999,
                          background: "var(--critical-ring)",
                          border: `1.5px solid ${C.bg}`,
                        }}
                      />
                    )}
                  </span>
                  {!collapsed && <span style={{ flex: 1 }}>{item.label}</span>}
                  {!collapsed && item.badge !== undefined && item.badge > 0 && (
                    <span
                      style={{
                        background: "var(--critical-ring)",
                        color: "#fff",
                        fontSize: 10,
                        fontWeight: 700,
                        borderRadius: 999,
                        padding: "1px 6px",
                        minWidth: 18,
                        textAlign: "center",
                        lineHeight: "14px",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {item.badge > 99 ? "99+" : item.badge}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </div>
      ))}

      <div style={{ flex: 1 }} />

      <NavLink
        to="/settings"
        className={({ isActive }) => `ag-nav${isActive ? " ag-nav--active" : ""}`}
        title={collapsed ? "Settings" : undefined}
        style={({ isActive }) => ({
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "flex-start",
          gap: collapsed ? 0 : 11,
          padding: collapsed ? "9px 0" : "8px 9px",
          borderRadius: 8,
          color: isActive ? C.txtOn : C.txt,
          background: isActive ? C.onBg : "transparent",
          fontSize: 14,
          fontWeight: isActive ? 600 : 450,
          textDecoration: "none",
          fontFamily: "var(--font-sans)",
        })}
      >
        {({ isActive }) => (
          <>
            <span style={{ color: isActive ? C.iconOn : C.icon, display: "flex" }}>
              <SettingsIcon size={17} strokeWidth={1.7} />
            </span>
            {!collapsed && "Settings"}
          </>
        )}
      </NavLink>

      <div
        style={{
          display: "flex",
          flexDirection: collapsed ? "column" : "row",
          alignItems: "center",
          gap: collapsed ? 8 : 10,
          padding: collapsed ? "12px 0 2px" : "12px 8px 2px",
          marginTop: 8,
          borderTop: `1px solid ${C.border}`,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: C.subA,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            flexShrink: 0,
          }}
          title={user?.email ?? ""}
        >
          {initial}
        </div>
        {!collapsed && (
          <div style={{ lineHeight: 1.25, minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 550,
                color: C.subT,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-sans)",
              }}
            >
              {user?.email ?? ""}
            </div>
            <div style={{ fontSize: 11, color: C.subS, fontFamily: "var(--font-sans)" }}>
              {orgName}
            </div>
          </div>
        )}
        <button
          onClick={logout}
          aria-label="Sign out"
          title="Sign out"
          style={{
            background: "none",
            border: "none",
            color: C.subS,
            cursor: "pointer",
            padding: 4,
            display: "flex",
            alignItems: "center",
          }}
        >
          <LogOut size={13} />
        </button>
      </div>
    </aside>
  );
}
