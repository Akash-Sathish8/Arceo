import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { apiFetch } from "./api.js";
import { toast } from "./Toast.jsx";
import "./AgentDetail.css";

const formatAction = (action) =>
  action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const actionRiskDot = (tool, action) => {
  const s = `${tool}.${action}`.toLowerCase();
  if (/delete|terminate|drop|destroy|remove|cancel/.test(s)) return "#dc2626";
  if (/charge|transfer|pay|refund|create_charge/.test(s)) return "#2563eb";
  if (/send|email|message|notify/.test(s)) return "#7c3aed";
  return "#9ca3af";
};

const RISK_COLORS = {
  moves_money: "#dc2626",
  touches_pii: "#7c3aed",
  deletes_data: "#ea580c",
  sends_external: "#2563eb",
  changes_production: "#0d9488",
};

const RISK_LABELS = {
  moves_money: "Moves Money",
  touches_pii: "Touches PII",
  deletes_data: "Deletes Data",
  sends_external: "Sends External",
  changes_production: "Changes Prod",
};

const SEV_STYLE = {
  critical: { bg: "#fef2f2", color: "#dc2626" },
  high: { bg: "#fff7ed", color: "#ea580c" },
};

// ── Authority Map ─────────────────────────────────────────────────────────

function AuthorityMap({ graph }) {
  const nodeById = {};
  graph.nodes.forEach((n) => { nodeById[n.id] = n; });

  const toolActionIds = {};
  graph.edges.filter((e) => e.relation === "exposes").forEach((e) => {
    if (!toolActionIds[e.source]) toolActionIds[e.source] = [];
    toolActionIds[e.source].push(e.target);
  });

  const toolIds = graph.edges
    .filter((e) => e.relation === "has_tool")
    .map((e) => e.target);

  const tools = toolIds.map((id) => nodeById[id]).filter(Boolean);
  const [collapsed, setCollapsed] = useState(() => {
    const init = {};
    tools.forEach((tool) => {
      const acts = (toolActionIds[tool.id] || []).map((id) => nodeById[id]).filter(Boolean);
      const hasDanger = acts.some((a) => a.reversible === false || a.risk_labels?.length > 0);
      if (!hasDanger) init[tool.id] = true;
    });
    return init;
  });
  const toggle = (id) => setCollapsed((p) => ({ ...p, [id]: !p[id] }));

  return (
    <div className="authority-map">
      {tools.map((tool) => {
        const actions = (toolActionIds[tool.id] || [])
          .map((id) => nodeById[id])
          .filter(Boolean)
          .sort((a, b) => {
            const rank = (x) => x.reversible === false ? 0 : x.risk_labels?.length ? 1 : 2;
            return rank(a) - rank(b);
          });
        const nIrrev = actions.filter((a) => a.reversible === false).length;
        const nRisky = actions.filter((a) => a.reversible !== false && a.risk_labels?.length).length;
        const nSafe  = actions.filter((a) => a.reversible !== false && !a.risk_labels?.length).length;
        const isOpen = !collapsed[tool.id];
        const accentColor = nIrrev > 0 ? "#dc2626" : nRisky > 0 ? "#f59e0b" : "#d1d5db";
        return (
          <div key={tool.id} className="am-tool" style={{ borderLeftColor: accentColor }}>
            <div className="am-tool-header" onClick={() => toggle(tool.id)}>
              <span className="am-tool-name">{tool.label}</span>
              <div className="am-tool-header-right">
                <div className="am-tool-risk-counts">
                  {nIrrev > 0 && <span className="am-count-chip am-count-irrev">{nIrrev} irreversible</span>}
                  {nRisky > 0 && <span className="am-count-chip am-count-risky">{nRisky} risky</span>}
                  {nSafe  > 0 && <span className="am-count-chip am-count-safe">{nSafe} safe</span>}
                </div>
                <span className="am-chevron">{isOpen ? "▾" : "▸"}</span>
              </div>
            </div>
            {isOpen && (
              <div className="am-actions">
                {actions.map((action) => {
                  const isIrrev = action.reversible === false;
                  const hasRisk = action.risk_labels && action.risk_labels.length > 0;
                  const dotClass = isIrrev ? "irreversible" : hasRisk ? "risky" : "safe";
                  return (
                    <div key={action.id} className={`am-action${isIrrev ? " am-action-irrev" : hasRisk ? " am-action-risky" : ""}`}>
                      <span className={`am-dot am-dot-${dotClass}`} />
                      <span className="am-action-name">{formatAction(action.label)}</span>
                      <div className="am-badges">
                        {action.risk_labels?.map((r) => (
                          <span key={r} className="am-badge" style={{
                            background: RISK_COLORS[r] + "18",
                            color: RISK_COLORS[r],
                            borderColor: RISK_COLORS[r] + "50",
                          }}>
                            {RISK_LABELS[r]}
                          </span>
                        ))}
                        {isIrrev && (
                          <span className="am-badge am-badge-irrev">Irreversible</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Policy Form ───────────────────────────────────────────────────────────

const EFFECT_OPTIONS = ["BLOCK", "REQUIRE_APPROVAL", "ALLOW"];
const EFFECT_STYLE = {
  BLOCK: { bg: "#fef2f2", color: "#dc2626" },
  REQUIRE_APPROVAL: { bg: "#fff7ed", color: "#ea580c" },
  ALLOW: { bg: "#f0fdf4", color: "#16a34a" },
};
const EXEC_STATUS_STYLE = {
  EXECUTED: { bg: "#d4edda", color: "#155724" },
  BLOCKED: { bg: "#f8d7da", color: "#721c24" },
  PENDING_APPROVAL: { bg: "#fff3cd", color: "#856404" },
};

// ── Main Detail Page ──────────────────────────────────────────────────────

export default function AgentDetail() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Policy form
  const [newPattern, setNewPattern] = useState("");
  const [newEffect, setNewEffect] = useState("BLOCK");
  const [newReason, setNewReason] = useState("");

  const loadData = () => {
    setLoading(true);
    setError(null);
    apiFetch(`/api/authority/agent/${agentId}`)
      .then((d) => { setData(d); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  };

  useEffect(() => { loadData(); }, [agentId]);

  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    try {
      await apiFetch(`/api/authority/agent/${agentId}`, { method: "DELETE" });
      toast("Agent deleted");
      navigate("/");
    } catch (err) {
      toast("Failed to delete: " + err.message, "error");
    }
  };

  const handleAddPolicy = async (e) => {
    e.preventDefault();
    if (!newPattern.trim()) return;
    try {
      await apiFetch(`/api/authority/agent/${agentId}/policies`, {
        method: "POST",
        body: JSON.stringify({ action_pattern: newPattern, effect: newEffect, reason: newReason }),
      });
      setNewPattern("");
      setNewReason("");
      toast("Policy added");
      loadData();
    } catch (err) {
      toast("Failed to add policy: " + err.message, "error");
    }
  };

  const handleDeletePolicy = async (policyId) => {
    try {
      await apiFetch(`/api/authority/policy/${policyId}`, { method: "DELETE" });
      toast("Policy removed");
      loadData();
    } catch (err) {
      toast("Failed to delete policy: " + err.message, "error");
    }
  };

  if (loading) {
    return (
      <div className="detail-page">
        <Link to="/" className="back-link">&larr; All Agents</Link>
        <div className="loading-state"><div className="spinner" /><p>Loading agent data...</p></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="detail-page">
        <Link to="/" className="back-link">&larr; All Agents</Link>
        <div className="error-state">
          <div className="error-icon">!</div>
          <h2>Failed to load agent</h2>
          <p>{error}</p>
          <button className="retry-btn" onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    );
  }

  const { agent, graph, blast_radius: br, chains, recommendations, policies, executions } = data;
  const scoreColor = br.score >= 70 ? "#dc2626" : br.score >= 40 ? "#ea580c" : "#16a34a";
  const scoreLevel = br.score >= 70 ? "Critical" : br.score >= 40 ? "Warning" : "Safe";
  const ringR = 44;
  const ringC = 2 * Math.PI * ringR;
  const ringOffset = ringC * (1 - br.score / 100);

  const statItems = [
    { label: "Total Actions",  value: br.total_actions,       color: null },
    { label: "Move Money",     value: br.moves_money,         color: "#dc2626" },
    { label: "Touch PII",      value: br.touches_pii,         color: "#7c3aed" },
    { label: "Delete Data",    value: br.deletes_data,        color: "#ea580c" },
    { label: "Send External",  value: br.sends_external,      color: "#2563eb" },
    { label: "Change Prod",    value: br.changes_production,  color: "#0d9488" },
    { label: "Irreversible",   value: br.irreversible_actions, color: null },
  ];
  const visibleStats = statItems.filter((s, i) => i === 0 || i === statItems.length - 1 || s.value > 0);

  const formatExecTime = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === now.toDateString()) return `Today ${time}`;
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ` ${time}`;
  };

  const noPolicyCount = executions?.filter((e) => e.detail === "No matching policy").length || 0;
  const allUnpolicied = executions?.length > 0 && noPolicyCount === executions.length;

  return (
    <div className="detail-page">
      <div className="detail-topbar">
        <Link to="/" className="back-link">&larr; All Agents</Link>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Link to={`/sandbox?agent=${agentId}`} className="sandbox-agent-btn sandbox-agent-btn-primary">Simulate in Sandbox →</Link>
          {confirmDelete ? (
            <>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Are you sure?</span>
              <button className="delete-agent-btn confirm" onClick={handleDelete}>Yes, delete</button>
              <button className="delete-agent-btn cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            <button className="delete-agent-btn" onClick={handleDelete}>Delete Agent</button>
          )}
        </div>
      </div>

      <div className="detail-header">
        <div>
          <h1>{agent.name}</h1>
          <p>{agent.description}</p>
          <div className="detail-tools">
            {agent.tools.map((t) => (
              <span key={t.name} className="tool-chip-lg">{t.service}</span>
            ))}
          </div>
        </div>
        <div className="detail-score" style={{ color: scoreColor }}>
          <svg className="detail-score-svg" viewBox="0 0 110 110">
            <circle cx="55" cy="55" r={ringR} fill="none" stroke="currentColor" strokeWidth="7" opacity="0.12" />
            <circle cx="55" cy="55" r={ringR} fill="none" stroke="currentColor" strokeWidth="7"
              strokeDasharray={ringC}
              strokeDashoffset={ringOffset}
              strokeLinecap="round"
              transform="rotate(-90 55 55)"
              style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1)" }}
            />
          </svg>
          <div className="ds-number">{br.score}</div>
          <div className="ds-label">Risk Score</div>
          <div className="ds-level">{scoreLevel}</div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="detail-stats" style={{ gridTemplateColumns: `repeat(${visibleStats.length}, 1fr)` }}>
        {visibleStats.map((s) => (
          <div key={s.label} className="d-stat" style={s.color ? { color: s.color } : undefined}>
            <strong>{s.value}</strong>
            <span>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Enforcement Policies */}
      <div className="detail-section">
        <h2>Enforcement Policies ({policies?.length || 0})</h2>
        <div className="policies-list">
          {(policies || []).map((p) => {
            const es = EFFECT_STYLE[p.effect] || EFFECT_STYLE.BLOCK;
            return (
              <div key={p.id} className="policy-row">
                <span className="policy-effect" style={{ background: es.bg, color: es.color }}>{p.effect}</span>
                <code className="policy-pattern">{p.action_pattern}</code>
                <span className="policy-reason">{p.reason}</span>
                <button className="policy-delete" onClick={() => handleDeletePolicy(p.id)}>Remove</button>
              </div>
            );
          })}
        </div>
        <form className="policy-form" onSubmit={handleAddPolicy}>
          <select value={newPattern} onChange={(e) => setNewPattern(e.target.value)} required>
            <option value="">Select an action…</option>
            {agent.tools.flatMap((t) =>
              t.actions.map((a) => {
                const key = `${t.name}.${a.action}`;
                return <option key={key} value={key}>{t.service} — {formatAction(a.action)}</option>;
              })
            )}
          </select>
          <select value={newEffect} onChange={(e) => setNewEffect(e.target.value)}>
            {EFFECT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <input placeholder="Reason (optional)" value={newReason} onChange={(e) => setNewReason(e.target.value)} />
          <button type="submit">Add Policy</button>
        </form>
      </div>

      {/* Execution Log */}
      {executions && executions.length > 0 && (
        <div className="detail-section">
          <h2>Recent Executions ({executions.length})</h2>
          {allUnpolicied && (
            <div className="no-policy-banner">
              None of these {executions.length} executions matched a policy — this agent runs with no enforcement rules.
              <span className="no-policy-hint">Use the form above to block or require approval for risky actions.</span>
            </div>
          )}
          <div className="exec-list">
            {executions.slice(0, 20).map((e) => {
              const st = EXEC_STATUS_STYLE[e.status] || {};
              const dot = actionRiskDot(e.tool, e.action);
              const statusLabel = e.status === "PENDING_APPROVAL" ? "Pending" : e.status.charAt(0) + e.status.slice(1).toLowerCase();
              return (
                <div key={e.id} className="exec-row">
                  <span className="exec-time">{formatExecTime(e.timestamp)}</span>
                  <div className="exec-action-cell">
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0, display: "inline-block" }} />
                    <span className="exec-tool">{e.tool.charAt(0).toUpperCase() + e.tool.slice(1)}</span>
                    <span className="exec-action">{formatAction(e.action)}</span>
                  </div>
                  <span className="exec-status" style={{ background: st.bg, color: st.color }}>{statusLabel}</span>
                  {!allUnpolicied && <span className="exec-detail">{e.detail}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Authority Map */}
      <div className="detail-section">
        <div className="am-section-header">
          <h2>Authority Graph</h2>
          <div className="am-legend">
            <span><span className="am-dot am-dot-safe" /> Safe</span>
            <span><span className="am-dot am-dot-risky" /> Risky</span>
            <span><span className="am-dot am-dot-irreversible" /> Irreversible</span>
          </div>
        </div>
        <AuthorityMap graph={graph} />
      </div>

      {/* Chains */}
      {chains.length > 0 && (
        <div className="detail-section">
          <h2>Dangerous Chains ({chains.length})</h2>
          <div className="detail-chains">
            {chains.map((c) => {
              const sev = SEV_STYLE[c.severity] || SEV_STYLE.high;
              return (
                <div key={c.id} className="d-chain" style={{ borderLeftColor: sev.color }}>
                  <div className="d-chain-top">
                    <span className="d-chain-sev" style={{ background: sev.bg, color: sev.color }}>{c.severity}</span>
                    <strong>{c.name}</strong>
                  </div>
                  <p>{c.description}</p>
                  <div className="d-chain-steps">
                    {c.steps.map((step, j) => (
                      <span key={j}>
                        <span className="step-tag" style={{
                          borderColor: RISK_COLORS[step] || "#ccc",
                          color: RISK_COLORS[step] || "#555",
                          background: (RISK_COLORS[step] || "#ccc") + "12",
                        }}>
                          {RISK_LABELS[step] || step}
                        </span>
                        {j < c.steps.length - 1 && <span className="step-arrow">→</span>}
                      </span>
                    ))}
                  </div>
                  <div className="d-chain-actions">
                    {c.matching_actions.map((group, gi) => {
                      const byService = {};
                      const order = [];
                      group.forEach((a) => {
                        const dot = a.indexOf(".");
                        const svc = dot > -1 ? a.slice(0, dot) : a;
                        const act = dot > -1 ? a.slice(dot + 1) : a;
                        if (!byService[svc]) { byService[svc] = []; order.push(svc); }
                        byService[svc].push(act);
                      });
                      return (
                        <div key={gi} className="match-group">
                          <span className="match-label">Step {gi + 1}</span>
                          <div className="match-service-rows">
                            {order.map((svc) => (
                              <div key={svc} className="match-service-row">
                                <span className="match-svc">{svc.charAt(0).toUpperCase() + svc.slice(1)}</span>
                                {byService[svc].map((a) => (
                                  <span key={a} className="match-action">{formatAction(a)}</span>
                                ))}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="detail-section">
          <h2>Recommendations</h2>
          <div className="recs">
            {recommendations.map((r, i) => {
              const sev = SEV_STYLE[r.severity] || SEV_STYLE.high;
              return (
                <div key={i} className="rec-card" style={{ borderLeftColor: sev.color }}>
                  <div className="rec-top">
                    <span className="rec-sev" style={{ background: sev.bg, color: sev.color }}>{r.severity}</span>
                    <strong>{r.title}</strong>
                  </div>
                  <p>{r.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
