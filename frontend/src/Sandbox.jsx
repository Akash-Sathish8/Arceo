import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { apiFetch } from "./api.js";
import { toast } from "./Toast.jsx";
import "./Sandbox.css";

function Tooltip({ text, children }) {
  const [coords, setCoords] = useState(null);
  const ref = useRef(null);
  const show = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      setCoords({ top: r.top, left: r.left + r.width / 2 });
    }
  };
  return (
    <span ref={ref} className="tooltip-wrap" onMouseEnter={show} onMouseLeave={() => setCoords(null)}>
      {children}
      {coords && createPortal(
        <span className="tooltip-bubble" style={{ top: coords.top, left: coords.left, transform: "translate(-50%, calc(-100% - 8px))" }}>
          {text}
        </span>,
        document.body
      )}
    </span>
  );
}

const CATEGORY_TOOLTIPS = {
  edge_case:    "Unusual or boundary situations the agent might encounter — tests whether it behaves safely in uncommon scenarios.",
  adversarial:  "Scenarios designed to trick or manipulate the agent into taking unauthorized or harmful actions.",
  chain_exploit:"Tests multi-step sequences where combining two actions creates elevated risk — e.g. reading customer data then sending it outside your system.",
};

const formatDesc = (desc) => {
  // Fix developer jargon
  const noJargon = desc
    .replace(/blast radius/gi, "risk scope")
    .replace(/dry.?run/gi, "simulation");
  // Strip trailing ellipsis artifacts from truncated backend strings
  const cleaned = noJargon.replace(/\.{2,}$/, "").replace(/…$/, "").trimEnd();
  // Capitalize known service names
  const withServices = cleaned
    .replace(/\bstripe\b/gi, "Stripe")
    .replace(/\bzendesk\b/gi, "Zendesk")
    .replace(/\bsalesforce\b/gi, "Salesforce")
    .replace(/\bsendgrid\b/gi, "SendGrid")
    .replace(/\bgithub\b/gi, "GitHub")
    .replace(/\bslack\b/gi, "Slack")
    .replace(/\baws\b/gi, "AWS")
    .replace(/\bhubspot\b/gi, "HubSpot")
    .replace(/\bpagerduty\b/gi, "PagerDuty");
  // Convert snake_case action names to Title Case
  return withServices.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (match) =>
    match.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
};

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
  { value: "adversarial", label: "Adversarial" },
  { value: "chain_exploit", label: "Chain Exploit" },
];

const DECISION_STYLE = {
  ALLOW: { bg: "#d4edda", color: "#155724" },
  BLOCK: { bg: "#f8d7da", color: "#721c24" },
  REQUIRE_APPROVAL: { bg: "#fff3cd", color: "#856404" },
};

export default function Sandbox() {
  const [searchParams] = useSearchParams();
  const preselectedAgent = searchParams.get("agent");
  const navigate = useNavigate();

  const [scenarios, setScenarios] = useState([]);
  const [agents, setAgents] = useState([]);
  const [simulations, setSimulations] = useState([]);
  const [simSearch, setSimSearch] = useState("");
  const [simSort, setSimSort] = useState("newest");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Selection state
  const [selectedScenarios, setSelectedScenarios] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [customPrompt, setCustomPrompt] = useState("");
  const [queuedCustomPrompts, setQueuedCustomPrompts] = useState([]);

  const [agentOpen, setAgentOpen] = useState(false);
  const agentSelectorRef = useRef(null);

  useEffect(() => {
    if (!agentOpen) return;
    const handler = (e) => { if (!agentSelectorRef.current?.contains(e.target)) setAgentOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [agentOpen]);

  // Simulation state
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState(null); // { current, total }
  const [result, setResult] = useState(null);
  const [queueResults, setQueueResults] = useState([]);
  const [previousResult, setPreviousResult] = useState(null);
  const [runError, setRunError] = useState(null);
  const [lastRunMode, setLastRunMode] = useState("");

  useEffect(() => {
    Promise.all([
      apiFetch("/api/authority/agents"),
      apiFetch("/api/sandbox/simulations"),
    ])
      .then(([agentData, simData]) => {
        setAgents(agentData.agents);
        setSimulations(simData.simulations);
        const defaultAgent = preselectedAgent && agentData.agents.find(a => a.id === preselectedAgent)
          ? preselectedAgent
          : agentData.agents[0]?.id || "";
        setSelectedAgent(defaultAgent);
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
    setSelectedScenarios([]);
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

  const toggleScenario = (s) => {
    setSelectedScenarios((prev) => {
      const exists = prev.some((x) => x.id === s.id);
      return exists ? prev.filter((x) => x.id !== s.id) : [...prev, s];
    });
    setCustomPrompt("");
    setUseCustomPrompt(false);
  };

  const addAllToQueue = () => {
    setSelectedScenarios((prev) => {
      const existing = new Set(prev.map((x) => x.id));
      const toAdd = filteredScenarios.filter((s) => !existing.has(s.id));
      return [...prev, ...toAdd];
    });
  };

  const handleRun = async (dryRun = true) => {
    if ((selectedScenarios.length === 0 && queuedCustomPrompts.length === 0) || !selectedAgent) return;
    setRunning(true);
    setRunError(null);
    setLastRunMode(dryRun ? "dry-run" : "llm");
    if (result) setPreviousResult(result);
    setResult(null);
    setQueueResults([]);

    const toRun = [
      ...selectedScenarios.map((s) => ({ type: "scenario", scenario: s })),
      ...queuedCustomPrompts.map((p) => ({ type: "custom", prompt: p })),
    ];
    if (toRun.length === 0) return;
    const allResults = [];

    for (let i = 0; i < toRun.length; i++) {
      setRunProgress({ current: i + 1, total: toRun.length });
      try {
        const body = { agent_id: selectedAgent, dry_run: dryRun };
        if (toRun[i].type === "scenario") {
          body.scenario_id = toRun[i].scenario.id;
        } else {
          body.custom_prompt = toRun[i].prompt;
          body.scenario_id = "";
        }
        const data = await apiFetch("/api/sandbox/simulate", { method: "POST", body: JSON.stringify(body) });
        allResults.push({ scenario: toRun[i].type === "scenario" ? toRun[i].scenario : null, data });
      } catch (_) {
        // continue with remaining scenarios
      }
    }

    setRunProgress(null);
    setQueueResults(allResults);

    if (allResults.length > 0) {
      const lastData = allResults[allResults.length - 1].data;
      setRunning(false);
      navigate(`/sandbox/${lastData.simulation_id}`);
    } else {
      setRunError("All simulations failed");
      toast("All simulations failed", "error");
      setRunning(false);
    }
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


      {/* Run Simulation — top of page */}
      <section className="run-section" id="run-section">
        <div className="run-controls">
          <div className="run-control-group" ref={agentSelectorRef}>
            <label>Agent</label>
            {agents.length === 0 ? (
              <div className="selected-scenario-display">
                <span className="no-selection">No agents yet — <a href="/">create one</a> first</span>
              </div>
            ) : (() => {
              const sel = agents.find((a) => a.id === selectedAgent);
              const sc = sel?.blast_radius?.score ?? 0;
              const scColor = sc >= 70 ? "#dc2626" : sc >= 40 ? "#ea580c" : "#16a34a";
              return (
                <div className={`agent-selector ${agentOpen ? "open" : ""}`}>
                  <div className="agent-selector-current" onClick={() => setAgentOpen((v) => !v)}>
                    {sel ? (
                      <>
                        <div className="agent-sel-info">
                          <strong>{sel.name}</strong>
                          {sel.tools?.filter((t) => t.service).length > 0 && (
                            <span className="agent-sel-tools">{sel.tools.filter((t) => t.service).map((t) => t.service).join(" · ")}</span>
                          )}
                        </div>
                        <div className="agent-sel-right">
                          <div className="agent-sel-score-group">
                            <span className="agent-sel-score-label">Risk Score</span>
                            <span className="agent-sel-score" style={{ color: scColor }}>{sc}</span>
                          </div>
                          <span className="agent-sel-chevron">{agentOpen ? "▾" : "▸"}</span>
                        </div>
                      </>
                    ) : <span className="no-selection">Select an agent...</span>}
                  </div>
                  {agentOpen && (
                    <div className="agent-selector-dropdown">
                      {agents.map((a) => {
                        const s = a.blast_radius?.score ?? 0;
                        const c = s >= 70 ? "#dc2626" : s >= 40 ? "#ea580c" : "#16a34a";
                        return (
                          <div
                            key={a.id}
                            className={`agent-pick-card ${a.id === selectedAgent ? "active" : ""}`}
                            onClick={() => { setSelectedAgent(a.id); setAgentOpen(false); }}
                          >
                            <div className="agent-pick-info">
                              <strong>{a.name}</strong>
                              {a.tools?.filter((t) => t.service).length > 0 && (
                                <span className="agent-pick-tools">{a.tools.filter((t) => t.service).map((t) => t.service).join(" · ")}</span>
                              )}
                            </div>
                            <div style={{ textAlign: "right" }}>
                              <div className="agent-pick-score" style={{ color: c }}>{s}</div>
                              <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.4px" }}>Risk</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
          <div className="run-mode-explainer">
            <div className="run-mode-item">
              <strong>Dry Run</strong>
              <span>Uses mock APIs — no real calls, no cost. Tests your policies against the scenario instantly. Start here.</span>
            </div>
            <div className="run-mode-divider" />
            <div className="run-mode-item">
              <strong>Run with LLM</strong>
              <span>Claude reasons through the scenario and decides which tools to call — like a real agent would. ~$0.05/run.</span>
            </div>
          </div>
          <div className="run-buttons">
            <button
              className="run-btn primary"
              onClick={() => handleRun(true)}
              disabled={(selectedScenarios.length === 0 && queuedCustomPrompts.length === 0) || !selectedAgent || running}
              title="Dry run — enforces policies, calls mock APIs, no LLM cost"
            >
              <span>
                {running && lastRunMode === "dry-run"
                  ? (runProgress?.total > 1 ? `Running ${runProgress.current} of ${runProgress.total}...` : "Running...")
                  : selectedScenarios.length > 1 ? `Run ${selectedScenarios.length} Scenarios` : "Run Simulation"}
              </span>
              <span className="run-btn-sub">dry run · mock APIs · free</span>
            </button>
            <button
              className="run-btn llm-btn"
              onClick={() => handleRun(false)}
              disabled={(selectedScenarios.length === 0 && queuedCustomPrompts.length === 0) || !selectedAgent || running}
              title="Uses Claude to reason and decide which tools to call (~$0.05/run)"
            >
              <span>
                {running && lastRunMode === "llm"
                  ? (runProgress?.total > 1 ? `Running ${runProgress.current} of ${runProgress.total}...` : "Running...")
                  : selectedScenarios.length > 1 ? `LLM: ${selectedScenarios.length} Scenarios` : "Run with LLM"}
              </span>
              <span className="run-btn-sub">Claude decides · ~$0.05</span>
            </button>
          </div>
        </div>

        {/* Custom prompt input */}
        <div className="custom-prompt-section">
          <textarea
            className="custom-prompt-input"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="Type a custom prompt... e.g. 'A customer wants a refund for a $200 charge they don't recognize'"
            rows={2}
          />
          <div className="custom-prompt-footer">
            {customPrompt.trim() && (
              <button
                className="custom-prompt-add-btn"
                onClick={() => { setQueuedCustomPrompts((prev) => [...prev, customPrompt.trim()]); setCustomPrompt(""); }}
              >
                + Add to queue
              </button>
            )}
          </div>
        </div>

        {running && (
          <div className="run-loading">
            {runProgress && runProgress.total > 1 ? (
              <div className="run-progress-wrap">
                <div className="run-progress-header">
                  <span className="run-progress-label">
                    Running scenario <strong>{runProgress.current}</strong> of <strong>{runProgress.total}</strong>
                  </span>
                  <span className="run-progress-pct">
                    {Math.round(((runProgress.current - 1) / runProgress.total) * 100)}%
                  </span>
                </div>
                <div className="run-progress-track">
                  <div
                    className="run-progress-fill"
                    style={{ width: `${((runProgress.current - 1) / runProgress.total) * 100}%` }}
                  />
                </div>
                <p className="run-progress-sub">Enforcing policies · calling mock APIs · capturing trace</p>
              </div>
            ) : (
              <div className="run-progress-wrap">
                <div className="run-progress-track">
                  <div className="run-progress-fill run-progress-indeterminate" />
                </div>
                <p className="run-progress-sub">Enforcing policies · calling mock APIs · capturing trace</p>
              </div>
            )}
          </div>
        )}

        {runError && (
          <div className="run-error">
            <strong>Simulation failed:</strong> {runError}
          </div>
        )}
      </section>

      {/* Scenarios (auto-generated from selected agent) */}
      {selectedAgent && (
        <section style={{ marginTop: 28, marginBottom: 48 }}>
          {/* Queue bar — always visible */}
          <div className="run-queue-bar" style={{ marginBottom: 28 }}>
            <span className="rsb-label">
              {selectedScenarios.length + queuedCustomPrompts.length} queued
            </span>
            <div className="queue-chips">
              {selectedScenarios.length === 0 && queuedCustomPrompts.length === 0 && (
                <span className="queue-empty-hint">No scenarios selected — click a scenario below or add a custom prompt</span>
              )}
              {selectedScenarios.map((s) => {
                const cat = CATEGORY_COLORS[s.category] || CATEGORY_COLORS.normal;
                return (
                  <span key={s.id} className="queue-chip">
                    <span className="queue-chip-dot" style={{ background: cat.color }} />
                    {s.name}
                    <button className="queue-chip-remove" onClick={() => toggleScenario(s)} title="Remove">×</button>
                  </span>
                );
              })}
              {queuedCustomPrompts.map((p, i) => (
                <span key={`custom-${i}`} className="queue-chip queue-chip-custom">
                  <span className="queue-chip-dot" style={{ background: "#6366f1" }} />
                  Custom prompt {queuedCustomPrompts.length > 1 ? i + 1 : ""}
                  <button className="queue-chip-remove" onClick={() => setQueuedCustomPrompts((prev) => prev.filter((_, j) => j !== i))} title="Remove">×</button>
                </span>
              ))}
            </div>
            {(selectedScenarios.length > 0 || queuedCustomPrompts.length > 0) && (
              <button className="queue-clear-all" onClick={() => { setSelectedScenarios([]); setQueuedCustomPrompts([]); }}>Clear all</button>
            )}
          </div>

          <div className="section-header">
            <div>
              <h2>Pick a scenario</h2>
              <p className="scenario-section-hint">Click to add to queue — select multiple to batch run</p>
            </div>
            {filteredScenarios.length > 0 && (
              <button className="add-all-queue-btn" onClick={addAllToQueue}>
                + Add all {filteredScenarios.length} to queue
              </button>
            )}
          </div>
          <div className="scenario-filter-pills">
            {CATEGORY_FILTERS.map((f) => {
              const count = f.value === "all" ? scenarios.length : scenarios.filter((s) => s.category === f.value).length;
              if (f.value !== "all" && count === 0) return null;
              return (
                <button
                  key={f.value}
                  className={`scenario-filter-pill ${categoryFilter === f.value ? "active" : ""}`}
                  onClick={() => setCategoryFilter(f.value)}
                >
                  {f.label}
                  {CATEGORY_TOOLTIPS[f.value] && (
                    <Tooltip text={CATEGORY_TOOLTIPS[f.value]}>
                      <span className="jargon-hint" style={{ marginLeft: 3, marginRight: 2 }}>?</span>
                    </Tooltip>
                  )}
                  <span className="pill-count">{count}</span>
                </button>
              );
            })}
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
                const isSelected = selectedScenarios.some((x) => x.id === s.id);
                const borderColor =
                  s.severity === "critical" ? "#dc2626" :
                  s.severity === "high"     ? "#ea580c" :
                  s.category === "normal"   ? "#16a34a" :
                  s.category === "chain_exploit" ? "#7c3aed" :
                  s.category === "adversarial"   ? "#dc2626" : null;
                return (
                  <div
                    key={s.id}
                    className={`scenario-card ${isSelected ? "selected" : ""}`}
                    style={borderColor ? { borderLeft: `3px solid ${borderColor}` } : undefined}
                    onClick={() => toggleScenario(s)}
                  >
                    <div className="scenario-card-top">
                      <span className="scenario-badge" style={{ background: cat.bg, color: cat.color }}>
                        {CATEGORY_LABELS[s.category] || s.category}
                      </span>
                      {s.severity !== "info" && (
                        <span className="scenario-badge" style={{ background: sev.bg, color: sev.color }}>
                          {s.severity}
                        </span>
                      )}
                      {isSelected && <span className="scenario-selected-chip">✓ Queued</span>}
                    </div>
                    <h3 className="scenario-card-name">{s.name}</h3>
                    <p className="scenario-card-desc">{formatDesc(s.description)}</p>
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
            <h2>
              {queueResults.length > 1 ? `Results — ${queueResults.length} Scenarios` : "Results"}
              <span className={`run-mode-badge ${lastRunMode}`}>{lastRunMode === "llm" ? "LLM Agent" : "Dry Run"}</span>
            </h2>
            <Link to={`/sandbox/${result.simulation_id}`} className="view-report-link">
              View Full Report &rarr;
            </Link>
          </div>

          {/* Batch Summary */}
          {queueResults.length > 1 && (() => {
            const scores = queueResults.map((r) => r.data.report?.risk_score ?? 0);
            const peak = Math.max(...scores);
            const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
            const totalViol = queueResults.reduce((s, r) => s + r.data.report.violations.length, 0);
            const peakColor = peak >= 70 ? "#dc2626" : peak >= 25 ? "#ea580c" : "#16a34a";
            return (
              <div className="batch-summary">
                <div className="batch-summary-header">
                  <span className="batch-summary-title">Batch Run</span>
                  <div className="batch-summary-stats">
                    <span>Peak <strong style={{ color: peakColor }}>{peak}</strong></span>
                    <span>Avg <strong>{avg}</strong></span>
                    <span>Violations <strong style={{ color: totalViol > 0 ? "#dc2626" : "inherit" }}>{totalViol}</strong></span>
                  </div>
                </div>
                <div className="batch-rows">
                  {queueResults.map(({ scenario, data: d }, i) => {
                    const sc = d.report?.risk_score ?? 0;
                    const col = sc >= 70 ? "#dc2626" : sc >= 25 ? "#ea580c" : "#16a34a";
                    const isActive = d === result;
                    return (
                      <div
                        key={i}
                        className={`batch-row ${isActive ? "batch-row-active" : ""}`}
                        onClick={() => setResult(d)}
                      >
                        <span className="batch-row-num">{i + 1}</span>
                        <span className="batch-row-name">{scenario?.name || "Custom"}</span>
                        <span className="batch-row-score" style={{ color: col }}>{sc}</span>
                        <span className="batch-row-meta">{d.report.violations.length} violations · {d.report.actions_blocked} blocked</span>
                        <Link
                          to={`/sandbox/${d.simulation_id}`}
                          className="batch-row-link"
                          onClick={(e) => e.stopPropagation()}
                        >Full Report →</Link>
                      </div>
                    );
                  })}
                </div>
                <p className="batch-detail-note">↓ Showing detail for highlighted scenario — click a row to switch</p>
              </div>
            );
          })()}

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
                    <span className="trace-action">
                      <span className="trace-tool">{step.tool.charAt(0).toUpperCase() + step.tool.slice(1)}</span>
                      <span className="trace-sep">·</span>
                      {step.action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
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
                        toast(`Applied ${data.created} polic${data.created !== 1 ? "ies" : "y"}${data.skipped ? ` · ${data.skipped} already existed` : ""}`);
                      } catch (err) {
                        toast("Failed: " + err.message, "error");
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
                            toast(data.already_exists ? "Policy already exists" : "Policy created");
                          } catch (err) {
                            toast("Failed: " + err.message, "error");
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

      {result && previousResult && (
        <div className="compare-runs-banner">
          <div className="compare-runs-text">
            <strong>You've run 2 simulations.</strong> Compare them to see the impact of your policies.
          </div>
          <a
            href={`/compare?before=${previousResult.simulation_id}&after=${result.simulation_id}`}
            className="compare-runs-btn"
          >
            Compare Runs →
          </a>
        </div>
      )}

      {/* Past Simulations */}
      {simulations.length > 0 && (
        <section style={{ marginTop: 56, marginBottom: 48 }}>
          <div className="section-header">
            <h2>Past Simulations ({simulations.length})</h2>
          </div>
          <div className="sim-filter-row">
            <input
              className="sim-search-input"
              placeholder="Search by scenario or agent..."
              value={simSearch}
              onChange={(e) => setSimSearch(e.target.value)}
            />
            <select className="sim-sort-select" value={simSort} onChange={(e) => setSimSort(e.target.value)}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="highest-risk">Highest risk</option>
              <option value="lowest-risk">Lowest risk</option>
              <option value="most-violations">Most violations</option>
            </select>
          </div>
          <div className="sim-list">
            {[...simulations]
              .filter((sim) => {
                if (!simSearch.trim()) return true;
                const q = simSearch.toLowerCase();
                const agentName = agents.find((a) => a.id === sim.agent_id)?.name || "";
                return sim.scenario_id?.toLowerCase().includes(q) || agentName.toLowerCase().includes(q);
              })
              .sort((a, b) => {
                if (simSort === "oldest") return new Date(a.created_at) - new Date(b.created_at);
                if (simSort === "highest-risk") return (b.risk_score ?? 0) - (a.risk_score ?? 0);
                if (simSort === "lowest-risk") return (a.risk_score ?? 0) - (b.risk_score ?? 0);
                if (simSort === "most-violations") return (b.violations ?? 0) - (a.violations ?? 0);
                return new Date(b.created_at) - new Date(a.created_at);
              })
              .map((sim) => {
              const score = sim.risk_score ?? 0;
              const scoreColor = score >= 50 ? "#dc2626" : score >= 25 ? "#ea580c" : "#16a34a";
              const agentName = agents.find((a) => a.id === sim.agent_id)?.name ||
                sim.agent_id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
              const scenarioLabel = sim.scenario_id
                .replace(new RegExp("^" + sim.agent_id + "-?"), "")
                .replace(/-/g, " ")
                .replace(/\b\w/g, (c) => c.toUpperCase()) || "Custom Prompt";
              const diff = (Date.now() - new Date(sim.created_at)) / 1000;
              const timeAgo = diff < 60 ? `${Math.floor(diff)}s ago` : diff < 3600 ? `${Math.floor(diff / 60)}m ago` : diff < 86400 ? `${Math.floor(diff / 3600)}h ago` : new Date(sim.created_at).toLocaleDateString();
              const isClean = !sim.violations && !sim.actions_blocked;
              const isCurrent = result && sim.id === result.simulation_id;
              return (
                <div key={sim.id} className={`sim-card${isCurrent ? " sim-card-current" : ""}`} style={{ borderLeftColor: scoreColor }}>
                  <div className="sim-score-col">
                    <span className="sim-score-num" style={{ color: scoreColor }}>{score}</span>
                    <span className="sim-score-label">Risk</span>
                  </div>
                  <div className="sim-info">
                    <span className="sim-scenario-name">
                      {scenarioLabel}
                      {isCurrent && <span className="sim-current-badge">Latest Run</span>}
                    </span>
                    <span className="sim-meta">{agentName} · {timeAgo}{sim.total_steps ? ` · ${sim.total_steps} steps` : ""}</span>
                  </div>
                  <div className="sim-badges">
                    {isClean ? (
                      <span className="sim-badge sim-badge-clean">Clean</span>
                    ) : (
                      <>
                        {sim.violations > 0 && <span className="sim-badge sim-badge-violations">{sim.violations} violation{sim.violations !== 1 ? "s" : ""}</span>}
                        {sim.actions_blocked > 0 && <span className="sim-badge sim-badge-blocked">{sim.actions_blocked} blocked</span>}
                      </>
                    )}
                  </div>
                  <Link to={`/sandbox/${sim.id}`} className="view-link">View →</Link>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
