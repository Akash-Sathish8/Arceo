import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "./api.js";
import { toast } from "./Toast.jsx";
import "./Approvals.css";

function parseTs(ts) {
  if (!ts) return new Date(0);
  return new Date(ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z");
}

function relativeTime(ts) {
  const diff = (Date.now() - parseTs(ts)) / 1000;
  if (diff < 60) return `${Math.max(0, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatAction(s) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function Approvals() {
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState({});
  const [notes, setNotes] = useState({});
  const [decided, setDecided] = useState({}); // id → "approve" | "reject" (post-decision flash)

  const load = useCallback(() => {
    apiFetch("/api/approvals")
      .then((d) => { setApprovals(d.approvals || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 10000);
    return () => clearInterval(iv);
  }, [load]);

  const decide = async (id, decision) => {
    setDeciding((p) => ({ ...p, [id]: decision }));
    try {
      await apiFetch(`/api/approvals/${id}`, {
        method: "POST",
        body: JSON.stringify({ decision, reason: notes[id] || "" }),
      });
      toast(decision === "approve" ? "Action approved" : "Action rejected");
      setDecided((p) => ({ ...p, [id]: decision }));
      setTimeout(() => {
        setApprovals((prev) => prev.filter((a) => a.id !== id));
        setDecided((p) => { const n = { ...p }; delete n[id]; return n; });
      }, 2000);
    } catch (e) {
      toast("Failed: " + e.message, "error");
    } finally {
      setDeciding((p) => { const n = { ...p }; delete n[id]; return n; });
    }
  };

  if (loading) return (
    <div className="approvals-page">
      <div className="approvals-loading"><div className="spinner" /> Loading...</div>
    </div>
  );

  return (
    <div className="approvals-page">
      <header className="approvals-header">
        <div>
          <h1>Approval Queue</h1>
          <p className="approvals-sub">
            Actions your agents flagged for human review before proceeding.
          </p>
        </div>
        {approvals.length > 0 && (
          <span className="approvals-count-badge">{approvals.length} pending</span>
        )}
      </header>

      {approvals.length === 0 ? (
        <div className="approvals-empty">
          <div className="approvals-empty-icon">
            <div className="approvals-empty-icon-circle">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                <path d="M7.5 12l3 3 6-6" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>
          <div className="approvals-empty-title">You're all caught up</div>
          <div className="approvals-empty-desc">
            No actions are waiting for your review right now.
            <br />
            When an agent triggers a <code>REQUIRE_APPROVAL</code> policy, it will pause here until you decide.
            <br /><br />
            <Link to="/" className="approvals-link">Set up a policy on an agent →</Link>
          </div>
        </div>
      ) : (
        <div className="approvals-list">
          {approvals.map((a) => {
            const isBusy = !!deciding[a.id];
            const postDecision = decided[a.id];
            return (
              <div key={a.id} className={`approval-card${postDecision ? " approval-card-decided" : ""}`}>
                {postDecision && (
                  <div className={`approval-decision-flash ${postDecision === "approve" ? "approved" : "rejected"}`}>
                    {postDecision === "approve" ? "✓ Agent resumed" : "✗ Agent blocked"}
                  </div>
                )}
                <div className="approval-card-header">
                  <div className="approval-meta">
                    <Link to={`/agent/${a.agent_id}`} className="approval-agent-link">
                      {a.agent_name || a.agent_id}
                    </Link>
                    <span className="approval-dot">·</span>
                    <span className="approval-time">{relativeTime(a.timestamp)}</span>
                  </div>
                </div>

                <div className="approval-action-row">
                  <span className="approval-tool-chip">{a.tool}</span>
                  <span className="approval-arrow">→</span>
                  <span className="approval-action-name">{formatAction(a.action)}</span>
                </div>

                {a.detail && (
                  <div className="approval-detail">{a.detail}</div>
                )}

                {a.params && Object.keys(a.params).length > 0 && (
                  <div className="approval-params">
                    <div className="approval-params-label">Parameters</div>
                    <div className="approval-params-grid">
                      {Object.entries(a.params).map(([k, v]) => (
                        <div key={k} className="approval-param-row">
                          <span className="approval-param-key">{k.replace(/_/g, " ")}</span>
                          <span className="approval-param-val">
                            {typeof v === "object" ? JSON.stringify(v) : String(v)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="approval-footer">
                  <input
                    className="approval-note-input"
                    placeholder="Add a note (optional)..."
                    value={notes[a.id] || ""}
                    onChange={(e) => setNotes((p) => ({ ...p, [a.id]: e.target.value }))}
                    disabled={isBusy}
                  />
                  <div className="approval-actions">
                    <button
                      className="approval-btn approve"
                      disabled={isBusy}
                      onClick={() => decide(a.id, "approve")}
                    >
                      {deciding[a.id] === "approve" ? "Approving..." : "Approve"}
                    </button>
                    <button
                      className="approval-btn reject"
                      disabled={isBusy}
                      onClick={() => decide(a.id, "reject")}
                    >
                      {deciding[a.id] === "reject" ? "Rejecting..." : "Reject"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
