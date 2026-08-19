import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { Link2, CheckCircle, Square, CheckSquare } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/shared/Toast";
import { scoreBand, scoreToColor } from "@/lib/utils";
import { chainShortLabel, chainNarrative } from "@/lib/chainLabels";
import Tooltip from "@/components/shared/Tooltip";
import ErrorState from "@/components/shared/ErrorState";
import { RISK_SCORE_METHODOLOGY, OVER_PERMISSION_METHODOLOGY } from "@/lib/methodology";

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_COLORS = ["#2563eb", "#16a34a", "#ea580c", "#7c3aed", "#0d9488"] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentBlastRadius {
  score?: number;
  moves_money?: number;
  touches_pii?: number;
  deletes_data?: number;
  sends_external?: number;
  changes_production?: number;
  changes_access?: number;
  reads_secrets?: number;
  evades_detection?: number;
  bulk_export?: number;
  executes_code?: number;
}

interface AgentData {
  id: string;
  name: string;
  description?: string;
  /** The list endpoint returns tool service names as plain strings. */
  tools?: string[];
  blast_radius?: AgentBlastRadius;
}

interface CrossAgentChain {
  chain_id?: string;
  chain_name: string;
  severity: string;
  from_agent: string;
  to_agent: string;
  from_agent_id?: string;
  to_agent_id?: string;
  from_label: string;
  to_label: string;
}

interface OverprivilegedItem {
  action: string;
  action_name?: string;
  tool?: string;
  severity?: string;
  reason: string;
}

interface PermissionGapItem {
  action: string;
  reason: string;
}

interface ApprovalGate {
  chain_id?: string;
  chain_name: string;
  severity?: string;
  to_agent?: string;
  // The from-agent's tool.action patterns that begin this chain — used to
  // create a scoped REQUIRE_APPROVAL policy the enforcer actually matches.
  action_patterns?: string[];
}

interface AgentOptimization {
  agent_id: string;
  agent_name: string;
  summary: string;
  overprivileged?: OverprivilegedItem[];
  permission_gaps?: PermissionGapItem[];
  approval_gates_needed?: ApprovalGate[];
}

interface OptimizeResultData {
  agents: Record<string, AgentOptimization>;
  overall_optimization_score: number;
  total_overprivileged: number;
  total_permission_gaps: number;
  verdict: string;
}

interface TraceStep {
  /* Backend TraceStep emits source_agent_id / enforce_decision; older shapes
     used agent_id / decision. Read both. */
  agent_id?: string;
  source_agent_id?: string;
  tool: string;
  action: string;
  decision?: string;
  enforce_decision?: string;
}

interface PairingAgent {
  id: string;
  name: string;
  score: number;
}

interface PairingChain {
  id: string;
  name: string;
  severity: string;
  description: string;
}

interface TopPairing {
  agents: PairingAgent[];
  severity: string;
  critical_count: number;
  high_count: number;
  chains: PairingChain[];
}

interface SimulationChain {
  chain_id?: string;
  chain_name: string;
  severity?: string;
  cross_agent?: boolean;
  from_agent?: string;
  to_agent?: string;
}

interface SimulationViolation {
  severity?: string;
  title?: string;
  description?: string;
}

interface SimulationReport {
  violations?: SimulationViolation[];
  // Backend serializes the report's chains under `chains_triggered` (SimulationReport
  // dataclass). Cross-agent chains are tagged by a `cross-agent-` chain_id prefix.
  chains_triggered?: SimulationChain[];
}

interface SimulationTrace {
  steps?: TraceStep[];
}

interface WorkflowResultData {
  simulation_id: string;
  report?: SimulationReport;
  trace?: SimulationTrace;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function blastLabel(score: number): string {
  const b = scoreBand(score);
  return b.key === "critical" ? "Critical" : `${b.label} risk`;
}

const blastColor = scoreToColor;

const LABEL_PHRASE: Record<string, string> = {
  touches_pii: "reads customer data",
  moves_money: "can move money",
  deletes_data: "can delete data",
  sends_external: "can send it outside the org",
  changes_production: "can change production systems",
  changes_access: "can change who has access",
  reads_secrets: "can read secrets",
  evades_detection: "can turn off logging",
  bulk_export: "can export data in bulk",
  executes_code: "can run arbitrary code",
};

function RiskPill({ score }: { score: number }) {
  const band = scoreBand(score);
  return (
    <Tooltip text={`Risk score: ${Math.round(score)} / 100`}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          padding: "2px 8px",
          borderRadius: "var(--radius-full)",
          background: band.bg,
          color: band.color,
          whiteSpace: "nowrap",
          flexShrink: 0,
          cursor: "default",
        }}
      >
        {band.label}
      </span>
    </Tooltip>
  );
}

// Cross-agent chain detection now runs on the backend via
// GET /api/authority/cross-agent-chains, which uses the canonical 14-rule
// chain_detector against each agent's real per-action labels. (It previously
// approximated this client-side from blast-radius label counts with a partial
// 6-rule set — see the MA5 audit item.)

// ── OptimizeResult ─────────────────────────────────────────────────────────────

interface OptimizeResultProps {
  result: OptimizeResultData;
  onApply: () => void;
  applying: boolean;
  appliedCount: number;
}

function OptimizeResult({ result, onApply, applying, appliedCount }: OptimizeResultProps) {
  const { agents, overall_optimization_score, total_overprivileged, total_permission_gaps, verdict } = result;
  const agentList = Object.values(agents || {});
  const totalApprovalGates = agentList.reduce((s, a) => s + (a.approval_gates_needed?.length || 0), 0);

  const verdictColor =
    overall_optimization_score < 20
      ? "#16a34a"
      : overall_optimization_score < 50
      ? "#ea580c"
      : "#dc2626";

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        padding: 16,
        marginTop: 16,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          Permission check — what these agents need vs. what they have
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: verdictColor }}>{verdict}</span>
      </div>

      {/* Summary stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: total_overprivileged > 0 ? "#dc2626" : "#16a34a",
            }}
          >
            {total_overprivileged}
          </div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>Permissions not needed</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: total_permission_gaps > 0 ? "#ea580c" : "#16a34a",
            }}
          >
            {total_permission_gaps}
          </div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>Permissions missing</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: totalApprovalGates > 0 ? "#ca8a04" : "#16a34a",
            }}
          >
            {totalApprovalGates}
          </div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>Steps needing sign-off</div>
        </div>
        <Tooltip content={OVER_PERMISSION_METHODOLOGY}>
          <div style={{ textAlign: "center", cursor: "help" }}>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                color:
                  overall_optimization_score > 50
                    ? "#dc2626"
                    : overall_optimization_score > 20
                    ? "#ea580c"
                    : "#16a34a",
              }}
            >
              {overall_optimization_score}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280" }}>Excess-permission score</div>
          </div>
        </Tooltip>
      </div>

      {/* Per-agent cards */}
      {agentList.map((agent) => (
        <div
          key={agent.agent_id}
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              {agent.agent_name}
            </span>
            <span style={{ fontSize: 12, color: "#6b7280" }}>{agent.summary}</span>
          </div>

          {agent.overprivileged && agent.overprivileged.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "#dc2626",
                  marginBottom: 4,
                }}
              >
                Not needed for this workflow — block them
              </div>
              {agent.overprivileged.map((item, i) => (
                <div
                  key={i}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      ...(item.severity === "high"
                        ? { background: "#fef2f2", color: "#dc2626" }
                        : { background: "#fff7ed", color: "#ea580c" }),
                    }}
                  >
                    {item.severity?.toUpperCase()}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <code style={{ fontSize: 12, fontFamily: "monospace", color: "#1f2937" }}>
                      {item.action}
                    </code>
                    <span style={{ fontSize: 12, color: "#6b7280", marginLeft: 8 }}>
                      {item.reason}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "#fef2f2",
                      color: "#dc2626",
                    }}
                  >
                    BLOCK
                  </span>
                </div>
              ))}
            </div>
          )}

          {agent.permission_gaps && agent.permission_gaps.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "#ea580c",
                  marginBottom: 4,
                }}
              >
                Missing — the workflow needs these to run
              </div>
              {agent.permission_gaps.map((item, i) => (
                <div
                  key={i}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <code style={{ fontSize: 12, fontFamily: "monospace", color: "#1f2937" }}>
                      {item.action}
                    </code>
                    <span style={{ fontSize: 12, color: "#6b7280", marginLeft: 8 }}>
                      {item.reason}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "#fff7ed",
                      color: "#ea580c",
                    }}
                  >
                    REVIEW
                  </span>
                </div>
              ))}
            </div>
          )}

          {agent.approval_gates_needed && agent.approval_gates_needed.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--severity-high)",
                  marginBottom: 4,
                }}
              >
                Risky handoffs — add a human sign-off step
              </div>
              {agent.approval_gates_needed.map((chain, i) => (
                <div
                  key={i}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "#fefce8",
                      color: "#ca8a04",
                    }}
                  >
                    {chain.severity?.toUpperCase()}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "#1f2937" }}>
                      {chainShortLabel(chain.chain_id ?? chain.chain_name)}
                    </span>
                    <span style={{ fontSize: 12, color: "#6b7280", marginLeft: 8 }}>
                      {agent.agent_name} → {chain.to_agent} — a person approves before this handoff runs
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "#fefce8",
                      color: "#ca8a04",
                      whiteSpace: "nowrap",
                    }}
                  >
                    NEEDS APPROVAL
                  </span>
                </div>
              ))}
            </div>
          )}

          {!agent.overprivileged?.length &&
            !agent.permission_gaps?.length &&
            !agent.approval_gates_needed?.length && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "#16a34a",
                  fontWeight: 500,
                }}
              >
                <CheckCircle size={13} />
                Well-scoped for this workflow — no changes needed
              </div>
            )}
        </div>
      ))}

      {/* Apply button */}
      {(total_overprivileged > 0 || totalApprovalGates > 0) && (
        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
          {appliedCount > 0 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                color: "#16a34a",
                fontWeight: 500,
              }}
            >
              <CheckCircle size={14} />
              {appliedCount} polic{appliedCount !== 1 ? "ies" : "y"} applied
            </div>
          ) : (
            <button
              onClick={onApply}
              disabled={applying}
              style={{
                background: "var(--color-cta)",
                color: "var(--text-inverse)",
                padding: "8px 20px",
                borderRadius: "var(--radius-full)",
                fontSize: 13,
                fontWeight: 600,
                border: "none",
                cursor: applying ? "not-allowed" : "pointer",
                opacity: applying ? 0.5 : 1,
              }}
            >
              {applying
                ? "Applying..."
                : `Apply All Recommendations (${total_overprivileged + totalApprovalGates} policies)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── WorkflowResult ─────────────────────────────────────────────────────────────

interface WorkflowResultProps {
  result: WorkflowResultData;
  agentNames: Record<string, string>;
  agentColors: Record<string, string>;
  mode: "llm" | "dry";
}

function WorkflowResult({ result, agentNames, agentColors, mode }: WorkflowResultProps) {
  const { report, trace } = result;
  const steps = trace?.steps || [];

  const violations = report?.violations || [];
  const allChains = report?.chains_triggered || [];
  const crossChains = allChains.filter((c) => c.chain_id?.startsWith("cross-agent"));

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        padding: 16,
        marginTop: 16,
      }}
    >
      {/* Run mode */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: "var(--radius-full)",
            ...(mode === "llm"
              ? { background: "var(--accent-soft)", color: "var(--accent-ink)" }
              : { background: "var(--bg-sunken)", color: "#6b7280" }),
          }}
        >
          {mode === "llm" ? "Driven by Claude" : "Capability sweep — no LLM"}
        </span>
      </div>

      {/* Stats row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: violations.length > 0 ? "#dc2626" : "#16a34a",
            }}
          >
            {violations.length}
          </div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>Rules broken</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: allChains.length > 0 ? "#ea580c" : "#16a34a",
            }}
          >
            {allChains.length}
          </div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>Risky sequences</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>{steps.length}</div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>Steps taken</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: crossChains.length > 0 ? "#dc2626" : "#16a34a",
            }}
          >
            {crossChains.length}
          </div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>Risky handoffs</div>
        </div>
      </div>

      {/* Cross-agent chains */}
      {crossChains.length > 0 && (
        <div
          style={{
            marginBottom: 16,
            border: "1px solid #fecaca",
            borderRadius: "var(--radius-md)",
            padding: 12,
            background: "rgba(254,242,242,0.3)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: 8,
            }}
          >
            <Link2 size={14} style={{ color: "#dc2626" }} />
            Risky handoffs that happened in this test
          </div>
          {crossChains.map((c, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "6px 0 6px 8px",
                borderLeft: `2px solid ${c.severity === "critical" ? "#dc2626" : "#ea580c"}`,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: 4,
                  ...(c.severity === "critical"
                    ? { background: "#fef2f2", color: "#dc2626" }
                    : { background: "#fff7ed", color: "#ea580c" }),
                }}
              >
                {c.severity?.toUpperCase()}
              </span>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: "#1f2937" }}>
                  {chainShortLabel(c.chain_id ?? c.chain_name)}
                  {c.from_agent && c.to_agent && (
                    <span style={{ fontWeight: 400, color: "#6b7280" }}>
                      {" "}· {c.from_agent} → {c.to_agent}
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 12, color: "#6b7280" }}>
                  {chainNarrative(c.chain_id ?? c.chain_name)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Violations */}
      {violations.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "#9ca3af",
              marginBottom: 8,
            }}
          >
            Violations
          </div>
          {violations.slice(0, 5).map((v, i) => (
            <div
              key={i}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: "#fef2f2",
                  color: "#dc2626",
                }}
              >
                {v.severity?.toUpperCase() || "HIGH"}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-primary)" }}>{v.title || v.description}</span>
            </div>
          ))}
          {violations.length > 5 && (
            <span style={{ fontSize: 12, color: "#9ca3af" }}>+{violations.length - 5} more</span>
          )}
        </div>
      )}

      {/* Timeline */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "#9ca3af",
            marginBottom: 8,
          }}
        >
          What happened, step by step
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {steps.slice(0, 20).map((step, i) => {
            const stepAgentId = step.source_agent_id || step.agent_id || "";
            const decision = step.enforce_decision || step.decision;
            const color = agentColors[stepAgentId] || "#9ca3af";
            const agentName = agentNames[stepAgentId] || stepAgentId;
            const isBlocked = decision === "BLOCK";
            const isPending = decision === "REQUIRE_APPROVAL";
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 8px",
                  borderRadius: "var(--radius-md)",
                  fontSize: 12,
                  ...(isBlocked
                    ? { background: "#fef2f2", border: "1px solid #fecaca" }
                    : isPending
                    ? { background: "#fefce8", border: "1px solid #fef08a" }
                    : { background: "var(--bg-sunken)" }),
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: color,
                  }}
                />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: 140,
                    flexShrink: 0,
                  }}
                >
                  {agentName}
                </span>
                <span style={{ fontFamily: "monospace", color: "var(--text-primary)", flex: 1 }}>
                  {step.tool}.{step.action}
                </span>
                {isBlocked && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "#fecaca",
                      color: "#dc2626",
                    }}
                  >
                    BLOCKED
                  </span>
                )}
                {isPending && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "#fef08a",
                      color: "#ca8a04",
                    }}
                  >
                    PENDING
                  </span>
                )}
              </div>
            );
          })}
          {steps.length > 20 && (
            <div style={{ fontSize: 12, color: "#9ca3af", paddingLeft: 8 }}>
              +{steps.length - 20} more steps
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          borderTop: "1px solid var(--border)",
          paddingTop: 12,
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <Link
          to={`/sandbox/${result.simulation_id}`}
          style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", textDecoration: "none" }}
        >
          View Full Report
        </Link>
      </div>
    </div>
  );
}

// ── Main Workflows page ────────────────────────────────────────────────────────

export default function Workflows() {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [coordinatorId, setCoordinatorId] = useState("");
  const [specialistIds, setSpecialistIds] = useState<string[]>([]);
  const [customPrompt, setCustomPrompt] = useState("");

  const [analyzing, setAnalyzing] = useState(false);
  const [staticChains, setStaticChains] = useState<CrossAgentChain[] | null>(null);

  const [topPairings, setTopPairings] = useState<TopPairing[] | null>(null);
  const [pairingsLoading, setPairingsLoading] = useState(true);

  const [llmAvailable, setLlmAvailable] = useState(false);
  const [runMode, setRunMode] = useState<"llm" | "dry">("dry");

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WorkflowResultData | null>(null);

  const [optimizing, setOptimizing] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResultData | null>(null);
  const [workflowDesc, setWorkflowDesc] = useState("");
  const [applyingPolicies, setApplyingPolicies] = useState(false);
  const [appliedCount, setAppliedCount] = useState(0);

  const loadAgents = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    apiFetch<{ agents?: AgentData[] } | AgentData[]>("/api/authority/agents")
      .then((d) => {
        const list = (d as { agents?: AgentData[] }).agents || (Array.isArray(d) ? d : []);
        setAgents(list);
        if (list.length >= 1) setCoordinatorId(list[0].id);
        if (list.length >= 2) setSpecialistIds([list[1].id]);
      })
      // Don't render the "you need at least 2 agents" onboarding on an outage.
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  // Fleet-wide auto-scan: the riskiest agent pairings, before any selection.
  useEffect(() => {
    apiFetch<{ pairings: TopPairing[] }>("/api/workflows/top-pairings")
      .then((d) => setTopPairings(d.pairings || []))
      .catch(() => setTopPairings([]))
      .finally(() => setPairingsLoading(false));
  }, []);

  // LLM-driven simulation is only possible when the backend has an API key.
  useEffect(() => {
    apiFetch<{ llm_available?: boolean }>("/api/demo-mode", { skipLogoutOn401: true })
      .then((d) => setLlmAvailable(!!d.llm_available))
      .catch(() => {});
  }, []);

  const allAgentIds = coordinatorId
    ? [coordinatorId, ...specialistIds.filter((id) => id !== coordinatorId)]
    : [];

  // Invalidate stale results whenever the team MEMBERSHIP changes (not just when
  // it empties). Otherwise analyzing team [A,B] then switching to [A,C] left the
  // old [A,B] chains/optimize output on screen — looking like the page ignored
  // the change. Keyed on the sorted id list so any add/remove/swap clears.
  const teamKey = [...allAgentIds].sort().join(',');
  useEffect(() => {
    setStaticChains(null);
    setResult(null);
    setOptimizeResult(null);
  }, [teamKey]);

  // Stable color/name maps per agent
  const agentColors: Record<string, string> = {};
  const agentNames: Record<string, string> = {};
  allAgentIds.forEach((id, i) => {
    agentColors[id] = AGENT_COLORS[i % AGENT_COLORS.length];
    const a = agents.find((x) => x.id === id);
    if (a) agentNames[id] = a.name;
  });

  const runAnalysis = async (ids: string[]) => {
    setAnalyzing(true);
    setStaticChains(null);
    setResult(null);
    const idSet = new Set(ids);
    try {
      // Canonical detection lives on the backend; filter the fleet-wide result
      // to the selected agents.
      const data = await apiFetch<{ chains: CrossAgentChain[] }>(
        "/api/authority/cross-agent-chains",
      );
      const chains = (data.chains || []).filter(
        (c) => idSet.has(c.from_agent_id || "") && idSet.has(c.to_agent_id || ""),
      );
      setStaticChains(chains);
    } catch {
      toast("Couldn't analyze cross-agent chains.", "error");
      setStaticChains([]);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleAnalyze = () => {
    if (allAgentIds.length < 2) {
      toast("Pick a lead agent and at least one agent it works with.", "error");
      return;
    }
    runAnalysis(allAgentIds);
  };

  // Clicking a top pairing pre-fills the selection (first agent leads) and
  // runs the same analysis path immediately.
  const handlePairingClick = (p: TopPairing) => {
    const [first, second] = p.agents;
    if (!first || !second) return;
    setCoordinatorId(first.id);
    setSpecialistIds([second.id]);
    runAnalysis([first.id, second.id]);
  };

  const handleOptimize = async () => {
    if (allAgentIds.length < 2) {
      toast("Pick a lead agent and at least one agent it works with.", "error");
      return;
    }
    if (!workflowDesc.trim()) {
      toast("Describe what this workflow does so Arceo can analyze permissions.", "error");
      return;
    }
    setOptimizing(true);
    setOptimizeResult(null);
    setAppliedCount(0);   // a fresh optimize run must re-enable the Apply button
    try {
      const data = await apiFetch<OptimizeResultData>("/api/workflows/optimize", {
        method: "POST",
        body: JSON.stringify({
          agent_ids: allAgentIds,
          coordinator_id: coordinatorId,
          workflow_description: workflowDesc,
          dry_run: true,
        }),
      });
      setOptimizeResult(data);
    } catch (err: unknown) {
      toast("Optimization failed: " + (err instanceof Error ? err.message : "Unknown error"), "error");
    }
    setOptimizing(false);
  };

  const applyAllRecommendations = async () => {
    if (!optimizeResult) return;
    setApplyingPolicies(true);
    let count = 0;
    let failed = 0;
    const seen = new Set<string>(); // dedupe identical (agent, pattern, effect)
    // The policies endpoint expects {action_pattern, effect} — the old
    // {tool, action, decision} body 422'd and the empty catch hid it, so this
    // "applied N" toast used to be a lie. Post the real schema and surface fails.
    const createPolicy = async (agentId: string, action_pattern: string, effect: string, reason: string) => {
      const dedupeKey = `${agentId}|${action_pattern}|${effect}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      try {
        await apiFetch(`/api/authority/agent/${agentId}/policies`, {
          method: "POST",
          body: JSON.stringify({ action_pattern, effect, reason }),
        });
        count++;
      } catch {
        failed++;
      }
    };
    for (const [agentId, analysis] of Object.entries(optimizeResult.agents)) {
      for (const item of analysis.overprivileged || []) {
        await createPolicy(agentId, item.action, "BLOCK", `Auto-generated: ${item.reason}`);
      }
      for (const gate of analysis.approval_gates_needed || []) {
        // Scope the gate to the specific actions that begin the chain — a bare
        // "*" pattern is never matched by the enforcer, so the old gate was inert.
        for (const pattern of gate.action_patterns || []) {
          await createPolicy(agentId, pattern, "REQUIRE_APPROVAL", `Auto-generated: Cross-agent chain gate — ${gate.chain_name}`);
        }
      }
    }
    setAppliedCount(count);
    setApplyingPolicies(false);
    if (failed > 0) {
      toast(`Applied ${count} recommendation${count !== 1 ? "s" : ""}, ${failed} failed`, "error");
    } else {
      toast(`Applied ${count} policy recommendation${count !== 1 ? "s" : ""}`);
    }
  };

  const handleSimulate = async () => {
    if (allAgentIds.length < 2) {
      toast("Pick a lead agent and at least one agent it works with.", "error");
      return;
    }
    if (!customPrompt.trim()) {
      toast("Enter a scenario prompt to simulate.", "error");
      return;
    }
    setRunning(true);
    setResult(null);
    const simulate = (dry: boolean) =>
      apiFetch<WorkflowResultData>("/api/sandbox/simulate/multi", {
        method: "POST",
        body: JSON.stringify({
          agent_ids: allAgentIds,
          coordinator_id: coordinatorId,
          custom_prompt: customPrompt,
          dry_run: dry,
        }),
      });
    try {
      const data = await simulate(!llmAvailable);
      setRunMode(llmAvailable ? "llm" : "dry");
      setResult(data);
    } catch (err: unknown) {
      if (llmAvailable) {
        // Key may have gone away since page load — fall back to the dry sweep.
        try {
          const data = await simulate(true);
          setRunMode("dry");
          setResult(data);
          toast("LLM run unavailable — ran the capability sweep instead.", "error");
        } catch (err2: unknown) {
          toast("Simulation failed: " + (err2 instanceof Error ? err2.message : "Unknown error"), "error");
        }
      } else {
        toast("Simulation failed: " + (err instanceof Error ? err.message : "Unknown error"), "error");
      }
    }
    setRunning(false);
  };

  // One multi-select over the existing two state variables: the first
  // selection is the lead (coordinatorId), everyone after is a specialist.
  // Deselecting the lead promotes the earliest remaining selection.
  const toggleAgent = (id: string) => {
    if (id === coordinatorId) {
      const [next, ...rest] = specialistIds;
      setCoordinatorId(next || "");
      setSpecialistIds(rest);
    } else if (specialistIds.includes(id)) {
      setSpecialistIds((prev) => prev.filter((x) => x !== id));
    } else if (!coordinatorId) {
      setCoordinatorId(id);
    } else {
      setSpecialistIds((prev) => [...prev, id]);
    }
  };

  const textareaStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--bg-sunken)",
    border: "2px solid transparent",
    borderRadius: 16,
    fontSize: 12,
    padding: 10,
    color: "var(--text-primary)",
    outline: "none",
    resize: "none",
    boxSizing: "border-box",
    fontFamily: "inherit",
  };

  if (loading) {
    return (
      <div style={{ padding: 24, background: "var(--bg-card)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: 192,
          }}
        >
          <div
            style={{
              width: 24,
              height: 24,
              border: "2px solid var(--border-strong)",
              borderTopColor: "var(--color-cta)",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }}
          />
        </div>
      </div>
    );
  }

  if (loadError) {
    return <div style={{ padding: 40 }}><ErrorState message={loadError} onRetry={loadAgents} /></div>;
  }

  if (agents.length < 2) {
    return (
      <div style={{ padding: 24, background: "var(--bg-card)" }}>
        <Link to="/" style={{ fontSize: 13, color: "#6b7280", textDecoration: "none" }}>
          ← All Agents
        </Link>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: 288,
            textAlign: "center",
            marginTop: 32,
          }}
        >
          <Link2 size={32} style={{ color: "var(--border)", marginBottom: 16 }} />
          <h2 style={{ fontSize: 17, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
            Multi-Agent Workflows
          </h2>
          <p style={{ fontSize: 13, color: "#6b7280", maxWidth: 360, marginBottom: 24 }}>
            You need at least 2 agents to define a workflow. Arceo will analyze cross-agent risk
            chains — actions one agent takes that enable another to cause harm.
          </p>
          <Link
            to="/?connect=true"
            style={{
              background: "var(--color-cta)",
              color: "var(--text-inverse)",
              padding: "8px 20px",
              borderRadius: "var(--radius-full)",
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Add an Agent
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, background: "var(--bg-card)" }}>
      {/* Back link */}
      <Link to="/" style={{ fontSize: 13, color: "#6b7280", textDecoration: "none" }}>
        ← All Agents
      </Link>

      {/* Header */}
      <div style={{ marginTop: 16, marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
          Multi-Agent Workflows
        </h1>
        <p style={{ fontSize: 13, color: "#6b7280", marginTop: 4, marginBottom: 0 }}>
          Some risks only appear when agents work together — one agent's output becomes another's
          dangerous input. Pick the agents, find those handoffs, then test the workflow safely.
        </p>
      </div>

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        {/* ── Left: Agent picker ── */}
        <div
          style={{
            width: 320,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {/* Agent team picker */}
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              padding: 16,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "#9ca3af",
                marginBottom: 2,
              }}
            >
              Test a team of agents
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>
              Select 2 or more agents. The first one you pick leads the workflow.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {agents.map((a) => {
                const isSelected = allAgentIds.includes(a.id);
                const isLead = a.id === coordinatorId;
                return (
                  <button
                    key={a.id}
                    onClick={() => toggleAgent(a.id)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: "var(--radius-md)",
                      border: `1px solid ${isSelected ? "var(--accent)" : "var(--border)"}`,
                      background: isSelected ? "var(--accent-soft)" : "#ffffff",
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    {isSelected ? (
                      <CheckSquare size={15} style={{ color: "var(--accent)", flexShrink: 0 }} />
                    ) : (
                      <Square size={15} style={{ color: "#d1d5db", flexShrink: 0 }} />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          fontSize: 12,
                          fontWeight: 500,
                          color: "var(--text-primary)",
                        }}
                      >
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {a.name}
                        </span>
                        {isLead && (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              letterSpacing: "0.05em",
                              padding: "1px 5px",
                              borderRadius: 4,
                              background: "var(--accent)",
                              color: "#ffffff",
                              flexShrink: 0,
                            }}
                          >
                            LEAD
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "#9ca3af",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {a.description || (a.tools || []).join(", ")}
                      </div>
                    </div>
                    <RiskPill score={a.blast_radius?.score || 0} />
                  </button>
                );
              })}
            </div>
            <button
              onClick={handleAnalyze}
              disabled={allAgentIds.length < 2 || analyzing}
              style={{
                width: "100%",
                marginTop: 12,
                background: "var(--color-cta)",
                color: "var(--text-inverse)",
                padding: "10px 20px",
                borderRadius: "var(--radius-full)",
                fontSize: 13,
                fontWeight: 600,
                border: "none",
                cursor: allAgentIds.length < 2 || analyzing ? "not-allowed" : "pointer",
                opacity: allAgentIds.length < 2 || analyzing ? 0.5 : 1,
              }}
            >
              {analyzing
                ? "Checking…"
                : `Find risky handoffs (${allAgentIds.length} agent${
                    allAgentIds.length === 1 ? "" : "s"
                  } selected)`}
            </button>
          </div>

          {/* Optimize panel */}
          {allAgentIds.length >= 2 && (
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "#9ca3af",
                    marginBottom: 2,
                  }}
                >
                  Right-size the permissions
                </div>
                <div style={{ fontSize: 12, color: "#6b7280" }}>
                  Describe what this workflow is supposed to do. Arceo flags the permissions these
                  agents don't need for it — and any they're missing.
                </div>
              </div>
              <textarea
                style={textareaStyle}
                value={workflowDesc}
                onChange={(e) => setWorkflowDesc(e.target.value)}
                placeholder={`Example: "Handle customer refund requests — look up order, check eligibility, issue refund if under $500, escalate otherwise."`}
                rows={3}
                onFocus={(e) => {
                  (e.target as HTMLTextAreaElement).style.borderColor = "var(--border-focus)";
                }}
                onBlur={(e) => {
                  (e.target as HTMLTextAreaElement).style.borderColor = "transparent";
                }}
              />
              <button
                onClick={handleOptimize}
                disabled={optimizing || !workflowDesc.trim()}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "var(--color-cta)",
                  color: "var(--text-inverse)",
                  padding: "10px 20px",
                  borderRadius: "var(--radius-lg)",
                  fontSize: 13,
                  fontWeight: 600,
                  border: "none",
                  whiteSpace: "nowrap",
                  cursor: optimizing || !workflowDesc.trim() ? "not-allowed" : "pointer",
                  opacity: optimizing || !workflowDesc.trim() ? 0.5 : 1,
                }}
              >
                {optimizing ? "Checking permissions…" : "Check the permissions"}
              </button>
            </div>
          )}
        </div>

        {/* ── Right: Results ── */}
        <div
          style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}
        >
          {/* Static chain analysis */}
          {staticChains !== null && (
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                padding: 16,
              }}
            >
              {allAgentIds.length >= 2 && (() => {
                const max = Math.max(
                  ...allAgentIds.map((id) => agents.find((a) => a.id === id)?.blast_radius?.score || 0)
                );
                const avg = Math.round(
                  allAgentIds.reduce(
                    (s, id) => s + (agents.find((a) => a.id === id)?.blast_radius?.score || 0),
                    0
                  ) / allAgentIds.length
                );
                const combined = Math.min(100, Math.round(max * 0.6 + avg * 0.4 + allAgentIds.length * 3));
                return (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 12,
                      borderBottom: "1px solid var(--border)",
                      paddingBottom: 12,
                      marginBottom: 12,
                    }}
                  >
                    <Tooltip content={RISK_SCORE_METHODOLOGY}>
                      <span
                        style={{
                          fontSize: 32,
                          fontWeight: 700,
                          lineHeight: 1,
                          color: blastColor(combined),
                          cursor: "help",
                        }}
                      >
                        {combined}
                      </span>
                    </Tooltip>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                        {blastLabel(combined)} when these agents act together
                        {combined > max ? " — each is safer on its own" : ""}
                      </div>
                      <div style={{ fontSize: 12, color: "#9ca3af" }}>
                        Based on what they can do — before anything runs
                      </div>
                    </div>
                  </div>
                );
              })()}

              {staticChains.length === 0 ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                    color: "#16a34a",
                    fontWeight: 500,
                  }}
                >
                  <CheckCircle size={14} />
                  No risky handoffs found — nothing one of these agents does enables another to
                  cause harm.
                </div>
              ) : (
                <>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      marginBottom: 16,
                    }}
                  >
                    {staticChains.map((c, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 8,
                          padding: "6px 0 6px 12px",
                          borderLeft: `2px solid ${c.severity === "critical" ? "#dc2626" : "#ea580c"}`,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: "2px 6px",
                            borderRadius: 4,
                            flexShrink: 0,
                            ...(c.severity === "critical"
                              ? { background: "#fef2f2", color: "#dc2626" }
                              : { background: "#fff7ed", color: "#ea580c" }),
                          }}
                        >
                          {c.severity?.toUpperCase()}
                        </span>
                        <span style={{ fontSize: 12.5, color: "var(--text-primary)", lineHeight: 1.5 }}>
                          <strong>{c.from_agent}</strong> {LABEL_PHRASE[c.from_label] || c.from_label}{" "}
                          → <strong>{c.to_agent}</strong> {LABEL_PHRASE[c.to_label] || c.to_label} —
                          with no approval in between.
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Simulate section — available whether or not handoffs were found */}
              <div
                    style={{
                      borderTop: "1px solid var(--border)",
                      paddingTop: 16,
                      marginTop: 16,
                      display: "flex",
                      flexDirection: "column",
                      gap: 12,
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          color: "#9ca3af",
                          marginBottom: 2,
                        }}
                      >
                        Test it with a scenario
                      </div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>
                        {llmAvailable
                          ? "Describe a task in plain English. Claude runs your agents against simulated tools — nothing real happens — and Arceo enforces your policies on every step."
                          : "Describe a task in plain English. Arceo plays it out across these agents with simulated tools — nothing real happens — and shows you every step."}
                      </div>
                    </div>
                    <textarea
                      style={textareaStyle}
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      placeholder={`Describe a scenario to simulate across ${allAgentIds.length} agents...\n\nExample: "Process a bulk refund for customers affected by the outage, then notify the team and update all records."`}
                      rows={4}
                      onFocus={(e) => {
                        (e.target as HTMLTextAreaElement).style.borderColor = "var(--border-focus)";
                      }}
                      onBlur={(e) => {
                        (e.target as HTMLTextAreaElement).style.borderColor = "transparent";
                      }}
                    />
                    <button
                      onClick={handleSimulate}
                      disabled={running || !customPrompt.trim()}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        background: "var(--color-cta)",
                        color: "var(--text-inverse)",
                        padding: "8px 20px",
                        borderRadius: "var(--radius-full)",
                        fontSize: 13,
                        fontWeight: 600,
                        border: "none",
                        cursor: running || !customPrompt.trim() ? "not-allowed" : "pointer",
                        opacity: running || !customPrompt.trim() ? 0.5 : 1,
                        width: "fit-content",
                      }}
                    >
                      <span>
                        {running
                          ? llmAvailable
                            ? "Claude is running the workflow…"
                            : "Running the test…"
                          : "Run a safe test"}
                      </span>
                      {!running && (
                        <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 400 }}>
                          {llmAvailable
                            ? "Claude-driven · nothing real happens"
                            : "simulated · nothing real happens"}
                        </span>
                      )}
                    </button>
                  </div>
            </div>
          )}

          {/* Optimize result */}
          {optimizeResult && (
            <OptimizeResult
              result={optimizeResult}
              onApply={applyAllRecommendations}
              applying={applyingPolicies}
              appliedCount={appliedCount}
            />
          )}

          {/* Simulation result */}
          {result && (
            <WorkflowResult
              result={result}
              agentNames={agentNames}
              agentColors={agentColors}
              mode={runMode}
            />
          )}

          {/* Default state: auto-detected riskiest pairings; skeleton while
              loading; instructional fallback on error / empty fleet */}
          {staticChains === null && !result && !optimizeResult && pairingsLoading && (
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                padding: 16,
              }}
            >
              <div style={{ height: 13, width: 220, background: "var(--bg-sunken)", borderRadius: 6, marginBottom: 8 }} />
              <div style={{ height: 11, width: 280, background: "var(--bg-sunken)", borderRadius: 6, marginBottom: 16 }} />
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    height: 68,
                    background: "var(--bg-sunken)",
                    borderRadius: "var(--radius-md)",
                    marginBottom: 8,
                  }}
                />
              ))}
            </div>
          )}

          {staticChains === null && !result && !optimizeResult && !pairingsLoading &&
            topPairings && topPairings.length > 0 && (
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                padding: 16,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                Riskiest combinations in your fleet
              </div>
              <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>
                Detected automatically — no setup needed.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {topPairings.map((p, i) => {
                  const worst = p.chains[0];
                  const more = p.chains.length - 1;
                  return (
                    <button
                      key={i}
                      onClick={() => handlePairingClick(p)}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                        width: "100%",
                        textAlign: "left",
                        padding: "10px 12px",
                        borderRadius: "var(--radius-md)",
                        border: "1px solid var(--border)",
                        background: "#ffffff",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: 4,
                          flexShrink: 0,
                          marginTop: 1,
                          ...(p.severity === "critical"
                            ? { background: "#fef2f2", color: "#dc2626" }
                            : { background: "#fff7ed", color: "#ea580c" }),
                        }}
                      >
                        {p.severity === "critical" ? "CRITICAL" : "HIGH"}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                          {p.agents[0]?.name} + {p.agents[1]?.name}
                        </div>
                        {worst && (
                          <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.5 }}>
                            {worst.description}
                          </div>
                        )}
                        {more > 0 && (
                          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                            +{more} more chain{more !== 1 ? "s" : ""}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {staticChains === null && !result && !optimizeResult && !pairingsLoading &&
            (!topPairings || topPairings.length === 0) && (
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                padding: 32,
                textAlign: "center",
              }}
            >
              <Link2 size={32} style={{ color: "var(--border)", margin: "0 auto 16px" }} />
              <p
                style={{
                  fontSize: 13,
                  color: "#6b7280",
                  maxWidth: 400,
                  margin: "0 auto 24px",
                }}
              >
                Select 2 or more agents on the left, then find the risky handoffs between them —
                for example:
              </p>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  textAlign: "left",
                  maxWidth: 360,
                  margin: "0 auto",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "#fef2f2",
                      color: "#dc2626",
                      whiteSpace: "nowrap",
                    }}
                  >
                    CRITICAL
                  </span>
                  <span style={{ color: "var(--text-secondary)" }}>
                    Support agent reads PII → Finance agent issues refund without approval
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "#fff7ed",
                      color: "#ea580c",
                      whiteSpace: "nowrap",
                    }}
                  >
                    HIGH
                  </span>
                  <span style={{ color: "var(--text-secondary)" }}>
                    DevOps agent changes production → Notifier agent broadcasts externally
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
