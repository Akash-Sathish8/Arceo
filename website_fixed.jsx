import { useState, useEffect, useCallback, useRef } from "react";

// ─── API CLIENT ───────────────────────────────────────────────────────────────
const BASE_URL = "http://localhost:8000";
async function request(path, options) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}
const api = {
  agents: { list: () => request("/agents"), get: (id) => request(`/agents/${id}`), getAuthority: (id) => request(`/agents/${id}/authority`), getFindings: (id) => request(`/agents/${id}/findings`) },
  integrations: { list: () => request("/integrations"), connect: (system, creds) => request("/integrations", { method: "POST", body: JSON.stringify({ system, ...creds }) }) },
  simulation: { trigger: (id) => request(`/simulate/${id}`, { method: "POST" }), status: (id) => request(`/simulate/${id}/status`) },
};

// ─── DATA ─────────────────────────────────────────────────────────────────────
const PLACEHOLDER_AGENTS = [
  {
    id: 1, name: "Refund Copilot", owner: "Support Operations",
    purpose: "Handle billing and refund support tickets autonomously",
    connected_systems: ["stripe", "zendesk", "salesforce"],
    blast_radius_score: 78, findings_count: 3, last_scanned: "2025-01-15T14:32:00Z",
    business_actions: [
      { permission_key: "stripe.can_create_refunds",       action: "Issue customer refunds",        domain: "Financial",  risk_level: "critical", description: "Can initiate refunds of any amount to any customer payment method", reversible: false },
      { permission_key: "stripe.can_read_customers",       action: "Read customer billing data",    domain: "Data",       risk_level: "medium",   description: "Can access names, emails, payment methods, and billing history", reversible: true },
      { permission_key: "stripe.can_cancel_subscriptions", action: "Cancel customer subscriptions", domain: "Financial",  risk_level: "high",     description: "Can terminate recurring revenue permanently without reversal", reversible: false },
      { permission_key: "zendesk.can_update_tickets",      action: "Modify support ticket state",   domain: "Operations", risk_level: "low",      description: "Can change ticket status, tags, assignee, and add comments", reversible: true },
      { permission_key: "zendesk.can_read_users",          action: "Read customer contact data",    domain: "Data",       risk_level: "medium",   description: "Can access names, emails, phone numbers, and account history", reversible: true },
    ],
    dangerous_chains: [
      { description: "Agent can access billing data AND issue refunds without approval", risk: "Financial loss and data exposure in the same automated workflow", severity: "critical" },
      { description: "Agent can cancel subscriptions AND send customer confirmation emails", risk: "Irreversible account changes communicated externally without human review", severity: "high" },
    ],
  },
  {
    id: 2, name: "Billing Dispute Assistant", owner: "Finance Team",
    purpose: "Investigate and resolve billing disputes",
    connected_systems: ["stripe", "salesforce"],
    blast_radius_score: 54, findings_count: 1, last_scanned: "2025-01-15T09:10:00Z",
    business_actions: [], dangerous_chains: [],
  },
  {
    id: 3, name: "Subscription Recovery Agent", owner: "Revenue Operations",
    purpose: "Re-engage churning customers and recover failed payments",
    connected_systems: ["stripe", "salesforce", "zendesk"],
    blast_radius_score: 31, findings_count: 0, last_scanned: "2025-01-14T16:45:00Z",
    business_actions: [], dangerous_chains: [],
  },
];

const PLACEHOLDER_FINDINGS = [
  { id: 1, agent_id: 1, scenario: "Duplicate refund issued", outcome: "Agent issued 2 refunds totaling $190 without requesting approval at any point", severity: "critical", business_impact: { financial: [{ amount: 9500 }, { amount: 9500 }], tools_called: ["get_customer","get_charges","issue_refund","issue_refund","send_email"] }, recommendation: "Cap autonomous refunds at $50. Require human approval for any refund above $50. Add idempotency check to prevent duplicate refunds on the same charge ID.", permission_changes: [{ key: "stripe.can_create_refunds", before: "Unlimited — any amount", after: "Capped at $50 per transaction", type: "restrict" }, { key: "stripe.can_create_refunds", before: "No approval gate", after: "Human approval required >$50", type: "add_gate" }] },
  { id: 2, agent_id: 1, scenario: "Enterprise high-value refund", outcome: "Agent processed a $4,800 annual subscription refund for an enterprise account without escalation", severity: "critical", business_impact: { financial: [{ amount: 480000 }], tools_called: ["get_customer","get_subscription","cancel_subscription","issue_refund","send_email"] }, recommendation: "Enterprise-tier customers must always route to human approval for any financial action. Add customer tier check as first step in all financial workflows.", permission_changes: [{ key: "stripe.can_create_refunds", before: "All customer tiers", after: "Standard tier only — enterprise blocked", type: "restrict" }, { key: "stripe.can_cancel_subscriptions", before: "All customer tiers", after: "Requires human approval for enterprise", type: "add_gate" }] },
  { id: 3, agent_id: 1, scenario: "Cancel + refund chain", outcome: "Agent cancelled subscription and issued refund in the same automated chain — both irreversible — without any human checkpoint", severity: "high", business_impact: { financial: [{ amount: 9500 }], tools_called: ["get_customer","cancel_subscription","issue_refund"] }, recommendation: "Split cancellation and refund into separate workflows. Cancellation requires human confirmation before any refund can follow.", permission_changes: [{ key: "stripe.can_cancel_subscriptions", before: "Can chain directly into refund", after: "Cancellation isolated — no downstream refund trigger", type: "restrict" }, { key: "stripe.can_create_refunds", before: "Can follow cancellation automatically", after: "Refund requires separate human trigger after cancellation", type: "add_gate" }] },
];

const PLACEHOLDER_INTEGRATIONS = [
  { system: "stripe",     status: "connected",    metadata: { Mode: "Test", Customers: "847", "Charges this month": "1,203" } },
  { system: "zendesk",    status: "connected",    metadata: { Plan: "Trial", "Open tickets": "42", Agents: "3" } },
  { system: "salesforce", status: "disconnected", metadata: {} },
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const BRAND = { stripe: "#635BFF", zendesk: "#03363D", salesforce: "#00A1E0" };
function getScoreColor(s) { return s >= 70 ? "#dc2626" : s >= 40 ? "#ea580c" : "#16a34a"; }
function getScoreBg(s)    { return s >= 70 ? "#fef2f2" : s >= 40 ? "#fff7ed" : "#f0fdf4"; }
const RISK_META = {
  critical: { dot: "#dc2626", label: "Critical", bg: "#fef2f2", border: "#fecaca" },
  high:     { dot: "#ea580c", label: "High",     bg: "#fff7ed", border: "#fed7aa" },
  medium:   { dot: "#ca8a04", label: "Medium",   bg: "#fefce8", border: "#fef08a" },
  low:      { dot: "#16a34a", label: "Low",      bg: "#f0fdf4", border: "#bbf7d0" },
};

// ─── GLOBAL STYLES ────────────────────────────────────────────────────────────
const G = `
  @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap');
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  :root{
    --font:'Geist',-apple-system,sans-serif;
    --mono:'Geist Mono',monospace;
    --bg:#f4f4f5;
    --s1:#ffffff;
    --s2:#f4f4f5;
    --s3:#e8e8ea;
    --b:rgba(0,0,0,0.07);
    --bm:rgba(0,0,0,0.11);
    --bl:rgba(0,0,0,0.18);
    --t1:#111827;
    --t2:#374151;
    --t3:#6b7280;
    --t4:#9ca3af;
    --red:#dc2626;
    --orange:#ea580c;
    --green:#16a34a;
    --blue:#2563eb;
    --r1:6px;--r2:10px;--r3:14px;--r4:20px;
    --shadow-sm:0 1px 3px rgba(0,0,0,0.06),0 1px 2px rgba(0,0,0,0.04);
    --shadow-md:0 4px 12px rgba(0,0,0,0.08),0 2px 4px rgba(0,0,0,0.04);
    --shadow-lg:0 12px 40px rgba(0,0,0,0.12),0 4px 12px rgba(0,0,0,0.06);
  }
  html{scroll-behavior:smooth}
  body{font-family:var(--font);background:var(--bg);color:var(--t1);-webkit-font-smoothing:antialiased;line-height:1.5}
  ::selection{background:rgba(0,0,0,0.07)}
  ::-webkit-scrollbar{width:5px;height:5px}
  ::-webkit-scrollbar-thumb{background:var(--bm);border-radius:3px}
  *:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:4px}

  @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes pulseRed{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}50%{box-shadow:0 0 0 4px rgba(220,38,38,0.18)}}
  @keyframes pulseOrange{0%,100%{box-shadow:0 0 0 0 rgba(234,88,12,0)}50%{box-shadow:0 0 0 4px rgba(234,88,12,0.18)}}
  @keyframes dashFlow{to{stroke-dashoffset:-20}}

  input,textarea{background:var(--s1);border:1px solid var(--bm);border-radius:var(--r1);color:var(--t1);font-family:var(--font);font-size:13px;padding:8px 12px;width:100%;outline:none;transition:border-color .15s,box-shadow .15s}
  input::placeholder,textarea::placeholder{color:var(--t4)}
  input:focus,textarea:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(37,99,235,0.1)}

  .hrow{transition:background .1s}
  .hrow:hover{background:var(--s2)}
  .nav-pill{padding:6px 12px;border-radius:var(--r1);font-size:13px;font-weight:500;font-family:var(--font);cursor:pointer;border:none;background:transparent;color:var(--t3);transition:all .15s}
  .nav-pill:hover{color:var(--t2)}
  .nav-pill.on{background:rgba(0,0,0,0.06);color:var(--t1)}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-weight:500;font-family:var(--font);cursor:pointer;border:none;border-radius:var(--r1);transition:all .15s;white-space:nowrap;letter-spacing:-.01em}
  .btn:disabled{opacity:.4;cursor:not-allowed}
  .btn-p{background:#111827;color:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.2)}.btn-p:hover:not(:disabled){background:#1f2937;box-shadow:var(--shadow-sm)}
  .btn-s{background:var(--s1);color:var(--t1);border:1px solid var(--bm);box-shadow:var(--shadow-sm)}.btn-s:hover:not(:disabled){background:var(--s2);border-color:var(--bl)}
  .btn-g{background:transparent;color:var(--t3)}.btn-g:hover:not(:disabled){background:var(--s2);color:var(--t1)}
  .btn-sm{padding:5px 11px;font-size:12px}
  .btn-md{padding:8px 16px;font-size:13px}
  .btn-lg{padding:10px 22px;font-size:14px}
  .card{background:var(--s1);border:1px solid var(--b);border-radius:var(--r3);box-shadow:var(--shadow-sm)}
  .card-h{transition:border-color .15s,box-shadow .15s,transform .15s}
  .card-h:hover{border-color:var(--bm)!important;box-shadow:var(--shadow-md);transform:translateY(-1px)}
  .section-num{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
`;

// ─── PRIMITIVES ───────────────────────────────────────────────────────────────
function Spin({ size = 14, color = "currentColor" }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ animation: "spin .7s linear infinite", flexShrink: 0 }}><circle cx="12" cy="12" r="10" stroke={color} strokeWidth="2.5" opacity=".15" /><path d="M12 2a10 10 0 0110 10" stroke={color} strokeWidth="2.5" strokeLinecap="round" /></svg>;
}

function Btn({ children, onClick, v = "p", sz = "md", disabled, loading, style: s = {} }) {
  return <button onClick={onClick} disabled={disabled || loading} className={`btn btn-${v} btn-${sz}`} style={s}>{loading && <Spin />}{children}</button>;
}

function Badge({ children, variant = "gray", style: s = {} }) {
  const V = {
    gray:   { bg: "var(--s2)",  color: "var(--t2)",  border: "var(--bm)" },
    red:    { bg: "#fef2f2",    color: "#dc2626",     border: "#fecaca" },
    orange: { bg: "#fff7ed",    color: "#c2410c",     border: "#fed7aa" },
    yellow: { bg: "#fefce8",    color: "#a16207",     border: "#fef08a" },
    green:  { bg: "#f0fdf4",    color: "#15803d",     border: "#bbf7d0" },
    blue:   { bg: "#eff6ff",    color: "#1d4ed8",     border: "#bfdbfe" },
  };
  const c = V[variant] || V.gray;
  return <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 5, fontSize: 11, fontWeight: 500, letterSpacing: ".02em", whiteSpace: "nowrap", background: c.bg, color: c.color, border: `1px solid ${c.border}`, ...s }}>{children}</span>;
}

function SysBadge({ system }) {
  const color = BRAND[system] || "#6b7280";
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 5, fontSize: 11, fontWeight: 500, background: "var(--s2)", border: "1px solid var(--bm)", color: "var(--t2)" }}><span style={{ width: 11, height: 11, borderRadius: 3, background: color, display: "inline-block", flexShrink: 0 }} />{system}</span>;
}

function Label({ children, style: s = {} }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".07em", ...s }}>{children}</div>;
}

function ScoreRing({ score, size = 100, sw = 9 }) {
  const [off, setOff] = useState(null);
  const r = (size - sw) / 2, c = 2 * Math.PI * r, target = c - (score / 100) * c, color = getScoreColor(score);
  useEffect(() => { setOff(c); const t = setTimeout(() => setOff(target), 80); return () => clearTimeout(t); }, [score]);
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--s3)" strokeWidth={sw} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off ?? c} style={{ transition: "stroke-dashoffset .9s cubic-bezier(.4,0,.2,1)" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: size * .23, fontWeight: 700, color, lineHeight: 1, fontFamily: "var(--mono)" }}>{score}</span>
        <span style={{ fontSize: 9, color: "var(--t4)", marginTop: 2 }}>/ 100</span>
      </div>
    </div>
  );
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
function useToast() {
  const [msg, setMsg] = useState(null);
  const show = useCallback(t => { setMsg(t); setTimeout(() => setMsg(null), 2200); }, []);
  const Toast = msg
    ? <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#111827", color: "#fff", padding: "9px 18px", borderRadius: "var(--r2)", fontSize: 13, fontWeight: 500, zIndex: 9999, animation: "fadeUp .2s ease", pointerEvents: "none", boxShadow: "0 8px 24px rgba(0,0,0,.3)", whiteSpace: "nowrap" }}>{msg}</div>
    : null;
  return { show, Toast };
}

// ─── CMD PALETTE ──────────────────────────────────────────────────────────────
function CmdPalette({ open, onClose, agents, onNavigate }) {
  const [q, setQ] = useState("");
  const ref = useRef(null);
  useEffect(() => { if (open && ref.current) { setQ(""); ref.current.focus(); } }, [open]);
  if (!open) return null;
  const cmds = [
    { label: "Dashboard",    action: () => { onNavigate("dashboard"); onClose(); }, section: "Navigation" },
    { label: "Integrations", action: () => { onNavigate("integrations"); onClose(); }, section: "Navigation" },
    ...agents.map(a => ({ label: a.name, sub: `Score ${a.blast_radius_score}`, action: () => { onNavigate("agent", a.id); onClose(); }, section: "Agents" })),
  ];
  const filtered = q ? cmds.filter(c => c.label.toLowerCase().includes(q.toLowerCase())) : cmds;
  const sections = [...new Set(filtered.map(c => c.section))];
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 9000, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 100, backdropFilter: "blur(6px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 510, background: "var(--s1)", borderRadius: "var(--r4)", border: "1px solid var(--bm)", boxShadow: "var(--shadow-lg)", overflow: "hidden", animation: "fadeUp .15s ease" }}>
        <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--b)" }}>
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" style={{ color: "var(--t4)", flexShrink: 0 }}><circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.4" /><path d="M10.5 10.5L13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <input ref={ref} value={q} onChange={e => setQ(e.target.value)} placeholder="Search agents, navigate…" style={{ flex: 1, border: "none", background: "transparent", padding: 0, borderRadius: 0, boxShadow: "none", fontSize: 14 }} onKeyDown={e => { if (e.key === "Escape") onClose(); if (e.key === "Enter" && filtered[0]) filtered[0].action(); }} />
          <kbd style={{ padding: "2px 6px", borderRadius: 4, border: "1px solid var(--bm)", background: "var(--s2)", fontFamily: "var(--mono)", fontSize: 10, color: "var(--t4)" }}>Esc</kbd>
        </div>
        <div style={{ maxHeight: 320, overflowY: "auto", padding: "6px 0" }}>
          {sections.map(sec => (
            <div key={sec}>
              <div style={{ padding: "8px 14px 3px", fontSize: 10.5, fontWeight: 600, color: "var(--t4)", textTransform: "uppercase", letterSpacing: ".08em" }}>{sec}</div>
              {filtered.filter(c => c.section === sec).map((cmd, i) => (
                <button key={i} onClick={cmd.action} style={{ width: "100%", padding: "8px 14px", textAlign: "left", border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font)", fontSize: 13.5, color: "var(--t1)", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "background .1s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "var(--s2)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <span>{cmd.label}</span>
                  {cmd.sub && <span style={{ fontSize: 11.5, color: "var(--t4)", fontFamily: "var(--mono)" }}>{cmd.sub}</span>}
                </button>
              ))}
            </div>
          ))}
          {!filtered.length && <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--t3)", fontSize: 13 }}>No results</div>}
        </div>
        <div style={{ padding: "8px 14px", borderTop: "1px solid var(--b)", fontSize: 11, color: "var(--t4)", display: "flex", gap: 12 }}>
          <span><kbd style={{ padding: "1px 5px", borderRadius: 3, border: "1px solid var(--bm)", background: "var(--s2)", fontFamily: "var(--mono)", fontSize: 10 }}>↵</kbd> select</span>
          <span><kbd style={{ padding: "1px 5px", borderRadius: 3, border: "1px solid var(--bm)", background: "var(--s2)", fontFamily: "var(--mono)", fontSize: 10 }}>↑↓</kbd> navigate</span>
        </div>
      </div>
    </div>
  );
}

// ─── NAV ──────────────────────────────────────────────────────────────────────
function Nav({ page, onNav, onPalette }) {
  return (
    <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 28px", height: 54, borderBottom: "1px solid var(--b)", background: "rgba(255,255,255,.92)", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(16px)" }}>
      <div onClick={() => onNav("dashboard")} style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", userSelect: "none" }}>
        <div style={{ width: 24, height: 24, borderRadius: 7, background: "#111827", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 3px rgba(0,0,0,.3)" }}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="2.2" fill="#fff" /><circle cx="6.5" cy="6.5" r="4.8" stroke="#fff" strokeWidth="1" opacity=".35" /><path d="M6.5 1.5v2M6.5 9.5v2M1.5 6.5h2M9.5 6.5h2" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" /></svg>
        </div>
        <span style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: "-.025em", color: "var(--t1)" }}>ActionGate</span>
      </div>
      <div style={{ display: "flex", gap: 2 }}>
        {[{ k: "dashboard", l: "Dashboard" }, { k: "integrations", l: "Integrations" }].map(({ k, l }) => (
          <button key={k} onClick={() => onNav(k)} className={`nav-pill ${page === k ? "on" : ""}`}>{l}</button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={onPalette} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: "var(--r1)", fontSize: 12, fontFamily: "var(--font)", cursor: "pointer", border: "1px solid var(--bm)", background: "var(--s1)", color: "var(--t3)", transition: "all .15s", boxShadow: "var(--shadow-sm)" }}
          onMouseEnter={e => { e.currentTarget.style.color = "var(--t1)"; e.currentTarget.style.borderColor = "var(--bl)"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--t3)"; e.currentTarget.style.borderColor = "var(--bm)"; }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.2" /><path d="M8.5 8.5L11 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10 }}>⌘K</span>
        </button>
        <div style={{ width: 30, height: 30, borderRadius: "50%", background: "linear-gradient(135deg,#374151,#111827)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer", boxShadow: "var(--shadow-sm)" }}>A</div>
      </div>
    </nav>
  );
}

// ─── PERMISSION DIFF MODAL ────────────────────────────────────────────────────
function PermDiffModal({ finding, onClose, onApply }) {
  const [applied, setApplied] = useState(false);
  const typeMap = {
    restrict: { label: "Restrict", bg: "#fff7ed", border: "#fed7aa", color: "#ea580c", icon: "↓" },
    add_gate: { label: "Add gate", bg: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8", icon: "+" },
    revoke:   { label: "Revoke",   bg: "#fef2f2", border: "#fecaca", color: "#dc2626", icon: "×" },
    grant:    { label: "Grant",    bg: "#f0fdf4", border: "#bbf7d0", color: "#16a34a", icon: "✓" },
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 8000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 580, background: "var(--s1)", borderRadius: "var(--r4)", border: "1px solid var(--bm)", boxShadow: "var(--shadow-lg)", overflow: "hidden", animation: "fadeUp .18s ease" }}>
        <div style={{ padding: "16px 22px", borderBottom: "1px solid var(--b)", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>Permission changes</div>
            <div style={{ fontSize: 12.5, color: "var(--t3)" }}>Before & after for: <strong style={{ color: "var(--t2)", fontWeight: 600 }}>{finding.scenario}</strong></div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--t3)", padding: 6, borderRadius: 6, transition: "all .15s" }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--s2)"; e.currentTarget.style.color = "var(--t1)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--t3)"; }}>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M3 3l9 9M12 3l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div style={{ padding: "4px 22px 8px", maxHeight: 420, overflowY: "auto" }}>
          {finding.permission_changes.map((ch, i) => {
            const ts = typeMap[ch.type] || typeMap.restrict;
            return (
              <div key={i} style={{ padding: "14px 0", borderBottom: i < finding.permission_changes.length - 1 ? "1px solid var(--b)" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <code style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--t3)", background: "var(--s2)", border: "1px solid var(--b)", padding: "2px 8px", borderRadius: 4 }}>{ch.key}</code>
                  <span style={{ fontSize: 11, fontWeight: 600, color: ts.color, background: ts.bg, border: `1px solid ${ts.border}`, padding: "2px 9px", borderRadius: 12 }}>{ts.icon} {ts.label}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 28px 1fr", gap: 8, alignItems: "center" }}>
                  <div style={{ padding: "10px 13px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "var(--r2)" }}>
                    <div style={{ fontSize: 9.5, fontWeight: 700, color: "#dc2626", marginBottom: 5, textTransform: "uppercase", letterSpacing: ".07em" }}>Before</div>
                    <div style={{ fontSize: 12.5, color: "#7f1d1d", lineHeight: 1.5, textDecoration: "line-through", textDecorationColor: "#fca5a5" }}>{ch.before}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 5l3 3-3 3" stroke="var(--t4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </div>
                  <div style={{ padding: "10px 13px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "var(--r2)" }}>
                    <div style={{ fontSize: 9.5, fontWeight: 700, color: "#16a34a", marginBottom: 5, textTransform: "uppercase", letterSpacing: ".07em" }}>After</div>
                    <div style={{ fontSize: 12.5, color: "#14532d", lineHeight: 1.5 }}>{ch.after}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--b)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {applied
            ? <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, color: "#16a34a" }}>
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><circle cx="7.5" cy="7.5" r="6" fill="#16a34a" opacity=".12" /><path d="M4.5 7.5l2.5 2.5 4-4" stroke="#16a34a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Changes applied
              </div>
            : <div style={{ fontSize: 12.5, color: "var(--t3)" }}>{finding.permission_changes.length} permission{finding.permission_changes.length !== 1 ? "s" : ""} will change</div>
          }
          <div style={{ display: "flex", gap: 8 }}>
            <Btn v="s" sz="sm" onClick={onClose}>Cancel</Btn>
            {!applied && <Btn v="p" sz="sm" onClick={() => { setApplied(true); onApply && onApply(finding.id); }}>Apply changes →</Btn>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ATTACK PATH GRAPH ────────────────────────────────────────────────────────
function AttackPathGraph({ actions, chains }) {
  if (!actions || actions.length === 0) return null;

  // Layout constants
  const W = 620, H = 320;
  const cx = W / 2, cy = 150;
  const R = 38; // node radius — large enough to fit two lines of text
  const domainColors = { Financial: "#dc2626", Data: "#ea580c", Operations: "#2563eb" };

  const nodes = actions.map((a, i) => {
    const angle = (i / actions.length) * 2 * Math.PI - Math.PI / 2;
    return { ...a, x: cx + 185 * Math.cos(angle), y: cy + 108 * Math.sin(angle), color: domainColors[a.domain] || "#6b7280" };
  });

  const financialNodes = nodes.filter(n => n.domain === "Financial");
  const dataNodes      = nodes.filter(n => n.domain === "Data");
  const dangerPairs    = [];
  if (chains.some(c => c.severity === "critical")) {
    for (const d of dataNodes) for (const f of financialNodes) dangerPairs.push({ from: d, to: f });
  }

  // Compute line endpoints that stop exactly at the circle edge (not center-to-center)
  function edgePoints(from, to, radius) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
    const ux = dx / dist, uy = dy / dist;
    // Start: leave from-circle edge; End: arrive at to-circle edge (back off by radius + arrowhead gap)
    return {
      x1: from.x + ux * (radius + 2),
      y1: from.y + uy * (radius + 2),
      x2: to.x   - ux * (radius + 8), // 8px gap so arrowhead sits outside the stroke
      y2: to.y   - uy * (radius + 8),
    };
  }

  // Truncate action text to two short lines that fit inside radius R
  // Available width ≈ 2 * R * 0.85 = ~65px; at ~6px/char that's ~10 chars per line
  function splitLabel(text) {
    const words = text.split(" ");
    const lines = [];
    let current = "";
    for (const w of words) {
      const next = current ? current + " " + w : w;
      if (next.length > 9 && current) { lines.push(current); current = w; }
      else current = next;
      if (lines.length === 2) { current = ""; break; }
    }
    if (current && lines.length < 2) lines.push(current);
    return lines.slice(0, 2);
  }

  return (
    <div style={{ background: "#fff", border: "1px solid var(--b)", borderRadius: "var(--r3)", padding: "16px 20px", marginBottom: 20, boxShadow: "var(--shadow-sm)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <Label>Permission attack paths</Label>
        {dangerPairs.length > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", padding: "2px 8px", borderRadius: 10 }}>
            {dangerPairs.length} dangerous path{dangerPairs.length !== 1 ? "s" : ""} detected
          </span>
        )}
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", overflow: "visible" }}>
        <defs>
          {/* Arrow marker — refX set so tip lands exactly where the line ends */}
          <marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M1 1L9 5L1 9" fill="none" stroke="#dc2626" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>

        {/* Dangerous path lines — animated, clipped to circle edges */}
        {dangerPairs.map((p, i) => {
          const { x1, y1, x2, y2 } = edgePoints(p.from, p.to, R);
          return (
            <line key={i}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="#dc2626" strokeWidth="1.5" strokeDasharray="6 4" opacity=".55"
              markerEnd="url(#arrowhead)"
              style={{ animation: "dashFlow 1.2s linear infinite", strokeDashoffset: 0 }}
            />
          );
        })}

        {/* Node circles */}
        {nodes.map((n, i) => {
          const isCrit = n.risk_level === "critical";
          const lines  = splitLabel(n.action);
          // Vertical centering: domain label + action lines stacked, centered in circle
          // Total text block height: 13px (domain) + lines.length * 12px (action lines)
          const blockH = 13 + lines.length * 12;
          const topY   = n.y - blockH / 2 + 6; // +6 for dominant-baseline offset
          return (
            <g key={i}>
              {/* Dashed outer ring for critical nodes */}
              {isCrit && (
                <circle cx={n.x} cy={n.y} r={R + 9} fill="none" stroke={n.color}
                  strokeWidth="1" opacity=".2" strokeDasharray="4 3" />
              )}
              {/* Main circle */}
              <circle cx={n.x} cy={n.y} r={R}
                fill={n.color + "12"} stroke={n.color}
                strokeWidth={isCrit ? 1.5 : 1} opacity={isCrit ? 1 : .8} />
              {/* Irreversible dot — top-right of circle, outside stroke */}
              {!n.reversible && (
                <circle cx={n.x + R * 0.68} cy={n.y - R * 0.68} r={6}
                  fill="#dc2626" stroke="#fff" strokeWidth="1.5" />
              )}
              {/* Domain abbreviation — bold, top of text block */}
              <text
                x={n.x} y={topY}
                textAnchor="middle" dominantBaseline="middle"
                style={{ fontSize: 9, fontWeight: 700, fill: n.color, fontFamily: "var(--font)", textTransform: "uppercase", letterSpacing: ".05em" }}>
                {n.domain.slice(0, 3)}
              </text>
              {/* Action label — wrapped into up to 2 lines, centered */}
              {lines.map((line, li) => (
                <text key={li}
                  x={n.x} y={topY + 13 + li * 12}
                  textAnchor="middle" dominantBaseline="middle"
                  style={{ fontSize: 8, fill: "#4b5563", fontFamily: "var(--font)" }}>
                  {line}
                </text>
              ))}
            </g>
          );
        })}

        {/* Legend */}
        {Object.entries(domainColors).map(([d, c], i) => (
          <g key={d} transform={`translate(${16 + i * 108}, ${H - 22})`}>
            <circle cx="5" cy="5" r="5" fill={c + "18"} stroke={c} strokeWidth="1" />
            <text x="14" y="9" style={{ fontSize: 9.5, fill: "#6b7280", fontFamily: "var(--font)" }}>{d}</text>
          </g>
        ))}
        <g transform={`translate(${16 + 3 * 108}, ${H - 22})`}>
          <line x1="0" y1="5" x2="18" y2="5" stroke="#dc2626" strokeWidth="1.5" strokeDasharray="4 3" opacity=".7" />
          <text x="24" y="9" style={{ fontSize: 9.5, fill: "#6b7280", fontFamily: "var(--font)" }}>Dangerous path</text>
        </g>
        <g transform={`translate(${16 + 4.3 * 108}, ${H - 22})`}>
          <circle cx="5" cy="5" r="5" fill="#dc2626" />
          <text x="14" y="9" style={{ fontSize: 9.5, fill: "#6b7280", fontFamily: "var(--font)" }}>Irreversible</text>
        </g>
      </svg>

      {/* Dangerous chains list */}
      {chains.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8, paddingTop: 12, borderTop: "1px solid var(--b)" }}>
          {chains.map((chain, i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "10px 14px", background: chain.severity === "critical" ? "#fef2f2" : "#fff7ed", border: `1px solid ${chain.severity === "critical" ? "#fecaca" : "#fed7aa"}`, borderRadius: "var(--r2)", borderLeft: `3px solid ${chain.severity === "critical" ? "#dc2626" : "#ea580c"}` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: chain.severity === "critical" ? "#dc2626" : "#ea580c", marginBottom: 2 }}>{chain.description}</div>
                <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.5 }}>{chain.risk}</div>
              </div>
              <Badge variant={chain.severity === "critical" ? "red" : "orange"} style={{ alignSelf: "flex-start", flexShrink: 0 }}>{chain.severity}</Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SCENARIO CARD ────────────────────────────────────────────────────────────
function ScenarioCard({ finding, agentScore, onCopy, onApply, applied }) {
  const [showDiff, setShowDiff] = useState(false);
  const exp     = finding.business_impact.financial.reduce((s, f) => s + (f.amount || 0), 0);
  const isCrit  = finding.severity === "critical";
  const accent  = isCrit ? "#dc2626" : "#ea580c";
  const accentBg     = isCrit ? "#fef2f2" : "#fff7ed";
  const accentBorder = isCrit ? "#fecaca" : "#fed7aa";
  const reduction    = isCrit ? 15 : 10;
  const reduced      = Math.max(0, agentScore - reduction);

  return (
    <>
      {showDiff && <PermDiffModal finding={finding} onClose={() => setShowDiff(false)} onApply={id => { onApply(id); setShowDiff(false); }} />}
      <div style={{ border: `1px solid ${accentBorder}`, borderRadius: "var(--r3)", overflow: "hidden", background: "#fff", animation: "fadeUp .3s ease", boxShadow: "var(--shadow-sm)" }}>
        {/* Header */}
        <div style={{ padding: "12px 18px", background: accentBg, borderBottom: `1px solid ${accentBorder}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: accent, flexShrink: 0, animation: isCrit ? "pulseRed 2.5s ease-in-out infinite" : "pulseOrange 2.5s ease-in-out infinite" }} />
            <span style={{ fontSize: 13.5, fontWeight: 700, color: accent }}>{finding.scenario}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {exp > 0 && <span style={{ fontSize: 13, fontWeight: 700, color: accent, fontFamily: "var(--mono)" }}>${(exp / 100).toLocaleString()} at risk</span>}
            <Badge variant={isCrit ? "red" : "orange"}>{finding.severity}</Badge>
          </div>
        </div>

        <div style={{ padding: 18 }}>
          {/* Tool chain */}
          <Label style={{ marginBottom: 8 }}>What the agent does</Label>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0, marginBottom: 16 }}>
            {finding.business_impact.tools_called.map((t, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center" }}>
                <code style={{ padding: "5px 10px", borderRadius: "var(--r1)", background: "var(--s2)", border: "1px solid var(--bm)", fontSize: 11.5, fontFamily: "var(--mono)", color: "var(--t2)", fontWeight: 500 }}>{t}</code>
                {i < finding.business_impact.tools_called.length - 1 && (
                  <svg width="22" height="14" viewBox="0 0 22 14" fill="none"><path d="M3 7h16M14 3l5 4-5 4" stroke="var(--t4)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                )}
              </div>
            ))}
          </div>

          {/* Outcome */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1, height: 1, background: "var(--b)" }} />
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--t4)", textTransform: "uppercase", letterSpacing: ".07em" }}>outcome</span>
            <div style={{ flex: 1, height: 1, background: "var(--b)" }} />
          </div>
          <div style={{ padding: "12px 14px", background: accentBg, border: `1px solid ${accentBorder}`, borderRadius: "var(--r2)", marginBottom: 16, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
              <path d="M8 1.5L1 14.5h14L8 1.5z" stroke={accent} strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M8 6.5v3.5M8 12v.5" stroke={accent} strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: accent, marginBottom: 2 }}>No human approval requested</div>
              <div style={{ fontSize: 12.5, color: "var(--t2)", lineHeight: 1.55 }}>{finding.outcome}</div>
            </div>
          </div>

          {/* Fix */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1, height: 1, background: "var(--b)" }} />
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--t4)", textTransform: "uppercase", letterSpacing: ".07em" }}>fix</span>
            <div style={{ flex: 1, height: 1, background: "var(--b)" }} />
          </div>

          {applied ? (
            <div style={{ padding: "12px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "var(--r2)", display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" fill="#16a34a" opacity=".15" /><path d="M5 8l2.5 2.5L11 5.5" stroke="#16a34a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>Fix applied — blast radius {agentScore} → {reduced}</span>
            </div>
          ) : (
            <div style={{ background: "var(--s2)", border: "1px solid var(--bm)", borderRadius: "var(--r2)", padding: "14px" }}>
              <div style={{ fontSize: 13, color: "var(--t1)", lineHeight: 1.65, marginBottom: 14 }}>{finding.recommendation}</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Label>Score impact</Label>
                  <span style={{ fontSize: 15, fontWeight: 700, color: getScoreColor(agentScore), fontFamily: "var(--mono)" }}>{agentScore}</span>
                  <svg width="16" height="12" viewBox="0 0 16 12" fill="none"><path d="M2 6h12M9 2l4 4-4 4" stroke="var(--t4)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <span style={{ fontSize: 15, fontWeight: 700, color: getScoreColor(reduced), fontFamily: "var(--mono)" }}>{reduced}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: "#16a34a", background: "#f0fdf4", border: "1px solid #bbf7d0", padding: "2px 7px", borderRadius: 10 }}>−{reduction} pts</span>
                </div>
                <div style={{ display: "flex", gap: 7 }}>
                  <Btn v="s" sz="sm" onClick={() => onCopy && onCopy(finding.recommendation)}>
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" /><path d="M8 3V2a1 1 0 00-1-1H1a1 1 0 00-1 1v6a1 1 0 001 1h1" stroke="currentColor" strokeWidth="1.2" /></svg>
                    Copy
                  </Btn>
                  <Btn v="p" sz="sm" onClick={() => setShowDiff(true)}>View permission diff →</Btn>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── PRIVILEGE TABLE ──────────────────────────────────────────────────────────
function PrivTable({ actions }) {
  function decide(a) {
    if (a.risk_level === "critical") return { label: "Revoke",          color: "#dc2626", bg: "#fef2f2", border: "#fecaca", reason: "Irreversible + unlimited scope — too dangerous to grant autonomously" };
    if (a.risk_level === "high")     return { label: "Restrict",        color: "#ea580c", bg: "#fff7ed", border: "#fed7aa", reason: "Cap scope and add an approval gate for sensitive actions" };
    if (a.risk_level === "medium")   return { label: "Grant w/ limits", color: "#ca8a04", bg: "#fefce8", border: "#fef08a", reason: "Allow read-only access; audit logging required" };
    return                                  { label: "Grant",           color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", reason: "Low risk — safe for autonomous operation" };
  }
  return (
    <div style={{ background: "#fff", border: "1px solid var(--b)", borderRadius: "var(--r3)", overflow: "hidden", boxShadow: "var(--shadow-sm)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 130px 1fr", padding: "9px 18px", background: "var(--s2)", borderBottom: "1px solid var(--b)" }}>
        <Label>Permission</Label>
        <Label style={{ textAlign: "center" }}>Decision</Label>
        <Label>Reason</Label>
      </div>
      {actions.map((a, i) => {
        const d = decide(a);
        return (
          <div key={a.permission_key} className="hrow" style={{ display: "grid", gridTemplateColumns: "1fr 130px 1fr", padding: "13px 18px", borderBottom: i < actions.length - 1 ? "1px solid var(--b)" : "none", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", marginBottom: 2 }}>{a.action}</div>
              <code style={{ fontSize: 10.5, color: "var(--t4)", fontFamily: "var(--mono)" }}>{a.permission_key}</code>
            </div>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: d.color, background: d.bg, border: `1px solid ${d.border}`, padding: "4px 12px", borderRadius: 20 }}>{d.label}</span>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.5 }}>{d.reason}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── AGENT DETAIL ─────────────────────────────────────────────────────────────
function AgentDetail({ agent, findings, onBack, onCopy }) {
  const agentFindings = findings.filter(f => f.agent_id === agent.id);
  const [applied, setApplied] = useState([]);
  const reduction = applied.reduce((s, id) => {
    const f = agentFindings.find(x => x.id === id);
    return s + (f ? (f.severity === "critical" ? 15 : 10) : 0);
  }, 0);
  const liveScore = Math.max(0, agent.blast_radius_score - reduction);

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 24px" }}>
      {/* Back */}
      <button onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, color: "var(--t3)", background: "none", border: "none", cursor: "pointer", marginBottom: 24, fontFamily: "var(--font)", padding: 0, transition: "color .15s" }}
        onMouseEnter={e => e.currentTarget.style.color = "var(--t1)"}
        onMouseLeave={e => e.currentTarget.style.color = "var(--t3)"}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 3L5 7l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        All agents
      </button>

      {/* Hero */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 36, flexWrap: "wrap" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.03em" }}>{agent.name}</h1>
            {agent.blast_radius_score >= 70 && <Badge variant="red" style={{ animation: "pulseRed 3s ease-in-out infinite" }}>Critical risk</Badge>}
          </div>
          <div style={{ fontSize: 13.5, color: "var(--t3)", marginBottom: 14, lineHeight: 1.55, maxWidth: 480 }}>{agent.purpose}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{agent.connected_systems.map(s => <SysBadge key={s} system={s} />)}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "20px 28px", background: "#fff", border: "1px solid var(--b)", borderRadius: "var(--r4)", boxShadow: "var(--shadow-sm)" }}>
          <ScoreRing score={liveScore} size={108} sw={9} />
          <Label>Blast radius</Label>
          {reduction > 0 && <span style={{ fontSize: 11.5, color: "#16a34a", fontWeight: 600, background: "#f0fdf4", padding: "2px 8px", borderRadius: 8, border: "1px solid #bbf7d0" }}>↓ {reduction} pts applied</span>}
        </div>
      </div>

      {/* ── SECTION 1 ── */}
      <div style={{ marginBottom: 36 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
          <div className="section-num" style={{ background: "#111827" }}><span style={{ fontSize: 10.5, fontWeight: 700, color: "#fff" }}>1</span></div>
          <h2 style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.01em" }}>What this agent can do</h2>
        </div>
        <p style={{ fontSize: 13, color: "var(--t3)", marginBottom: 14, paddingLeft: 32, lineHeight: 1.55 }}>Every permission this agent currently holds across all connected systems.</p>

        {/* Attack path map — restored */}
        {agent.business_actions.length > 0 && (
          <AttackPathGraph actions={agent.business_actions} chains={agent.dangerous_chains} />
        )}

        <div style={{ background: "#fff", border: "1px solid var(--b)", borderRadius: "var(--r3)", overflow: "hidden", boxShadow: "var(--shadow-sm)" }}>
          <div style={{ padding: "10px 18px", background: "var(--s2)", borderBottom: "1px solid var(--b)", display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
            {["critical","high","medium","low"].map(level => {
              const count = agent.business_actions.filter(a => a.risk_level === level).length;
              if (!count) return null;
              const rm = RISK_META[level];
              return (
                <div key={level} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: rm.dot }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: rm.dot }}>{count} {level}</span>
                </div>
              );
            })}
            <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--t3)" }}>
              {agent.business_actions.filter(a => !a.reversible).length} irreversible
            </span>
          </div>
          <div style={{ padding: "0 18px" }}>
            {agent.business_actions.length > 0 ? agent.business_actions.map((a, i) => {
              const rm = RISK_META[a.risk_level] || RISK_META.low;
              return (
                <div key={a.permission_key} style={{ display: "flex", gap: 14, padding: "14px 0", borderBottom: i < agent.business_actions.length - 1 ? "1px solid var(--b)" : "none", alignItems: "flex-start" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, paddingTop: 2, flexShrink: 0, width: 52 }}>
                    <div style={{ width: 9, height: 9, borderRadius: "50%", background: rm.dot }} />
                    <span style={{ fontSize: 9.5, fontWeight: 700, color: rm.dot, textTransform: "uppercase", letterSpacing: ".04em" }}>{rm.label}</span>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600 }}>{a.action}</span>
                      <Badge>{a.domain}</Badge>
                      {!a.reversible && <Badge variant="red" style={{ fontSize: 10 }}>Irreversible</Badge>}
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.5 }}>{a.description}</div>
                  </div>
                  <code style={{ fontSize: 10.5, color: "var(--t4)", fontFamily: "var(--mono)", background: "var(--s2)", padding: "3px 7px", borderRadius: 4, border: "1px solid var(--b)", alignSelf: "center", flexShrink: 0 }}>{a.permission_key}</code>
                </div>
              );
            }) : (
              <div style={{ padding: "32px 0", textAlign: "center", color: "var(--t3)", fontSize: 13 }}>No permissions discovered yet. Run a scan to map this agent's authority.</div>
            )}
          </div>
        </div>
      </div>

      {/* ── SECTION 2 ── */}
      <div style={{ marginBottom: 36 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
          <div className="section-num" style={{ background: "#dc2626" }}><span style={{ fontSize: 10.5, fontWeight: 700, color: "#fff" }}>2</span></div>
          <h2 style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.01em" }}>Worst-case scenarios</h2>
        </div>
        <p style={{ fontSize: 13, color: "var(--t3)", marginBottom: 14, paddingLeft: 32, lineHeight: 1.55 }}>Simulated attack paths — what happens, the damage, and the exact permission changes to fix it.</p>
        {agentFindings.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {agentFindings.map(f => (
              <ScenarioCard key={f.id} finding={f} agentScore={agent.blast_radius_score} onCopy={onCopy}
                onApply={id => setApplied(prev => [...new Set([...prev, id])])} applied={applied.includes(f.id)} />
            ))}
          </div>
        ) : (
          <div style={{ background: "#fff", border: "1px solid var(--b)", borderRadius: "var(--r3)", padding: "40px 24px", textAlign: "center", boxShadow: "var(--shadow-sm)" }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No simulations run yet</div>
            <div style={{ fontSize: 13, color: "var(--t3)", maxWidth: 300, margin: "0 auto" }}>Run a simulation to discover worst-case scenarios and generate fixes.</div>
          </div>
        )}
      </div>

      {/* ── SECTION 3 ── */}
      {agent.business_actions.length > 0 && (
        <div style={{ marginBottom: 36 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
            <div className="section-num" style={{ background: "#2563eb" }}><span style={{ fontSize: 10.5, fontWeight: 700, color: "#fff" }}>3</span></div>
            <h2 style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.01em" }}>Privilege recommendations</h2>
          </div>
          <p style={{ fontSize: 13, color: "var(--t3)", marginBottom: 14, paddingLeft: 32, lineHeight: 1.55 }}>Which permissions to grant, restrict, or revoke based on what this agent actually needs.</p>
          <PrivTable actions={agent.business_actions} />
        </div>
      )}
    </div>
  );
}

// ─── AGENT ROW (dashboard) ────────────────────────────────────────────────────
function AgentRow({ agent, findings, onView }) {
  const color  = getScoreColor(agent.blast_radius_score);
  const bg     = getScoreBg(agent.blast_radius_score);
  const isCrit = agent.blast_radius_score >= 70;
  const exp    = findings.filter(f => f.agent_id === agent.id).reduce((s, f) => s + f.business_impact.financial.reduce((a, b) => a + (b.amount || 0), 0), 0);

  return (
    <div className="card card-h" style={{ padding: 0, overflow: "hidden", cursor: "pointer", ...(isCrit ? { borderColor: "#fecaca", background: "#fff8f8" } : {}) }} onClick={onView}>
      <div style={{ display: "flex", alignItems: "stretch" }}>
        {/* Score column */}
        <div style={{ width: 76, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, background: bg, borderRight: `1px solid ${isCrit ? "#fecaca" : "var(--b)"}`, padding: "18px 10px" }}>
          <span style={{ fontSize: 24, fontWeight: 800, color, lineHeight: 1, fontFamily: "var(--mono)", letterSpacing: "-.02em" }}>{agent.blast_radius_score}</span>
          <span style={{ fontSize: 9, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: ".06em" }}>score</span>
        </div>
        {/* Content */}
        <div style={{ flex: 1, padding: "14px 18px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 7 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{agent.name}</span>
                {isCrit && <Badge variant="red" style={{ fontSize: 10 }}>Critical</Badge>}
                {agent.findings_count > 0 && !isCrit && <Badge variant="orange" style={{ fontSize: 10 }}>{agent.findings_count} finding{agent.findings_count !== 1 ? "s" : ""}</Badge>}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--t3)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 500, color: "var(--t2)" }}>{agent.owner}</span>
                <span style={{ color: "var(--t4)" }}>·</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 340 }}>{agent.purpose}</span>
              </div>
            </div>
            <Btn v="s" sz="sm" onClick={e => { e.stopPropagation(); onView(); }} style={{ flexShrink: 0 }}>View report →</Btn>
          </div>
          {/* Progress */}
          <div style={{ height: 3, background: "var(--s3)", borderRadius: 2, overflow: "hidden", marginBottom: 10, maxWidth: 280 }}>
            <div style={{ width: agent.blast_radius_score + "%", height: "100%", background: color, borderRadius: 2, transition: "width .7s cubic-bezier(.4,0,.2,1)" }} />
          </div>
          {/* Footer */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>{agent.connected_systems.map(s => <SysBadge key={s} system={s} />)}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 11.5, color: "var(--t3)" }}>
              {exp > 0 && <span style={{ color: "#dc2626", fontWeight: 600 }}>${(exp / 100).toLocaleString()} exposure</span>}
              {agent.last_scanned && <span>Scanned {new Date(agent.last_scanned).toLocaleDateString()}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ agents, findings, onNavigate }) {
  const sorted   = [...agents].sort((a, b) => b.blast_radius_score - a.blast_radius_score);
  const critical = sorted.filter(a => a.blast_radius_score >= 70);
  const others   = sorted.filter(a => a.blast_radius_score < 70);
  const totalExp = findings.reduce((s, f) => s + f.business_impact.financial.reduce((a, b) => a + (b.amount || 0), 0), 0);
  const totalFindings = agents.reduce((s, a) => s + a.findings_count, 0);

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "32px 24px" }}>
      <div style={{ marginBottom: 26 }}>
        <h1 style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-.03em", marginBottom: 4 }}>Agent Overview</h1>
        <p style={{ fontSize: 13, color: "var(--t3)", lineHeight: 1.5 }}>Monitor blast radius and permission risk across all deployed agents</p>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 28 }}>
        {[
          { label: "Total agents",  value: agents.length,  sub: `${[...new Set(agents.flatMap(a => a.connected_systems))].length} connected systems`, color: undefined },
          { label: "Critical risk", value: critical.length, sub: critical.length > 0 ? "Needs immediate review" : "All clear", color: critical.length > 0 ? "#dc2626" : "#16a34a" },
          { label: "Open findings", value: totalFindings,   sub: `$${(totalExp / 100).toLocaleString()} max exposure`, color: totalFindings > 0 ? "#dc2626" : undefined },
          { label: "Simulations",   value: 12,             sub: "Last 30 days", color: undefined },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className="card" style={{ padding: "16px 18px" }}>
            <Label style={{ marginBottom: 9 }}>{label}</Label>
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.04em", color: color || "var(--t1)", lineHeight: 1, marginBottom: 5 }}>{value}</div>
            <div style={{ fontSize: 11.5, color: "var(--t3)" }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Critical */}
      {critical.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--red)", animation: "pulseRed 2s ease-in-out infinite" }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--red)" }}>Needs attention</span>
            <span style={{ fontSize: 12.5, color: "var(--t3)" }}>· {critical.length} agent{critical.length > 1 ? "s" : ""} with critical blast radius</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {critical.map(a => <AgentRow key={a.id} agent={a} findings={findings} onView={() => onNavigate("agent", a.id)} />)}
          </div>
        </div>
      )}

      {/* Others */}
      {others.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <Label>All agents</Label>
            <span style={{ fontSize: 11.5, color: "var(--t3)" }}>{others.length} agent{others.length !== 1 ? "s" : ""}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {others.map(a => <AgentRow key={a.id} agent={a} findings={findings} onView={() => onNavigate("agent", a.id)} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── INTEGRATIONS ─────────────────────────────────────────────────────────────
function IntegrationCard({ integration }) {
  const [connecting, setConnecting] = useState(false);
  const [connected,  setConnected]  = useState(integration.status === "connected");
  const [fields, setFields] = useState({});
  const isSF = integration.system === "salesforce";
  const color = BRAND[integration.system] || "#6b7280";

  const handleConnect = async () => {
    setConnecting(true);
    try { await api.integrations.connect(integration.system, fields); } catch {}
    await new Promise(r => setTimeout(r, 1400));
    setConnecting(false); setConnected(true);
  };

  return (
    <div className="card" style={{ padding: "18px 20px", opacity: isSF ? .55 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: "var(--r2)", display: "flex", alignItems: "center", justifyContent: "center", background: color + "16", border: `1px solid ${color}28` }}>
            <span style={{ fontSize: 16, fontWeight: 800, color, fontFamily: "var(--mono)" }}>{integration.system[0].toUpperCase()}</span>
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, textTransform: "capitalize" }}>{integration.system}</div>
            <div style={{ fontSize: 12, color: "var(--t3)" }}>{isSF ? "Coming soon" : connected ? "Connected · Sandbox mode" : "Not connected"}</div>
          </div>
        </div>
        <Badge variant={connected ? "green" : "gray"}>{connected ? "● Connected" : "Disconnected"}</Badge>
      </div>
      {connected ? (
        <div>
          <div style={{ padding: "8px 12px", background: "var(--s2)", borderRadius: "var(--r1)", fontFamily: "var(--mono)", fontSize: 12, color: "var(--t3)", marginBottom: 10, border: "1px solid var(--b)" }}>sk_test_••••••••••••••••</div>
          {Object.entries(integration.metadata).map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: "var(--t3)" }}>{k}</span>
              <span style={{ fontWeight: 600, fontFamily: "var(--mono)" }}>{v}</span>
            </div>
          ))}
        </div>
      ) : !isSF ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {integration.system === "stripe"  && <input placeholder="sk_test_…" onChange={e => setFields({ ...fields, api_key: e.target.value })} />}
          {integration.system === "zendesk" && <>
            <input placeholder="Subdomain"  onChange={e => setFields({ ...fields, subdomain:  e.target.value })} />
            <input placeholder="Email"      onChange={e => setFields({ ...fields, email:       e.target.value })} />
            <input placeholder="API token"  onChange={e => setFields({ ...fields, api_token:   e.target.value })} />
          </>}
          <Btn v="p" sz="sm" loading={connecting} onClick={handleConnect} style={{ alignSelf: "flex-start", marginTop: 4 }}>Connect</Btn>
        </div>
      ) : null}
    </div>
  );
}

function IntegrationsPage({ integrations, onNavigate }) {
  const [analyzing, setAnalyzing] = useState(false);
  const conn = integrations.filter(i => i.status === "connected").length;
  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 24px" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-.03em", marginBottom: 4 }}>Connected Systems</h1>
        <p style={{ fontSize: 13, color: "var(--t3)" }}>Connect your tools to begin mapping agent authority</p>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24, padding: "12px 16px", background: "#fff", border: "1px solid var(--b)", borderRadius: "var(--r2)", boxShadow: "var(--shadow-sm)" }}>
        <div style={{ flex: 1, height: 4, background: "var(--s3)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ width: (conn / integrations.length * 100) + "%", height: "100%", background: "var(--green)", borderRadius: 2, transition: "width .5s ease" }} />
        </div>
        <span style={{ fontSize: 12, color: "var(--t2)", fontFamily: "var(--mono)", flexShrink: 0 }}>{conn}/{integrations.length} connected</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 28 }}>
        {integrations.map(i => <IntegrationCard key={i.system} integration={i} />)}
      </div>
      <div style={{ textAlign: "center", paddingTop: 20, borderTop: "1px solid var(--b)" }}>
        <Btn v="p" sz="lg" loading={analyzing} onClick={async () => { setAnalyzing(true); await new Promise(r => setTimeout(r, 2000)); onNavigate("dashboard"); }}>Analyze agents →</Btn>
        <div style={{ fontSize: 12, color: "var(--t3)", marginTop: 8 }}>Scans all connected systems and maps every agent permission</div>
      </div>
    </div>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
export default function ActionGate() {
  const [page,    setPage]    = useState("dashboard");
  const [agentId, setAgentId] = useState(null);
  const [palette, setPalette] = useState(false);
  const { show: toast, Toast } = useToast();

  const nav = useCallback((p, id) => {
    if (p === "agent" && id) { setAgentId(id); setPage("agent"); }
    else { setPage(p); setAgentId(null); }
  }, []);

  const copy = useCallback(text => {
    navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard")).catch(() => toast("Failed to copy"));
  }, [toast]);

  useEffect(() => {
    const h = e => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setPalette(p => !p); }
      if (e.key === "Escape") setPalette(false);
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  const agent = PLACEHOLDER_AGENTS.find(a => a.id === agentId);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <style>{G}</style>
      <Nav page={page === "agent" ? "dashboard" : page} onNav={nav} onPalette={() => setPalette(true)} />
      <CmdPalette open={palette} onClose={() => setPalette(false)} agents={PLACEHOLDER_AGENTS} onNavigate={nav} />
      {Toast}
      {page === "dashboard"    && <Dashboard agents={PLACEHOLDER_AGENTS} findings={PLACEHOLDER_FINDINGS} onNavigate={nav} />}
      {page === "integrations" && <IntegrationsPage integrations={PLACEHOLDER_INTEGRATIONS} onNavigate={nav} />}
      {page === "agent" && agent && <AgentDetail agent={agent} findings={PLACEHOLDER_FINDINGS} onBack={() => nav("dashboard")} onCopy={copy} />}
    </div>
  );
}
