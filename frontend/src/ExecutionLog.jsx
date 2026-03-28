import { useState, useEffect } from "react";
import { apiFetch } from "./api.js";
import "./LogPages.css";

const STATUS_STYLE = {
  EXECUTED: { bg: "#d4edda", color: "#155724" },
  BLOCKED: { bg: "#f8d7da", color: "#721c24" },
  PENDING_APPROVAL: { bg: "#fff3cd", color: "#856404" },
};

export default function ExecutionLog() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterStatus, setFilterStatus] = useState("all");

  useEffect(() => {
    apiFetch("/api/executions")
      .then((d) => { setEntries(d.entries); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  const filtered = filterStatus === "all"
    ? entries
    : entries.filter((e) => e.status === filterStatus);

  if (loading) return <div className="log-page"><div className="log-loading"><div className="spinner" />Loading...</div></div>;
  if (error) return <div className="log-page"><div className="log-error">{error}</div></div>;

  const blocked = entries.filter((e) => e.status === "BLOCKED").length;
  const executed = entries.filter((e) => e.status === "EXECUTED").length;
  const pending = entries.filter((e) => e.status === "PENDING_APPROVAL").length;

  const handleExport = () => {
    const rows = [["Time", "Agent", "Tool", "Action", "Status", "Detail"]];
    filtered.forEach((e) => {
      rows.push([new Date(e.timestamp).toISOString(), e.agent_id, e.tool, e.action, e.status, e.detail || ""]);
    });
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "executions.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const CHIPS = [
    { value: "all", label: "All", count: entries.length },
    { value: "EXECUTED", label: "Executed", count: executed },
    { value: "BLOCKED", label: "Blocked", count: blocked },
    { value: "PENDING_APPROVAL", label: "Pending", count: pending },
  ];

  return (
    <div className="log-page">
      <h1>Execution Log</h1>
      <p className="log-subtitle">What your agents actually did — and what was stopped.</p>

      <div className="exec-stats">
        <div className="exec-stat">
          <strong>{entries.length}</strong><span>Total</span>
        </div>
        <div className="exec-stat executed">
          <strong>{executed}</strong><span>Executed</span>
        </div>
        <div className="exec-stat blocked">
          <strong>{blocked}</strong><span>Blocked</span>
        </div>
      </div>

      <div className="log-controls">
        <div className="filter-chips">
          {CHIPS.map((chip) => (
            <button
              key={chip.value}
              className={`filter-chip${filterStatus === chip.value ? " active" : ""}`}
              onClick={() => setFilterStatus(chip.value)}
            >
              {chip.label}
              <span className="chip-count">{chip.count}</span>
            </button>
          ))}
        </div>
        <button className="export-btn" onClick={handleExport}>↓ Export CSV</button>
      </div>

      <table className="log-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Agent</th>
            <th>Action</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((e) => {
            const st = STATUS_STYLE[e.status] || {};
            return (
              <tr key={e.id}>
                <td className="log-time">{new Date(e.timestamp).toLocaleString()}</td>
                <td className="mono">{e.agent_id}</td>
                <td className="mono">{e.tool}.{e.action}</td>
                <td>
                  <span className="status-badge" style={{ background: st.bg, color: st.color }}>
                    {e.status}
                  </span>
                </td>
                <td className="log-detail">{e.detail || "—"}</td>
              </tr>
            );
          })}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={5}>
                <div className="table-empty-state">
                  <div className="empty-icon">📋</div>
                  <div className="empty-title">
                    {entries.length === 0 ? "No executions yet" : "No matching entries"}
                  </div>
                  <div className="empty-desc">
                    {entries.length === 0 ? "Actions your agents take will appear here." : "Try a different filter."}
                  </div>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
