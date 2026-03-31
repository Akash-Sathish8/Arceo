"use client";

import { useEffect, useState } from "react";
import {
  fetchDemoAgent,
  fetchDemoScenario,
  runDemoScan,
  type DemoAgent,
  type DemoScenario,
  type ScanResult,
  type ScanViolation,
} from "@/lib/api";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";

const RISK_LABEL_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  moves_money:        { bg: "rgba(220,38,38,0.15)",   color: "#f87171", label: "moves_money" },
  touches_pii:        { bg: "rgba(124,58,237,0.15)",  color: "#a78bfa", label: "touches_pii" },
  deletes_data:       { bg: "rgba(234,88,12,0.15)",   color: "#fb923c", label: "deletes_data" },
  sends_external:     { bg: "rgba(37,99,235,0.15)",   color: "#60a5fa", label: "sends_external" },
  changes_production: { bg: "rgba(13,148,136,0.15)",  color: "#2dd4bf", label: "changes_production" },
};

const SEV_STYLES: Record<string, { bg: string; color: string }> = {
  critical: { bg: "rgba(220,38,38,0.15)",  color: "#f87171" },
  high:     { bg: "rgba(234,88,12,0.15)",  color: "#fb923c" },
  medium:   { bg: "rgba(202,138,4,0.15)",  color: "#fbbf24" },
  low:      { bg: "rgba(74,222,128,0.1)",  color: "#4ade80" },
};

const SCAN_STEPS = [
  "Analyzing tool permissions",
  "Mapping authority graph",
  "Running adversarial scenario",
  "Detecting dangerous chains",
];

function scoreColor(score: number) {
  if (score >= 70) return "#f87171";
  if (score >= 40) return "#fb923c";
  return "#4ade80";
}

type Status = "loading" | "ready" | "scanning" | "done" | "error";

export default function LiveDemo() {
  const [status, setStatus] = useState<Status>("loading");
  const [agent, setAgent] = useState<DemoAgent | null>(null);
  const [scenario, setScenario] = useState<DemoScenario | null>(null);
  const [token, setToken] = useState<string>("");
  const [completedSteps, setCompletedSteps] = useState<number>(0);
  const [activeStep, setActiveStep] = useState<number>(0);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    fetchDemoAgent()
      .then(({ agent: a, token: t }) => {
        setAgent(a);
        setToken(t);
        return fetchDemoScenario(t).then((s) => setScenario(s));
      })
      .then(() => setStatus("ready"))
      .catch((e: Error) => {
        setErrorMsg(e.message);
        setStatus("error");
      });
  }, []);

  async function handleScan() {
    if (!agent || !scenario || !token) return;
    setStatus("scanning");
    setCompletedSteps(0);
    setActiveStep(0);

    // Kick off the API call concurrently while the animation plays
    const scanPromise = runDemoScan(agent.id, scenario.id, token);

    // Animate steps — reveal one every 900ms
    for (let i = 0; i < SCAN_STEPS.length; i++) {
      setActiveStep(i);
      await wait(900);
      setCompletedSteps(i + 1);
    }

    try {
      const scanResult = await scanPromise;
      setResult(scanResult);
      setStatus("done");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Scan failed";
      setErrorMsg(msg);
      setStatus("error");
    }
  }

  function handleReset() {
    setResult(null);
    setCompletedSteps(0);
    setActiveStep(0);
    setStatus("ready");
  }

  const headerTitle =
    status === "scanning" ? "arceo — scanning..." :
    status === "done"     ? "arceo — scan complete" :
    status === "error"    ? "arceo — error" :
                            "arceo — live demo environment";

  return (
    <section id="demo" className="demo-section">
      <div className="container">
        <div className="section-header">
          <span className="section-tag">Live Demo</span>
          <h2 className="section-title">Watch Arceo scan a real agent</h2>
          <p className="section-sub">
            Connected to a live backend. No mock data — this is real analysis running right now.
          </p>
        </div>

        <div className="demo-box">
          {/* Terminal-style header */}
          <div className="demo-box-header">
            <div className="demo-dots">
              <span className="demo-dot demo-dot-red" />
              <span className="demo-dot demo-dot-yellow" />
              <span className="demo-dot demo-dot-green" />
            </div>
            <span className="demo-box-title">{headerTitle}</span>
          </div>

          {/* Loading */}
          {status === "loading" && (
            <div className="demo-loading">
              <div className="demo-spinner" />
              <p>connecting to demo environment...</p>
            </div>
          )}

          {/* Error */}
          {status === "error" && (
            <div className="demo-error">
              <p style={{ marginBottom: 12, color: "rgba(255,255,255,0.4)" }}>
                Could not connect to the demo backend.
              </p>
              <p>
                Start it with:{" "}
                <code>cd backend &amp;&amp; uvicorn main:app --port 8000</code>
              </p>
              {errorMsg && (
                <p style={{ marginTop: 10, fontSize: 11, color: "#4a6480" }}>{errorMsg}</p>
              )}
            </div>
          )}

          {/* Ready */}
          {status === "ready" && agent && (
            <div className="demo-body">
              <AgentPanel agent={agent} />
              <div className="demo-panel">
                <div className="demo-panel-label">Action</div>
                <div className="demo-ready-title">Run a live security scan</div>
                <p className="demo-ready-desc">
                  This fires a real dry-run simulation against the demo agent using one of
                  our adversarial scenarios. No LLM calls — instant results.
                </p>
                <button className="demo-run-btn" onClick={handleScan}>
                  <span className="demo-run-btn-icon">▶</span>
                  Run scan
                </button>
                {scenario && (
                  <p className="demo-scenario-hint">
                    Scenario: <span>{scenario.name}</span>
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Scanning */}
          {status === "scanning" && agent && (
            <div className="demo-body">
              <AgentPanel agent={agent} />
              <div className="demo-panel">
                <div className="demo-scan-title">$ arceo scan --agent {agent.name.toLowerCase().replace(/ /g, "-")}</div>
                <div className="demo-scan-steps">
                  {SCAN_STEPS.map((step, i) => {
                    const done   = i < completedSteps;
                    const active = i === activeStep && !done;
                    const cls    = done ? "demo-step demo-step-done" : active ? "demo-step demo-step-active" : "demo-step demo-step-pending";
                    return (
                      <div key={step} className={cls}>
                        <span className="demo-step-icon">
                          {done ? "✓" : active ? <span className="demo-step-pulse" /> : "○"}
                        </span>
                        <span>{step}...</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Done */}
          {status === "done" && agent && result && (
            <div className="demo-body">
              <div className="demo-panel demo-panel-left">
                <div className="demo-panel-label">Risk Profile</div>

                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                    <span className="demo-agent-name">{agent.name}</span>
                  </div>
                  <div className="demo-score-row" style={{ marginBottom: 8 }}>
                    <span className="demo-score-label">Before</span>
                    <div className="demo-score-bar-wrap">
                      <div
                        className="demo-score-bar"
                        style={{
                          width: `${Math.min(agent.blast_radius_score, 100)}%`,
                          background: scoreColor(agent.blast_radius_score),
                          opacity: 0.4,
                        }}
                      />
                    </div>
                    <span className="demo-score-number" style={{ color: scoreColor(agent.blast_radius_score), opacity: 0.5, fontSize: 14 }}>
                      {Math.round(agent.blast_radius_score)}
                    </span>
                  </div>
                  <div className="demo-score-row">
                    <span className="demo-score-label">After scan</span>
                    <div className="demo-score-bar-wrap">
                      <div
                        className="demo-score-bar"
                        style={{
                          width: `${Math.min(result.risk_score, 100)}%`,
                          background: scoreColor(result.risk_score),
                        }}
                      />
                    </div>
                    <span className="demo-score-number" style={{ color: scoreColor(result.risk_score) }}>
                      {Math.round(result.risk_score)}
                    </span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 20, marginBottom: 20, flexWrap: "wrap" }}>
                  <div className="demo-stat-item">
                    <span
                      className="demo-stat-value"
                      style={{ color: result.violations.length > 0 ? "#f87171" : "#4ade80" }}
                    >
                      {result.violations.length}
                    </span>
                    <span className="demo-stat-label">Violations</span>
                  </div>
                  <div className="demo-stat-item">
                    <span
                      className="demo-stat-value"
                      style={{ color: result.chains.length > 0 ? "#a78bfa" : "#4ade80" }}
                    >
                      {result.chains.length}
                    </span>
                    <span className="demo-stat-label">Chains</span>
                  </div>
                  <div className="demo-stat-item">
                    <span
                      className="demo-stat-value"
                      style={{ color: result.actions_blocked > 0 ? "#fb923c" : "rgba(255,255,255,0.4)" }}
                    >
                      {result.actions_blocked}
                    </span>
                    <span className="demo-stat-label">Blocked</span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <a href={`${APP_URL}/sandbox`} className="demo-cta-primary">
                    Open in Arceo →
                  </a>
                  <button onClick={handleReset} className="demo-cta-ghost">
                    Scan again
                  </button>
                </div>
              </div>

              <div className="demo-panel">
                <div className="demo-results-title">
                  {result.violations.length > 0
                    ? `${result.violations.length} violation${result.violations.length !== 1 ? "s" : ""} found`
                    : "No violations — agent passed"}
                </div>

                <div className="demo-violations-list">
                  {result.violations.length === 0 ? (
                    <div className="demo-violation-empty">
                      <span>✓</span> All scenarios passed cleanly.
                    </div>
                  ) : (
                    result.violations.slice(0, 4).map((v: ScanViolation, i: number) => {
                      const sev = SEV_STYLES[v.severity] ?? SEV_STYLES.medium;
                      return (
                        <div key={i} className="demo-violation">
                          <span
                            className="demo-violation-sev"
                            style={{ background: sev.bg, color: sev.color }}
                          >
                            {v.severity}
                          </span>
                          <span className="demo-violation-text">
                            {v.title || v.type}
                          </span>
                        </div>
                      );
                    })
                  )}
                  {result.violations.length > 4 && (
                    <p style={{ fontSize: 12, color: "#4a6480", marginTop: 4 }}>
                      +{result.violations.length - 4} more in the full report
                    </p>
                  )}
                </div>

                {result.violations.length > 0 && (
                  <a href={`${APP_URL}/sandbox`} className="demo-cta-primary" style={{ marginTop: 4 }}>
                    Fix in production →
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function AgentPanel({ agent }: { agent: DemoAgent }) {
  const color = scoreColor(agent.blast_radius_score);
  return (
    <div className="demo-panel demo-panel-left">
      <div className="demo-panel-label">Demo Agent</div>
      <div className="demo-agent-name">{agent.name}</div>
      {agent.description && (
        <p className="demo-agent-desc">{agent.description}</p>
      )}
      <div className="demo-score-row">
        <span className="demo-score-label">Risk</span>
        <div className="demo-score-bar-wrap">
          <div
            className="demo-score-bar"
            style={{
              width: `${Math.min(agent.blast_radius_score, 100)}%`,
              background: color,
            }}
          />
        </div>
        <span className="demo-score-number" style={{ color }}>{Math.round(agent.blast_radius_score)}</span>
      </div>
      {agent.risk_labels && agent.risk_labels.length > 0 && (
        <div className="demo-labels">
          {agent.risk_labels.map((label) => {
            const style = RISK_LABEL_STYLES[label] ?? { bg: "rgba(255,255,255,0.05)", color: "#94a3b8", label };
            return (
              <span
                key={label}
                className="demo-label"
                style={{ background: style.bg, color: style.color }}
              >
                {style.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
