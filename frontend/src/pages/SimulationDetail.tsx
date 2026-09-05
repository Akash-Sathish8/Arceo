import { useParams, Link, useNavigate } from "react-router-dom";
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
  RotateCcw,
  Gavel,
  Send,
  Banknote,
  Plug,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/shared/Toast";
import { timeAgo, riskLabelColor, riskLabelBg, riskLabelName } from "@/lib/utils";
import ErrorState from "@/components/shared/ErrorState";
import type { RiskLabel } from "@/lib/types";

interface TraceStep {
  id?: string;
  /** Raw enforcement decision: ALLOW / REQUIRE_APPROVAL / BLOCK. */
  decision?: string;
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
  /** Trace steps that form the chain (ChainViolation.step_indices). Lets the
   *  timeline bracket the actual pair instead of listing the chain elsewhere
   *  and leaving the reader to find it. */
  step_indices?: number[];
}

interface ChainSpan {
  chain: Chain;
  start: number;
  end: number;
  lane: number;
  color: string;
}

/** Chains that cover a contiguous run of steps, packed into lanes so two
 *  overlapping chains never draw over each other. */
function buildChainSpans(chains: Chain[]): ChainSpan[] {
  const raw = chains
    .map((c) => {
      const idx = (c.step_indices ?? []).filter((n) => Number.isInteger(n));
      if (idx.length < 2) return null;
      return { chain: c, start: Math.min(...idx), end: Math.max(...idx) };
    })
    .filter((v): v is { chain: Chain; start: number; end: number } => v !== null)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const laneEnds: number[] = [];
  return raw.map((v) => {
    let lane = laneEnds.findIndex((end) => end < v.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(v.end);
    } else {
      laneEnds[lane] = v.end;
    }
    const sev = v.chain.severity?.toLowerCase();
    const color =
      sev === "critical" ? "var(--critical)" :
      sev === "high" ? "var(--high)" :
      sev === "medium" ? "var(--caution)" :
      "var(--ink-400)";
    return { ...v, lane, color };
  });
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
    return <span style={{ color: data ? "var(--safe)" : "var(--critical)" }}>{String(data)}</span>;
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
  /* Filled, not tinted — critical must read differently from high at a glance. */
  critical: { bg: "var(--critical)", color: "#fff" },
  high: { bg: "var(--high-bg)", color: "var(--high)" },
  medium: { bg: "var(--caution-bg)", color: "var(--on-caution)" },
  low: { bg: "var(--safe-bg)", color: "var(--safe)" },
};

/**
 * How each enforcement decision presents: marker, card border, and chip.
 * ALLOW is deliberately neutral — only the two decisions that stopped or
 * paused the agent get colour.
 */
const DECISION: Record<string, {
  label: string
  Icon: typeof Send
  fg: string
  markerBg: string
  markerBorder: string
  markerFg: string
  cardBorder: string
  chipBg: string
  chipFg: string
  chipBorder: string
}> = {
  ALLOW: {
    label: "Allow", Icon: Plug, fg: "var(--ink-500)",
    markerBg: "var(--surface-container-high, #e8e7ef)", markerBorder: "var(--line)", markerFg: "var(--ink-600)",
    cardBorder: "var(--line)",
    chipBg: "var(--paper-2)", chipFg: "var(--ink-600)", chipBorder: "var(--line)",
  },
  REQUIRE_APPROVAL: {
    label: "Require_approval", Icon: Banknote, fg: "var(--amber-ink)",
    markerBg: "var(--caution-bg)", markerBorder: "var(--caution-line)", markerFg: "var(--on-caution)",
    cardBorder: "var(--line)",
    chipBg: "var(--caution-bg)", chipFg: "var(--on-caution)", chipBorder: "var(--caution-line)",
  },
  BLOCK: {
    label: "Block", Icon: Send, fg: "var(--critical)",
    markerBg: "var(--critical-bg)", markerBorder: "var(--critical-line)", markerFg: "var(--critical)",
    cardBorder: "var(--critical-line)",
    chipBg: "var(--critical)", chipFg: "#ffffff", chipBorder: "var(--critical)",
  },
};

/** A plain sentence for what the step did, built from the action it called. */
function stepSentence(step: TraceStep): string {
  const verb = step.action.replace(/_/g, " ");
  const target = step.tool.replace(/_/g, " ");
  const amount = ["amount", "total", "value"].map((k) => step.params?.[k]).find((v) => typeof v === "number");
  const money = typeof amount === "number"
    ? ` of $${(amount > 1000 ? amount / 100 : amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "";
  return step.allowed
    ? `Called ${target} to ${verb}${money}.`
    : `Attempted to ${verb} via ${target}${money}.`;
}

/** Why a step was stopped — the covering chain, else the matching violation. */
function blockReason(step: TraceStep, violations: Violation[], covering: ChainSpan[]): string {
  if (covering.length > 0) {
    return `Blocked by policy: ${covering[0].chain.description}`;
  }
  const v = violations.find((x) => x.description?.includes(step.action) || x.title?.includes(step.action));
  return v ? `Blocked by policy: ${v.description}` : "Blocked by policy before it could run.";
}

/** The line/edge form of a severity. SEVERITY_STYLES.color is #fff for
 *  critical (its chip is filled), so it can't double as an accent. */
const SEVERITY_ACCENT: Record<string, string> = {
  critical: "var(--critical)",
  high: "var(--high)",
  medium: "var(--caution)",
  low: "var(--safe)",
};

function ScoreRing({ score }: { score: number }) {
  const radius = 44;
  const circ = 2 * Math.PI * radius;
  const dash = (score / 100) * circ;
  const color = score >= 70 ? "var(--critical)" : score >= 40 ? "var(--high)" : "var(--safe)";
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
            backgroundColor: step.allowed ? "var(--safe-bg)" : "var(--critical-bg)",
            color: step.allowed ? "var(--safe)" : "var(--critical)",
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
  const navigate = useNavigate();

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
          decision: (s.enforce_decision as string | undefined)
            ?? (s.allowed === false ? "BLOCK" : "ALLOW"),
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
  // Chain brackets drawn down the left of the timeline — the product's core
  // claim ("these two steps together are the danger") made visible in place.
  const chainSpans = buildChainSpans(chains);
  const chainGutter = chainSpans.length > 0
    ? 14 + chainSpans.reduce((mx, s) => Math.max(mx, s.lane + 1), 0) * 11
    : 0;
  const recommendations = report?.recommendations ?? [];
  const score = report?.risk_score ?? 0;

  // REQUIRE_APPROVAL is an action held for a human, not one the run stopped.
  // Counting it as blocked overstated what enforcement actually prevented.
  const decisionOf = (st: TraceStep) => (st.decision ?? (st.allowed ? "ALLOW" : "BLOCK")).toUpperCase();
  const executed = steps.filter((st) => decisionOf(st) === "ALLOW").length;
  const blocked = steps.filter((st) => decisionOf(st) === "BLOCK").length;
  const criticalViolations = violations.filter((v) => (v.severity ?? "").toLowerCase() === "critical").length
    + chains.filter((c) => (c.severity ?? "").toLowerCase() === "critical").length;
  const traceId = String(sim.id ?? "").slice(0, 8) || "None";
  const runDate = sim.created_at
    ? new Date(sim.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "None";

  return (
    <div className="px-container-padding py-stack-gap flex flex-col gap-stack-gap w-full">
      {/* ── Header ── */}
      <div className="w-full flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-page-title text-page-title text-on-surface m-0">
            {sim.scenario_name ?? sim.scenario_id}
          </h1>
          <div className="flex items-center gap-2 text-meta font-meta text-neutral-secondary">
            <span>
              Agent: <span className="font-monospace-data text-on-surface">{sim.agent_name ?? sim.agent_id}</span>
            </span>
            <span className="w-1 h-1 rounded-full bg-neutral-border" />
            <span>
              Run Date: <span className="font-monospace-data text-on-surface">{runDate}</span>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/sandbox" className="no-underline">
            <button
              type="button"
              className="px-4 py-2 bg-surface-container-lowest text-on-surface-variant font-body text-body rounded-lg hover:bg-surface-container-low transition-colors cursor-pointer"
            >
              Back to Sandbox
            </button>
          </Link>
          <button
            type="button"
            onClick={() => navigate(`/sandbox?agent=${encodeURIComponent(sim.agent_id)}`)}
            className="btn btn--primary"
          >
            <RotateCcw size={18} strokeWidth={2} />
            Re-run Simulation
          </button>
        </div>
      </div>

      {/* ── Result tiles ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile label="Steps taken" value={steps.length} />
        <StatTile label="Actions executed" value={executed} color="var(--aqua-deep)" />
        <StatTile label="Actions blocked" value={blocked} color="var(--critical)" wash={blocked > 0} />
        <StatTile label="Critical violations" value={criticalViolations} color="var(--critical)" wash={criticalViolations > 0} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-4 items-start">
        {/* ── Execution trace ── */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          <div className="bg-surface-container-lowest rounded-xl overflow-hidden flex flex-col">
            <div className="p-6 border-b border-neutral-border flex justify-between items-center gap-3">
              <h2 className="font-card-title text-card-title text-on-surface m-0">Execution Trace</h2>
              <span className="px-2 py-1 bg-surface-container-low border border-neutral-border rounded text-monospace-label font-monospace-label text-neutral-secondary">
                TRACE_ID: {traceId}
              </span>
            </div>

            <div className="p-6 relative">
              {steps.length === 0 ? (
                <p className="text-body font-body text-neutral-muted text-center m-0 py-4">
                  No trace steps recorded.
                </p>
              ) : (
                <>
                  {/* Spine behind the step markers */}
                  <div className="absolute w-px bg-neutral-border" style={{ left: 43, top: 32, bottom: 32 }} />
                  <div className="flex flex-col gap-8 relative z-20">
                    {steps.map((step, i) => {
                      const covering = chainSpans.filter((c) => i >= c.start && i <= c.end);
                      const startsHere = covering.filter((c) => c.start === i);
                      const d = DECISION[decisionOf(step)] ?? DECISION.ALLOW;
                      return (
                        <div key={step.id ?? i} className="relative">
                          {/* Chain bracket label, where a chain opens */}
                          {startsHere.map((c) => (
                            <div
                              key={c.chain.chain_name}
                              className="flex items-center gap-1.5 mb-2 ml-14"
                            >
                              <GitBranch size={11} style={{ color: c.color, flexShrink: 0 }} />
                              <span
                                className="font-monospace-label text-monospace-label uppercase"
                                style={{ color: c.color }}
                              >
                                Dangerous chain: {c.chain.chain_name}
                              </span>
                            </div>
                          ))}
                          <div className="flex items-start gap-4">
                            {/* Step marker */}
                            <div
                              className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 z-10 font-monospace-data text-[12px]"
                              style={{ background: d.markerBg, border: `1px solid ${d.markerBorder}`, color: d.markerFg }}
                            >
                              {String(i + 1).padStart(2, "0")}
                            </div>
                            <div
                              className="flex-1 min-w-0 rounded-lg p-4 transition-colors"
                              style={{
                                background: "var(--card)",
                                border: `1px solid ${d.cardBorder}`,
                              }}
                            >
                              <div className="flex justify-between items-center gap-3 mb-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <d.Icon size={18} style={{ color: d.fg, flexShrink: 0 }} />
                                  <span className="font-monospace-data text-monospace-data text-on-surface truncate">
                                    {step.tool}.{step.action}
                                  </span>
                                </div>
                                <span
                                  className="px-2 py-1 rounded font-meta uppercase tracking-wider text-[10px] shrink-0"
                                  style={{ background: d.chipBg, color: d.chipFg, border: `1px solid ${d.chipBorder}` }}
                                >
                                  {d.label}
                                </span>
                              </div>
                              <p className="text-body font-body text-neutral-secondary m-0">
                                {stepSentence(step)}
                              </p>
                              {Object.keys(step.params ?? {}).length > 0 && (
                                <pre className="mt-3 bg-surface-container-low rounded p-3 border border-neutral-border font-monospace-data text-[12px] text-neutral-primary whitespace-pre-wrap overflow-x-auto m-0">
                                  {JSON.stringify(step.params, null, 2)}
                                </pre>
                              )}
                              {decisionOf(step) === "BLOCK" && (
                                <div
                                  className="mt-3 flex items-start gap-2 text-[12px] font-medium p-2 rounded"
                                  style={{
                                    color: "var(--critical)",
                                    background: "var(--critical-bg)",
                                    border: "1px solid var(--critical-line)",
                                  }}
                                >
                                  <AlertTriangle size={16} className="shrink-0 mt-px" />
                                  <span>{blockReason(step, violations, covering)}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>

          {report?.detection_grade && <DetectionGrade grade={report.detection_grade} />}
          {recommendations.length > 0 && <Recommendations items={recommendations} onApplyAll={applyAllRecommendations} applying={applyingAll} />}
        </div>

        {/* ── Right rail ── */}
        <div className="lg:col-span-1 flex flex-col gap-6">
          {report?.executive_summary && (
            <div className="bg-surface-container-lowest rounded-xl flex flex-col">
              <div className="p-6 border-b border-neutral-border">
                <h2 className="font-card-title text-card-title text-on-surface m-0">Simulation Executive Summary</h2>
              </div>
              <div className="p-6 flex flex-col gap-4">
                {report.executive_summary.split(/\n{2,}/).map((para, i) => (
                  <p key={i} className="font-body text-body text-neutral-secondary leading-relaxed m-0">{para}</p>
                ))}
              </div>
            </div>
          )}

          {(violations.length > 0 || chains.length > 0) && (
            <div
              className="rounded-xl flex flex-col"
              style={{ background: "var(--caution-bg)" }}
            >
              <div className="p-6 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Gavel size={20} style={{ color: "var(--amber-ink)" }} />
                  <h2 className="font-card-title text-card-title m-0" style={{ color: "var(--amber-ink)" }}>
                    Policy Violations
                  </h2>
                </div>
                <span className="font-eyebrow text-eyebrow uppercase" style={{ color: "var(--amber-ink)", opacity: 0.75 }}>
                  Triggered rules
                </span>
              </div>
              <div className="px-6 pb-6 flex flex-col gap-3">
                {[
                  ...chains.map((c) => ({ title: c.chain_name, severity: c.severity, description: c.description })),
                  ...violations.map((v) => ({ title: v.title || v.type || "Violation", severity: v.severity, description: v.description })),
                ].map((v, i) => {
                  const sty = SEVERITY_STYLES[(v.severity ?? "").toLowerCase()] ?? { bg: "var(--paper-2)", color: "var(--ink-600)" };
                  return (
                    <div key={i} className="bg-surface-container-lowest rounded-lg p-4">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <span className="font-monospace-data text-monospace-data text-on-surface">{v.title}</span>
                        <span
                          className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide shrink-0"
                          style={{ background: sty.bg, color: sty.color }}
                        >
                          {v.severity}
                        </span>
                      </div>
                      <p className="font-body text-neutral-secondary m-0 text-[13px]">{v.description}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One result tile. The two failure tiles carry the canvas's corner wash. */
function StatTile({ label, value, color, wash = false }: { label: string; value: number; color?: string; wash?: boolean }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl p-6 flex flex-col gap-2 relative overflow-hidden">
      {wash && (
        <div
          className="absolute right-0 top-0 w-16 h-16 rounded-bl-full"
          style={{ background: "linear-gradient(to bottom left, var(--critical-bg), transparent)" }}
        />
      )}
      <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase relative">{label}</span>
      <span className="font-display text-display relative" style={{ color: color ?? "var(--ink-900)" }}>
        {value}
      </span>
    </div>
  );
}

/** Precision/recall of violation detection against what the scenario expected. */
function DetectionGrade({ grade }: { grade: NonNullable<SimulationDetailData["report"]["detection_grade"]> }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl p-6">
      <div className="flex items-center gap-2 mb-1">
        <Crosshair size={18} style={{ color: grade.passed ? "var(--aqua-deep)" : "var(--high)" }} />
        <h3 className="font-card-title text-card-title text-on-surface m-0">Detection grade</h3>
        <span
          className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
          style={
            grade.passed
              ? { background: "var(--aqua-soft)", color: "var(--aqua-deep)" }
              : { background: "var(--high-bg)", color: "var(--high)" }
          }
        >
          {grade.passed ? "All expected violations detected" : "Missed expected violations"}
        </span>
      </div>
      <p className="text-meta font-meta text-neutral-secondary mt-1 mb-4">
        How well this run surfaced the violations the scenario was designed to trigger. Actions that policy
        blocked still count as detected. Catching and stopping a violation is not a miss.
      </p>
      <div className="flex gap-8 mb-4">
        {grade.recall != null && (
          <div>
            <div className="font-monospace-data text-[20px] font-semibold text-on-surface">
              {Math.round(grade.recall * 100)}%
            </div>
            <div className="text-meta font-meta text-neutral-secondary">
              Recall · {grade.matched.length}/{grade.expected.length} expected found
            </div>
          </div>
        )}
        {grade.precision != null && (
          <div>
            <div className="font-monospace-data text-[20px] font-semibold text-on-surface">
              {Math.round(grade.precision * 100)}%
            </div>
            <div className="text-meta font-meta text-neutral-secondary">
              Precision · of {grade.detected.length} detected
            </div>
          </div>
        )}
      </div>
      {grade.missed.length > 0 && (
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-meta font-meta text-neutral-secondary mt-0.5">Missed:</span>
          {grade.missed.map((label) => (
            <span
              key={label}
              className="text-[11px] px-2 py-0.5 rounded-full font-medium"
              style={{ background: "var(--critical-bg)", color: "var(--critical)" }}
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Fixes the run suggests, each applyable as a policy. */
function Recommendations({
  items, onApplyAll, applying,
}: {
  items: SimulationDetailData["report"]["recommendations"]
  onApplyAll: () => void
  applying: boolean
}) {
  const actionable = items.filter((r) => typeof r !== "string" && r.actionable);
  return (
    <div className="bg-surface-container-lowest rounded-xl p-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="font-card-title text-card-title text-on-surface m-0 flex items-center gap-2">
          <Shield size={18} style={{ color: "var(--accent)" }} />
          Recommendations ({items.length})
        </h3>
        {actionable.length > 0 && (
          <Button size="sm" onClick={onApplyAll} loading={applying} disabled={applying}>
            {applying ? "Applying…" : `Apply ${actionable.length}`}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {items.map((rec, i) => {
          const text = typeof rec === "string" ? rec : (rec.message ?? rec.reason ?? "");
          const pattern = typeof rec === "string" ? undefined : rec.action_pattern;
          return (
            <div key={i} className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full mt-2 shrink-0" style={{ background: "var(--accent)" }} />
              <div className="min-w-0">
                <p className="text-body font-body text-on-surface m-0">{text}</p>
                {pattern && (
                  <span className="font-monospace-label text-monospace-label text-neutral-secondary">{pattern}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
