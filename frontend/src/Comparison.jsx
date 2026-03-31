import { useState, useEffect, useRef } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { apiFetch } from "./api.js";
import { scoreToColor } from "./scoreColor.js";
import "./Comparison.css";

function AnimatedNumber({ value, duration = 1200 }) {
  const [display, setDisplay] = useState(0);
  const startRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    if (value === 0) { setDisplay(0); return; }
    const start = performance.now();
    startRef.current = start;
    const animate = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(eased * value));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value, duration]);

  return <>{display}</>;
}

const METRIC_LABELS = {
  risk_score: "Risk Score",
  violations: "Violations",
  chains: "Chains Triggered",
  blocked: "Actions Blocked",
  executed: "Actions Executed",
};

function MetricRow({ label, before, after, lowerIsBetter = true }) {
  const improved = lowerIsBetter ? after < before : after > before;
  const delta = after - before;
  const pct = before > 0 ? Math.round(Math.abs(delta / before) * 100) : 0;

  return (
    <div className="cmp-metric-row">
      <span className="cmp-metric-label">{label}</span>
      <div className="cmp-metric-values">
        <span className="cmp-metric-before">{before}</span>
        <span className="cmp-metric-arrow">→</span>
        <span className={`cmp-metric-after ${improved ? "improved" : delta === 0 ? "same" : "worse"}`}>
          {after}
        </span>
        {delta !== 0 && (
          <span className={`cmp-metric-delta ${improved ? "delta-good" : "delta-bad"}`}>
            {improved ? "↓" : "↑"} {pct}%
          </span>
        )}
        {delta === 0 && <span className="cmp-metric-delta delta-same">no change</span>}
      </div>
    </div>
  );
}

function SimulationPicker({ afterId, afterData }) {
  const navigate = useNavigate();
  const [sims, setSims] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/api/sandbox/simulations")
      .then((d) => { setSims(d.simulations || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const candidates = sims.filter((s) => s.simulation_id !== afterId && s.status === "completed");

  const scoreColor = scoreToColor;

  return (
    <div className="cmp-page">
      <Link to="/sandbox" className="cmp-back">← Sandbox</Link>
      <h1 className="cmp-title" style={{ marginTop: 12 }}>Compare Simulations</h1>
      <p className="cmp-picker-sub">
        You're comparing against <strong>{afterData?.trace?.agent_name || "this simulation"}</strong> — <em>{afterData?.trace?.scenario_name}</em>.
        <br />Pick an earlier run to compare it against.
      </p>
      {loading ? (
        <div className="loading-state"><div className="spinner" /></div>
      ) : candidates.length === 0 ? (
        <div className="cmp-no-sims">
          <p>No other completed simulations found. Run another simulation first, then come back to compare.</p>
          <Link to="/sandbox" className="cmp-btn-primary" style={{ display: "inline-block", marginTop: 12 }}>Go to Sandbox</Link>
        </div>
      ) : (
        <div className="cmp-picker-list">
          {candidates.map((s) => (
            <button
              key={s.simulation_id}
              className="cmp-picker-row"
              onClick={() => navigate(`/compare?before=${s.simulation_id}&after=${afterId}`)}
            >
              <div className="cmp-picker-row-left">
                <span className="cmp-picker-agent">{s.agent_name}</span>
                <span className="cmp-picker-scenario">{s.scenario_name}</span>
                {s.is_dry_run && <span className="cmp-picker-badge">Dry Run</span>}
              </div>
              <div className="cmp-picker-row-right">
                <span className="cmp-picker-score" style={{ color: scoreColor(s.risk_score ?? 0) }}>
                  {s.risk_score ?? "—"}
                </span>
                <span className="cmp-picker-time">{new Date(s.timestamp + (s.timestamp?.endsWith("Z") ? "" : "Z")).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                <span className="cmp-picker-arrow">→</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Comparison() {
  const [searchParams] = useSearchParams();
  const beforeId = searchParams.get("before");
  const afterId = searchParams.get("after");

  const [beforeData, setBeforeData] = useState(null);
  const [afterData, setAfterData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const navigate = useNavigate();

  useEffect(() => {
    if (!beforeId && !afterId) {
      // Auto-load last 2 completed simulations so /compare always shows something
      apiFetch("/api/sandbox/simulations")
        .then((d) => {
          const completed = (d.simulations || []).filter((s) => s.status === "completed");
          if (completed.length >= 2) {
            navigate(`/compare?before=${completed[1].simulation_id}&after=${completed[0].simulation_id}`, { replace: true });
          } else {
            setLoading(false);
          }
        })
        .catch(() => setLoading(false));
      return;
    }
    if (!beforeId && afterId) {
      // Load afterData so the picker can show the context
      apiFetch(`/api/sandbox/simulation/${afterId}`)
        .then((a) => { setAfterData(a); setLoading(false); })
        .catch(() => setLoading(false));
      return;
    }
    Promise.all([
      apiFetch(`/api/sandbox/simulation/${beforeId}`),
      apiFetch(`/api/sandbox/simulation/${afterId}`),
    ])
      .then(([b, a]) => {
        setBeforeData(b);
        setAfterData(a);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [beforeId, afterId]);

  // No IDs at all — show a guide
  if (!loading && !beforeId && !afterId) {
    return (
      <div className="cmp-page">
        <h1 className="cmp-title" style={{ marginTop: 12 }}>Compare Simulations</h1>
        <div className="cmp-guide">
          <div className="cmp-guide-icon">↔</div>
          <h2>See how policies change your risk</h2>
          <p>Run two simulations on the same agent — one before and one after applying policies — then compare them side by side.</p>
          <ol className="cmp-guide-steps">
            <li>Go to <strong>Sandbox</strong> and run a simulation on an agent</li>
            <li>On the report page, click <strong>"Compare with..."</strong></li>
            <li>Pick a second simulation to compare against</li>
          </ol>
          <Link to="/sandbox" className="cmp-btn-primary" style={{ display: "inline-block", marginTop: 20 }}>Go to Sandbox →</Link>
        </div>
      </div>
    );
  }

  // Only afterId — show simulation picker
  if (!loading && afterId && !beforeId) {
    return <SimulationPicker afterId={afterId} afterData={afterData} />;
  }

  if (loading) {
    return (
      <div className="cmp-page">
        <Link to="/sandbox" className="cmp-back">← Sandbox</Link>
        <div className="loading-state"><div className="spinner" /><p>Loading comparison...</p></div>
      </div>
    );
  }

  if (error || !beforeData || !afterData) {
    return (
      <div className="cmp-page">
        <Link to="/sandbox" className="cmp-back">← Sandbox</Link>
        <div className="error-state">
          <div className="error-icon">!</div>
          <h2>Cannot load comparison</h2>
          <p>{error || "One or both simulations could not be found."}</p>
          <Link to="/sandbox" className="retry-btn" style={{ textDecoration: "none", display: "inline-block", marginTop: 12 }}>Back to Sandbox</Link>
        </div>
      </div>
    );
  }

  const bReport = beforeData.report;
  const aReport = afterData.report;
  const bTrace = beforeData.trace;
  const aTrace = afterData.trace;

  const differentAgents = bTrace?.agent_id !== aTrace?.agent_id;

  const scoreBefore = bReport.risk_score ?? 0;
  const scoreAfter = aReport.risk_score ?? 0;
  const scoreImproved = scoreAfter < scoreBefore;
  const scoreReduction = scoreBefore > 0 ? Math.round(((scoreBefore - scoreAfter) / scoreBefore) * 100) : 0;

  const violBefore = bReport.violations?.length ?? 0;
  const violAfter = aReport.violations?.length ?? 0;
  const chainBefore = bReport.chains_triggered?.length ?? 0;
  const chainAfter = aReport.chains_triggered?.length ?? 0;
  const blockedBefore = bReport.actions_blocked ?? 0;
  const blockedAfter = aReport.actions_blocked ?? 0;
  const execBefore = bReport.actions_executed ?? 0;
  const execAfter = aReport.actions_executed ?? 0;

  const overallImproved = scoreImproved || violAfter < violBefore || chainAfter < chainBefore;

  // Find newly blocked actions (in after but not in before)
  const blockedInAfter = (aTrace?.steps || []).filter(s => s.enforce_decision === "BLOCK");
  const blockedInBefore = new Set((bTrace?.steps || []).filter(s => s.enforce_decision === "BLOCK").map(s => `${s.tool}.${s.action}`));
  const newlyBlocked = blockedInAfter.filter(s => !blockedInBefore.has(`${s.tool}.${s.action}`));
  const uniqueNewlyBlocked = [...new Map(newlyBlocked.map(s => [`${s.tool}.${s.action}`, s])).values()];

  const scoreColor = scoreToColor;

  return (
    <div className="cmp-page">
      <Link to="/sandbox" className="cmp-back">← Sandbox</Link>

      {differentAgents && (
        <div className="cmp-agent-warning">
          <strong>Different agents</strong> — Before: <em>{bTrace?.agent_name}</em> · After: <em>{aTrace?.agent_name}</em>. Comparing different agents may produce misleading results.
        </div>
      )}

      {/* Headline banner */}
      <div className={`cmp-banner ${overallImproved ? "cmp-banner-success" : "cmp-banner-neutral"}`}>
        {overallImproved ? (
          <>
            <span className="cmp-banner-icon">✓</span>
            <div>
              <div className="cmp-banner-title">
                {scoreReduction > 0 ? `Risk reduced by ${scoreReduction}%` : "Risk profile improved"}
              </div>
              <div className="cmp-banner-sub">
                {violBefore > 0 && violAfter === 0
                  ? `All ${violBefore} violation${violBefore > 1 ? "s" : ""} resolved`
                  : violAfter < violBefore
                  ? `${violBefore - violAfter} violation${violBefore - violAfter > 1 ? "s" : ""} resolved`
                  : "Policies are working"}
                {chainAfter < chainBefore && ` · ${chainBefore - chainAfter} chain${chainBefore - chainAfter > 1 ? "s" : ""} neutralized`}
              </div>
            </div>
          </>
        ) : (
          <>
            <span className="cmp-banner-icon cmp-banner-icon-neutral">→</span>
            <div>
              <div className="cmp-banner-title">No significant change detected</div>
              <div className="cmp-banner-sub">Risk profile is similar across both runs</div>
            </div>
          </>
        )}
      </div>

      <h1 className="cmp-title">Simulation Comparison</h1>
      <div className="cmp-meta">
        <span>{bTrace?.agent_name || "Agent"}</span>
        <span className="cmp-meta-sep">·</span>
        <span>{bTrace?.scenario_name || "Scenario"}</span>
      </div>

      {/* Score cards */}
      <div className="cmp-scores">
        <div className="cmp-score-card cmp-score-before">
          <div className="cmp-score-label">Before Policies</div>
          <div className="cmp-score-number" style={{ color: scoreColor(scoreBefore) }}>
            <AnimatedNumber value={scoreBefore} />
          </div>
          <div className="cmp-score-sub">Risk Score</div>
          <div className="cmp-score-details">
            <span className={violBefore > 0 ? "cmp-detail-bad" : "cmp-detail-ok"}>
              {violBefore} violation{violBefore !== 1 ? "s" : ""}
            </span>
            <span className={chainBefore > 0 ? "cmp-detail-bad" : "cmp-detail-ok"}>
              {chainBefore} chain{chainBefore !== 1 ? "s" : ""}
            </span>
            <span className="cmp-detail-neutral">{blockedBefore} blocked</span>
          </div>
        </div>

        <div className="cmp-score-divider">
          <div className="cmp-score-arrow">→</div>
          {scoreReduction > 0 && (
            <div className="cmp-reduction-badge">
              -{scoreReduction}%
            </div>
          )}
        </div>

        <div className="cmp-score-card cmp-score-after">
          <div className="cmp-score-label">After Policies</div>
          <div className="cmp-score-number" style={{ color: scoreColor(scoreAfter) }}>
            <AnimatedNumber value={scoreAfter} duration={1600} />
          </div>
          <div className="cmp-score-sub">Risk Score</div>
          <div className="cmp-score-details">
            <span className={violAfter > 0 ? "cmp-detail-bad" : "cmp-detail-ok"}>
              {violAfter === 0 ? "✓ " : ""}{violAfter} violation{violAfter !== 1 ? "s" : ""}
            </span>
            <span className={chainAfter > 0 ? "cmp-detail-bad" : "cmp-detail-ok"}>
              {chainAfter === 0 ? "✓ " : ""}{chainAfter} chain{chainAfter !== 1 ? "s" : ""}
            </span>
            <span className="cmp-detail-neutral">{blockedAfter} blocked</span>
          </div>
        </div>
      </div>

      {/* Metrics table */}
      <div className="cmp-section">
        <h2>Metric Breakdown</h2>
        <div className="cmp-metrics">
          <MetricRow label="Risk Score" before={scoreBefore} after={scoreAfter} lowerIsBetter={true} />
          <MetricRow label="Violations" before={violBefore} after={violAfter} lowerIsBetter={true} />
          <MetricRow label="Chains Triggered" before={chainBefore} after={chainAfter} lowerIsBetter={true} />
          <MetricRow label="Actions Blocked" before={blockedBefore} after={blockedAfter} lowerIsBetter={false} />
          <MetricRow label="Actions Executed" before={execBefore} after={execAfter} lowerIsBetter={true} />
        </div>
      </div>

      {/* Newly blocked actions */}
      {uniqueNewlyBlocked.length > 0 && (
        <div className="cmp-section">
          <h2>Actions Now Blocked by Policy</h2>
          <p className="cmp-section-sub">These actions ran freely in the first simulation but were caught by the new policies in the second run.</p>
          <div className="cmp-blocked-list">
            {uniqueNewlyBlocked.map((s, i) => (
              <div key={i} className="cmp-blocked-item">
                <span className="cmp-blocked-check">✓</span>
                <span className="cmp-blocked-tool">{s.tool.charAt(0).toUpperCase() + s.tool.slice(1)}</span>
                <span className="cmp-blocked-action">{s.action.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</span>
                <span className="cmp-blocked-badge">BLOCKED</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Violations comparison */}
      {(violBefore > 0 || violAfter > 0) && (
        <div className="cmp-section">
          <h2>Violations</h2>
          <div className="cmp-two-col">
            <div className="cmp-col">
              <div className="cmp-col-header cmp-col-before">Before ({violBefore})</div>
              {bReport.violations?.length > 0 ? bReport.violations.map((v, i) => (
                <div key={i} className="cmp-viol-item cmp-viol-before">
                  <span className={`cmp-sev cmp-sev-${v.severity}`}>{v.severity}</span>
                  <span className="cmp-viol-title">{v.title}</span>
                </div>
              )) : <div className="cmp-empty-col">No violations</div>}
            </div>
            <div className="cmp-col">
              <div className="cmp-col-header cmp-col-after">After ({violAfter})</div>
              {aReport.violations?.length > 0 ? aReport.violations.map((v, i) => (
                <div key={i} className="cmp-viol-item cmp-viol-after">
                  <span className={`cmp-sev cmp-sev-${v.severity}`}>{v.severity}</span>
                  <span className="cmp-viol-title">{v.title}</span>
                </div>
              )) : (
                <div className="cmp-empty-col cmp-empty-col-success">
                  <span>✓</span> No violations
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Chains comparison */}
      {(chainBefore > 0 || chainAfter > 0) && (
        <div className="cmp-section">
          <h2>Dangerous Chains</h2>
          <div className="cmp-two-col">
            <div className="cmp-col">
              <div className="cmp-col-header cmp-col-before">Before ({chainBefore})</div>
              {bReport.chains_triggered?.length > 0 ? bReport.chains_triggered.map((c, i) => (
                <div key={i} className="cmp-viol-item cmp-viol-before">
                  <span className={`cmp-sev cmp-sev-${c.severity}`}>{c.severity}</span>
                  <span className="cmp-viol-title">{c.chain_name}</span>
                </div>
              )) : <div className="cmp-empty-col">No chains</div>}
            </div>
            <div className="cmp-col">
              <div className="cmp-col-header cmp-col-after">After ({chainAfter})</div>
              {aReport.chains_triggered?.length > 0 ? aReport.chains_triggered.map((c, i) => (
                <div key={i} className="cmp-viol-item">
                  <span className={`cmp-sev cmp-sev-${c.severity}`}>{c.severity}</span>
                  <span className="cmp-viol-title">{c.chain_name}</span>
                </div>
              )) : (
                <div className="cmp-empty-col cmp-empty-col-success">
                  <span>✓</span> No chains triggered
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="cmp-actions">
        <Link to="/sandbox" className="cmp-btn-secondary">← Run Another Simulation</Link>
        <Link to="/" className="cmp-btn-primary">View Agent Dashboard</Link>
      </div>
    </div>
  );
}
