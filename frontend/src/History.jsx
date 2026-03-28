import { useState, useEffect, useMemo } from "react";
import { apiFetch } from "./api.js";
import "./LogPages.css";

const formatAction = (action) =>
  action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const actionRiskDot = (tool, action) => {
  const s = `${tool}.${action}`.toLowerCase();
  if (/delete|terminate|drop|destroy|remove|cancel/.test(s)) return "#dc2626";
  if (/charge|transfer|pay|refund|create_charge/.test(s)) return "#2563eb";
  if (/send|email|message|notify/.test(s)) return "#7c3aed";
  return "#9ca3af";
};

const STATUS_STYLE = {
  EXECUTED: { bg: "#d4edda", color: "#155724" },
  BLOCKED: { bg: "#f8d7da", color: "#721c24" },
  PENDING_APPROVAL: { bg: "#fff3cd", color: "#856404" },
};

const TIME_FILTERS = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
];

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
    return entries.filter((e) => new Date(e.timestamp) >= cutoff);
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
  }, [auditEntries, timeFilter, search]);

  const blocked = executions.filter((e) => e.status === "BLOCKED").length;
  const executed = executions.filter((e) => e.status === "EXECUTED").length;
  const pending = executions.filter((e) => e.status === "PENDING_APPROVAL").length;

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
    { value: "all", label: "All", count: executions.length },
    { value: "EXECUTED", label: "Executed", count: executed },
    { value: "BLOCKED", label: "Blocked", count: blocked },
    { value: "PENDING_APPROVAL", label: "Pending", count: pending },
  ];

  return (
    <div className="log-page">
      <div className="history-header">
        <div>
          <h1>History</h1>
          <p className="log-subtitle">
            {view === "executions"
              ? "What your agents did — and what was stopped."
              : "Every change made in ActionGate."}
          </p>
        </div>
        <select
          className="view-select"
          value={view}
          onChange={(e) => { setView(e.target.value); setFilterStatus("all"); setSearch(""); }}
        >
          <option value="executions">Agent Activity</option>
          <option value="audit">Change History</option>
        </select>
      </div>

      {/* Search + time filter row */}
      <div className="history-search-row">
        <input
          className="history-search"
          type="text"
          placeholder={view === "executions" ? "Search by agent, action, or detail…" : "Search by user, action, or resource…"}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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
          <div className="exec-stats">
            <div className="exec-stat"><strong>{executions.length}</strong><span>Total</span></div>
            <div className="exec-stat executed"><strong>{executed}</strong><span>Executed</span></div>
            <div className="exec-stat blocked"><strong>{blocked}</strong><span>Blocked</span></div>
          </div>

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

          <div className="risk-legend" style={{ marginBottom: 10 }}>
            <span className="risk-legend-item"><span className="risk-legend-dot" style={{ background: "#dc2626" }} />Destructive</span>
            <span className="risk-legend-item"><span className="risk-legend-dot" style={{ background: "#2563eb" }} />Financial</span>
            <span className="risk-legend-item"><span className="risk-legend-dot" style={{ background: "#7c3aed" }} />Sends message</span>
            <span className="risk-legend-item"><span className="risk-legend-dot" style={{ background: "#9ca3af" }} />Read-only</span>
          </div>

          <table className="log-table">
            <thead>
              <tr><th>Time</th><th>Agent</th><th>Action</th><th>Status</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {filteredExecs.map((e) => {
                const st = STATUS_STYLE[e.status] || {};
                const dot = actionRiskDot(e.tool, e.action);
                const statusLabel = e.status === "PENDING_APPROVAL" ? "Pending" : e.status.charAt(0) + e.status.slice(1).toLowerCase();
                return (
                  <tr key={e.id}>
                    <td className="log-time">{new Date(e.timestamp).toLocaleString()}</td>
                    <td>{agentMap[e.agent_id] || e.agent_id}</td>
                    <td>
                      <div className="log-action-cell">
                        <span className="log-action-dot" style={{ background: dot }} />
                        <span className="log-action-tool">{e.tool.charAt(0).toUpperCase() + e.tool.slice(1)}</span>
                        <span className="log-action-name">{formatAction(e.action)}</span>
                      </div>
                    </td>
                    <td><span className="status-badge" style={{ background: st.bg, color: st.color }}>{statusLabel}</span></td>
                    <td className="log-detail">{e.detail || "—"}</td>
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
            <div />
            <button className="export-btn" onClick={handleExport}>↓ Export CSV</button>
          </div>

          <table className="log-table">
            <thead>
              <tr><th>Time</th><th>User</th><th>Action</th><th>Resource</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {filteredAudit.map((e) => (
                <tr key={e.id}>
                  <td className="log-time">{new Date(e.timestamp).toLocaleString()}</td>
                  <td>{e.user_email || "—"}</td>
                  <td><span className="action-badge">{e.action}</span></td>
                  <td className="mono">{e.resource || "—"}</td>
                  <td className="log-detail">{e.detail || "—"}</td>
                </tr>
              ))}
              {filteredAudit.length === 0 && (
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
