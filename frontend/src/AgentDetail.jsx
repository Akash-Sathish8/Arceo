import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { apiFetch } from "./api.js";
import { toast } from "./Toast.jsx";
import "./AgentDetail.css";

const formatAction = (action) =>
  action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const parsePolicyPattern = (pattern) => {
  const dot = pattern.indexOf(".");
  if (dot === -1) return { service: "", action: formatAction(pattern) };
  const svc = pattern.slice(0, dot);
  return {
    service: svc.charAt(0).toUpperCase() + svc.slice(1),
    action: formatAction(pattern.slice(dot + 1)),
  };
};

const formatDescription = (text) =>
  text.replace(/\b([a-z]+(?:_[a-z]+)+)\b/g, (m) =>
    m.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
  );

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

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [collapsedChains, setCollapsedChains] = useState({});
  const toggleChain = (id) => setCollapsedChains((p) => ({ ...p, [id]: !p[id] }));
  const [applyingRecs, setApplyingRecs] = useState(false);
  const [showRecsMenu, setShowRecsMenu] = useState(false);
  const [selectedRecs, setSelectedRecs] = useState(new Set());
  const [appliedRecIndices, setAppliedRecIndices] = useState(new Set());

  const loadData = () => {
    setLoading(true);
    setError(null);
    apiFetch(`/api/authority/agent/${agentId}`)
      .then((d) => { setData(d); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  };

  useEffect(() => { loadData(); }, [agentId]);

  useEffect(() => {
    if (!showRecsMenu) return;
    const handler = (e) => { if (!e.target.closest(".apply-recs-wrapper")) setShowRecsMenu(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showRecsMenu]);

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

  const getPoliciesForRec = (rec) => {
    const tokens = rec.description.match(/\b[a-z]+(?:_[a-z]+)+\b/g) || [];
    const fallbackRe = /delete|terminate|cancel|charge|refund|send_email|send_template/;
    return agent.tools.flatMap((t) =>
      t.actions
        .filter((a) => tokens.length > 0 ? tokens.includes(a.action) : fallbackRe.test(a.action))
        .map((a) => `${t.name}.${a.action}`)
    );
  };

  const handleApplySelected = async () => {
    setApplyingRecs(true);
    const existingPatterns = new Set((policies || []).map((p) => p.action_pattern));
    const toCreate = new Set();
    recommendations.forEach((rec, i) => {
      if (selectedRecs.has(i)) getPoliciesForRec(rec).forEach((p) => { if (!existingPatterns.has(p)) toCreate.add(p); });
    });
    if (toCreate.size === 0) {
      toast("All selected policies are already applied");
      setAppliedRecIndices((prev) => new Set([...prev, ...selectedRecs]));
      setApplyingRecs(false);
      setShowRecsMenu(false);
      return;
    }
    try {
      await Promise.all([...toCreate].map((pattern) =>
        apiFetch(`/api/authority/agent/${agentId}/policies`, {
          method: "POST",
          body: JSON.stringify({ action_pattern: pattern, effect: "REQUIRE_APPROVAL", reason: "Auto-applied from recommendations" }),
        })
      ));
      toast(`Applied ${toCreate.size} polic${toCreate.size !== 1 ? "ies" : "y"}`);
      setAppliedRecIndices((prev) => new Set([...prev, ...selectedRecs]));
      loadData();
      setShowRecsMenu(false);
    } catch (err) {
      toast("Failed: " + err.message, "error");
    }
    setApplyingRecs(false);
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

  const EFFECT_ORDER = { BLOCK: 0, REQUIRE_APPROVAL: 1, ALLOW: 2 };
  const sortedPolicies = [...(policies || [])].sort((a, b) => (EFFECT_ORDER[a.effect] ?? 3) - (EFFECT_ORDER[b.effect] ?? 3));
  const policyEffectCounts = sortedPolicies.reduce((acc, p) => { acc[p.effect] = (acc[p.effect] || 0) + 1; return acc; }, {});
  const allSamePolicyReason = sortedPolicies.length > 1 && sortedPolicies.every((p) => p.reason === sortedPolicies[0]?.reason) ? sortedPolicies[0]?.reason : null;

  const existingPolicyPatterns = new Set((policies || []).map((p) => p.action_pattern));
  const visibleRecs = recommendations
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => {
      if (appliedRecIndices.has(i)) return false;
      const tokens = r.description.match(/\b[a-z]+(?:_[a-z]+)+\b/g) || [];
      const fallbackRe = /delete|terminate|cancel|charge|refund|send_email|send_template/;
      const needed = agent.tools.flatMap((t) =>
        t.actions
          .filter((a) => tokens.length > 0 ? tokens.includes(a.action) : fallbackRe.test(a.action))
          .map((a) => `${t.name}.${a.action}`)
      );
      if (needed.length === 0) return true;
      return !needed.every((p) => existingPolicyPatterns.has(p));
    })
    .sort((a, b) => (a.r.severity === "critical" ? -1 : 1) - (b.r.severity === "critical" ? -1 : 1));

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
        <div className="chain-section-header">
          <h2>Enforcement Policies ({sortedPolicies.length})</h2>
          <div className="chain-sev-counts">
            {policyEffectCounts.BLOCK > 0 && <span className="chain-sev-chip" style={{ background: "#fef2f2", color: "#dc2626" }}>{policyEffectCounts.BLOCK} Block</span>}
            {policyEffectCounts.REQUIRE_APPROVAL > 0 && <span className="chain-sev-chip" style={{ background: "#fff7ed", color: "#ea580c" }}>{policyEffectCounts.REQUIRE_APPROVAL} Req. Approval</span>}
            {policyEffectCounts.ALLOW > 0 && <span className="chain-sev-chip" style={{ background: "#f0fdf4", color: "#16a34a" }}>{policyEffectCounts.ALLOW} Allow</span>}
          </div>
        </div>
        {allSamePolicyReason && (
          <p className="policy-shared-reason">All policies: {allSamePolicyReason}</p>
        )}
        <div className="policies-list">
          {sortedPolicies.map((p) => {
            const es = EFFECT_STYLE[p.effect] || EFFECT_STYLE.BLOCK;
            const { service, action } = parsePolicyPattern(p.action_pattern);
            return (
              <div key={p.id} className="policy-row">
                <span className="policy-effect" style={{ background: es.bg, color: es.color }}>{p.effect}</span>
                <div className="policy-action">
                  {service && <span className="policy-service">{service}</span>}
                  <span className="policy-action-name">{action}</span>
                </div>
                {!allSamePolicyReason && p.reason && <span className="policy-reason">{p.reason}</span>}
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
          <div className="chain-section-header">
            <h2>Dangerous Chains ({chains.length})</h2>
            <div className="chain-sev-counts">
              {chains.filter((c) => c.severity === "critical").length > 0 && (
                <span className="chain-sev-chip chain-sev-critical">{chains.filter((c) => c.severity === "critical").length} Critical</span>
              )}
              {chains.filter((c) => c.severity === "high").length > 0 && (
                <span className="chain-sev-chip chain-sev-high">{chains.filter((c) => c.severity === "high").length} High</span>
              )}
            </div>
          </div>
          <div className="detail-chains">
            {chains.map((c) => {
              const sev = SEV_STYLE[c.severity] || SEV_STYLE.high;
              const isOpen = !collapsedChains[c.id];
              return (
                <div key={c.id} className="d-chain" style={{ borderLeftColor: sev.color }}>
                  <div className="d-chain-header" onClick={() => toggleChain(c.id)}>
                    <div className="d-chain-top">
                      <span className="d-chain-sev" style={{ background: sev.bg, color: sev.color }}>{c.severity}</span>
                      <strong>{c.name}</strong>
                    </div>
                    <span className="d-chain-chevron">{isOpen ? "▾" : "▸"}</span>
                  </div>
                  {isOpen && (
                    <>
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
                                    {byService[svc].map((a) => {
                                      const isDanger = /delete|terminate|drop|destroy|cancel|charge|refund/.test(a.toLowerCase());
                                      return (
                                        <span key={a} className={`match-action${isDanger ? " match-action-danger" : ""}`}>
                                          {formatAction(a)}
                                        </span>
                                      );
                                    })}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {visibleRecs.length > 0 && (
        <div className="detail-section">
          <div className="chain-section-header">
            <h2>Recommendations ({visibleRecs.length})</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="chain-sev-counts">
                {visibleRecs.filter(({ r }) => r.severity === "critical").length > 0 && (
                  <span className="chain-sev-chip chain-sev-critical">{visibleRecs.filter(({ r }) => r.severity === "critical").length} Critical</span>
                )}
                {visibleRecs.filter(({ r }) => r.severity === "high").length > 0 && (
                  <span className="chain-sev-chip chain-sev-high">{visibleRecs.filter(({ r }) => r.severity === "high").length} High</span>
                )}
              </div>
              <div className="apply-recs-wrapper">
                <button
                  className="apply-recs-btn"
                  onClick={() => {
                    setSelectedRecs(new Set(visibleRecs.map(({ i }) => i)));
                    setShowRecsMenu((v) => !v);
                  }}
                >
                  Apply Recommendations {showRecsMenu ? "▾" : "▸"}
                </button>
                {showRecsMenu && (
                  <div className="apply-recs-menu">
                    <div className="apply-recs-menu-header">
                      <span>Select to apply</span>
                      <button className="apply-recs-toggle" onClick={() =>
                        setSelectedRecs(selectedRecs.size === visibleRecs.length ? new Set() : new Set(visibleRecs.map(({ i }) => i)))
                      }>
                        {selectedRecs.size === visibleRecs.length ? "Deselect all" : "Select all"}
                      </button>
                    </div>
                    {visibleRecs.map(({ r, i }) => {
                      const sev = SEV_STYLE[r.severity] || SEV_STYLE.high;
                      const checked = selectedRecs.has(i);
                      return (
                        <label key={i} className="apply-recs-item">
                          <input type="checkbox" checked={checked} onChange={() => {
                            const next = new Set(selectedRecs);
                            checked ? next.delete(i) : next.add(i);
                            setSelectedRecs(next);
                          }} />
                          <span className="rec-sev" style={{ background: sev.bg, color: sev.color }}>{r.severity}</span>
                          <span className="apply-recs-item-title">{r.title}</span>
                        </label>
                      );
                    })}
                    <div className="apply-recs-menu-footer">
                      <button className="apply-recs-confirm" onClick={handleApplySelected} disabled={applyingRecs || selectedRecs.size === 0}>
                        {applyingRecs ? "Applying…" : `Apply ${selectedRecs.size} selected`}
                      </button>
                      <button className="apply-recs-cancel" onClick={() => setShowRecsMenu(false)}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="recs">
            {visibleRecs.map(({ r, i }) => {
              const sev = SEV_STYLE[r.severity] || SEV_STYLE.high;
              return (
                <div key={i} className="rec-card" style={{ borderLeftColor: sev.color }}>
                  <div className="rec-top">
                    <span className="rec-sev" style={{ background: sev.bg, color: sev.color }}>{r.severity}</span>
                    <strong>{r.title}</strong>
                  </div>
                  <p>{formatDescription(r.description)}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
