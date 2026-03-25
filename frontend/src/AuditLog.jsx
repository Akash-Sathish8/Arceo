import { useState, useEffect } from "react";
import { apiFetch } from "./api.js";
import "./LogPages.css";

export default function AuditLog() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiFetch("/api/audit")
      .then((d) => { setEntries(d.entries); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return <div className="log-page"><div className="log-loading"><div className="spinner" />Loading...</div></div>;
  if (error) return <div className="log-page"><div className="log-error">{error}</div></div>;

  return (
    <div className="log-page">
      <h1>Audit Log</h1>
      <p className="log-subtitle">Every action taken in ActionGate is recorded here.</p>

      <table className="log-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Action</th>
            <th>Resource</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="log-time">{new Date(e.timestamp).toLocaleString()}</td>
              <td>{e.user_email || "—"}</td>
              <td><span className="action-badge">{e.action}</span></td>
              <td className="mono">{e.resource || "—"}</td>
              <td className="log-detail">{e.detail || "—"}</td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr><td colSpan={5} className="log-empty">No audit entries yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
