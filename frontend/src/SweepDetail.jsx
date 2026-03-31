import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { apiFetch } from "./api.js";
import "./SweepDetail.css";

const CATEGORY_COLORS = {
  normal:        { bg: "#f0fdf4", color: "#16a34a" },
  edge_case:     { bg: "#fff7ed", color: "#ea580c" },
  adversarial:   { bg: "#fef2f2", color: "#dc2626" },
  chain_exploit: { bg: "#f5f3ff", color: "#7c3aed" },
};

const CATEGORY_LABELS = {
  normal: "Normal", edge_case: "Edge Case",
  adversarial: "Adversarial", chain_exploit: "Chain Exploit",
};

const SEVERITY_COLORS = {
  critical: { bg: "#fef2f2", color: "#dc2626" },
  high:     { bg: "#fff7ed", color: "#ea580c" },
  medium:   { bg: "#fefce8", color: "#ca8a04" },
};

export default function SweepDetail() {
  const { sweepId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiFetch(`/api/sandbox/sweep/${sweepId}`)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [sweepId]);

  if (loading) return (
    <div className="sweep-page">
      <Link to="/sandbox" className="back-link">← Sandbox</Link>
      <div className="loading-state"><div className="spinner" /><p>Loading sweep report...</p></div>
    </div>
  );

  if (error || !data) return (
    <div className="sweep-page">
      <Link to="/sandbox" className="back-link">← Sandbox</Link>
      <div className="error-state">
        <div className="error-icon">!</div>
        <h2>Failed to load sweep</h2>
        <p>{error || "Sweep not found"}</p>
        <Link to="/sandbox" className="retry-btn" style={{ textDecoration: "none", display: "inline-block", marginTop: 12 }}>Back to Sandbox</Link>
      </div>
    </div>
  );

  const scoreColor = data.overall_risk_score >= 70 ? "#dc2626" : data.overall_risk_score >= 40 ? "#ea580c" : "#16a34a";
  const ringR = 44;
  const ringC = 2 * Math.PI * ringR;
  const ringOffset = ringC * (1 - Math.min(data.overall_risk_score, 100) / 100);

  const totalViolations = (data.all_violations || []).length;
  const totalChains = (data.all_chains || []).length;
  const totalBlocked = (data.scenario_results || []).reduce((s, r) => s + (r.actions_blocked ?? 0), 0);

  return (
    <div className="sweep-page">
      <div className="sweep-topbar">
        <Link to="/sandbox" className="back-link">← Sandbox</Link>
        <Link to={`/agent/${data.agent_id}`} className="sweep-agent-link">{data.agent_name} →</Link>
      </div>

      <div className="sweep-header">
        <div>
          <h1>Full Scan Report</h1>
          <div className="sweep-meta">
            <span className="sweep-id">#{(data.sweep_id || "").slice(0, 8)}</span>
            <span className="sweep-agent">{data.agent_name}</span>
            <span className="sweep-badge">{data.total_scenarios} scenarios</span>
            <span className="sweep-badge sweep-badge-dry">Dry Run</span>
          </div>
        </div>
        <div className="sweep-score-ring">
          <svg viewBox="0 0 110 110" className="sweep-score-svg">
            <circle cx="55" cy="55" r={ringR} fill="none" stroke={scoreColor} strokeWidth="7" opacity="0.12" />
            <circle cx="55" cy="55" r={ringR} fill="none" stroke={scoreColor} strokeWidth="7"
              strokeDasharray={ringC} strokeDashoffset={ringOffset}
              strokeLinecap="round" transform="rotate(-90 55 55)"
              style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(0.4,0,0.2,1)" }}
            />
          </svg>
          <div className="sweep-score-number" style={{ color: scoreColor }}>{Math.round(data.overall_risk_score)}</div>
          <div className="sweep-score-label">Overall Risk</div>
        </div>
      </div>

      <div className="sweep-stats">
        <div className="sweep-stat"><strong>{data.total_scenarios}</strong><span>Scenarios Run</span></div>
        <div className="sweep-stat" style={{ color: data.avg_risk_score >= 40 ? "#ea580c" : undefined }}>
          <strong>{Math.round(data.avg_risk_score ?? 0)}</strong><span>Avg Risk Score</span>
        </div>
        <div className="sweep-stat" style={{ color: data.max_risk_score >= 70 ? "#dc2626" : data.max_risk_score >= 40 ? "#ea580c" : undefined }}>
          <strong>{data.max_risk_score ?? 0}</strong><span>Peak Risk Score</span>
        </div>
        <div className="sweep-stat" style={{ color: totalViolations > 0 ? "#dc2626" : undefined }}>
          <strong>{totalViolations}</strong><span>Total Violations</span>
        </div>
        <div className="sweep-stat" style={{ color: totalBlocked > 0 ? "#721c24" : undefined }}>
          <strong>{totalBlocked}</strong><span>Actions Blocked</span>
        </div>
        <div className="sweep-stat" style={{ color: totalChains > 0 ? "#7c3aed" : undefined }}>
          <strong>{totalChains}</strong><span>Chains Detected</span>
        </div>
      </div>

      {/* Per-scenario breakdown */}
      <div className="sweep-section">
        <h2>Scenario Breakdown</h2>
        <p className="sweep-section-sub">Results for each scenario run against {data.agent_name}.</p>
        <div className="sweep-scenario-table">
          <div className="sweep-table-head">
            <span>Scenario</span>
            <span>Category</span>
            <span>Risk Score</span>
            <span>Violations</span>
            <span>Chains</span>
            <span>Status</span>
          </div>
          {(data.scenario_results || []).map((r, i) => {
            const cat = CATEGORY_COLORS[r.category] || CATEGORY_COLORS.normal;
            const sc = r.risk_score ?? 0;
            const scColor = sc >= 70 ? "#dc2626" : sc >= 40 ? "#ea580c" : "#16a34a";
            return (
              <div key={i} className={`sweep-table-row${r.status === "error" ? " sweep-row-error" : ""}`}>
                <span className="sweep-row-name">{r.scenario_name}</span>
                <span>
                  <span className="sweep-cat-badge" style={{ background: cat.bg, color: cat.color }}>
                    {CATEGORY_LABELS[r.category] || r.category}
                  </span>
                </span>
                <span className="sweep-row-score" style={{ color: scColor, fontWeight: 700 }}>{r.status === "error" ? "—" : sc}</span>
                <span className={r.violations_count > 0 ? "sweep-cell-warn" : ""}>{r.status === "error" ? "—" : r.violations_count}</span>
                <span className={r.chains_count > 0 ? "sweep-cell-warn" : ""}>{r.status === "error" ? "—" : r.chains_count}</span>
                <span>
                  <span className={`sweep-status-badge ${r.status === "error" ? "sweep-status-error" : "sweep-status-ok"}`}>
                    {r.status === "error" ? "Failed" : "Done"}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top violations */}
      {(data.all_violations || []).length > 0 && (
        <div className="sweep-section">
          <h2>Violations Found ({data.all_violations.length})</h2>
          <p className="sweep-section-sub">Unique violations detected across all scenarios.</p>
          <div className="sweep-violations">
            {data.all_violations.slice(0, 10).map((v, i) => {
              const sev = SEVERITY_COLORS[v.severity] || SEVERITY_COLORS.medium;
              return (
                <div key={i} className="sweep-violation-card" style={{ borderLeftColor: sev.color, background: sev.bg }}>
                  <div className="sweep-viol-top">
                    <span className="sweep-viol-sev" style={{ background: `${sev.color}22`, color: sev.color }}>{v.severity}</span>
                    <strong>{v.title || v.type}</strong>
                  </div>
                  {v.description && <p>{v.description}</p>}
                </div>
              );
            })}
          </div>
          <Link to={`/agent/${data.agent_id}`} className="sweep-fix-link">
            Fix these in production →
          </Link>
        </div>
      )}

      {/* Recommendations */}
      {(data.recommendations || []).length > 0 && (
        <div className="sweep-section">
          <h2>Recommendations ({data.recommendations.length})</h2>
          <p className="sweep-section-sub">Suggested policies to reduce risk across your scenarios.</p>
          <div className="sweep-recs">
            {data.recommendations.slice(0, 6).map((r, i) => {
              const sev = SEVERITY_COLORS[r.severity] || SEVERITY_COLORS.medium;
              return (
                <div key={i} className="sweep-rec-card">
                  <span className="sweep-rec-sev" style={{ background: sev.bg, color: sev.color }}>{r.severity}</span>
                  <span className="sweep-rec-text">{r.description}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
