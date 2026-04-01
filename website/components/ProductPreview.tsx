"use client";

import { useEffect, useState } from "react";
import { fetchDemoAgent, runDemoScan, fetchDemoScenario, type DemoAgent, type ScanResult } from "@/lib/api";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";

function scoreToColor(score: number) {
  if (score >= 70) return "#dc2626";  // red   — high risk
  if (score >= 40) return "#f59e0b";  // amber — medium risk
  return "#16a34a";                   // green — low risk
}

function riskLevel(score: number) {
  if (score >= 70) return { label: "High Risk",   color: "#dc2626", bg: "#fef2f2" };
  if (score >= 40) return { label: "Medium Risk", color: "#d97706", bg: "#fffbeb" };
  return                { label: "Low Risk",    color: "#16a34a", bg: "#f0fdf4" };
}

const RISK_BARS = [
  { key: "moves_money",        label: "Moves money",        color: "#dc2626" },
  { key: "touches_pii",        label: "Touches PII",        color: "#7c3aed" },
  { key: "deletes_data",       label: "Deletes data",       color: "#ea580c" },
  { key: "sends_external",     label: "Sends external",     color: "#2563eb" },
  { key: "changes_production", label: "Changes production", color: "#0d9488" },
] as const;

const SEV_COLORS: Record<string, string> = {
  critical: "#dc2626",
  high: "#ea580c",
  medium: "#ca8a04",
};

// ── Static fallback (shown when backend is offline) ──────────────────
const STATIC_AGENT = {
  id: "static",
  name: "Customer Support Agent",
  blast_radius_score: 72,
  risk_labels: ["touches_pii", "sends_external"],
  tool_count: 11,
  moves_money: 0,
  touches_pii: 5,
  deletes_data: 1,
  sends_external: 3,
  changes_production: 0,
} as DemoAgent & Record<string, number>;

const STATIC_RESULT: ScanResult = {
  simulation_id: "static",
  risk_score: 78,
  violations: [
    { type: "pii_exfil",    severity: "critical", title: "PII Exfiltration Chain" },
    { type: "unauth_send",  severity: "high",     title: "Unauthorized External Send" },
  ],
  chains: [{ pattern: "touches_pii → sends_external", severity: "critical" }],
  actions_blocked: 2,
  actions_executed: 7,
};

type Status = "loading" | "ready" | "offline" | "scanning" | "done";

export default function ProductPreview() {
  const [status, setStatus] = useState<Status>("loading");
  const [agent, setAgent] = useState<DemoAgent | null>(null);
  const [token, setToken] = useState("");
  const [scenarioId, setScenarioId] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    fetchDemoAgent()
      .then(({ agent: a, token: t }) => {
        setAgent(a);
        setToken(t);
        return fetchDemoScenario(t).then((s) => setScenarioId(s.id));
      })
      .then(() => setStatus("ready"))
      .catch(() => {
        // Backend offline — use static fallback, still looks great
        setAgent(STATIC_AGENT);
        setIsOffline(true);
        setStatus("offline");
      });
  }, []);

  async function handleScan() {
    if (!agent) return;

    setStatus("scanning");

    if (isOffline) {
      // Simulate a scan with a short delay
      await new Promise((r) => setTimeout(r, 1800));
      setResult(STATIC_RESULT);
      setStatus("done");
      return;
    }

    try {
      const r = await runDemoScan(agent.id, scenarioId, token);
      setResult(r);
      setStatus("done");
    } catch {
      // Fall back to static result on error
      setResult(STATIC_RESULT);
      setStatus("done");
    }
  }

  function handleReset() {
    setResult(null);
    setStatus(isOffline ? "offline" : "ready");
  }

  if (status === "loading") {
    return (
      <div className="pp-loading">
        <div className="pp-spinner" />
        <span>Connecting to live demo…</span>
      </div>
    );
  }

  if (!agent) return null;

  const totalActions = agent.tool_count ?? 10;
  const score = status === "done" && result ? result.risk_score : agent.blast_radius_score;
  const color = scoreToColor(score);
  const level = riskLevel(score);

  return (
    <div className="pp-root">
      {/* Header row */}
      <div className="pp-header">
        <div className="pp-live-dot" style={isOffline ? { background: "#9ca3af", boxShadow: "none", animation: "none" } : undefined} />
        <span className="pp-agent-name">{agent.name}</span>
        {status === "done" && result ? (
          <button onClick={handleReset} className="pp-reset">↺ Reset</button>
        ) : isOffline ? (
          <span className="pp-reset" style={{ cursor: "default" }}>Preview</span>
        ) : null}
      </div>

      {/* Score bar */}
      <div className="pp-score-section">
        <div className="pp-score-row">
          <div className="pp-score-left">
            <span className="pp-score-label">Blast radius</span>
            <span className="pp-risk-badge" style={{ color: level.color, background: level.bg }}>{level.label}</span>
          </div>
          <span className="pp-score-num" style={{ color }}>{Math.round(score)}<span className="pp-score-denom">/100</span></span>
        </div>
        <div className="pp-bar-track">
          <div className="pp-bar-fill" style={{ width: `${Math.min(score, 100)}%`, background: color }} />
        </div>
      </div>

      {/* Risk breakdown */}
      <div className="pp-risks">
        {RISK_BARS.map(({ key, label, color: c }) => {
          const count = (agent as unknown as Record<string, number>)[key] ?? 0;
          const pct = totalActions > 0 ? (count / totalActions) * 100 : 0;
          return (
            <div key={key} className="pp-risk-row">
              <span className="pp-risk-label">
                <span className="pp-risk-dot" style={{ background: c }} />
                {label}
              </span>
              <div className="pp-risk-track">
                <div className="pp-risk-fill" style={{ width: `${pct}%`, background: c }} />
              </div>
              <span className="pp-risk-count">{count}</span>
            </div>
          );
        })}
      </div>

      {/* Divider */}
      <div className="pp-divider" />

      {/* Scan results or CTA */}
      {status === "done" && result ? (
        <div className="pp-results">
          <div className="pp-results-summary">
            <div className="pp-result-stat">
              <span className="pp-result-num" style={{ color: result.violations.length > 0 ? "#dc2626" : "#16a34a" }}>
                {result.violations.length}
              </span>
              <span className="pp-result-label">violations</span>
            </div>
            <div className="pp-result-stat">
              <span className="pp-result-num" style={{ color: result.chains.length > 0 ? "#7c3aed" : "#16a34a" }}>
                {result.chains.length}
              </span>
              <span className="pp-result-label">chains</span>
            </div>
            <div className="pp-result-stat">
              <span className="pp-result-num" style={{ color: result.actions_blocked > 0 ? "#ea580c" : "inherit" }}>
                {result.actions_blocked}
              </span>
              <span className="pp-result-label">blocked</span>
            </div>
          </div>
          {result.violations.slice(0, 2).map((v, i) => (
            <div key={i} className="pp-violation">
              <span className="pp-viol-dot" style={{ background: SEV_COLORS[v.severity] ?? "#ca8a04" }} />
              <span className="pp-viol-title">{v.title || v.type}</span>
              <span className="pp-viol-sev" style={{ color: SEV_COLORS[v.severity] ?? "#ca8a04" }}>{v.severity}</span>
            </div>
          ))}
          <a href={`${APP_URL}/login?signup=true`} className="pp-open-btn">Open in Arceo →</a>
        </div>
      ) : (
        <button
          className="pp-scan-btn"
          onClick={handleScan}
          disabled={status === "scanning"}
        >
          {status === "scanning" ? (
            <><span className="pp-scan-spinner" /> Running scan…</>
          ) : (
            <>▶ Run security scan</>
          )}
        </button>
      )}

      {/* Footer stats — fills dead space and adds context */}
      <div className="pp-stats-footer">
        <div className="pp-stat-item">
          <span className="pp-stat-num">{agent.tool_count ?? 0}</span>
          <span className="pp-stat-label">Tools mapped</span>
        </div>
        <div className="pp-stat-divider" />
        <div className="pp-stat-item">
          <span className="pp-stat-num">{agent.risk_labels?.length ?? 0}</span>
          <span className="pp-stat-label">Risk categories</span>
        </div>
        <div className="pp-stat-divider" />
        <div className="pp-stat-item">
          <span className="pp-stat-num">14</span>
          <span className="pp-stat-label">Chain patterns</span>
        </div>
      </div>
    </div>
  );
}
