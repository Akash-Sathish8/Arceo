import { useState, useEffect, useMemo } from "react";
import { apiFetch } from "./api.js";
import "./LogPages.css";

const formatAction = (action) =>
  action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const actionRiskDot = (tool, action) => {
  const s = `${tool}.${action}`.toLowerCase();
  if (/delete|terminate|drop|destroy|remove|cancel/.test(s)) return "destructive";
  if (/charge|transfer|pay|refund|create_charge/.test(s)) return "financial";
  if (/send|email|message|notify/.test(s)) return "sends";
  return "readonly";
};

const RISK_META = {
  destructive: { dot: "#9ca3af", border: "#fca5a5", row: "#fff5f5", label: "Destructive — permanently deletes or cancels something" },
  financial:   { dot: "#2563eb", border: "transparent", row: "transparent", label: "Financial — moves or modifies money" },
  sends:       { dot: "#7c3aed", border: "transparent", row: "transparent", label: "Sends message — emails, SMS, or webhooks" },
  readonly:    { dot: "#9ca3af", border: "transparent", row: "transparent", label: "Read-only — no data was changed" },
};

const STATUS_STYLE = {
  EXECUTED:         { bg: "#d4edda", color: "#155724", label: "Executed" },
  BLOCKED:          { bg: "#f8d7da", color: "#721c24", label: "Blocked" },
  PENDING_APPROVAL: { bg: "#fff3cd", color: "#856404", label: "Pending" },
};

const TIME_FILTERS = [
  { value: "all",  label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d",   label: "Last 7d" },
  { value: "30d",  label: "Last 30d" },
];

const TOOL_CHIP_COLORS = {
  stripe:     { bg: "#ede9fe", color: "#6d28d9" },
  zendesk:    { bg: "#fef3c7", color: "#92400e" },
  salesforce: { bg: "#dbeafe", color: "#1e40af" },
  sendgrid:   { bg: "#d1fae5", color: "#065f46" },
  github:     { bg: "#f3f4f6", color: "#111827" },
  slack:      { bg: "#fef3c7", color: "#92400e" },
  aws:        { bg: "#fff7ed", color: "#c2410c" },
  hubspot:    { bg: "#fce7f3", color: "#9d174d" },
  pagerduty:  { bg: "#fef2f2", color: "#991b1b" },
};

// Backend stores UTC timestamps without Z — append it so browsers parse correctly
function parseTs(ts) {
  if (!ts) return new Date();
  return new Date(ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z");
}

function relativeTime(ts) {
  const diff = (Date.now() - parseTs(ts)) / 1000;
  if (diff < 0) return fullTime(ts);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return parseTs(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fullTime(ts) {
  return parseTs(ts).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

// Human-readable audit action labels
const AUDIT_ACTION_LABELS = {
  LOGIN:            "Signed in",
  LOGOUT:           "Signed out",
  LIST_AGENTS:      "Listed agents",
  CREATE_AGENT:     "Created agent",
  UPDATE_AGENT:     "Updated agent",
  DELETE_AGENT:     "Deleted agent",
  CREATE_POLICY:    "Created policy",
  DELETE_POLICY:    "Deleted policy",
  RUN_SIMULATION:   "Ran simulation",
  IMPORT_MCP:       "Imported via MCP",
  IMPORT_OPENAI:    "Imported via OpenAI",
  APPLY_POLICY:     "Applied policy",
};

// Actions that are just data reads — no state change, low signal
const SYSTEM_ACTIONS = new Set(["LIST_AGENTS", "GET_AGENT", "LIST_POLICIES", "LIST_SIMULATIONS"]);

function detailDisplay(detail) {
  if (!detail || detail === "No matching policy") {
    return <span className="log-detail-none">No policy set</span>;
  }
  if (detail.toLowerCase().startsWith("matched policy")) {
    return <span className="log-detail-policy">{detail}</span>;
  }
  return <span>{detail}</span>;
}

export default function History() {
  const [view, setView] = useState("executions");
  const [executions, setExecutions] = useState([]);
  const [auditEntries, setAuditEntries] = useState([]);
  const [agentMap, setAgentMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [timeFilter, setTimeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [hideSystem, setHideSystem] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch("/api/executions"),
      apiFetch("/api/audit"),
      apiFetch("/api/authority/agents").catch(() => ({ agents: [] })),
    ])
      .then(([execData, auditData, agentData]) => {
        setExecutions(execData.entries || []);
        setAuditEntries(auditData.entries || []);
        const map = {};
        (agentData.agents || []).forEach((a) => { map[a.id] = a.name; });
        setAgentMap(map);
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  const applyTimeFilter = (entries) => {
    if (timeFilter === "all") return entries;
    const cutoffs = { today: 86400000, "7d": 7 * 86400000, "30d": 30 * 86400000 };
    const cutoff = new Date(Date.now() - cutoffs[timeFilter]);
    return entries.filter((e) => parseTs(e.timestamp) >= cutoff);
  };

  const filteredExecs = useMemo(() => {
    let result = filterStatus === "all" ? executions : executions.filter((e) => e.status === filterStatus);
    result = applyTimeFilter(result);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((e) =>
        (agentMap[e.agent_id] || e.agent_id || "").toLowerCase().includes(q) ||
        `${e.tool}.${e.action}`.toLowerCase().includes(q) ||
        (e.detail || "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [executions, filterStatus, timeFilter, search, agentMap]);

  const filteredAudit = useMemo(() => {
    let result = applyTimeFilter(auditEntries);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((e) =>
        (e.user_email || "").toLowerCase().includes(q) ||
        (e.action || "").toLowerCase().includes(q) ||
        (e.resource || "").toLowerCase().includes(q) ||
        (e.detail || "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [auditEntries, timeFilter, search, hideSystem]);

  // Group consecutive identical audit entries into one row with a count
  const groupedAudit = useMemo(() => {
    let entries = filteredAudit;
    if (hideSystem) entries = entries.filter((e) => !SYSTEM_ACTIONS.has(e.action));
    const grouped = [];
    entries.forEach((entry) => {
      const last = grouped[grouped.length - 1];
      if (last && last.action === entry.action && last.user_email === entry.user_email) {
        last._count = (last._count || 1) + 1;
      } else {
        grouped.push({ ...entry, _count: 1 });
      }
    });
    return grouped;
  }, [filteredAudit, hideSystem]);

  const systemHiddenCount = filteredAudit.filter((e) => SYSTEM_ACTIONS.has(e.action)).length;

  const blocked = executions.filter((e) => e.status === "BLOCKED").length;
  const executed = executions.filter((e) => e.status === "EXECUTED").length;
  const pending = executions.filter((e) => e.status === "PENDING_APPROVAL").length;
  const total = executions.length;

  const handleExport = () => {
    const isExec = view === "executions";
    const data = isExec ? filteredExecs : filteredAudit;
    const headers = isExec
      ? ["Time", "Agent", "Tool", "Action", "Status", "Detail"]
      : ["Time", "User", "Action", "Resource", "Detail"];
    const rows = [headers];
    data.forEach((e) => {
      rows.push(isExec
        ? [new Date(e.timestamp).toISOString(), agentMap[e.agent_id] || e.agent_id, e.tool, e.action, e.status, e.detail || ""]
        : [new Date(e.timestamp).toISOString(), e.user_email || "", e.action, e.resource || "", e.detail || ""]
      );
    });
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${view}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="log-page"><div className="log-loading"><div className="spinner" />Loading...</div></div>;
  if (error) return <div className="log-page"><div className="log-error">{error}</div></div>;

  const CHIPS = [
    { value: "all",              label: "All",     count: total },
    { value: "EXECUTED",         label: "Executed", count: executed },
    { value: "BLOCKED",          label: "Blocked",  count: blocked },
    { value: "PENDING_APPROVAL", label: "Pending",  count: pending },
  ];

  // Safety ratio bar (blocked / total)
  const blockedPct = total > 0 ? Math.round((blocked / total) * 100) : 0;
  const executedPct = total > 0 ? Math.round((executed / total) * 100) : 0;

  return (
    <div className="log-page">
      {/* Header */}
      <div className="history-header">
        <div>
          <h1>History</h1>
          <p className="log-subtitle">
            {view === "executions"
              ? "What your agents did — and what was stopped."
              : "Every change made in ActionGate."}
          </p>
        </div>
        {/* View toggle — replaces <select> */}
        <div className="view-toggle">
          <button
            className={`view-tab${view === "executions" ? " active" : ""}`}
            onClick={() => { setView("executions"); setFilterStatus("all"); setSearch(""); }}
          >
            Agent Activity
          </button>
          <button
            className={`view-tab${view === "audit" ? " active" : ""}`}
            onClick={() => { setView("audit"); setFilterStatus("all"); setSearch(""); }}
          >
            Change History
          </button>
        </div>
      </div>

      {/* Search + time filter */}
      <div className="history-search-row">
        <div className="history-search-wrap">
          <svg className="history-search-icon" viewBox="0 0 20 20" fill="none">
            <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <input
            className="history-search"
            type="text"
            placeholder={view === "executions" ? "Search by agent, action, or detail…" : "Search by user, action, or resource…"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="filter-chips">
          {TIME_FILTERS.map((f) => (
            <button
              key={f.value}
              className={`filter-chip${timeFilter === f.value ? " active" : ""}`}
              onClick={() => setTimeFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {view === "executions" && (
        <>
          {/* Stats row */}
          <div className="exec-stats">
            <div className="exec-stat">
              <strong>{total}</strong>
              <span>Total Actions</span>
            </div>
            <div className="exec-stat executed">
              <strong>{executed}</strong>
              <span>Executed</span>
              {total > 0 && <div className="exec-stat-bar"><div className="exec-stat-fill exec-fill-green" style={{ width: `${executedPct}%` }} /></div>}
            </div>
            <div className="exec-stat blocked">
              <strong>{blocked}</strong>
              <span>Blocked</span>
              {total > 0 && <div className="exec-stat-bar"><div className="exec-stat-fill exec-fill-red" style={{ width: `${blockedPct}%` }} /></div>}
            </div>
            <div className="exec-stat pending">
              <strong>{pending}</strong>
              <span>Pending Review</span>
            </div>
          </div>

          {/* Filter chips + export */}
          <div className="log-controls">
            <div className="filter-chips">
              {CHIPS.map((chip) => (
                <button
                  key={chip.value}
                  className={`filter-chip${filterStatus === chip.value ? " active" : ""}`}
                  onClick={() => setFilterStatus(chip.value)}
                >
                  {chip.label}<span className="chip-count">{chip.count}</span>
                </button>
              ))}
            </div>
            <button className="export-btn" onClick={handleExport}>↓ Export CSV</button>
          </div>

          {/* Risk legend */}
          <div className="risk-legend" style={{ marginBottom: 10 }}>
            <span className="risk-legend-item"><span className="risk-legend-swatch" style={{ background: "#fff5f5", border: "1.5px solid #fca5a5" }} />Destructive</span>
            <span className="risk-legend-item"><span className="risk-legend-dot" style={{ background: "#2563eb" }} />Financial</span>
            <span className="risk-legend-item"><span className="risk-legend-dot" style={{ background: "#7c3aed" }} />Sends message</span>
            <span className="risk-legend-item"><span className="risk-legend-dot" style={{ background: "#9ca3af" }} />Read-only</span>
          </div>

          {/* Table */}
          <table className="log-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Agent</th>
                <th>Action</th>
                <th>Status</th>
                <th>Policy / Reason</th>
              </tr>
            </thead>
            <tbody>
              {filteredExecs.map((e) => {
                const st = STATUS_STYLE[e.status] || {};
                const risk = actionRiskDot(e.tool, e.action);
                const meta = RISK_META[risk];
                const toolKey = (e.tool || "").toLowerCase();
                const toolChip = TOOL_CHIP_COLORS[toolKey];
                return (
                  <tr
                    key={e.id}
                    className={`log-row log-row-${risk}`}
                    style={meta.row !== "transparent" ? { background: meta.row } : {}}
                  >
                    <td className="log-time">
                      <span className="log-time-rel" title={fullTime(e.timestamp)}>
                        {relativeTime(e.timestamp)}
                      </span>
                      <span className="log-time-full">{fullTime(e.timestamp)}</span>
                    </td>
                    <td className="log-agent">{agentMap[e.agent_id] || e.agent_id}</td>
                    <td>
                      <div className="log-action-cell">
                        <span className="log-action-dot" style={{ background: meta.dot }} title={meta.label} />
                        <span
                          className="log-tool-chip"
                          style={toolChip
                            ? { background: toolChip.bg, color: toolChip.color }
                            : { background: "#f3f4f6", color: "#374151" }
                          }
                        >
                          {e.tool.toUpperCase()}
                        </span>
                        <span className="log-action-name">{formatAction(e.action)}</span>
                      </div>
                    </td>
                    <td>
                      <span className="status-badge" style={{ background: st.bg, color: st.color }}>
                        {st.label || e.status}
                      </span>
                    </td>
                    <td className="log-detail">{detailDisplay(e.detail)}</td>
                  </tr>
                );
              })}
              {filteredExecs.length === 0 && (
                <tr><td colSpan={5}>
                  <div className="table-empty-state">
                    <div className="empty-icon">📋</div>
                    <div className="empty-title">{executions.length === 0 ? "No executions yet" : "No matching entries"}</div>
                    <div className="empty-desc">{executions.length === 0 ? "Actions your agents take will appear here." : "Try a different filter or search term."}</div>
                  </div>
                </td></tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {view === "audit" && (
        <>
          <div className="log-controls">
            <label className="audit-system-toggle">
              <input
                type="checkbox"
                checked={hideSystem}
                onChange={(e) => setHideSystem(e.target.checked)}
              />
              Hide system activity
              {hideSystem && systemHiddenCount > 0 && (
                <span className="audit-hidden-count">{systemHiddenCount} hidden</span>
              )}
            </label>
            <button className="export-btn" onClick={handleExport}>↓ Export CSV</button>
          </div>

          <table className="log-table">
            <thead>
              <tr><th>Time</th><th>User</th><th>Action</th><th>Resource</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {groupedAudit.map((e) => (
                <tr key={e.id}>
                  <td className="log-time">
                    <span className="log-time-rel" title={fullTime(e.timestamp)}>
                      {relativeTime(e.timestamp)}
                    </span>
                    <span className="log-time-full">{fullTime(e.timestamp)}</span>
                  </td>
                  <td className="log-agent">{e.user_email || "—"}</td>
                  <td>
                    <div className="audit-action-cell">
                      <span className="audit-action-label">
                        {AUDIT_ACTION_LABELS[e.action] || e.action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                      </span>
                      {e._count > 1 && <span className="audit-count-badge">×{e._count}</span>}
                    </div>
                  </td>
                  <td className="log-detail">{e.resource || <span className="log-detail-none">—</span>}</td>
                  <td className="log-detail">{e.detail || <span className="log-detail-none">—</span>}</td>
                </tr>
              ))}
              {groupedAudit.length === 0 && (
                <tr><td colSpan={5}>
                  <div className="table-empty-state">
                    <div className="empty-icon">🗂</div>
                    <div className="empty-title">{auditEntries.length === 0 ? "No audit entries yet" : "No matching entries"}</div>
                    <div className="empty-desc">{auditEntries.length === 0 ? "Changes made in ActionGate will be recorded here." : "Try a different filter or search term."}</div>
                  </div>
                </td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
