import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Shield, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/shared/Toast";
import { timeAgo } from "@/lib/utils";

interface ScenarioResult {
  scenario_id: string;
  scenario_name?: string;
  category?: string;
  status: string;
  risk_score: number;
  violations: number;
  chains: number;
}

interface SweepViolation {
  rule: string;
  severity: string;
  description: string;
  scenario_id?: string;
}

interface SweepDetailData {
  id: string;
  agent_id: string;
  agent_name?: string;
  status: string;
  created_at: string;
  scenarios: ScenarioResult[];
  aggregate: {
    risk_score: number;
    total_violations: number;
    total_chains: number;
    scenarios_run: number;
    scenarios_failed: number;
  };
  recommendations: string[];
  violations: SweepViolation[];
}

const SEVERITY_STYLES: Record<string, { bg: string; color: string }> = {
  critical: { bg: "var(--severity-critical-bg)", color: "var(--severity-critical)" },
  high:     { bg: "var(--severity-high-bg)",     color: "var(--severity-high)" },
  medium:   { bg: "var(--severity-medium-bg)",   color: "var(--severity-medium)" },
  low:      { bg: "var(--severity-safe-bg)",     color: "var(--severity-safe)" },
};

const FALLBACK_STYLE = { bg: "var(--bg-sunken)", color: "var(--text-secondary)" };

function scoreColor(score: number): string {
  return score >= 70 ? "var(--severity-critical)" : score >= 40 ? "var(--severity-high)" : "var(--severity-safe)";
}

function statusStyle(status: string): { background: string; color: string } {
  if (status === "completed") return { background: "var(--status-executed-bg)", color: "var(--status-executed)" };
  if (status === "failed")    return { background: "var(--severity-critical-bg)", color: "var(--severity-critical)" };
  return { background: "var(--status-pending-bg)", color: "var(--status-pending)" };
}

function ScoreRing({ score }: { score: number }) {
  const radius = 44;
  const circ = 2 * Math.PI * radius;
  const dash = (score / 100) * circ;
  const color = scoreColor(score);
  const label = score >= 70 ? "Critical" : score >= 40 ? "High" : "Safe";

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
  const navigate = useNavigate();
  const [sweep, setSweep] = useState<SweepDetailData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sweepId) return;
    setLoading(true);
    apiFetch<{ sweep: SweepDetailData }>(`/api/sandbox/sweep/${sweepId}`)
      .then((data) => setSweep(data.sweep))
      .catch(() => toast("Failed to load sweep", "error"))
      .finally(() => setLoading(false));
  }, [sweepId]);

  if (loading) {
    return (
      <div style={{ padding: 40 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ height: 32, background: "var(--bg-sunken)", borderRadius: "var(--radius-md)", width: 192 }} />
          <div style={{ height: 160, background: "var(--bg-sunken)", borderRadius: 12 }} />
          <div style={{ height: 256, background: "var(--bg-sunken)", borderRadius: 12 }} />
        </div>
      </div>
    );
  }

  if (!sweep) {
    return (
      <div style={{ padding: 40, textAlign: "center", paddingTop: 80, color: "var(--text-muted)" }}>
        <Shield size={32} style={{ margin: "0 auto 8px", color: "var(--border-strong)" }} />
        <p style={{ fontSize: 13 }}>Sweep not found.</p>
      </div>
    );
  }

  const agg = sweep.aggregate;
  const scenarios = sweep.scenarios ?? [];
  const violations = sweep.violations ?? [];
  const recommendations = sweep.recommendations ?? [];

  return (
    <div style={{ padding: 40, display: "flex", flexDirection: "column", gap: 32, maxWidth: 800 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button variant="secondary" size="sm" onClick={() => navigate(-1)} icon={<ArrowLeft size={14} />}>
          Back to Sandbox
        </Button>
        <span style={{ color: "var(--border-strong)" }}>/</span>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
          Sweep Detail
        </h1>
      </div>

      {/* Overview */}
      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <ScoreRing score={agg.risk_score} />
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
                  ...statusStyle(sweep.status),
                }}
              >
                {sweep.status}
              </span>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{timeAgo(sweep.created_at)}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, textAlign: "center" }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>{agg.scenarios_run}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Scenarios</div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--severity-critical)" }}>{agg.total_violations}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Violations</div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--severity-high)" }}>{agg.total_chains}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Chains</div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--severity-critical)" }}>{agg.scenarios_failed}</div>
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
                  const sc_color = scoreColor(sc.risk_score);
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                      <td style={{ padding: "12px 16px", fontWeight: 500, color: "var(--text-primary)" }}>
                        {sc.scenario_name ?? sc.scenario_id}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "center", fontWeight: 700, color: sc_color }}>
                        {sc.risk_score}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "center", color: "var(--text-primary)" }}>
                        {sc.violations}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "center", color: "var(--text-primary)" }}>
                        {sc.chains}
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
                    <div style={{ fontWeight: 500, fontSize: 13, color: sty.color }}>{v.rule}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{v.description}</div>
                    {v.scenario_id && (
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                        Scenario: {v.scenario_id}
                      </div>
                    )}
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
            <Shield size={16} style={{ color: "var(--color-accent)" }} />
            Recommendations ({recommendations.length})
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recommendations.map((rec, i) => (
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
                {rec}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
