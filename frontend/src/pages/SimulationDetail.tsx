import { useParams, Link } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Shield,
  GitBranch,
  ExternalLink,
  Crosshair,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/shared/Toast";
import { timeAgo, riskLabelColor, riskLabelBg, riskLabelName } from "@/lib/utils";
import ErrorState from "@/components/shared/ErrorState";
import type { RiskLabel } from "@/lib/types";

interface TraceStep {
  id?: string;
  tool: string;
  action: string;
  params: Record<string, unknown>;
  result?: Record<string, unknown>;
  allowed: boolean;
  risk_labels: string[];
  severity?: string;
  timestamp?: string;
  agent_id?: string;
}

interface Violation {
  // Mirrors backend Violation (backend/sandbox/models.py): title/type, not `rule`.
  title: string;
  type?: string;
  severity: string;
  description: string;
  from_label?: string;
  to_label?: string;
}

interface Chain {
  // Mirrors backend ChainViolation: chain_name, not `type`.
  chain_name: string;
  severity: string;
  description: string;
}

interface SimulationDetailData {
  id: string;
  agent_id: string;
  scenario_id: string;
  status: string;
  trace: { steps: TraceStep[] };
  report: {
    violations: Violation[];
    chains: Chain[];
    // Backend returns recommendation OBJECTS ({message, actionable, effect,
    // action_pattern, reason}); older sims returned plain strings. Support both.
    recommendations: (string | {
      message?: string;
      reason?: string;
      effect?: string;
      action_pattern?: string;
      actionable?: boolean;
    })[];
    risk_score: number;
    executive_summary?: string;
    // Precision/recall of violation detection vs the scenario's expected
    // violations — computed by the backend since day one, dropped by the UI
    // until Phase 1 (A1).
    detection_grade?: {
      expected: string[];
      detected: string[];
      matched: string[];
      missed: string[];
      unexpected: string[];
      precision: number | null;
      recall: number | null;
      passed: boolean;
    } | null;
  };
  created_at: string;
  agent_name?: string;
  scenario_name?: string;
}

function SimpleView({ data, depth = 0 }: { data: unknown; depth?: number }) {
  if (data === null || data === undefined) {
    return <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>null</span>;
  }
  if (typeof data === "boolean") {
    return <span style={{ color: data ? "#16a34a" : "#dc2626" }}>{String(data)}</span>;
  }
  if (typeof data === "number") {
    return <span style={{ color: "var(--color-accent)" }}>{data}</span>;
  }
  if (typeof data === "string") {
    return <span style={{ color: "var(--text-primary)" }}>"{data}"</span>;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return <span style={{ color: "var(--text-muted)" }}>[]</span>;
    return (
      <div style={{ marginLeft: depth * 12 }}>
        {data.map((item, i) => (
          <div key={i} className="flex gap-1">
            <span style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>{i}.</span>
            <SimpleView data={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span style={{ color: "var(--text-muted)" }}>{"{}"}</span>;
    return (
      <div style={{ marginLeft: depth * 12 }}>
        {entries.map(([key, val]) => (
          <div key={key} className="flex gap-1 flex-wrap">
            <span style={{ color: "#7c3aed" }} className="font-medium text-xs">{key}:</span>
            <SimpleView data={val} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  return <span style={{ color: "var(--text-primary)" }}>{String(data)}</span>;
}

const SEVERITY_STYLES: Record<string, { bg: string; color: string }> = {
  critical: { bg: "#fef2f2", color: "#dc2626" },
  high: { bg: "#fff7ed", color: "#ea580c" },
  medium: { bg: "#fefce8", color: "#ca8a04" },
  low: { bg: "#f0fdf4", color: "#16a34a" },
};

function ScoreRing({ score }: { score: number }) {
  const radius = 44;
  const circ = 2 * Math.PI * radius;
  const dash = (score / 100) * circ;
  const color = score >= 70 ? "#dc2626" : score >= 40 ? "#d97706" : "#16a34a";
  const label = score >= 70 ? "Critical" : score >= 40 ? "High" : "Safe";

  return (
    <div className="flex-shrink-0">
      <div className="relative" style={{ width: 100, height: 100 }}>
        <svg width={100} height={100} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={50} cy={50} r={radius} fill="none" stroke="#e5e7eb" strokeWidth={8} />
          <circle
            cx={50}
            cy={50}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={8}
            strokeDasharray={`${dash} ${circ - dash}`}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-2xl font-bold leading-none" style={{ color }}>{score}</div>
          <div className="text-xs font-medium mt-0.5" style={{ color }}>{label}</div>
        </div>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: TraceStep }) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const sty = SEVERITY_STYLES[step.severity?.toLowerCase() ?? ""] ?? { bg: "#f9fafb", color: "#6b7280" };

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden" style={{ background: '#ffffff' }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 p-3 text-left transition-colors hover:bg-gray-50"
        style={{ background: 'transparent' }}
      >
        <div
          className="flex items-center justify-center w-5 h-5 rounded-full flex-shrink-0"
          style={{
            backgroundColor: step.allowed ? "#d1fae5" : "#fee2e2",
            color: step.allowed ? "#065f46" : "#991b1b",
          }}
        >
          {step.allowed ? <CheckCircle size={12} /> : <XCircle size={12} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span style={{ fontWeight: 500, color: "var(--text-primary)", fontSize: 13 }}>{step.tool}</span>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>→</span>
            <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{step.action}</span>
            {step.agent_id && (
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-sunken)', color: 'var(--text-secondary)' }}>
                {step.agent_id}
              </span>
            )}
          </div>
          {step.risk_labels.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {step.risk_labels.map((label) => (
                <span
                  key={label}
                  className="text-xs px-1.5 py-0.5 rounded font-medium"
                  style={{ backgroundColor: riskLabelBg(label as RiskLabel), color: riskLabelColor(label as RiskLabel) }}
                >
                  {riskLabelName(label)}
                </span>
              ))}
            </div>
          )}
        </div>
        {step.severity && (
          <span
            className="text-xs px-2 py-0.5 rounded font-medium capitalize flex-shrink-0"
            style={{ backgroundColor: sty.bg, color: sty.color }}
          >
            {step.severity}
          </span>
        )}
        {expanded ? (
          <ChevronDown size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        ) : (
          <ChevronRight size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-200 p-3" style={{ background: '#ffffff' }}>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setShowRaw(false)}
              className="text-xs font-medium transition-colors"
              style={!showRaw
                ? { background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '4px 12px', fontFamily: 'inherit', cursor: 'pointer' }
                : { background: 'var(--bg-sunken)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-full)', border: 'none', padding: '4px 12px', fontFamily: 'inherit', cursor: 'pointer' }}
            >
              Simple
            </button>
            <button
              onClick={() => setShowRaw(true)}
              className="text-xs font-medium transition-colors"
              style={showRaw
                ? { background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '4px 12px', fontFamily: 'inherit', cursor: 'pointer' }
                : { background: 'var(--bg-sunken)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-full)', border: 'none', padding: '4px 12px', fontFamily: 'inherit', cursor: 'pointer' }}
            >
              Raw
            </button>
          </div>
          {showRaw ? (
            <pre className="text-xs font-mono rounded p-3 overflow-auto max-h-64" style={{ background: 'var(--bg-sunken)', color: 'var(--text-primary)' }}>
              {JSON.stringify({ params: step.params, result: step.result }, null, 2)}
            </pre>
          ) : (
            <div className="space-y-2">
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>Params</div>
                <div className="rounded p-2 text-xs font-mono" style={{ background: 'var(--bg-sunken)' }}>
                  <SimpleView data={step.params} />
                </div>
              </div>
              {step.result && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>Result</div>
                  <div className="rounded p-2 text-xs font-mono" style={{ background: 'var(--bg-sunken)' }}>
                    <SimpleView data={step.result} />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SimulationDetail() {
  const { simulationId } = useParams<{ simulationId: string }>();
  const [sim, setSim] = useState<SimulationDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyingAll, setApplyingAll] = useState(false);

  const load = useCallback(() => {
    if (!simulationId) return;
    setLoading(true);
    setLoadError(null);
    apiFetch<Record<string, unknown>>(`/api/sandbox/simulation/${simulationId}`)
      .then((raw) => {
        // Backend returns the simulation directly (not wrapped). Normalize shape
        // to what the component expects: id (vs simulation_id), report.chains
        // (vs chains_triggered), per-step allowed (vs enforce_decision) and
        // risk_labels (missing entirely from backend trace steps).
        const r = (raw.report ?? {}) as Record<string, unknown>;
        const trace = (raw.trace ?? {}) as Record<string, unknown>;
        const rawSteps = (trace.steps ?? []) as Record<string, unknown>[];
        const steps: TraceStep[] = rawSteps.map((s) => ({
          id: s.id as string | undefined,
          tool: String(s.tool ?? ""),
          action: String(s.action ?? ""),
          params: (s.params ?? {}) as Record<string, unknown>,
          result: s.result as Record<string, unknown> | undefined,
          allowed: s.enforce_decision === undefined
            ? Boolean(s.allowed ?? true)
            : s.enforce_decision === "ALLOW",
          risk_labels: (s.risk_labels ?? []) as string[],
          severity: s.severity as string | undefined,
          timestamp: s.timestamp as string | undefined,
          agent_id: (s.source_agent_id as string) || (s.agent_id as string) || undefined,
        }));
        setSim({
          id: String(raw.simulation_id ?? raw.id ?? ""),
          agent_id: String(raw.agent_id ?? ""),
          scenario_id: String(raw.scenario_id ?? ""),
          status: String(raw.status ?? ""),
          trace: { steps },
          report: {
            violations: (r.violations ?? []) as Violation[],
            chains: (r.chains ?? r.chains_triggered ?? []) as Chain[],
            recommendations: (r.recommendations ?? []) as SimulationDetailData["report"]["recommendations"],
            risk_score: Number(r.risk_score ?? 0),
            executive_summary: r.executive_summary as string | undefined,
            detection_grade: (r.detection_grade ?? null) as SimulationDetailData["report"]["detection_grade"],
          },
          created_at: String(raw.created_at ?? ""),
          agent_name: trace.agent_name as string | undefined,
          scenario_name: trace.scenario_name as string | undefined,
        });
      })
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, [simulationId]);

  useEffect(() => { load(); }, [load]);

  async function applyAllRecommendations() {
    if (!sim) return;
    setApplyingAll(true);
    // Create a policy per actionable recommendation via the real policies
    // endpoint (there is no /apply-recommendations route). Same contract the
    // Workflows page uses: {action_pattern, effect, reason}.
    const seen = new Set<string>();
    let applied = 0;
    let failed = 0;
    try {
      for (const rec of sim.report.recommendations) {
        if (typeof rec === "string") continue;
        if (!rec.actionable || !rec.action_pattern || !rec.effect) continue;
        const key = `${rec.action_pattern}|${rec.effect}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          await apiFetch(`/api/authority/agent/${sim.agent_id}/policies`, {
            method: "POST",
            body: JSON.stringify({
              action_pattern: rec.action_pattern,
              effect: rec.effect,
              reason: rec.reason ?? rec.message ?? "Applied from simulation recommendation",
            }),
          });
          applied++;
        } catch {
          failed++;
        }
      }
      if (applied === 0 && failed === 0) {
        toast("No actionable recommendations to apply");
      } else if (failed > 0) {
        toast(`Applied ${applied} recommendation${applied !== 1 ? "s" : ""}, ${failed} failed`, "error");
      } else {
        toast(`Applied ${applied} recommendation${applied !== 1 ? "s" : ""}`);
      }
    } finally {
      setApplyingAll(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-40 bg-gray-200 rounded-xl" />
          <div className="h-64 bg-gray-200 rounded-xl" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return <div style={{ padding: 40 }}><ErrorState message={loadError} onRetry={load} /></div>;
  }

  if (!sim) {
    return (
      <div style={{ padding: 40, textAlign: "center", paddingTop: 80, color: "var(--text-muted)" }}>
        <Shield size={32} style={{ margin: "0 auto 8px", color: "var(--border-strong)" }} />
        <p style={{ fontSize: 13 }}>Simulation not found.</p>
      </div>
    );
  }

  const report = sim.report;
  const steps = sim.trace?.steps ?? [];
  const violations = report?.violations ?? [];
  const chains = report?.chains ?? [];
  const recommendations = report?.recommendations ?? [];
  const score = report?.risk_score ?? 0;

  return (
    <div className="p-8 space-y-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/sandbox">
          <Button variant="secondary" size="sm" icon={<ArrowLeft size={14} />}>
            Back to Sandbox
          </Button>
        </Link>
        <span style={{ color: "var(--border-strong)" }}>/</span>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>Simulation Detail</h1>
      </div>

      {/* Overview */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
        <div className="flex items-start gap-6">
          <ScoreRing score={score} />
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h2 style={{ fontSize: 17, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
                {sim.scenario_name ?? sim.scenario_id}
              </h2>
              <span
                style={{
                  fontSize: 12,
                  padding: "2px 8px",
                  borderRadius: "var(--radius-full)",
                  fontWeight: 500,
                  ...(sim.status === "completed"
                    ? { background: "var(--status-executed-bg)", color: "var(--status-executed)" }
                    : sim.status === "failed" || sim.status === "error"
                    ? { background: "var(--severity-critical-bg)", color: "var(--severity-critical)" }
                    : { background: "var(--status-pending-bg)", color: "var(--status-pending)" }),
                }}
              >
                {sim.status}
              </span>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
              Agent: {sim.agent_name ?? sim.agent_id} · {timeAgo(sim.created_at)}
            </p>
            <div className="grid grid-cols-4 gap-4 text-center">
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>{steps.length}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Steps</div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--severity-critical)" }}>{violations.length}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Violations</div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--severity-high)" }}>{chains.length}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Chains</div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-secondary)" }}>
                  {steps.filter((s) => !s.allowed).length}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Blocked</div>
              </div>
            </div>
          </div>
        </div>

        {report?.executive_summary && (
          <div className="mt-4 p-3 rounded-lg text-sm leading-relaxed" style={{ background: 'var(--bg-sunken)', color: 'var(--text-primary)' }}>
            {report.executive_summary}
          </div>
        )}
      </div>

      {/* Violations */}
      {violations.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
          <h3 className="font-semibold mb-5 flex items-center gap-2" style={{ fontSize: 15, color: "var(--text-primary)" }}>
            <XCircle size={16} className="text-red-500" />
            Violations ({violations.length})
          </h3>
          <div className="space-y-2">
            {violations.map((v, i) => {
              const sty = SEVERITY_STYLES[v.severity?.toLowerCase()] ?? { bg: "#f9fafb", color: "#6b7280" };
              return (
                <div
                  key={i}
                  className="flex items-start gap-3 p-3 rounded-lg"
                  style={{ backgroundColor: sty.bg }}
                >
                  <AlertTriangle
                    size={14}
                    className="flex-shrink-0 mt-0.5"
                    style={{ color: sty.color }}
                  />
                  <div className="flex-1">
                    <div className="font-medium text-sm" style={{ color: sty.color }}>{v.title}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{v.description}</div>
                    {v.from_label && v.to_label && (
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                        {v.from_label} → {v.to_label}
                      </div>
                    )}
                  </div>
                  <span
                    className="text-xs font-semibold px-2 py-0.5 rounded capitalize text-white flex-shrink-0"
                    style={{ backgroundColor: sty.color }}
                  >
                    {v.severity}
                  </span>
                </div>
              );
            })}
          </div>
          {sim.agent_id && (
            <Link
              to={`/agent/${sim.agent_id}?tab=policies`}
              className="flex items-center gap-1.5 mt-3 text-sm font-medium"
              style={{ color: 'var(--text-link)' }}
            >
              Fix in production <ExternalLink size={12} />
            </Link>
          )}
        </div>
      )}

      {/* Detection accuracy — only when the scenario declared expected
          violations (optional data; absent renders nothing, not an error) */}
      {report?.detection_grade && report.detection_grade.expected.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
          <h3 className="font-semibold mb-2 flex items-center gap-2" style={{ fontSize: 15, color: "var(--text-primary)" }}>
            <Crosshair size={16} style={{ color: report.detection_grade.passed ? "#16a34a" : "#ea580c" }} />
            Detection accuracy
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={report.detection_grade.passed
                ? { background: "#f0fdf4", color: "#16a34a" }
                : { background: "#fff7ed", color: "#ea580c" }}
            >
              {report.detection_grade.passed ? "All expected violations detected" : "Missed expected violations"}
            </span>
          </h3>
          <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>
            How well this run surfaced the violations the scenario was designed to trigger.
            Actions that policy blocked still count as detected — catching and stopping a
            violation is not a miss.
          </p>
          <div className="flex gap-8 mb-4">
            {report.detection_grade.recall != null && (
              <div>
                <div className="text-xl font-semibold mono" style={{ color: "var(--text-primary)" }}>
                  {Math.round(report.detection_grade.recall * 100)}%
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Recall · {report.detection_grade.matched.length}/{report.detection_grade.expected.length} expected found
                </div>
              </div>
            )}
            {report.detection_grade.precision != null && (
              <div>
                <div className="text-xl font-semibold mono" style={{ color: "var(--text-primary)" }}>
                  {Math.round(report.detection_grade.precision * 100)}%
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Precision · of {report.detection_grade.detected.length} detected
                </div>
              </div>
            )}
          </div>
          {report.detection_grade.missed.length > 0 && (
            <div className="flex items-start gap-2 flex-wrap">
              <span style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>Missed:</span>
              {report.detection_grade.missed.map((label) => (
                <span key={label} className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={{ background: "#fef2f2", color: "#dc2626" }}>
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Chains */}
      {chains.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
          <h3 className="font-semibold mb-5 flex items-center gap-2" style={{ fontSize: 15, color: "var(--text-primary)" }}>
            <GitBranch size={16} className="text-orange-500" />
            Chains Triggered ({chains.length})
          </h3>
          <div className="space-y-2">
            {chains.map((c, i) => {
              const sty = SEVERITY_STYLES[c.severity?.toLowerCase()] ?? { bg: "#f9fafb", color: "#6b7280" };
              return (
                <div
                  key={i}
                  className="p-3 rounded-lg border"
                  style={{ backgroundColor: sty.bg, borderColor: sty.color + "40" }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm" style={{ color: sty.color }}>{c.chain_name}</span>
                    <span
                      className="text-xs font-semibold px-1.5 py-0.5 rounded capitalize text-white"
                      style={{ backgroundColor: sty.color }}
                    >
                      {c.severity}
                    </span>
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>{c.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold flex items-center gap-2" style={{ fontSize: 15, color: "var(--text-primary)" }}>
              <Shield size={16} className="text-blue-500" />
              Recommendations ({recommendations.length})
            </h3>
            <Button size="sm" onClick={applyAllRecommendations} disabled={applyingAll} loading={applyingAll}>
              {applyingAll ? "Applying..." : "Apply All"}
            </Button>
          </div>
          <div className="space-y-1.5">
            {recommendations.map((rec, i) => {
              const text = typeof rec === "string" ? rec : (rec.message ?? rec.reason ?? "");
              const tag = typeof rec === "string" ? "" : (rec.effect && rec.action_pattern ? `${rec.effect} · ${rec.action_pattern}` : "");
              return (
                <div
                  key={i}
                  style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "var(--text-primary)", padding: 8, background: "var(--bg-sunken)", borderRadius: 10 }}
                >
                  <CheckCircle size={14} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--color-cta)' }} />
                  <div style={{ flex: 1 }}>
                    <span>{text}</span>
                    {tag && (
                      <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: "var(--text-muted)" }}>{tag}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
        <h3 className="font-semibold mb-3 flex items-center gap-2" style={{ fontSize: 15, color: "var(--text-primary)" }}>
          <Clock size={16} style={{ color: "var(--text-secondary)" }} />
          Execution Timeline ({steps.length} steps)
        </h3>
        {steps.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)", padding: "16px 0", textAlign: "center" }}>No trace steps recorded.</p>
        ) : (
          <div className="space-y-2">
            {steps.map((step, i) => (
              <StepRow key={step.id ?? i} step={step} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
