import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Shield, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/shared/Toast";
import { timeAgo, scoreBand } from "@/lib/utils";
import ErrorState from "@/components/shared/ErrorState";

// Shapes below mirror the backend SweepReport (backend/sandbox/models.py) exactly
// — the endpoint returns that dataclass flat (no `{sweep: ...}` wrapper).
interface ScenarioResult {
  scenario_id: string;
  scenario_name?: string;
  category?: string;
  status: string;
  risk_score: number;
  violations_count: number;
  chains_count: number;
}

interface SweepViolation {
  type?: string;
  title: string;
  severity: string;
  description: string;
}

interface SweepReportData {
  sweep_id: string;
  agent_id: string;
  agent_name?: string;
  total_scenarios: number;
  completed: number;
  failed: number;
  overall_risk_score: number;
  all_violations: SweepViolation[];
  all_chains: unknown[];
  scenario_results: ScenarioResult[];
  // Backend returns recommendation OBJECTS ({message, effect, action_pattern,
  // reason, actionable}) or plain strings — support both to avoid a render crash.
  recommendations: (string | {
    message?: string;
    reason?: string;
    effect?: string;
    action_pattern?: string;
    actionable?: boolean;
  })[];
  started_at?: string;
  completed_at?: string;
}

const SEVERITY_STYLES: Record<string, { bg: string; color: string }> = {
  /* Filled, not tinted — critical must read differently from high at a glance. */
  critical: { bg: "var(--severity-critical)", color: "#fff" },
  high:     { bg: "var(--severity-high-bg)",     color: "var(--severity-high)" },
  medium:   { bg: "var(--severity-medium-bg)",   color: "var(--severity-medium)" },
  low:      { bg: "var(--severity-safe-bg)",     color: "var(--severity-safe)" },
};

const FALLBACK_STYLE = { bg: "var(--bg-sunken)", color: "var(--text-secondary)" };

function statusStyle(status: string): { background: string; color: string } {
  if (status === "completed") return { background: "var(--status-executed-bg)", color: "var(--status-executed)" };
  if (status === "failed" || status === "error") return { background: "var(--severity-critical-bg)", color: "var(--severity-critical)" };
  return { background: "var(--status-pending-bg)", color: "var(--status-pending)" };
}

function ScoreRing({ score }: { score: number }) {
  const radius = 44;
  const circ = 2 * Math.PI * radius;
  const dash = (score / 100) * circ;
  // Use the single authoritative band scale (80/60/40) instead of ad-hoc 70/40.
  const band = scoreBand(score);
  const color = band.color;
  const label = band.label;

  return (
    <div style={{ flexShrink: 0 }}>
      <div style={{ position: "relative", width: 100, height: 100 }}>
        <svg width={100} height={100} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={50} cy={50} r={radius} fill="none" stroke="var(--border)" strokeWidth={8} />
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
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1, color }}>{score}</div>
          <div style={{ fontSize: 12, fontWeight: 500, marginTop: 2, color }}>{label}</div>
        </div>
      </div>
    </div>
  );
}

export default function SweepDetail() {
  const { sweepId } = useParams<{ sweepId: string }>();
  const [sweep, setSweep] = useState<SweepReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyingAll, setApplyingAll] = useState(false);

  /** Gate every actionable recommendation this sweep produced, in one call.
   *
   * Uses /api/sandbox/apply-all-policies rather than looping the per-agent
   * policies endpoint (what SimulationDetail does): it de-dupes against
   * policies that already exist, so a second click reports "skipped" instead
   * of stacking duplicates, and it sets the effect-derived priority server-side.
   * Each item must carry agent_id — the request model requires it per policy,
   * not just at the top level. */
  async function applyAllRecommendations() {
    if (!sweep) return;
    const seen = new Set<string>();
    const policies = [];
    for (const rec of sweep.recommendations ?? []) {
      if (typeof rec === "string") continue;
      if (!rec.actionable || !rec.action_pattern || !rec.effect) continue;
      const key = `${rec.action_pattern}|${rec.effect}`;
      if (seen.has(key)) continue;
      seen.add(key);
      policies.push({
        agent_id: sweep.agent_id,
        action_pattern: rec.action_pattern,
        effect: rec.effect,
        reason: rec.reason ?? rec.message ?? "Applied from sweep recommendation",
      });
    }
    if (policies.length === 0) {
      toast("No actionable recommendations to apply");
      return;
    }
    setApplyingAll(true);
    try {
      const res = await apiFetch<{ created: number; skipped: number }>(
        "/api/sandbox/apply-all-policies",
        { method: "POST", body: JSON.stringify({ agent_id: sweep.agent_id, policies }) },
      );
      const skipped = res.skipped ? `, ${res.skipped} already in place` : "";
      toast(`Applied ${res.created} polic${res.created === 1 ? "y" : "ies"}${skipped} — re-run the sweep to see the effect`);
    } catch (err) {
      toast("Couldn't apply recommendations: " + (err as Error).message, "error");
    } finally {
      setApplyingAll(false);
    }
  }

  const load = useCallback(() => {
    if (!sweepId) return;
    setLoading(true);
    setLoadError(null);
    // The endpoint returns the SweepReport flat (no wrapper) — consume it directly.
    apiFetch<SweepReportData>(`/api/sandbox/sweep/${sweepId}`)
      .then((data) => setSweep(data))
      // Distinguish a network/server error from a genuinely-missing sweep.
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, [sweepId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div style={{ padding: 40 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="animate-pulse" style={{ height: 32, background: "var(--bg-sunken)", borderRadius: "var(--radius-md)", width: 192 }} />
          <div className="animate-pulse" style={{ height: 160, background: "var(--bg-sunken)", borderRadius: 12 }} />
          <div className="animate-pulse" style={{ height: 256, background: "var(--bg-sunken)", borderRadius: 12 }} />
        </div>
      </div>
    );
  }

  if (loadError) {
    return <div style={{ padding: 40 }}><ErrorState message={loadError} onRetry={load} /></div>;
  }

  if (!sweep) {
    return (
      <div style={{ padding: 40, textAlign: "center", paddingTop: 80, color: "var(--text-muted)" }}>
        <Shield size={32} style={{ margin: "0 auto 8px", color: "var(--border-strong)" }} />
        <p style={{ fontSize: 13 }}>Sweep not found.</p>
      </div>
    );
  }

  // Derive the display values from the flat backend report.
  const scenarios = sweep.scenario_results ?? [];
  const violations = sweep.all_violations ?? [];
  const recommendations = sweep.recommendations ?? [];
  const riskScore = Math.round(sweep.overall_risk_score ?? 0);
  const totalViolations = violations.length;
  const totalChains = (sweep.all_chains ?? []).length;
  const scenariosRun = sweep.total_scenarios ?? scenarios.length;
  const scenariosFailed = sweep.failed ?? 0;
  const sweepStatus = scenariosFailed > 0 ? "partial" : "completed";
  const createdAt = sweep.completed_at ?? sweep.started_at ?? "";

  return (
    <div style={{ padding: 40, display: "flex", flexDirection: "column", gap: 32, maxWidth: 800 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Link to="/sandbox">
          <Button variant="secondary" size="sm" icon={<ArrowLeft size={14} />}>
            Back to Sandbox
          </Button>
        </Link>
        <span style={{ color: "var(--border-strong)" }}>/</span>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
          Sweep Detail
        </h1>
      </div>

      {/* Overview */}
      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <ScoreRing score={riskScore} />
          <div style={{ flex: 1 }}>
            <h2 style={{ fontSize: 17, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4, marginTop: 0 }}>
              {sweep.agent_name ?? sweep.agent_id}
            </h2>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <span
                style={{
                  fontSize: 12,
                  padding: "2px 8px",
                  borderRadius: "var(--radius-full)",
                  fontWeight: 500,
                  ...statusStyle(sweepStatus),
                }}
              >
                {sweepStatus}
              </span>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{timeAgo(createdAt)}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, textAlign: "center" }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>{scenariosRun}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Scenarios</div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--severity-critical)" }}>{totalViolations}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Violations</div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--severity-high)" }}>{totalChains}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Chains</div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--severity-critical)" }}>{scenariosFailed}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Failed</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Scenario breakdown */}
      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
        <div style={{ padding: "16px 24px 0" }}>
          <h3 style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: 15, margin: 0 }}>
            Scenario Breakdown
          </h3>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-sunken)" }}>
                {["Scenario", "Score", "Violations", "Chains", "Status"].map((col, i) => (
                  <th
                    key={col}
                    style={{
                      textAlign: i >= 1 ? "center" : "left",
                      padding: "12px 16px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--text-secondary)",
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scenarios.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: "24px 16px", textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>
                    No scenarios recorded
                  </td>
                </tr>
              ) : (
                scenarios.map((sc, i) => {
                  const sc_color = scoreBand(sc.risk_score).color;
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                      <td style={{ padding: "12px 16px", fontWeight: 500, color: "var(--text-primary)" }}>
                        {sc.scenario_name ?? sc.scenario_id}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "center", fontWeight: 700, color: sc_color }}>
                        {sc.risk_score}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "center", color: "var(--text-primary)" }}>
                        {sc.violations_count}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "center", color: "var(--text-primary)" }}>
                        {sc.chains_count}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "center" }}>
                        <span
                          style={{
                            fontSize: 12,
                            padding: "2px 8px",
                            borderRadius: "var(--radius-full)",
                            fontWeight: 500,
                            ...statusStyle(sc.status),
                          }}
                        >
                          {sc.status}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Violations */}
      {violations.length > 0 && (
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: 24 }}>
          <h3
            style={{
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: 12,
              fontSize: 15,
              marginTop: 0,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <XCircle size={16} style={{ color: "var(--severity-critical)" }} />
            Violations Across Scenarios ({violations.length})
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {violations.map((v, i) => {
              const sty = SEVERITY_STYLES[v.severity?.toLowerCase()] ?? FALLBACK_STYLE;
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                    padding: 12,
                    borderRadius: "var(--radius-lg)",
                    backgroundColor: sty.bg,
                  }}
                >
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2, color: sty.color }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, fontSize: 13, color: sty.color }}>{v.title}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{v.description}</div>
                  </div>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: "var(--radius-full)",
                      textTransform: "capitalize",
                      color: "var(--text-inverse)",
                      flexShrink: 0,
                      backgroundColor: sty.color,
                    }}
                  >
                    {v.severity}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12 }}>
            <h3
              style={{
                fontWeight: 600,
                color: "var(--text-primary)",
                margin: 0,
                fontSize: 15,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Shield size={16} style={{ color: "var(--color-accent)" }} />
              Recommendations ({recommendations.length})
            </h3>
            {recommendations.some((r) => typeof r !== "string" && r.actionable && r.action_pattern && r.effect) && (
              <Button size="sm" onClick={applyAllRecommendations} disabled={applyingAll} loading={applyingAll}>
                {applyingAll ? "Applying..." : "Apply All"}
              </Button>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recommendations.map((rec, i) => {
              const text = typeof rec === "string" ? rec : (rec.message ?? rec.reason ?? "");
              const tag = typeof rec === "string" ? "" : (rec.effect && rec.action_pattern ? `${rec.effect} · ${rec.action_pattern}` : "");
              return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  fontSize: 13,
                  color: "var(--text-primary)",
                  padding: 8,
                  background: "var(--color-accent-bg)",
                  borderRadius: "var(--radius-md)",
                }}
              >
                <CheckCircle size={14} style={{ color: "var(--color-accent)", marginTop: 2, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <span>{text}</span>
                  {tag && <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: "var(--text-muted)" }}>{tag}</span>}
                </div>
              </div>
            );})}
          </div>
        </div>
      )}
    </div>
  );
}
