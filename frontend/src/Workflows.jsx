import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "./api.js";
import { toast } from "./Toast.jsx";
import { scoreToColor } from "./scoreColor.js";
import "./Workflows.css";

const AGENT_COLORS = ["#2563eb", "#16a34a", "#ea580c", "#7c3aed", "#0d9488"];

const CHAIN_LABELS = {
  "pii-exfiltration":           "PII → Sent Externally",
  "unsupervised-refund":        "PII → Moves Money",
  "data-destruction":           "Access → Deletes Data",
  "infrastructure-destruction": "Prod Change → Destroys Infra",
  "financial-destruction":      "Reads Records → Deletes Them",
  "privilege-escalation":       "Prod Change → Deletes Data",
  "external-financial":         "Moves Money → Sends Externally",
  "pii-financial":              "PII → Financial Action",
  "production-external":        "Prod Change → External Notify",
};

function blastLabel(score) {
  if (score >= 76) return "Critical";
  if (score >= 56) return "High risk";
  if (score >= 31) return "Medium risk";
  return "Low risk";
}

const blastColor = scoreToColor;

// ── Cross-agent chain analysis (static, no LLM) ───────────────────────────

const LABEL_TRANSITIONS = [
  ["touches_pii", "sends_external", "pii-exfiltration", "critical"],
  ["touches_pii", "moves_money", "unsupervised-refund", "critical"],
  ["touches_pii", "deletes_data", "data-destruction", "high"],
  ["changes_production", "deletes_data", "infrastructure-destruction", "critical"],
  ["moves_money", "sends_external", "external-financial", "high"],
  ["changes_production", "sends_external", "production-external", "high"],
];

function detectCrossAgentChains(agentMap) {
  const agentLabels = {};
  for (const [id, agent] of Object.entries(agentMap)) {
    const labels = new Set();
    agent.tools?.forEach((t) => t.actions?.forEach((a) => (a.risk_labels || []).forEach((l) => labels.add(l))));
    agentLabels[id] = labels;
  }

  const chains = [];
  const ids = Object.keys(agentMap);
  for (const [fromLabel, toLabel, chainName, severity] of LABEL_TRANSITIONS) {
    for (const fromId of ids) {
      if (!agentLabels[fromId]?.has(fromLabel)) continue;
      for (const toId of ids) {
        if (toId === fromId) continue;
        if (!agentLabels[toId]?.has(toLabel)) continue;
        chains.push({
          chain_name: chainName,
          severity,
          from_agent: agentMap[fromId].name,
          to_agent: agentMap[toId].name,
          from_label: fromLabel,
          to_label: toLabel,
        });
      }
    }
  }
  return chains;
}

// ── OptimizeResult ─────────────────────────────────────────────────────────

function OptimizeResult({ result, onApply, applying, appliedCount }) {
  const { agents, overall_optimization_score, total_overprivileged, total_permission_gaps, verdict } = result;
  const agentList = Object.values(agents || {});
  const totalApprovalGates = agentList.reduce((s, a) => s + (a.approval_gates_needed?.length || 0), 0);

  const verdictColor = overall_optimization_score < 20 ? "#16a34a" : overall_optimization_score < 50 ? "#ea580c" : "#dc2626";

  return (
    <div className="opt-result">
      <div className="opt-result-header">
        <div className="opt-result-title">Permission Optimization Report</div>
        <div className="opt-verdict" style={{ color: verdictColor }}>{verdict}</div>
      </div>

      <div className="opt-summary-stats">
        <div className="opt-stat">
          <strong style={{ color: total_overprivileged > 0 ? "#dc2626" : "#16a34a" }}>{total_overprivileged}</strong>
          <span>Overprivileged</span>
        </div>
        <div className="opt-stat">
          <strong style={{ color: total_permission_gaps > 0 ? "#ea580c" : "#16a34a" }}>{total_permission_gaps}</strong>
          <span>Permission Gaps</span>
        </div>
        <div className="opt-stat">
          <strong style={{ color: totalApprovalGates > 0 ? "#ca8a04" : "#16a34a" }}>{totalApprovalGates}</strong>
          <span>Approval Gates Needed</span>
        </div>
        <div className="opt-stat">
          <strong style={{ color: overall_optimization_score > 50 ? "#dc2626" : overall_optimization_score > 20 ? "#ea580c" : "#16a34a" }}>
            {overall_optimization_score}
          </strong>
          <span>Over-permission Score</span>
        </div>
      </div>

      {agentList.map((agent) => (
        <div key={agent.agent_id} className="opt-agent-card">
          <div className="opt-agent-header">
            <span className="opt-agent-name">{agent.agent_name}</span>
            <span className="opt-agent-summary">{agent.summary}</span>
          </div>

          {agent.overprivileged?.length > 0 && (
            <div className="opt-section">
              <div className="opt-section-label overprivileged">Overprivileged — restrict these</div>
              {agent.overprivileged.map((item, i) => (
                <div key={i} className="opt-action-row">
                  <span className="opt-action-badge" style={item.severity === "high" ? { background: "#fef2f2", color: "#dc2626" } : { background: "#fff7ed", color: "#ea580c" }}>
                    {item.severity?.toUpperCase()}
                  </span>
                  <div className="opt-action-detail">
                    <code className="opt-action-name">{item.action}</code>
                    <span className="opt-action-reason">{item.reason}</span>
                  </div>
                  <span className="opt-rec-badge block">BLOCK</span>
                </div>
              ))}
            </div>
          )}

          {agent.permission_gaps?.length > 0 && (
            <div className="opt-section">
              <div className="opt-section-label gaps">Permission Gaps — review policies</div>
              {agent.permission_gaps.map((item, i) => (
                <div key={i} className="opt-action-row">
                  <div className="opt-action-detail">
                    <code className="opt-action-name">{item.action}</code>
                    <span className="opt-action-reason">{item.reason}</span>
                  </div>
                  <span className="opt-rec-badge review">REVIEW</span>
                </div>
              ))}
            </div>
          )}

          {agent.approval_gates_needed?.length > 0 && (
            <div className="opt-section">
              <div className="opt-section-label gates">Approval Gates — add human review</div>
              {agent.approval_gates_needed.map((chain, i) => (
                <div key={i} className="opt-action-row">
                  <span className="opt-action-badge" style={{ background: "#fefce8", color: "#ca8a04" }}>
                    {chain.severity?.toUpperCase()}
                  </span>
                  <div className="opt-action-detail">
                    <span className="opt-action-name">{CHAIN_LABELS[chain.chain_name] || chain.chain_name}</span>
                    <span className="opt-action-reason">
                      {agent.agent_name} → {chain.to_agent} — requires approval gate
                    </span>
                  </div>
                  <span className="opt-rec-badge approval">REQUIRE_APPROVAL</span>
                </div>
              ))}
            </div>
          )}

          {!agent.overprivileged?.length && !agent.permission_gaps?.length && !agent.approval_gates_needed?.length && (
            <div className="opt-agent-clean">✓ Well-scoped for this workflow — no changes needed</div>
          )}
        </div>
      ))}

      {(total_overprivileged > 0 || totalApprovalGates > 0) && (
        <div className="opt-apply-row">
          {appliedCount > 0 ? (
            <div className="opt-applied-msg">✓ {appliedCount} polic{appliedCount !== 1 ? "ies" : "y"} applied</div>
          ) : (
            <button className="opt-apply-btn" onClick={onApply} disabled={applying}>
              {applying ? "Applying..." : `Apply All Recommendations (${total_overprivileged + totalApprovalGates} policies)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── WorkflowResult ─────────────────────────────────────────────────────────

function WorkflowResult({ result, agentNames, agentColors }) {
  const { report, trace } = result;
  const steps = trace?.steps || [];

  const violations = report?.violations || [];
  const crossChains = report?.cross_agent_chains || report?.chains?.filter((c) => c.cross_agent) || [];
  const allChains = report?.chains || [];

  return (
    <div className="wf-result">
      <div className="wf-result-header">
        <div className="wf-result-stats">
          <div className="wf-result-stat">
            <strong style={{ color: violations.length > 0 ? "#dc2626" : "#16a34a" }}>{violations.length}</strong>
            <span>Violations</span>
          </div>
          <div className="wf-result-stat">
            <strong style={{ color: allChains.length > 0 ? "#ea580c" : "#16a34a" }}>{allChains.length}</strong>
            <span>Chains</span>
          </div>
          <div className="wf-result-stat">
            <strong>{steps.length}</strong>
            <span>Total Steps</span>
          </div>
          <div className="wf-result-stat">
            <strong style={{ color: crossChains.length > 0 ? "#dc2626" : "#16a34a" }}>{crossChains.length}</strong>
            <span>Cross-Agent Chains</span>
          </div>
        </div>
      </div>

      {crossChains.length > 0 && (
        <div className="wf-cross-chains">
          <div className="wf-cross-chains-title">
            <span className="wf-alert-icon">⛓</span>
            Cross-Agent Chains Detected
          </div>
          {crossChains.map((c, i) => (
            <div key={i} className="wf-chain-row" style={{ borderLeftColor: c.severity === "critical" ? "#dc2626" : "#ea580c" }}>
              <span className="wf-chain-sev" style={{ background: c.severity === "critical" ? "#fef2f2" : "#fff7ed", color: c.severity === "critical" ? "#dc2626" : "#ea580c" }}>
                {c.severity?.toUpperCase()}
              </span>
              <span className="wf-chain-name">{CHAIN_LABELS[c.chain_name] || c.chain_name}</span>
              {c.from_agent && c.to_agent && (
                <span className="wf-chain-agents">{c.from_agent} → {c.to_agent}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {violations.length > 0 && (
        <div className="wf-violations">
          <div className="wf-section-title">Violations</div>
          {violations.slice(0, 5).map((v, i) => (
            <div key={i} className="wf-violation-row">
              <span className="wf-chain-sev" style={{ background: "#fef2f2", color: "#dc2626" }}>
                {v.severity?.toUpperCase() || "HIGH"}
              </span>
              <span>{v.title || v.description}</span>
            </div>
          ))}
          {violations.length > 5 && <span className="wf-more">+{violations.length - 5} more</span>}
        </div>
      )}

      <div className="wf-timeline">
        <div className="wf-section-title">Execution Timeline</div>
        <div className="wf-steps">
          {steps.slice(0, 20).map((step, i) => {
            const color = agentColors[step.agent_id] || "#9ca3af";
            const agentName = agentNames[step.agent_id] || step.agent_id;
            const isBlocked = step.decision === "BLOCK";
            const isPending = step.decision === "REQUIRE_APPROVAL";
            return (
              <div key={i} className={`wf-step${isBlocked ? " wf-step-blocked" : isPending ? " wf-step-pending" : ""}`}>
                <div className="wf-step-agent-dot" style={{ background: color }} title={agentName} />
                <div className="wf-step-content">
                  <span className="wf-step-tool">{step.tool}.{step.action}</span>
                  {isBlocked && <span className="wf-step-badge blocked">BLOCKED</span>}
                  {isPending && <span className="wf-step-badge pending">PENDING</span>}
                </div>
              </div>
            );
          })}
          {steps.length > 20 && <div className="wf-more">+{steps.length - 20} more steps</div>}
        </div>
      </div>

      <div className="wf-result-footer">
        <Link to={`/sandbox/${result.simulation_id}`} className="wf-view-report">
          View Full Report →
        </Link>
      </div>
    </div>
  );
}

// ── Main Workflows page ────────────────────────────────────────────────────

export default function Workflows() {

  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);

  const [coordinatorId, setCoordinatorId] = useState("");
  const [specialistIds, setSpecialistIds] = useState([]);
  const [customPrompt, setCustomPrompt] = useState("");

  const [analyzing, setAnalyzing] = useState(false);
  const [staticChains, setStaticChains] = useState(null);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const [optimizing, setOptimizing] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState(null);
  const [workflowDesc, setWorkflowDesc] = useState("");
  const [applyingPolicies, setApplyingPolicies] = useState(false);
  const [appliedCount, setAppliedCount] = useState(0);

  useEffect(() => {
    apiFetch("/api/authority/agents")
      .then((d) => {
        const list = d?.agents || (Array.isArray(d) ? d : []);
        setAgents(list);
        if (list.length >= 1) setCoordinatorId(list[0].id);
        if (list.length >= 2) setSpecialistIds([list[1].id]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const allAgentIds = coordinatorId ? [coordinatorId, ...specialistIds.filter((id) => id !== coordinatorId)] : [];
  const selectedAgents = agents.filter((a) => allAgentIds.includes(a.id));

  // Assign stable colors per agent
  const agentColors = {};
  const agentNames = {};
  allAgentIds.forEach((id, i) => {
    agentColors[id] = AGENT_COLORS[i % AGENT_COLORS.length];
    const a = agents.find((x) => x.id === id);
    if (a) agentNames[id] = a.name;
  });

  const handleAnalyze = () => {
    if (allAgentIds.length < 2) {
      toast("Select at least a coordinator and one specialist.", "error");
      return;
    }
    setAnalyzing(true);
    setStaticChains(null);
    setResult(null);
    const agentMap = {};
    selectedAgents.forEach((a) => { agentMap[a.id] = a; });
    const chains = detectCrossAgentChains(agentMap);
    setTimeout(() => {
      setStaticChains(chains);
      setAnalyzing(false);
    }, 600);
  };

  const handleOptimize = async () => {
    if (allAgentIds.length < 2) {
      toast("Select at least a coordinator and one specialist.", "error");
      return;
    }
    if (!workflowDesc.trim()) {
      toast("Describe what this workflow does so Arceo can analyze permissions.", "error");
      return;
    }
    setOptimizing(true);
    setOptimizeResult(null);
    try {
      const data = await apiFetch("/api/workflows/optimize", {
        method: "POST",
        body: JSON.stringify({
          agent_ids: allAgentIds,
          coordinator_id: coordinatorId,
          workflow_description: workflowDesc,
          dry_run: true,
        }),
      });
      setOptimizeResult(data);
    } catch (err) {
      toast("Optimization failed: " + err.message, "error");
    }
    setOptimizing(false);
  };

  const applyAllRecommendations = async () => {
    if (!optimizeResult) return;
    setApplyingPolicies(true);
    let count = 0;
    for (const [agentId, analysis] of Object.entries(optimizeResult.agents)) {
      // Block overprivileged actions
      for (const item of analysis.overprivileged || []) {
        try {
          await apiFetch(`/api/authority/agent/${agentId}/policies`, {
            method: "POST",
            body: JSON.stringify({
              tool: item.tool,
              action: item.action_name,
              decision: "BLOCK",
              reason: `Auto-generated: ${item.reason}`,
            }),
          });
          count++;
        } catch {}
      }
      // Add REQUIRE_APPROVAL gates for cross-agent chains
      for (const chain of analysis.approval_gates_needed || []) {
        try {
          await apiFetch(`/api/authority/agent/${agentId}/policies`, {
            method: "POST",
            body: JSON.stringify({
              tool: "*",
              action: "*",
              decision: "REQUIRE_APPROVAL",
              reason: `Auto-generated: Cross-agent chain gate — ${chain.chain_name}`,
            }),
          });
          count++;
        } catch {}
      }
    }
    setAppliedCount(count);
    setApplyingPolicies(false);
    toast(`Applied ${count} policy recommendation${count !== 1 ? "s" : ""} ✓`);
  };

  const handleSimulate = async () => {
    if (allAgentIds.length < 2) {
      toast("Select at least a coordinator and one specialist.", "error");
      return;
    }
    if (!customPrompt.trim()) {
      toast("Enter a scenario prompt to simulate.", "error");
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const data = await apiFetch("/api/sandbox/simulate/multi", {
        method: "POST",
        body: JSON.stringify({
          agent_ids: allAgentIds,
          coordinator_id: coordinatorId,
          custom_prompt: customPrompt,
          dry_run: true,
        }),
      });
      setResult(data);
    } catch (err) {
      toast("Simulation failed: " + err.message, "error");
    }
    setRunning(false);
  };

  const toggleSpecialist = (id) => {
    if (id === coordinatorId) return;
    setSpecialistIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  if (loading) {
    return (
      <div className="wf-page">
        <div className="loading-state"><div className="spinner" /></div>
      </div>
    );
  }

  if (agents.length < 2) {
    return (
      <div className="wf-page">
        <div className="wf-topbar">
          <Link to="/" className="back-link">← All Agents</Link>
        </div>
        <div className="wf-empty">
          <div className="wf-empty-icon">⛓</div>
          <h2>Multi-Agent Workflows</h2>
          <p>You need at least 2 agents to define a workflow. Arceo will analyze cross-agent risk chains — actions one agent takes that enable another to cause harm.</p>
          <Link to="/?connect=true" className="wf-cta-btn">Add an Agent →</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="wf-page">
      <div className="wf-topbar">
        <Link to="/" className="back-link">← All Agents</Link>
      </div>

      <div className="wf-header">
        <div>
          <h1>Multi-Agent Workflows</h1>
          <p className="wf-sub">Select a coordinator and specialists. Arceo detects cross-agent risk chains — dangerous sequences that only emerge when agents work together.</p>
        </div>
      </div>

      <div className="wf-layout">
        {/* ── Left: Agent picker ── */}
        <div className="wf-config">
          <div className="wf-config-section">
            <div className="wf-config-label">Coordinator Agent</div>
            <div className="wf-config-hint">Receives the task and dispatches to specialists</div>
            <div className="wf-agent-list">
              {agents.map((a) => (
                <button
                  key={a.id}
                  className={`wf-agent-btn${coordinatorId === a.id ? " selected coordinator" : ""}`}
                  style={coordinatorId === a.id ? { borderColor: AGENT_COLORS[0], background: `${AGENT_COLORS[0]}0f` } : {}}
                  onClick={() => {
                    setCoordinatorId(a.id);
                    setSpecialistIds((prev) => prev.filter((id) => id !== a.id));
                  }}
                >
                  <div className="wf-agent-dot" style={{ background: coordinatorId === a.id ? AGENT_COLORS[0] : "#d1d5db" }} />
                  <div className="wf-agent-info">
                    <span className="wf-agent-name">{a.name}</span>
                    <span className="wf-agent-tools">{(a.tools || []).map((t) => t.service).join(", ")}</span>
                  </div>
                  <span className="wf-agent-score" style={{ color: blastColor(a.blast_radius?.score || 0) }}>
                    {a.blast_radius?.score || 0}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="wf-config-section">
            <div className="wf-config-label">Specialist Agents</div>
            <div className="wf-config-hint">Agents the coordinator can dispatch sub-tasks to</div>
            <div className="wf-agent-list">
              {agents.filter((a) => a.id !== coordinatorId).map((a) => {
                const idx = specialistIds.indexOf(a.id);
                const isSelected = idx !== -1;
                const colorIdx = isSelected ? (1 + specialistIds.indexOf(a.id)) % AGENT_COLORS.length : null;
                return (
                  <button
                    key={a.id}
                    className={`wf-agent-btn${isSelected ? " selected" : ""}`}
                    style={isSelected ? { borderColor: AGENT_COLORS[colorIdx], background: `${AGENT_COLORS[colorIdx]}0f` } : {}}
                    onClick={() => toggleSpecialist(a.id)}
                  >
                    <div className="wf-agent-dot" style={{ background: isSelected ? AGENT_COLORS[colorIdx] : "#d1d5db" }} />
                    <div className="wf-agent-info">
                      <span className="wf-agent-name">{a.name}</span>
                      <span className="wf-agent-tools">{(a.tools || []).map((t) => t.service).join(", ")}</span>
                    </div>
                    <span className="wf-agent-score" style={{ color: blastColor(a.blast_radius?.score || 0) }}>
                      {a.blast_radius?.score || 0}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Combined blast radius */}
          {allAgentIds.length >= 2 && (
            <div className="wf-combined-risk">
              <div className="wf-combined-label">Combined Blast Radius</div>
              <div className="wf-combined-agents">
                {allAgentIds.map((id) => {
                  const a = agents.find((x) => x.id === id);
                  if (!a) return null;
                  return (
                    <div key={id} className="wf-combined-agent">
                      <div className="wf-agent-dot" style={{ background: agentColors[id] }} />
                      <span>{a.name}</span>
                      <span style={{ color: blastColor(a.blast_radius?.score || 0), fontWeight: 700 }}>
                        {a.blast_radius?.score || 0}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="wf-combined-total">
                {(() => {
                  const max = Math.max(...allAgentIds.map((id) => agents.find((a) => a.id === id)?.blast_radius?.score || 0));
                  const avg = Math.round(allAgentIds.reduce((s, id) => s + (agents.find((a) => a.id === id)?.blast_radius?.score || 0), 0) / allAgentIds.length);
                  const combined = Math.min(100, Math.round(max * 0.6 + avg * 0.4 + allAgentIds.length * 3));
                  return (
                    <>
                      <span className="wf-combined-score" style={{ color: blastColor(combined) }}>{combined}</span>
                      <span className="wf-combined-desc">{blastLabel(combined)} combined exposure</span>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          <div className="wf-actions">
            <button
              className="wf-btn wf-btn-analyze"
              onClick={handleAnalyze}
              disabled={allAgentIds.length < 2 || analyzing}
            >
              {analyzing ? "Analyzing..." : "Analyze Cross-Agent Risk"}
            </button>
          </div>

          {allAgentIds.length >= 2 && (
            <div className="wf-optimize-panel">
              <div className="wf-optimize-label">Optimize Permissions</div>
              <div className="wf-optimize-hint">
                Describe what this workflow does. Arceo will simulate it and identify which permissions are excessive and which are missing.
              </div>
              <textarea
                className="wf-prompt-input"
                value={workflowDesc}
                onChange={(e) => setWorkflowDesc(e.target.value)}
                placeholder={`Example: "Handle customer refund requests — look up order, check eligibility, issue refund if under $500, escalate otherwise."`}
                rows={3}
              />
              <button
                className="wf-btn wf-btn-optimize"
                onClick={handleOptimize}
                disabled={optimizing || !workflowDesc.trim()}
              >
                {optimizing ? "Analyzing permissions..." : "Optimize Permissions →"}
                {!optimizing && <span className="wf-btn-sub">dry-run · instant</span>}
              </button>
            </div>
          )}
        </div>

        {/* ── Right: Results ── */}
        <div className="wf-results">
          {/* Static chain analysis */}
          {staticChains !== null && (
            <div className="wf-static-analysis">
              <div className="wf-static-header">
                <span className="wf-static-title">Cross-Agent Risk Analysis</span>
                <span className="wf-static-sub">Static analysis — no simulation needed</span>
              </div>
              {staticChains.length === 0 ? (
                <div className="wf-no-chains">
                  <span>✓</span> No cross-agent risk chains detected between these agents.
                </div>
              ) : (
                <>
                  <div className="wf-chains-found">
                    {staticChains.filter((c) => c.severity === "critical").length > 0 && (
                      <div className="wf-chains-alert">
                        ⚠ {staticChains.filter((c) => c.severity === "critical").length} critical cross-agent chain{staticChains.filter((c) => c.severity === "critical").length !== 1 ? "s" : ""} detected
                      </div>
                    )}
                    {staticChains.map((c, i) => (
                      <div key={i} className="wf-chain-row" style={{ borderLeftColor: c.severity === "critical" ? "#dc2626" : "#ea580c" }}>
                        <span className="wf-chain-sev" style={{ background: c.severity === "critical" ? "#fef2f2" : "#fff7ed", color: c.severity === "critical" ? "#dc2626" : "#ea580c" }}>
                          {c.severity?.toUpperCase()}
                        </span>
                        <div className="wf-chain-detail">
                          <span className="wf-chain-name">{CHAIN_LABELS[c.chain_name] || c.chain_name}</span>
                          <span className="wf-chain-agents">{c.from_agent} → {c.to_agent}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="wf-simulate-section">
                    <div className="wf-simulate-label">Simulate this workflow</div>
                    <textarea
                      className="wf-prompt-input"
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      placeholder={`Describe a scenario to simulate across ${allAgentIds.length} agents...\n\nExample: "Process a bulk refund for customers affected by the outage, then notify the team and update all records."`}
                      rows={4}
                    />
                    <button
                      className="wf-btn wf-btn-simulate"
                      onClick={handleSimulate}
                      disabled={running || !customPrompt.trim()}
                    >
                      {running ? "Simulating..." : "Dry Run Workflow →"}
                      {!running && <span className="wf-btn-sub">free · instant</span>}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Optimize result */}
          {optimizeResult && (
            <OptimizeResult
              result={optimizeResult}
              onApply={applyAllRecommendations}
              applying={applyingPolicies}
              appliedCount={appliedCount}
            />
          )}

          {/* Simulation result */}
          {result && (
            <WorkflowResult
              result={result}
              agentNames={agentNames}
              agentColors={agentColors}
            />
          )}

          {/* Default empty state */}
          {staticChains === null && !result && !optimizeResult && (
            <div className="wf-results-empty">
              <div className="wf-results-empty-icon">⛓</div>
              <h3>Cross-Agent Risk Detection</h3>
              <p>Select a coordinator and at least one specialist, then click <strong>Analyze Cross-Agent Risk</strong> to see what dangerous sequences emerge when these agents work together.</p>
              <div className="wf-results-examples">
                <div className="wf-results-example">
                  <span className="wf-ex-sev critical">CRITICAL</span>
                  <span>Support agent reads PII → Finance agent issues refund without approval</span>
                </div>
                <div className="wf-results-example">
                  <span className="wf-ex-sev high">HIGH</span>
                  <span>DevOps agent changes production → Notifier agent broadcasts externally</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
