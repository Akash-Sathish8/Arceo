import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { apiFetch } from "./api.js";
import "./AgentDetail.css";

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

// ── Graph Visualization with hover tooltips + resize ──────────────────────

function GraphVisualization({ graph }) {
  const canvasRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const positionsRef = useRef({});
  const nodesRef = useRef([]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    const width = canvas.parentElement.offsetWidth;
    const actions = graph.nodes.filter((n) => n.type === "action");
    const height = Math.max(500, actions.length * 22 + 60);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.scale(dpr, dpr);

    const agents = graph.nodes.filter((n) => n.type === "agent");
    const tools = graph.nodes.filter((n) => n.type === "tool");
    const risks = graph.nodes.filter((n) => n.type === "risk");

    const positions = {};
    const padding = 40;
    const cols = [80, 200, width * 0.55, width - 90];

    agents.forEach((n) => {
      positions[n.id] = { x: cols[0], y: height / 2, node: n };
    });

    tools.forEach((n, i) => {
      const spacing = (height - padding * 2) / (tools.length + 1);
      positions[n.id] = { x: cols[1], y: padding + spacing * (i + 1), node: n };
    });

    // Group actions by tool, layout vertically
    const actionsByTool = {};
    graph.edges.filter((e) => e.relation === "exposes").forEach((e) => {
      if (!actionsByTool[e.source]) actionsByTool[e.source] = [];
      actionsByTool[e.source].push(e.target);
    });

    let actionIndex = 0;
    const actionSpacing = (height - padding * 2) / (actions.length + 1);
    tools.forEach((tool) => {
      const toolActions = actionsByTool[tool.id] || [];
      toolActions.forEach((actionId) => {
        actionIndex++;
        const node = graph.nodes.find((n) => n.id === actionId);
        positions[actionId] = { x: cols[2], y: padding + actionSpacing * actionIndex, node };
      });
    });

    // Deduplicate risk label positions
    const uniqueRisks = [...new Set(risks.map((n) => n.label))];
    const riskNodeMap = {};
    risks.forEach((n) => { if (!riskNodeMap[n.label]) riskNodeMap[n.label] = n.id; });
    Object.values(riskNodeMap).forEach((id, i) => {
      const spacing = (height - padding * 2) / (uniqueRisks.length + 1);
      const node = graph.nodes.find((n) => n.id === id);
      positions[id] = { x: cols[3], y: padding + spacing * (i + 1), node };
    });
    risks.forEach((n) => {
      if (!positions[n.id]) positions[n.id] = { ...positions[riskNodeMap[n.label]], node: n };
    });

    positionsRef.current = positions;
    nodesRef.current = graph.nodes;

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Column headers
    ctx.fillStyle = "#999999";
    ctx.font = "600 10px Inter, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("AGENT", cols[0], 18);
    ctx.fillText("TOOLS", cols[1], 18);
    ctx.fillText("ACTIONS", cols[2], 18);
    ctx.fillText("RISKS", cols[3], 18);

    // Draw curved edges
    graph.edges.forEach((edge) => {
      const from = positions[edge.source];
      const to = positions[edge.target];
      if (!from || !to) return;

      ctx.beginPath();
      const cpx = (from.x + to.x) / 2;
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(cpx, (from.y + to.y) / 2, to.x, to.y);

      if (edge.relation === "has_risk") {
        const targetNode = graph.nodes.find((n) => n.id === edge.target);
        ctx.strokeStyle = (RISK_COLORS[targetNode?.label] || "#ddd") + "30";
        ctx.lineWidth = 1;
      } else if (edge.relation === "has_tool") {
        ctx.strokeStyle = "#d0d0d0";
        ctx.lineWidth = 1.5;
      } else {
        ctx.strokeStyle = "#e8e8e8";
        ctx.lineWidth = 1;
      }
      ctx.stroke();
    });

    // Draw nodes
    graph.nodes.forEach((node) => {
      const pos = positions[node.id];
      if (!pos) return;

      if (node.type === "agent") {
        ctx.fillStyle = "#111111";
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "600 10px Inter, -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("AGENT", pos.x, pos.y);
      } else if (node.type === "tool") {
        ctx.fillStyle = "#f0f0f0";
        ctx.strokeStyle = "#d0d0d0";
        ctx.lineWidth = 1;
        ctx.beginPath();
        drawRoundRect(ctx, pos.x - 35, pos.y - 13, 70, 26, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#333";
        ctx.font = "600 10px Inter, -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label = node.label.length > 10 ? node.label.slice(0, 9) + ".." : node.label;
        ctx.fillText(label, pos.x, pos.y);
      } else if (node.type === "action") {
        const hasRisk = node.risk_labels && node.risk_labels.length > 0;
        const irreversible = node.reversible === false;
        ctx.fillStyle = irreversible ? "#fef2f2" : hasRisk ? "#fffaf0" : "#f0fff4";
        ctx.strokeStyle = irreversible ? "#fca5a5" : hasRisk ? "#fbd38d" : "#9ae6b4";
        ctx.lineWidth = 1;
        ctx.beginPath();
        drawRoundRect(ctx, pos.x - 55, pos.y - 10, 110, 20, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = irreversible ? "#e53e3e" : hasRisk ? "#555" : "#38a169";
        ctx.font = irreversible ? "bold 9px monospace" : "9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label = node.label.length > 18 ? node.label.slice(0, 17) + ".." : node.label;
        ctx.fillText(label, pos.x, pos.y);
      } else if (node.type === "risk") {
        // Only draw unique risk labels once
        if (node.id === riskNodeMap[node.label]) {
          const col = RISK_COLORS[node.label] || "#666";
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = col;
          ctx.font = "bold 9px Inter, -apple-system, sans-serif";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(RISK_LABELS[node.label] || node.label, pos.x + 14, pos.y);
        }
      }
    });
  }, [graph]);

  // Draw on mount + window resize
  useEffect(() => {
    draw();
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  // Hover tooltip
  const handleMouseMove = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let found = null;
    for (const [id, pos] of Object.entries(positionsRef.current)) {
      const node = pos.node;
      if (!node) continue;

      let hitRadius = 12;
      if (node.type === "action") hitRadius = 55;
      else if (node.type === "tool") hitRadius = 35;
      else if (node.type === "agent") hitRadius = 22;

      const dx = mx - pos.x;
      const dy = my - pos.y;
      if (node.type === "action") {
        if (Math.abs(dx) < 55 && Math.abs(dy) < 10) found = { node, x: e.clientX, y: e.clientY };
      } else {
        if (dx * dx + dy * dy < hitRadius * hitRadius) found = { node, x: e.clientX, y: e.clientY };
      }
      if (found) break;
    }

    if (found) {
      canvas.style.cursor = "pointer";
      setTooltip(found);
    } else {
      canvas.style.cursor = "default";
      setTooltip(null);
    }
  }, []);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  return (
    <div className="graph-wrapper">
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {tooltip && (
        <div
          className="graph-tooltip"
          style={{ left: tooltip.x + 12, top: tooltip.y - 8, position: "fixed" }}
        >
          {tooltip.node.type === "action" && (
            <>
              <div className="tt-title">{tooltip.node.label}</div>
              <div className="tt-desc">{tooltip.node.description}</div>
              {tooltip.node.risk_labels?.length > 0 && (
                <div className="tt-risks">
                  {tooltip.node.risk_labels.map((r) => (
                    <span key={r} className="tt-risk" style={{ color: RISK_COLORS[r] }}>
                      {r}
                    </span>
                  ))}
                </div>
              )}
              {tooltip.node.reversible === false && (
                <div className="tt-irreversible">Irreversible</div>
              )}
            </>
          )}
          {tooltip.node.type === "tool" && (
            <>
              <div className="tt-title">{tooltip.node.label}</div>
              <div className="tt-desc">{tooltip.node.description}</div>
            </>
          )}
          {tooltip.node.type === "agent" && (
            <div className="tt-title">{tooltip.node.label}</div>
          )}
          {tooltip.node.type === "risk" && (
            <>
              <div className="tt-title" style={{ color: RISK_COLORS[tooltip.node.label] }}>
                {RISK_LABELS[tooltip.node.label] || tooltip.node.label}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
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

  const handleDelete = async () => {
    if (!confirm(`Delete "${data.agent.name}"? This cannot be undone.`)) return;
    try {
      await apiFetch(`/api/authority/agent/${agentId}`, { method: "DELETE" });
      navigate("/");
    } catch (err) {
      alert("Failed to delete: " + err.message);
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
      loadData();
    } catch (err) {
      alert("Failed to add policy: " + err.message);
    }
  };

  const handleDeletePolicy = async (policyId) => {
    try {
      await apiFetch(`/api/authority/policy/${policyId}`, { method: "DELETE" });
      loadData();
    } catch (err) {
      alert("Failed to delete policy: " + err.message);
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

  return (
    <div className="detail-page">
      <div className="detail-topbar">
        <Link to="/" className="back-link">&larr; All Agents</Link>
        <button className="delete-agent-btn" onClick={handleDelete}>Delete Agent</button>
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
        <div className="detail-score" style={{ borderColor: scoreColor, color: scoreColor }}>
          <div className="ds-number">{br.score}</div>
          <div className="ds-label">Blast Radius</div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="detail-stats">
        <div className="d-stat"><strong>{br.total_actions}</strong><span>Total Actions</span></div>
        <div className="d-stat" style={{ color: "#dc2626" }}><strong>{br.moves_money}</strong><span>Move Money</span></div>
        <div className="d-stat" style={{ color: "#7c3aed" }}><strong>{br.touches_pii}</strong><span>Touch PII</span></div>
        <div className="d-stat" style={{ color: "#ea580c" }}><strong>{br.deletes_data}</strong><span>Delete Data</span></div>
        <div className="d-stat" style={{ color: "#2563eb" }}><strong>{br.sends_external}</strong><span>Send External</span></div>
        <div className="d-stat" style={{ color: "#0d9488" }}><strong>{br.changes_production}</strong><span>Change Prod</span></div>
        <div className="d-stat"><strong>{br.irreversible_actions}</strong><span>Irreversible</span></div>
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
          <input placeholder="tool.action (e.g. stripe.create_refund)" value={newPattern} onChange={(e) => setNewPattern(e.target.value)} required />
          <select value={newEffect} onChange={(e) => setNewEffect(e.target.value)}>
            {EFFECT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <input placeholder="Reason" value={newReason} onChange={(e) => setNewReason(e.target.value)} />
          <button type="submit">Add Policy</button>
        </form>
      </div>

      {/* Execution Log */}
      {executions && executions.length > 0 && (
        <div className="detail-section">
          <h2>Recent Executions ({executions.length})</h2>
          <div className="exec-list">
            {executions.slice(0, 20).map((e) => {
              const st = EXEC_STATUS_STYLE[e.status] || {};
              return (
                <div key={e.id} className="exec-row">
                  <span className="exec-time">{new Date(e.timestamp).toLocaleString()}</span>
                  <code className="exec-action">{e.tool}.{e.action}</code>
                  <span className="exec-status" style={{ background: st.bg, color: st.color }}>{e.status}</span>
                  <span className="exec-detail">{e.detail}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Graph */}
      <div className="detail-section">
        <h2>Authority Graph</h2>
        <p className="graph-hint">Hover over nodes for details</p>
        <div className="graph-container">
          <GraphVisualization graph={graph} />
        </div>
        <div className="graph-legend">
          <span className="legend-item"><span className="legend-dot" style={{ background: "#f0fff4", border: "1px solid #9ae6b4" }} /> Safe</span>
          <span className="legend-item"><span className="legend-dot" style={{ background: "#fffaf0", border: "1px solid #fbd38d" }} /> Has Risk</span>
          <span className="legend-item"><span className="legend-dot" style={{ background: "#fef2f2", border: "1px solid #fca5a5" }} /> Irreversible</span>
        </div>
      </div>

      {/* Chains */}
      {chains.length > 0 && (
        <div className="detail-section">
          <h2>Dangerous Chains ({chains.length})</h2>
          <div className="detail-chains">
            {chains.map((c) => {
              const sev = SEV_STYLE[c.severity] || SEV_STYLE.high;
              return (
                <div key={c.id} className="d-chain">
                  <div className="d-chain-top">
                    <span className="d-chain-sev" style={{ background: sev.bg, color: sev.color }}>{c.severity}</span>
                    <strong>{c.name}</strong>
                  </div>
                  <p>{c.description}</p>
                  <div className="d-chain-steps">
                    {c.steps.map((step, j) => (
                      <span key={j}>
                        <span className="step-tag" style={{ borderColor: RISK_COLORS[step] || "#ccc", color: RISK_COLORS[step] || "#555" }}>{step}</span>
                        {j < c.steps.length - 1 && <span className="step-arrow">&rarr;</span>}
                      </span>
                    ))}
                  </div>
                  <div className="d-chain-actions">
                    {c.matching_actions.map((group, gi) => (
                      <div key={gi} className="match-group">
                        <span className="match-label">Step {gi + 1}:</span>
                        {group.map((a) => <code key={a} className="match-action">{a}</code>)}
                      </div>
                    ))}
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
