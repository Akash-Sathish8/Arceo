import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { apiFetch } from "./api.js";
import { toast } from "./Toast.jsx";
import "./SimulationDetail.css";

function SimpleView({ data, depth = 0 }) {
  if (data === null || data === undefined) return <span className="sv-null">—</span>;
  if (typeof data !== "object") return <span className="sv-scalar">{String(data)}</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="sv-null">none</span>;
    return (
      <div className="sv-array">
        {data.slice(0, 5).map((item, idx) => (
          <div key={idx} className="sv-array-item">
            <SimpleView data={item} depth={depth + 1} />
          </div>
        ))}
        {data.length > 5 && <span className="sv-more">+{data.length - 5} more</span>}
      </div>
    );
  }

  return (
    <div className="sv-table">
      {Object.entries(data).map(([key, val]) => {
        const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        let display;
        if (val === null || val === undefined) {
          display = <span className="sv-null">—</span>;
        } else if (typeof val === "boolean") {
          display = <span className={`sv-bool ${val ? "sv-bool-yes" : "sv-bool-no"}`}>{val ? "Yes" : "No"}</span>;
        } else if (typeof val === "number") {
          display = <span className="sv-num">{val.toLocaleString()}</span>;
        } else if (typeof val === "string") {
          if (/^\d{4}-\d{2}-\d{2}/.test(val)) {
            try {
              display = <span className="sv-str">{new Date(val).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>;
            } catch { display = <span className="sv-str">{val}</span>; }
          } else {
            display = <span className="sv-str">{val}</span>;
          }
        } else if (Array.isArray(val)) {
          display = val.length === 0 ? <span className="sv-null">none</span> : (
            <div className="sv-nested-array">
              {val.slice(0, 3).map((item, idx) => (
                <div key={idx} className="sv-array-item"><SimpleView data={item} depth={depth + 1} /></div>
              ))}
              {val.length > 3 && <span className="sv-more">+{val.length - 3} more</span>}
            </div>
          );
        } else if (typeof val === "object") {
          display = <div className="sv-nested"><SimpleView data={val} depth={depth + 1} /></div>;
        } else {
          display = <span className="sv-str">{String(val)}</span>;
        }
        return (
          <div key={key} className="sv-row">
            <span className="sv-key">{label}</span>
            <span className="sv-val">{display}</span>
          </div>
        );
      })}
    </div>
  );
}

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

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, info: 3 };

const RISK_LABELS = {
  moves_money: "Moves Money",
  touches_pii: "Touches PII",
  deletes_data: "Deletes Data",
  sends_external: "Sends External",
  changes_production: "Changes Prod",
};

// Mirrors backend authority/risk_classifier.py KEYWORD_RULES exactly
const KEYWORD_RULES = {
  moves_money: ["pay", "charge", "refund", "invoice", "transfer", "billing", "payout", "debit", "credit", "subscription", "price"],
  touches_pii: ["customer", "user", "contact", "personal", "profile", "account", "pii", "address", "phone", "ssn", "identity"],
  deletes_data: ["delete", "remove", "drop", "purge", "destroy", "truncate", "erase", "wipe"],
  sends_external: ["send", "email", "notify", "post", "message", "sms", "webhook", "publish", "broadcast", "alert"],
  changes_production: ["deploy", "merge", "release", "production", "infrastructure", "instance", "scale", "terminate", "rollback", "migrate", "provision"],
};

function classifyStep(action) {
  const text = action.toLowerCase();
  return Object.entries(KEYWORD_RULES)
    .filter(([, kws]) => kws.some((kw) => text.includes(kw)))
    .map(([label]) => label);
}

export default function SimulationDetail() {
  const { simulationId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedSteps, setExpandedSteps] = useState({});
  const [stepViewModes, setStepViewModes] = useState({});
  const getViewMode = (i) => stepViewModes[i] || "pretty";
  const setStepViewMode = (i, mode) => setStepViewModes((prev) => ({ ...prev, [i]: mode }));
  const [selectedRecPatterns, setSelectedRecPatterns] = useState(new Set());
  const toggleRec = (pattern) => setSelectedRecPatterns((prev) => {
    const next = new Set(prev);
    if (next.has(pattern)) next.delete(pattern); else next.add(pattern);
    return next;
  });

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

  // Ring geometry
  const ringR = 44;
  const ringC = 2 * Math.PI * ringR;
  const ringOffset = ringC * (1 - riskScore / 100);

  // Strip [DRY RUN] prefix from prompt
  const isDryRun = /^\[dry\s*run\]/i.test(trace.prompt || "");
  const promptText = (trace.prompt || "").replace(/^\[dry\s*run\]\s*/i, "").trim();

  // Timestamp
  const simTime = data.created_at
    ? new Date(data.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  // Build a map of risk category → step indices that triggered it
  const stepsByCategory = {};
  trace.steps.forEach((step, i) => {
    classifyStep(step.action).forEach((label) => {
      if (!stepsByCategory[label]) stepsByCategory[label] = [];
      stepsByCategory[label].push(i);
    });
  });

  const formatAction = (action) =>
    action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const formatDecision = (d) => {
    if (d === "ALLOW") return "Allow";
    if (d === "BLOCK") return "Block";
    if (d === "REQUIRE_APPROVAL") return "Require Approval";
    return d;
  };

  const actionRiskDot = (tool, action) => {
    const s = `${tool}.${action}`.toLowerCase();
    if (/delete|terminate|drop|destroy|remove|cancel/.test(s)) return "#dc2626";
    if (/charge|transfer|pay|refund|create_charge/.test(s)) return "#2563eb";
    if (/send|email|message|notify/.test(s)) return "#7c3aed";
    return "#9ca3af";
  };

  const highlightJSON = (obj) => {
    const str = JSON.stringify(obj, null, 2);
    return str.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        if (/^"/.test(match)) {
          if (/:$/.test(match)) return `<span class="jk">${match}</span>`;
          return `<span class="js">${match}</span>`;
        }
        if (/true|false/.test(match)) return `<span class="jb">${match}</span>`;
        if (/null/.test(match)) return `<span class="jn">${match}</span>`;
        return `<span class="jnum">${match}</span>`;
      }
    );
  };

  const resultSummary = (result) => {
    if (!result || typeof result !== "object") return null;
    const keys = Object.keys(result);
    if (keys.length === 0) return null;
    if (keys.length === 1) {
      const key = keys[0];
      const val = result[key];
      if (Array.isArray(val)) return `${val.length} ${key.replace(/_/g, " ")} returned`;
      if (val && typeof val === "object") {
        const name = val.name || val.subject || val.title || val.email || val.description;
        const id = val.id || val.ticket_id || val.payment_id || val.charge_id;
        if (name && id) return `${key.replace(/_/g, " ")}: ${name} · ${id}`;
        if (name) return `${key.replace(/_/g, " ")}: ${name}`;
        if (id) return `${key.replace(/_/g, " ")}: ${id}`;
      }
      if (typeof val === "string" || typeof val === "number") return `${key.replace(/_/g, " ")}: ${val}`;
    }
    if (result.success === true) return "Success";
    if (result.success === false) return "Failed";
    if (result.status) return `Status: ${result.status}`;
    return `${keys.length} fields`;
  };

  return (
    <div className="sim-detail-page">
      <div className="sim-detail-topbar">
        <Link to="/sandbox" className="back-link">&larr; Sandbox</Link>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Link to={`/compare?after=${simulationId}`} className="sim-compare-btn">
            Compare with...
          </Link>
          <Link to={`/sandbox?agent=${data?.agent_id || ""}`} className="sim-run-again-btn">
            Run Again →
          </Link>
        </div>
      </div>

      {/* Header */}
      <div className="sim-detail-header">
        <div>
          <h1>Simulation Report</h1>
          <div className="sim-meta">
            <span className="sim-id">#{data.simulation_id?.slice(0, 8)}</span>
            {isDryRun && <span className="sim-dryrun-badge">Dry Run</span>}
            <span className="sim-agent">{trace.agent_name}</span>
            <span className="sim-scenario">{trace.scenario_name}</span>
            {simTime && <span className="sim-time">{simTime}</span>}
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
        <div className="sim-score-ring">
          <svg className="sim-score-svg" viewBox="0 0 110 110">
            <circle cx="55" cy="55" r={ringR} fill="none" stroke={scoreColor} strokeWidth="7" opacity="0.12" />
            <circle cx="55" cy="55" r={ringR} fill="none" stroke={scoreColor} strokeWidth="7"
              strokeDasharray={ringC} strokeDashoffset={ringOffset}
              strokeLinecap="round" transform="rotate(-90 55 55)"
              style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1)" }}
            />
          </svg>
          <div className="sim-score-number" style={{ color: scoreColor }}>{riskScore}</div>
          <div className="sim-score-label">Risk Score</div>
        </div>
      </div>

      {/* Prompt */}
      <div className="sim-prompt-box">
        <div className="sim-prompt-label">Scenario Prompt</div>
        <p className="sim-prompt-text">{promptText}</p>
      </div>

      {/* Stats Row */}
      <div className="sim-stats-row">
        <div className="sim-stat">
          <strong>{report.total_steps}</strong><span>Total Steps</span>
        </div>
        <div className="sim-stat" style={{ color: report.actions_executed > 0 ? "#155724" : undefined }}>
          <strong>{report.actions_executed}</strong><span>Executed</span>
        </div>
        <div className="sim-stat" style={{ color: report.actions_blocked > 0 ? "#721c24" : undefined }}>
          <strong>{report.actions_blocked}</strong><span>Blocked</span>
        </div>
        <div className="sim-stat" style={{ color: report.actions_pending > 0 ? "#856404" : undefined }}>
          <strong>{report.actions_pending}</strong><span>Pending</span>
        </div>
        <div className="sim-stat" style={{ color: report.violations.length > 0 ? "#dc2626" : undefined }}>
          <strong>{report.violations.length}</strong><span>Violations</span>
        </div>
        <div className="sim-stat" style={{ color: report.chains_triggered.length > 0 ? "#7c3aed" : undefined }}>
          <strong>{report.chains_triggered.length}</strong><span>Chains</span>
        </div>
      </div>

      {/* Risk Breakdown */}
      <div className="sim-section">
        <h2>Risk Breakdown</h2>
        <p className="sim-section-sub">How many of the {report.total_steps} steps in this simulation touched each sensitive category.</p>
        <div className="risk-breakdown-row">
          {Object.entries(report.risk_summary).map(([key, count]) => {
            const color = RISK_COLORS[key] || "#999";
            const pct = report.total_steps > 0 ? Math.round((count / report.total_steps) * 100) : 0;
            const steps = stepsByCategory[key] || [];
            const desc = {
              moves_money: "Charges, refunds, transfers, or subscription changes",
              touches_pii: "Reads or writes personal customer data",
              deletes_data: "Permanently removes records or files",
              sends_external: "Emails, messages, or webhooks sent outside your system",
              changes_production: "Updates live config, access rules, or deployments",
            }[key] || "";
            return (
              <div key={key} className={`risk-breakdown-item${count === 0 ? " risk-row-zero" : ""}`}>
                <div className="risk-breakdown-dot" style={{ background: color }} />
                <div className="risk-breakdown-text">
                  <span className="risk-breakdown-label">{RISK_LABELS[key] || key}</span>
                  <span className="risk-breakdown-desc">{desc}</span>
                </div>
                <div className="risk-breakdown-bar-wrap">
                  {count > 0 ? (
                    <>
                      <div className="risk-breakdown-bar-track">
                        <div className="risk-breakdown-bar-fill" style={{ width: `${pct}%`, background: color }} />
                      </div>
                      <div className="risk-breakdown-steps">
                        {steps.map((idx) => (
                          <a key={idx} href={`#step-${idx}`} className="step-ref-link" style={{ borderColor: color, color }}>
                            #{idx}
                          </a>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="risk-breakdown-bar-track risk-breakdown-bar-empty" />
                  )}
                </div>
                <strong className="risk-breakdown-count" style={{ color: count > 0 ? color : "var(--text-muted)" }}>
                  {count > 0 ? `${count} of ${report.total_steps}` : "none"}
                </strong>
              </div>
            );
          })}
        </div>
      </div>

      {/* Trace Timeline */}
      <div className="sim-section">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Execution Trace ({trace.steps.length} steps)</h2>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {[
              { color: "#dc2626", label: "Destructive" },
              { color: "#2563eb", label: "Financial" },
              { color: "#7c3aed", label: "Sends message" },
              { color: "#9ca3af", label: "Read-only" },
            ].map(({ color, label }) => (
              <span key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />
                {label}
              </span>
            ))}
          </div>
        </div>
        {(() => {
          const counts = trace.steps.reduce((acc, s) => {
            acc[s.enforce_decision] = (acc[s.enforce_decision] || 0) + 1;
            return acc;
          }, {});
          return (
            <div className="trace-tally">
              <span className="trace-tally-item tally-allow">{counts.ALLOW || 0} allowed</span>
              {counts.BLOCK > 0 && <span className="trace-tally-item tally-block">{counts.BLOCK} blocked</span>}
              {counts.REQUIRE_APPROVAL > 0 && <span className="trace-tally-item tally-pending">{counts.REQUIRE_APPROVAL} pending approval</span>}
            </div>
          );
        })()}
        <div className="trace-timeline">
          {trace.steps.map((step, i) => {
            const ds = DECISION_STYLE[step.enforce_decision] || DECISION_STYLE.ALLOW;
            const isExpanded = expandedSteps[i];
            return (
              <div key={i} id={`step-${i}`} className={`timeline-step${step.enforce_decision !== "ALLOW" ? " timeline-step-flagged" : ""}`} onClick={() => toggleStep(i)}>
                <div className="timeline-rail">
                  <div className="timeline-dot" style={{ background: ds.dot }} />
                  {i < trace.steps.length - 1 && <div className="timeline-line" />}
                </div>
                <div className={`timeline-content${isExpanded ? " is-expanded" : ""}${step.enforce_decision !== "ALLOW" ? " timeline-content-flagged" : ""}`}
                  style={step.enforce_decision !== "ALLOW" ? { borderLeft: `3px solid ${ds.dot}` } : {}}>
                  <div className="timeline-row">
                    <span className="timeline-index">#{i}</span>
                    <div className="timeline-action-cell">
                      <span className="timeline-dot-risk" style={{ background: actionRiskDot(step.tool, step.action) }} />
                      <span className="timeline-tool">{step.tool.charAt(0).toUpperCase() + step.tool.slice(1)}</span>
                      <span className="timeline-sep">·</span>
                      <span className="timeline-action">{formatAction(step.action)}</span>
                    </div>
                    <span className="timeline-decision" style={{ background: ds.bg, color: ds.color }}>
                      {formatDecision(step.enforce_decision)}
                    </span>
                    <span className="timeline-expand">{isExpanded ? "▾" : "▸"}</span>
                  </div>
                  {isExpanded && (
                    <div className="timeline-detail">
                      <div className="detail-view-toggle" onClick={(e) => e.stopPropagation()}>
                        <button
                          className={`dvt-btn${getViewMode(i) === "pretty" ? " active" : ""}`}
                          onClick={() => setStepViewMode(i, "pretty")}
                        >Simple</button>
                        <button
                          className={`dvt-btn${getViewMode(i) === "raw" ? " active" : ""}`}
                          onClick={() => setStepViewMode(i, "raw")}
                        >Raw JSON</button>
                      </div>
                      {step.params && Object.keys(step.params).length > 0 && (
                        <div className="timeline-json timeline-json-params">
                          <div className="json-label">Params</div>
                          {getViewMode(i) === "raw"
                            ? <pre dangerouslySetInnerHTML={{ __html: highlightJSON(step.params) }} />
                            : <div className="sv-wrap"><SimpleView data={step.params} /></div>}
                        </div>
                      )}
                      {step.result && (
                        <div className="timeline-json timeline-json-result">
                          <div className="json-label-row">
                            <span className="json-section-label">Result</span>
                            {getViewMode(i) === "pretty" && resultSummary(step.result) && (
                              <span className="json-summary">{resultSummary(step.result)}</span>
                            )}
                          </div>
                          {getViewMode(i) === "raw"
                            ? <pre dangerouslySetInnerHTML={{ __html: highlightJSON(step.result) }} />
                            : <div className="sv-wrap"><SimpleView data={step.result} /></div>}
                        </div>
                      )}
                      {step.enforce_policy && (
                        <div className="timeline-json timeline-json-policy">
                          <div className="json-label">Policy · {step.enforce_policy.effect || "rule"}</div>
                          {getViewMode(i) === "raw"
                            ? <pre dangerouslySetInnerHTML={{ __html: highlightJSON(step.enforce_policy) }} />
                            : <div className="sv-wrap"><SimpleView data={step.enforce_policy} /></div>}
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
            {[...report.violations]
              .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99))
              .map((v, i) => {
                const sev = SEVERITY_COLORS[v.severity] || SEVERITY_COLORS.medium;
                const desc = v.description.replace(/\s*\(\d+ occurrences?\)\.?$/i, "").trim();
                return (
                  <div key={i} className="sim-violation-card" style={{ borderLeftColor: sev.color, background: sev.bg }}>
                    <div className="sim-violation-top">
                      <span className="sim-violation-sev" style={{ background: `${sev.color}22`, color: sev.color }}>{v.severity}</span>
                      <strong className="sim-violation-title">{v.title}</strong>
                      <span className="sim-violation-count" style={{ color: sev.color, borderColor: `${sev.color}44` }}>
                        {v.step_indices.length}×
                      </span>
                    </div>
                    <p>{desc}</p>
                    <div className="sim-violation-steps">
                      <span className="sim-steps-label">Steps</span>
                      {v.step_indices.map((idx) => (
                        <a key={idx} href={`#step-${idx}`} className="step-ref-link" style={{ borderColor: sev.color, color: sev.color }}>
                          #{idx}
                        </a>
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
          {(() => {
            const groups = {};
            [...report.chains_triggered]
              .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99))
              .forEach((c) => {
                if (!groups[c.chain_name]) groups[c.chain_name] = { ...c, paths: [c.step_indices] };
                else groups[c.chain_name].paths.push(c.step_indices);
              });
            const grouped = Object.values(groups);
            const uniqueCount = grouped.length;
            const totalCount = report.chains_triggered.length;
            return (
              <>
                <div className="sim-chains-header">
                  <h2>Chains Triggered</h2>
                  <div className="sim-chains-meta">
                    <span className="sim-chains-total">{totalCount} occurrences</span>
                    <span className="sim-chains-unique">{uniqueCount} unique pattern{uniqueCount !== 1 ? "s" : ""}</span>
                  </div>
                </div>
                <div className="sim-chains">
                  {grouped.map((chain, i) => {
                    const sev = SEVERITY_COLORS[chain.severity] || SEVERITY_COLORS.high;
                    const hasMany = chain.paths.length > 1;
                    return (
                      <div key={i} className="sim-chain-card" style={{ borderLeftColor: sev.color, background: sev.bg }}>
                        <div className="sim-chain-top">
                          <span className="sim-chain-sev" style={{ background: `${sev.color}22`, color: sev.color }}>{chain.severity}</span>
                          <strong className="sim-violation-title">{chain.chain_name}</strong>
                          {hasMany && (
                            <span className="sim-violation-count" style={{ color: sev.color, borderColor: `${sev.color}44` }}>
                              {chain.paths.length}×
                            </span>
                          )}
                        </div>
                        <p>{chain.description}</p>
                        <div className="sim-chain-steps">
                          <span className="sim-steps-label">{hasMany ? `Paths (${chain.paths.length})` : "Path"}</span>
                          <div className="sim-chain-paths">
                            {chain.paths.map((path, pi) => (
                              <div key={pi} className="sim-chain-path-row">
                                {path.map((idx, j) => (
                                  <span key={idx} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                    <a href={`#step-${idx}`} className="step-ref-link" style={{ borderColor: sev.color, color: sev.color }}>#{idx}</a>
                                    {j < path.length - 1 && <span className="chain-arrow">&rarr;</span>}
                                  </span>
                                ))}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Recommendations */}
      {report.recommendations.length > 0 && (
        <div className="sim-section">
          {(() => {
            const actionableRecs = report.recommendations.filter(
              (r) => typeof r !== "string" && r.actionable
            );
            const selectedCount = actionableRecs.filter(
              (r) => selectedRecPatterns.has(r.action_pattern)
            ).length;
            const allSelected = actionableRecs.length > 0 && selectedCount === actionableRecs.length;
            const selectAll = () => setSelectedRecPatterns(new Set(actionableRecs.map((r) => r.action_pattern)));
            const clearAll = () => setSelectedRecPatterns(new Set());
            const sortedRecs = [...report.recommendations].sort((a, b) => {
              const rank = (r) => (typeof r === "string" || !r.actionable) ? 3 : r.effect === "BLOCK" ? 0 : 1;
              return rank(a) - rank(b);
            });
            return (
              <>
                <div className="sim-recs-header">
                  <div className="sim-recs-header-left">
                    <h2>Recommendations</h2>
                    {actionableRecs.length > 0 && (
                      <div className="rec-select-controls">
                        <input type="checkbox" className="rec-checkbox"
                          checked={allSelected} onChange={allSelected ? clearAll : selectAll} />
                        <span className="rec-select-label">
                          {selectedCount > 0 ? `${selectedCount} of ${actionableRecs.length} selected` : `${actionableRecs.length} policies`}
                        </span>
                      </div>
                    )}
                  </div>
                  {actionableRecs.length > 0 && (
                    <button
                      className="sim-apply-all-btn"
                      disabled={selectedCount === 0}
                      style={{ opacity: selectedCount === 0 ? 0.45 : 1, cursor: selectedCount === 0 ? "not-allowed" : "pointer" }}
                      onClick={async () => {
                        const toApply = actionableRecs.filter((r) => selectedRecPatterns.has(r.action_pattern));
                        if (toApply.length === 0) return;
                        try {
                          const resp = await apiFetch("/api/sandbox/apply-all-policies", {
                            method: "POST",
                            body: JSON.stringify({
                              agent_id: data.agent_id,
                              policies: toApply.map((r) => ({
                                agent_id: data.agent_id,
                                action_pattern: r.action_pattern,
                                effect: r.effect,
                                reason: r.reason,
                              })),
                            }),
                          });
                          toast(`Applied ${resp.created} polic${resp.created === 1 ? "y" : "ies"}${resp.skipped ? ` · ${resp.skipped} already existed` : ""}`);
                          clearAll();
                        } catch (err) {
                          toast(err.message, "error");
                        }
                      }}
                    >
                      {selectedCount > 0 ? `Apply Selected (${selectedCount})` : "Apply Policies"}
                    </button>
                  )}
                </div>
                <div className="sim-recs">
                  {sortedRecs.map((r, i) => {
                    const rec = typeof r === "string" ? { message: r, actionable: false } : r;
                    if (!rec.actionable) {
                      return (
                        <div key={i} className="sim-rec-card sim-rec-info">
                          <span className="sim-rec-arrow">&rarr;</span>
                          <p>{rec.message}</p>
                        </div>
                      );
                    }
                    const isBlock = rec.effect === "BLOCK";
                    const effectColor = isBlock ? "#dc2626" : "#ca8a04";
                    const effectBg = isBlock ? "#fef2f2" : "#fefce8";
                    const [service, ...rest] = (rec.action_pattern || "").split(".");
                    const action = rest.join(".").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                    const reason = rec.reason || (rec.message || "").replace(/^(Require approval for|Block)\s+[\w.]+\s*[—–-]\s*/i, "").trim();
                    const isSelected = selectedRecPatterns.has(rec.action_pattern);
                    return (
                      <div
                        key={i}
                        className={`sim-rec-card sim-rec-actionable${isSelected ? " rec-selected" : ""}`}
                        style={{ borderLeftColor: isSelected ? effectColor : "transparent" }}
                        onClick={() => toggleRec(rec.action_pattern)}
                      >
                        <input type="checkbox" className="rec-checkbox"
                          checked={isSelected} onChange={() => {}}
                          onClick={(e) => e.stopPropagation()} />
                        <div className="rec-content">
                          <div className="rec-top">
                            <span className="rec-service-chip">{service}</span>
                            <span className="rec-sep">·</span>
                            <span className="rec-action-name">{action}</span>
                            <span className="rec-effect-badge" style={{ background: effectBg, color: effectColor }}>
                              {isBlock ? "Block" : "Require Approval"}
                            </span>
                          </div>
                          {reason && <p className="rec-reason">{reason}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
