import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { apiFetch } from "./api.js";
import "./SimulationDetail.css";

const SEVERITY_COLORS = {
  critical: { bg: "#fef2f2", color: "#dc2626", border: "#fca5a5" },
  high: { bg: "#fff7ed", color: "#ea580c", border: "#fdba74" },
  medium: { bg: "#fefce8", color: "#ca8a04", border: "#fde68a" },
  info: { bg: "#edf5fb", color: "#4B9CD3", border: "#7DB8E0" },
};

const DECISION_STYLE = {
  ALLOW: { bg: "#d4edda", color: "#155724", dot: "#38a169" },
  BLOCK: { bg: "#f8d7da", color: "#721c24", dot: "#dc2626" },
  REQUIRE_APPROVAL: { bg: "#fff3cd", color: "#856404", dot: "#ca8a04" },
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

export default function SimulationDetail() {
  const { simulationId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedSteps, setExpandedSteps] = useState({});

  useEffect(() => {
    apiFetch(`/api/sandbox/simulation/${simulationId}`)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [simulationId]);

  const toggleStep = (idx) => {
    setExpandedSteps((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  if (loading) {
    return (
      <div className="sim-detail-page">
        <Link to="/sandbox" className="back-link">&larr; Sandbox</Link>
        <div className="loading-state"><div className="spinner" /><p>Loading simulation...</p></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="sim-detail-page">
        <Link to="/sandbox" className="back-link">&larr; Sandbox</Link>
        <div className="error-state">
          <div className="error-icon">!</div>
          <h2>Failed to load simulation</h2>
          <p>{error}</p>
          <button className="retry-btn" onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    );
  }

  const { trace, report } = data;
  const riskScore = report.risk_score;
  const scoreColor = riskScore >= 50 ? "#dc2626" : riskScore >= 25 ? "#ea580c" : "#16a34a";

  return (
    <div className="sim-detail-page">
      <Link to="/sandbox" className="back-link">&larr; Sandbox</Link>

      {/* Header */}
      <div className="sim-detail-header">
        <div>
          <h1>Simulation Report</h1>
          <div className="sim-meta">
            <span className="sim-id">#{data.simulation_id}</span>
            <span className="sim-agent">{trace.agent_name}</span>
            <span className="sim-scenario">{trace.scenario_name}</span>
            <span
              className="sim-status-badge"
              style={{
                background: data.status === "completed" ? "#d4edda" : "#f8d7da",
                color: data.status === "completed" ? "#155724" : "#721c24",
              }}
            >
              {data.status}
            </span>
          </div>
        </div>
        <div className="sim-score-ring" style={{ borderColor: scoreColor, color: scoreColor }}>
          <div className="sim-score-number">{riskScore}</div>
          <div className="sim-score-label">Risk Score</div>
        </div>
      </div>

      {/* Prompt */}
      <div className="sim-prompt-box">
        <div className="sim-prompt-label">Scenario Prompt</div>
        <p className="sim-prompt-text">{trace.prompt}</p>
      </div>

      {/* Stats Row */}
      <div className="sim-stats-row">
        <div className="sim-stat">
          <strong>{report.total_steps}</strong><span>Total Steps</span>
        </div>
        <div className="sim-stat" style={{ color: "#155724" }}>
          <strong>{report.actions_executed}</strong><span>Executed</span>
        </div>
        <div className="sim-stat" style={{ color: "#721c24" }}>
          <strong>{report.actions_blocked}</strong><span>Blocked</span>
        </div>
        <div className="sim-stat" style={{ color: "#856404" }}>
          <strong>{report.actions_pending}</strong><span>Pending</span>
        </div>
        <div className="sim-stat" style={{ color: "#dc2626" }}>
          <strong>{report.violations.length}</strong><span>Violations</span>
        </div>
        <div className="sim-stat" style={{ color: "#7c3aed" }}>
          <strong>{report.chains_triggered.length}</strong><span>Chains</span>
        </div>
      </div>

      {/* Risk Breakdown */}
      <div className="sim-section">
        <h2>Risk Breakdown</h2>
        <div className="risk-breakdown-row">
          {Object.entries(report.risk_summary).map(([key, count]) => (
            <div key={key} className="risk-breakdown-item">
              <div className="risk-breakdown-dot" style={{ background: RISK_COLORS[key] || "#999" }} />
              <span className="risk-breakdown-label">{RISK_LABELS[key] || key}</span>
              <strong className="risk-breakdown-count" style={{ color: RISK_COLORS[key] || "#999" }}>{count}</strong>
            </div>
          ))}
        </div>
      </div>

      {/* Trace Timeline */}
      <div className="sim-section">
        <h2>Execution Trace ({trace.steps.length} steps)</h2>
        <div className="trace-timeline">
          {trace.steps.map((step, i) => {
            const ds = DECISION_STYLE[step.enforce_decision] || DECISION_STYLE.ALLOW;
            const isExpanded = expandedSteps[i];
            return (
              <div key={i} className="timeline-step" onClick={() => toggleStep(i)}>
                <div className="timeline-rail">
                  <div className="timeline-dot" style={{ background: ds.dot }} />
                  {i < trace.steps.length - 1 && <div className="timeline-line" />}
                </div>
                <div className="timeline-content">
                  <div className="timeline-row">
                    <span className="timeline-index">#{i}</span>
                    <code className="timeline-action">{step.tool}.{step.action}</code>
                    <span className="timeline-decision" style={{ background: ds.bg, color: ds.color }}>
                      {step.enforce_decision}
                    </span>
                    <span className="timeline-expand">{isExpanded ? "−" : "+"}</span>
                  </div>
                  {isExpanded && (
                    <div className="timeline-detail">
                      {step.params && Object.keys(step.params).length > 0 && (
                        <div className="timeline-json">
                          <div className="json-label">Params</div>
                          <pre>{JSON.stringify(step.params, null, 2)}</pre>
                        </div>
                      )}
                      {step.result && (
                        <div className="timeline-json">
                          <div className="json-label">Result</div>
                          <pre>{JSON.stringify(step.result, null, 2)}</pre>
                        </div>
                      )}
                      {step.enforce_policy && (
                        <div className="timeline-json">
                          <div className="json-label">Policy</div>
                          <pre>{JSON.stringify(step.enforce_policy, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Violations */}
      {report.violations.length > 0 && (
        <div className="sim-section">
          <h2>Violations ({report.violations.length})</h2>
          <div className="sim-violations">
            {report.violations.map((v, i) => {
              const sev = SEVERITY_COLORS[v.severity] || SEVERITY_COLORS.medium;
              return (
                <div key={i} className="sim-violation-card" style={{ borderLeftColor: sev.border }}>
                  <div className="sim-violation-top">
                    <span className="sim-violation-sev" style={{ background: sev.bg, color: sev.color }}>{v.severity}</span>
                    <strong>{v.title}</strong>
                  </div>
                  <p>{v.description}</p>
                  <div className="sim-violation-steps">
                    Steps: {v.step_indices.map((idx) => (
                      <code key={idx} className="step-ref">#{idx}</code>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Chains Triggered */}
      {report.chains_triggered.length > 0 && (
        <div className="sim-section">
          <h2>Chains Triggered ({report.chains_triggered.length})</h2>
          <div className="sim-chains">
            {report.chains_triggered.map((c, i) => {
              const sev = SEVERITY_COLORS[c.severity] || SEVERITY_COLORS.high;
              return (
                <div key={i} className="sim-chain-card" style={{ borderLeftColor: sev.border }}>
                  <div className="sim-chain-top">
                    <span className="sim-chain-sev" style={{ background: sev.bg, color: sev.color }}>{c.severity}</span>
                    <strong>{c.chain_name}</strong>
                  </div>
                  <p>{c.description}</p>
                  <div className="sim-chain-steps">
                    Chain path: {c.step_indices.map((idx, j) => (
                      <span key={idx}>
                        <code className="step-ref">#{idx}</code>
                        {j < c.step_indices.length - 1 && <span className="chain-arrow">&rarr;</span>}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {report.recommendations.length > 0 && (
        <div className="sim-section">
          <div className="sim-recs-header">
            <h2>Recommendations</h2>
            {report.recommendations.some((r) => r.actionable) && (
              <button
                className="sim-apply-all-btn"
                onClick={async () => {
                  const actionable = report.recommendations.filter((r) => r.actionable);
                  try {
                    const resp = await apiFetch("/api/sandbox/apply-all-policies", {
                      method: "POST",
                      body: JSON.stringify({
                        agent_id: data.agent_id,
                        policies: actionable.map((r) => ({
                          agent_id: data.agent_id,
                          action_pattern: r.action_pattern,
                          effect: r.effect,
                          reason: r.reason,
                        })),
                      }),
                    });
                    alert(`Applied ${resp.created} policies${resp.skipped ? `, ${resp.skipped} already existed` : ""}`);
                  } catch (err) {
                    alert("Failed: " + err.message);
                  }
                }}
              >
                Apply All Policies
              </button>
            )}
          </div>
          <div className="sim-recs">
            {report.recommendations.map((r, i) => {
              const rec = typeof r === "string" ? { message: r, actionable: false } : r;
              return (
                <div key={i} className="sim-rec-card">
                  <span className="sim-rec-arrow">&rarr;</span>
                  <p>{rec.message}</p>
                  {rec.actionable && (
                    <button
                      className="sim-apply-btn"
                      onClick={async () => {
                        try {
                          const resp = await apiFetch("/api/sandbox/apply-policy", {
                            method: "POST",
                            body: JSON.stringify({
                              agent_id: data.agent_id,
                              action_pattern: rec.action_pattern,
                              effect: rec.effect,
                              reason: rec.reason,
                            }),
                          });
                          alert(resp.already_exists ? "Policy already exists" : "Policy created!");
                        } catch (err) {
                          alert("Failed: " + err.message);
                        }
                      }}
                    >
                      {rec.effect === "BLOCK" ? "Block" : "Require Approval"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
