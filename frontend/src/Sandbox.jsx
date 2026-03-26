import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "./api.js";
import "./Sandbox.css";

const SEVERITY_COLORS = {
  critical: { bg: "#fef2f2", color: "#dc2626", border: "#fca5a5" },
  high: { bg: "#fff7ed", color: "#ea580c", border: "#fdba74" },
  medium: { bg: "#fefce8", color: "#ca8a04", border: "#fde68a" },
  info: { bg: "#edf5fb", color: "#4B9CD3", border: "#7DB8E0" },
};

const CATEGORY_COLORS = {
  normal: { bg: "#f0fdf4", color: "#16a34a" },
  edge_case: { bg: "#fff7ed", color: "#ea580c" },
  adversarial: { bg: "#fef2f2", color: "#dc2626" },
  chain_exploit: { bg: "#f5f3ff", color: "#7c3aed" },
};

const CATEGORY_LABELS = {
  normal: "Normal",
  edge_case: "Edge Case",
  adversarial: "Adversarial",
  chain_exploit: "Chain Exploit",
};

const CATEGORY_FILTERS = [
  { value: "all", label: "All Categories" },
  { value: "normal", label: "Normal" },
  { value: "edge_case", label: "Edge Case" },
];

const DECISION_STYLE = {
  ALLOW: { bg: "#d4edda", color: "#155724" },
  BLOCK: { bg: "#f8d7da", color: "#721c24" },
  REQUIRE_APPROVAL: { bg: "#fff3cd", color: "#856404" },
};

export default function Sandbox() {
  const [scenarios, setScenarios] = useState([]);
  const [agents, setAgents] = useState([]);
  const [simulations, setSimulations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Selection state
  const [selectedScenario, setSelectedScenario] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [customPrompt, setCustomPrompt] = useState("");
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);

  // Simulation state
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [previousResult, setPreviousResult] = useState(null);
  const [runError, setRunError] = useState(null);

  useEffect(() => {
    Promise.all([
      apiFetch("/api/authority/agents"),
      apiFetch("/api/sandbox/simulations"),
    ])
      .then(([agentData, simData]) => {
        setAgents(agentData.agents);
        setSimulations(simData.simulations);
        if (agentData.agents.length > 0) {
          setSelectedAgent(agentData.agents[0].id);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  // Load scenarios when agent changes
  const [loadingScenarios, setLoadingScenarios] = useState(false);
  useEffect(() => {
    if (!selectedAgent) { setScenarios([]); return; }
    setLoadingScenarios(true);
    setSelectedScenario(null);
    apiFetch(`/api/sandbox/agent/${selectedAgent}/scenarios`)
      .then((d) => {
        setScenarios(d.scenarios);
        setLoadingScenarios(false);
      })
      .catch(() => {
        setScenarios([]);
        setLoadingScenarios(false);
      });
  }, [selectedAgent]);

  const filteredScenarios = useMemo(() => {
    let result = [...scenarios];
    if (categoryFilter !== "all") result = result.filter((s) => s.category === categoryFilter);
    return result;
  }, [scenarios, categoryFilter]);

  const handleRun = async (dryRun = true) => {
    if (!selectedScenario || !selectedAgent) return;
    setRunning(true);
    setRunError(null);
    if (result) setPreviousResult(result);
    setResult(null);
    try {
      const body = { agent_id: selectedAgent, dry_run: dryRun };
      if (useCustomPrompt && customPrompt.trim()) {
        body.custom_prompt = customPrompt.trim();
        body.scenario_id = "";
      } else if (selectedScenario) {
        body.scenario_id = selectedScenario.id;
      }
      const data = await apiFetch("/api/sandbox/simulate", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setResult(data);
      const simData = await apiFetch("/api/sandbox/simulations");
      setSimulations(simData.simulations);
    } catch (err) {
      setRunError(err.message);
    }
    setRunning(false);
  };

  if (loading) {
    return (
      <div className="sandbox-page">
        <div className="loading-state"><div className="spinner" /><p>Loading sandbox...</p></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="sandbox-page">
        <div className="error-state">
          <div className="error-icon">!</div>
          <h2>Failed to load sandbox</h2>
          <p>{error}</p>
          <button className="retry-btn" onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    );
  }

  const totalViolations = simulations.length > 0 && result ? result.report.violations.length : 0;

  return (
    <div className="sandbox-page">
      <header className="sandbox-header">
        <h1>Sandbox</h1>
        <p>Run AI agents against mock APIs. Watch what they do. See what goes wrong.</p>
      </header>

      {/* Summary Stats */}
      <div className="sandbox-stats">
        <div className="sandbox-stat">
          <div className="sandbox-stat-number">{scenarios.filter((s) => s.category !== "adversarial" && s.category !== "chain_exploit").length}</div>
          <div className="sandbox-stat-label">Scenarios</div>
        </div>
        <div className="sandbox-stat">
          <div className="sandbox-stat-number">{agents.length}</div>
          <div className="sandbox-stat-label">Agents</div>
        </div>
        <div className="sandbox-stat">
          <div className="sandbox-stat-number">{simulations.length}</div>
          <div className="sandbox-stat-label">Runs</div>
        </div>
        <div className="sandbox-stat">
          <div className="sandbox-stat-number">{scenarios.filter((s) => s.category === "normal").length}</div>
          <div className="sandbox-stat-label">Normal</div>
        </div>
        <div className="sandbox-stat">
          <div className="sandbox-stat-number">{scenarios.filter((s) => s.category === "edge_case").length}</div>
          <div className="sandbox-stat-label">Edge Cases</div>
        </div>
      </div>

      {/* Run Simulation — top of page */}
      <section className="run-section" id="run-section">
        <div className="run-controls">
          <div className="run-control-group">
            <label>Agent</label>
            {agents.length === 0 ? (
              <div className="selected-scenario-display">
                <span className="no-selection">No agents yet — <a href="/">create one</a> first</span>
              </div>
            ) : (
              <select
                className="control-select agent-select"
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} (blast radius: {a.blast_radius.score})</option>
                ))}
              </select>
            )}
          </div>
          <div className="run-buttons">
            <button
              className="run-btn primary"
              onClick={() => handleRun(true)}
              disabled={(!selectedScenario && !customPrompt.trim()) || !selectedAgent || running}
            >
              {running ? "Running..." : "Run Simulation"}
            </button>
          </div>
        </div>

        {/* Custom prompt input */}
        <div className="custom-prompt-section">
          <textarea
            className="custom-prompt-input"
            value={customPrompt}
            onChange={(e) => {
              setCustomPrompt(e.target.value);
              if (e.target.value.trim()) {
                setUseCustomPrompt(true);
                setSelectedScenario(null);
              } else {
                setUseCustomPrompt(false);
              }
            }}
            placeholder="Type a custom prompt... e.g. 'A customer wants a refund for a $200 charge they don't recognize'"
            rows={2}
          />
        </div>

        {running && (
          <div className="run-loading">
            <div className="spinner" />
            <p>Executing simulation — enforcing policies, calling mocks, capturing trace...</p>
          </div>
        )}

        {runError && (
          <div className="run-error">
            <strong>Simulation failed:</strong> {runError}
          </div>
        )}
      </section>

      {/* Scenarios (auto-generated from selected agent) */}
      {selectedAgent && !useCustomPrompt && (
        <section>
          <div className="section-header">
            <h2>Or pick a scenario</h2>
            <div className="controls">
              <select className="control-select" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                {CATEGORY_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
          </div>

          {loadingScenarios ? (
            <div className="empty-state"><div className="spinner" style={{ margin: "0 auto" }} /></div>
          ) : filteredScenarios.length === 0 ? (
            <div className="empty-state">No scenarios available for this agent.</div>
          ) : (
            <div className="scenario-grid">
              {filteredScenarios.map((s) => {
                const cat = CATEGORY_COLORS[s.category] || CATEGORY_COLORS.normal;
                const sev = SEVERITY_COLORS[s.severity] || SEVERITY_COLORS.info;
                const isSelected = selectedScenario?.id === s.id;
                return (
                  <div
                    key={s.id}
                    className={`scenario-card ${isSelected ? "selected" : ""}`}
                    onClick={() => {
                      setSelectedScenario(s);
                      setCustomPrompt("");
                      setUseCustomPrompt(false);
                    }}
                  >
                    <div className="scenario-card-top">
                      <span className="scenario-badge" style={{ background: cat.bg, color: cat.color }}>
                        {CATEGORY_LABELS[s.category] || s.category}
                      </span>
                      <span className="scenario-badge" style={{ background: sev.bg, color: sev.color }}>
                        {s.severity}
                      </span>
                    </div>
                    <h3 className="scenario-card-name">{s.name}</h3>
                    <p className="scenario-card-desc">{s.description}</p>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Inline Results */}
      {result && (
        <section className="results-section">
          <div className="section-header">
            <h2>Results</h2>
            <Link to={`/sandbox/${result.simulation_id}`} className="view-report-link">
              View Full Report &rarr;
            </Link>
          </div>

          {/* Before/After Comparison */}
          {previousResult && (
            <div className="comparison-banner">
              <h3>Before → After</h3>
              <div className="comparison-grid">
                <div className="comparison-item">
                  <span className="comp-label">Risk Score</span>
                  <span className="comp-before">{previousResult.report.risk_score}</span>
                  <span className="comp-arrow">→</span>
                  <span className={`comp-after ${result.report.risk_score < previousResult.report.risk_score ? "improved" : ""}`}>
                    {result.report.risk_score}
                  </span>
                  {result.report.risk_score < previousResult.report.risk_score && (
                    <span className="comp-delta">-{(previousResult.report.risk_score - result.report.risk_score).toFixed(1)}</span>
                  )}
                </div>
                <div className="comparison-item">
                  <span className="comp-label">Violations</span>
                  <span className="comp-before">{previousResult.report.violations.length}</span>
                  <span className="comp-arrow">→</span>
                  <span className={`comp-after ${result.report.violations.length < previousResult.report.violations.length ? "improved" : ""}`}>
                    {result.report.violations.length}
                  </span>
                </div>
                <div className="comparison-item">
                  <span className="comp-label">Blocked</span>
                  <span className="comp-before">{previousResult.report.actions_blocked}</span>
                  <span className="comp-arrow">→</span>
                  <span className={`comp-after ${result.report.actions_blocked > previousResult.report.actions_blocked ? "improved" : ""}`}>
                    {result.report.actions_blocked}
                  </span>
                </div>
                <div className="comparison-item">
                  <span className="comp-label">Chains</span>
                  <span className="comp-before">{previousResult.report.chains_triggered.length}</span>
                  <span className="comp-arrow">→</span>
                  <span className={`comp-after ${result.report.chains_triggered.length < previousResult.report.chains_triggered.length ? "improved" : ""}`}>
                    {result.report.chains_triggered.length}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Re-run button */}
          <div className="rerun-row">
            <button className="rerun-btn" onClick={() => handleRun(true)} disabled={running}>
              Re-run Simulation (test policies)
            </button>
          </div>

          <div className="results-stats">
            <div className="result-stat risk-score-stat">
              <div
                className="result-stat-number"
                style={{ color: result.report.risk_score >= 50 ? "#dc2626" : result.report.risk_score >= 25 ? "#ea580c" : "#16a34a" }}
              >
                {result.report.risk_score}
              </div>
              <div className="result-stat-label">Risk Score</div>
            </div>
            <div className="result-stat">
              <div className="result-stat-number">{result.report.total_steps}</div>
              <div className="result-stat-label">Total Steps</div>
            </div>
            <div className="result-stat executed">
              <div className="result-stat-number">{result.report.actions_executed}</div>
              <div className="result-stat-label">Executed</div>
            </div>
            <div className="result-stat blocked">
              <div className="result-stat-number">{result.report.actions_blocked}</div>
              <div className="result-stat-label">Blocked</div>
            </div>
            <div className="result-stat pending">
              <div className="result-stat-number">{result.report.actions_pending}</div>
              <div className="result-stat-label">Pending</div>
            </div>
            <div className="result-stat violations-stat">
              <div className="result-stat-number">{result.report.violations.length}</div>
              <div className="result-stat-label">Violations</div>
            </div>
            <div className="result-stat chains-stat">
              <div className="result-stat-number">{result.report.chains_triggered.length}</div>
              <div className="result-stat-label">Chains</div>
            </div>
          </div>

          {/* Quick Trace */}
          <div className="quick-trace">
            <h3>Trace</h3>
            <div className="trace-steps-mini">
              {result.trace.steps.map((step, i) => {
                const ds = DECISION_STYLE[step.enforce_decision] || DECISION_STYLE.ALLOW;
                return (
                  <div key={i} className="trace-step-mini">
                    <code className="trace-action">{step.tool}.{step.action}</code>
                    <span className="trace-decision" style={{ background: ds.bg, color: ds.color }}>
                      {step.enforce_decision}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Violations */}
          {result.report.violations.length > 0 && (
            <div className="quick-violations">
              <h3>Violations ({result.report.violations.length})</h3>
              <div className="violation-list">
                {result.report.violations.map((v, i) => {
                  const sev = SEVERITY_COLORS[v.severity] || SEVERITY_COLORS.medium;
                  return (
                    <div key={i} className="violation-card" style={{ borderLeftColor: sev.border }}>
                      <span className="violation-sev" style={{ background: sev.bg, color: sev.color }}>{v.severity}</span>
                      <strong>{v.title}</strong>
                      <span className="violation-desc">{v.description}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Chains */}
          {result.report.chains_triggered.length > 0 && (
            <div className="quick-chains">
              <h3>Chains Triggered ({result.report.chains_triggered.length})</h3>
              <div className="chain-list">
                {result.report.chains_triggered.map((c, i) => {
                  const sev = SEVERITY_COLORS[c.severity] || SEVERITY_COLORS.high;
                  return (
                    <div key={i} className="chain-result-card" style={{ borderLeftColor: sev.border }}>
                      <span className="chain-result-sev" style={{ background: sev.bg, color: sev.color }}>{c.severity}</span>
                      <strong>{c.chain_name}</strong>
                      <span className="chain-result-desc">{c.description}</span>
                      <span className="chain-steps-ref">Steps: {c.step_indices.join(" → ")}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recommendations */}
          {result.report.recommendations.length > 0 && (
            <div className="quick-recs">
              <div className="recs-header">
                <h3>Recommendations</h3>
                {result.report.recommendations.some((r) => r.actionable) && (
                  <button
                    className="apply-all-btn"
                    onClick={async () => {
                      const actionable = result.report.recommendations.filter((r) => r.actionable);
                      try {
                        const data = await apiFetch("/api/sandbox/apply-all-policies", {
                          method: "POST",
                          body: JSON.stringify({
                            agent_id: selectedAgent,
                            policies: actionable.map((r) => ({
                              agent_id: selectedAgent,
                              action_pattern: r.action_pattern,
                              effect: r.effect,
                              reason: r.reason,
                            })),
                          }),
                        });
                        alert(`Applied ${data.created} policies${data.skipped ? `, ${data.skipped} already existed` : ""}`);
                      } catch (err) {
                        alert("Failed: " + err.message);
                      }
                    }}
                  >
                    Apply All Policies
                  </button>
                )}
              </div>
              {result.report.recommendations.map((r, i) => {
                const rec = typeof r === "string" ? { message: r, actionable: false } : r;
                return (
                  <div key={i} className="rec-item-actionable">
                    <span className="rec-message">{rec.message}</span>
                    {rec.actionable && (
                      <button
                        className="apply-btn"
                        onClick={async () => {
                          try {
                            const data = await apiFetch("/api/sandbox/apply-policy", {
                              method: "POST",
                              body: JSON.stringify({
                                agent_id: selectedAgent,
                                action_pattern: rec.action_pattern,
                                effect: rec.effect,
                                reason: rec.reason,
                              }),
                            });
                            alert(data.already_exists ? "Policy already exists" : "Policy created!");
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
          )}
        </section>
      )}

      {/* Past Simulations */}
      {simulations.length > 0 && (
        <section>
          <div className="section-header">
            <h2>Past Simulations ({simulations.length})</h2>
          </div>
          <table className="log-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Agent</th>
                <th>Scenario</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {simulations.map((sim) => (
                <tr key={sim.id}>
                  <td className="log-time">{new Date(sim.created_at).toLocaleString()}</td>
                  <td className="mono">{sim.agent_id}</td>
                  <td className="mono">{sim.scenario_id}</td>
                  <td>
                    <span
                      className="status-badge"
                      style={{
                        background: sim.status === "completed" ? "#d4edda" : "#f8d7da",
                        color: sim.status === "completed" ? "#155724" : "#721c24",
                      }}
                    >
                      {sim.status}
                    </span>
                  </td>
                  <td>
                    <Link to={`/sandbox/${sim.id}`} className="view-link">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
