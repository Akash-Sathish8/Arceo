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

export default function Approvals() {
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState({});
  const [reasons, setReasons] = useState({});
  const [showReasonFor, setShowReasonFor] = useState(null);

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
        body: JSON.stringify({ decision, reason: reasons[id] || "" }),
      });
      toast(decision === "approve" ? "Action approved" : "Action rejected");
      setApprovals((prev) => prev.filter((a) => a.id !== id));
      setShowReasonFor(null);
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
          <div className="approvals-empty-icon">✓</div>
          <div className="approvals-empty-title">No pending approvals</div>
          <div className="approvals-empty-desc">
            When an agent triggers a <code>REQUIRE_APPROVAL</code> policy, the action will appear here for review.
            <br /><br />
            To create one, go to an <Link to="/" className="approvals-link">agent's detail page</Link> and add a policy with the "Require Approval" effect.
          </div>
        </div>
      ) : (
        <div className="approvals-list">
          {approvals.map((a) => (
            <div key={a.id} className="approval-card">
              <div className="approval-card-header">
                <div className="approval-meta">
                  <span className="approval-agent">
                    <Link to={`/agent/${a.agent_id}`}>{a.agent_name || a.agent_id}</Link>
                  </span>
                  <span className="approval-time">{relativeTime(a.timestamp)}</span>
                </div>
                <span className="approval-status-badge">Awaiting Review</span>
              </div>

              <div className="approval-action-row">
                <div className="approval-tool-action">
                  <span className="approval-tool">{a.tool}</span>
                  <span className="approval-arrow">→</span>
                  <span className="approval-action">{a.action}</span>
                </div>
              </div>

              {a.detail && (
                <div className="approval-detail">{a.detail}</div>
              )}

              {showReasonFor === a.id && (
                <div className="approval-reason-row">
                  <input
                    className="approval-reason-input"
                    placeholder="Reason (optional)"
                    value={reasons[a.id] || ""}
                    onChange={(e) => setReasons((p) => ({ ...p, [a.id]: e.target.value }))}
                    autoFocus
                  />
                </div>
              )}

              <div className="approval-actions">
                <button
                  className="approval-btn approve"
                  disabled={!!deciding[a.id]}
                  onClick={() => {
                    if (showReasonFor === a.id || reasons[a.id]) {
                      decide(a.id, "approve");
                    } else {
                      setShowReasonFor(a.id);
                    }
                  }}
                >
                  {deciding[a.id] === "approve" ? "Approving..." : "Approve"}
                </button>
                <button
                  className="approval-btn reject"
                  disabled={!!deciding[a.id]}
                  onClick={() => {
                    if (showReasonFor === a.id || reasons[a.id]) {
                      decide(a.id, "reject");
                    } else {
                      setShowReasonFor(a.id);
                    }
                  }}
                >
                  {deciding[a.id] === "reject" ? "Rejecting..." : "Reject"}
                </button>
                {showReasonFor !== a.id && (
                  <button className="approval-btn reason" onClick={() => setShowReasonFor(a.id)}>
                    Add reason
                  </button>
                )}
                {showReasonFor === a.id && (
                  <button className="approval-btn reason" onClick={() => { setShowReasonFor(null); setReasons((p) => ({ ...p, [a.id]: "" })); }}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
