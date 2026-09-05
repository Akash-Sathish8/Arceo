/**
 * Slide-over agent detail drawer from the design handoff
 * (`app/AgentDrawer.jsx`). Mirrors the detail page: stat row, worst-case
 * callout, capability breakdown, derived risk-chain list, spend footer.
 *
 * Replaces the route-based `/agent/:id` navigation for the new Agents
 * landing — clicking a card opens this drawer instead.
 */

import { useEffect, useRef, useState } from "react";
import { X, FlaskConical, AlertTriangle, Lock, Link2, TrendingUp, DollarSign } from "lucide-react";
import { Link } from "react-router-dom";
import { apiFetch } from "@/lib/api";
import RiskRing from "@/components/shared/RiskRing";
import {
  band,
  CapBars,
  fmtMoney,
  fmtTool,
  type AgentCardData,
} from "@/components/agents/AgentCard";
import { chainNarrative } from "@/lib/chainLabels";
import { riskLabelName } from "@/lib/utils";

interface BlastRadius {
  score: number;
  total_actions: number;
  irreversible_actions: number;
  moves_money: number;
  touches_pii: number;
  deletes_data: number;
  sends_external: number;
  changes_production: number;
  changes_access?: number;
  reads_secrets?: number;
  evades_detection?: number;
  bulk_export?: number;
  executes_code?: number;
}

interface Chain {
  id: string;
  name?: string;
  chain_name?: string;
  severity: "critical" | "high" | "medium";
  description?: string;
  steps?: string[];
  from_label?: string;
  to_label?: string;
}

interface AgentDetailResponse {
  agent: {
    id: string;
    name: string;
    description: string;
    tools?: Array<{ name: string; service?: string }>;
  };
  blast_radius: BlastRadius;
  chains: Chain[];
  policies: Array<{ id: string }>;
}

interface AgentDrawerProps {
  agent: AgentCardData | null;
  onClose: () => void;
  onSimulate?: (agentId: string) => void;
}

interface StatCellProps {
  label: string;
  value: React.ReactNode;
  color?: string;
}

function StatCell({ label, value, color }: StatCellProps): React.ReactElement {
  return (
    <div style={{ flex: 1, textAlign: "center", padding: "2px 4px" }}>
      <div
        className="mono"
        style={{ fontSize: 24, fontWeight: 600, color: color ?? "var(--ink-900)", letterSpacing: -0.5 }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-500)", marginTop: 5, lineHeight: 1.2 }}>
        {label}
      </div>
    </div>
  );
}

interface ChainRowProps {
  chain: Chain;
}

function ChainRow({ chain }: ChainRowProps): React.ReactElement {
  const sev = chain.severity === "critical" ? "critical" : chain.severity === "high" ? "warning" : "safe";
  const sevColor =
    sev === "critical" ? "var(--critical)" : sev === "warning" ? "var(--caution)" : "var(--safe)";
  const sevBg =
    sev === "critical" ? "var(--critical-bg)" : sev === "warning" ? "var(--caution-bg)" : "var(--safe-bg)";

  const steps = chain.steps && chain.steps.length > 0
    ? chain.steps
    : [chain.from_label, chain.to_label].filter(Boolean) as string[];
  const title =
    chain.description ||
    chainNarrative(chain.id ?? chain.chain_name) ||
    chain.name ||
    "Risk chain";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 2px",
        borderBottom: "1px solid var(--line-soft)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: sevColor,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, color: "var(--ink-800)", fontWeight: 500 }}>{title}</div>
        {steps.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}>
            {steps.map((step, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                {i > 0 && <span style={{ color: "var(--ink-300)", fontSize: 12 }}>→</span>}
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--ink-600)" }}>
                  <span style={{ width: 6, height: 6, borderRadius: 2, background: "var(--ink-300)" }} />
                  {riskLabelName(step)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: sevColor,
          background: sevBg,
          borderRadius: 5,
          padding: "3px 8px",
        }}
      >
        {chain.severity}
      </span>
    </div>
  );
}

export default function AgentDrawer({
  agent,
  onClose,
  onSimulate,
}: AgentDrawerProps): React.ReactElement | null {
  const lastRef = useRef<AgentCardData | null>(null);
  if (agent) lastRef.current = agent;
  const a = agent ?? lastRef.current;
  const open = !!agent;

  const [chains, setChains] = useState<Chain[] | null>(null);
  const [, setBlast] = useState<BlastRadius | null>(null);
  const [policiesLen, setPoliciesLen] = useState<number | null>(null);
  const [tools, setTools] = useState<string[] | null>(null);
  const [detailError, setDetailError] = useState(false);

  // Fetch the richer detail payload when the drawer opens for an agent.
  // The card's data is enough to render the header; chains + policy count
  // come from /api/authority/agent/{id}. Reset first so opening agent B never
  // flashes agent A's chains/policies/tools while B's fetch is in flight.
  const agentId = agent?.id;
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setChains(null);
    setPoliciesLen(null);
    setTools(null);
    setDetailError(false);
    apiFetch<AgentDetailResponse>(`/api/authority/agent/${agentId}`)
      .then((d) => {
        if (cancelled) return;
        setBlast(d.blast_radius);
        setChains(d.chains ?? []);
        setPoliciesLen(d.policies?.length ?? 0);
        if (d.agent.tools) {
          const services = Array.from(new Set(d.agent.tools.map((t) => t.service ?? t.name)));
          setTools(services);
        }
      })
      .catch(() => {
        if (!cancelled) setDetailError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll while the drawer is open so the page behind doesn't move.
  useEffect(() => {
    if (!agent) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [agent]);

  if (!a) return null;

  const b = band(a.score, a.critical, a.band);
  const unguarded = (policiesLen ?? a.policies) === 0;
  const toolList = tools ?? a.tools;

  return (
    <>
      {/* Centred, and in the same shell as the Configure Simulation dialog —
          same scrim, same header band / body / footer bands, same type ramp.
          It used to slide in from the right, which made two dialogs in one
          product behave like two different products. */}
      <div
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto"
        style={{
          background: "rgba(30, 40, 54, 0.5)",
          backdropFilter: "blur(2px)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity .2s ease",
        }}
      >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={a ? `${a.name} details` : "Agent details"}
        aria-hidden={!open}
        // inert removes the panel from tab order + AT when closed.
        inert={!open}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-surface-container-lowest border border-neutral-border rounded-lg flex flex-col my-auto outline-none font-body"
        style={{
          maxHeight: "calc(100vh - 2rem)",
          boxShadow: "0 4px 24px rgba(30, 40, 54, 0.08), 0 1px 2px rgba(15,15,15,0.03)",
          transform: open ? "scale(1)" : "scale(.98)",
          transition: "transform .2s cubic-bezier(.22,.61,.36,1)",
        }}
      >
        {/* Header band */}
        <div className="px-8 pt-8 pb-6 border-b border-neutral-border shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-page-title font-page-title text-on-surface mb-2 tracking-tight m-0">
                {a.name}
              </h2>
              <p className="text-body font-body text-neutral-secondary leading-relaxed m-0">
                {a.description}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 -mt-1 -mr-2 p-2 rounded-lg bg-transparent border-0 cursor-pointer text-neutral-muted hover:text-on-surface hover:bg-surface-container-low transition-colors"
            >
              <X size={18} strokeWidth={1.8} />
            </button>
          </div>
        </div>

        <div className="p-8 overflow-y-auto">
          {/* Services + score. Name and description live in the header band. */}
          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="stat-block__label mb-2">Services</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {toolList.map((t) => (
                  <span
                    key={t}
                    style={{
                      fontSize: 12,
                      color: "var(--ink-600)",
                      background: "#fff",
                      border: "1px solid var(--line)",
                      borderRadius: 6,
                      padding: "3px 9px",
                    }}
                  >
                    {fmtTool(t)}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <RiskRing value={a.score} size={84} stroke={6} color={b.ring} label={Math.round(a.score)} />
              <div style={{ textAlign: "center", whiteSpace: "nowrap" }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-700)" }}>Risk score</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: b.color }}>{b.label}</div>
              </div>
            </div>
          </div>

          {/* Stat row */}
          <div
            style={{
              display: "flex",
              background: "#fff",
              border: "1px solid var(--line)",
              borderRadius: 12,
              padding: "18px 8px",
              marginTop: 22,
              boxShadow: "var(--shadow-card-new)",
            }}
          >
            <StatCell label="Total actions" value={a.actions} />
            <div style={{ width: 1, background: "var(--line)" }} />
            <StatCell label="Touch PII" value={a.caps.pii ?? 0} />
            <div style={{ width: 1, background: "var(--line)" }} />
            <StatCell label="Delete data" value={a.caps.delete ?? 0} />
            <div style={{ width: 1, background: "var(--line)" }} />
            <StatCell label="Send external" value={a.caps.external ?? 0} />
            <div style={{ width: 1, background: "var(--line)" }} />
            <StatCell label="Irreversible" value={a.irreversible} color="var(--ink-900)" />
          </div>

          {/* Unclassifiable actions — they score 0 while their true risk is
              unknown; hiding that would be false assurance. */}
          {(a.unclassified ?? 0) > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 12,
                fontSize: 12,
                color: "var(--ink-600)",
                lineHeight: 1.4,
              }}
            >
              <AlertTriangle size={13} strokeWidth={1.8} style={{ flexShrink: 0, color: "var(--caution)" }} />
              {a.unclassified} unverified {a.unclassified === 1 ? "action" : "actions"} with no classifiable risk
              signal; scores may understate exposure. Review on the agent page.
            </div>
          )}

          {/* Worst-case callout */}
          {(unguarded || a.critical > 0) && (
            <div
              style={{
                background: "var(--caution-bg)",
                border: "1px solid var(--caution-line)",
                borderRadius: 12,
                padding: 18,
                marginTop: 18,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13.5,
                  fontWeight: 700,
                  color: "#8a5a12",
                  whiteSpace: "nowrap",
                }}
              >
                <AlertTriangle size={16} strokeWidth={1.8} /> Worst-case scenario
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  fontSize: 13,
                  color: "var(--ink-700)",
                  marginTop: 12,
                  lineHeight: 1.5,
                }}
              >
                <Lock size={14} strokeWidth={1.8} style={{ position: "relative", top: 2, flexShrink: 0 }} />
                <span>
                  <b className="mono" style={{ color: "var(--ink-900)" }}>{a.irreversible}</b> irreversible actions that cannot be undone once they run.
                </span>
              </div>
              {a.critical > 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    fontSize: 13,
                    color: "var(--ink-700)",
                    marginTop: 8,
                    lineHeight: 1.5,
                  }}
                >
                  <Link2 size={14} strokeWidth={1.8} style={{ position: "relative", top: 2, flexShrink: 0 }} />
                  <span>
                    <b className="mono" style={{ color: "var(--critical)" }}>{a.critical}</b> critical chains detected
                    {unguarded ? ", and no policy is set." : "."}
                  </span>
                </div>
              )}
              <div style={{ display: "flex", gap: 9, marginTop: 16 }}>
                <Link
                  to={`/agent/${a.id}#policies`}
                  className="ag-btn"
                  style={{
                    display: "inline-flex", alignItems: "center",
                    background: "var(--ink-900)",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    padding: "9px 15px",
                    fontSize: 13,
                    fontWeight: 550,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    textDecoration: "none",
                  }}
                >
                  Add policy
                </Link>
                <button
                  type="button"
                  className="ag-btn"
                  onClick={() => onSimulate?.(a.id)}
                  style={{
                    background: "#fff",
                    color: "var(--ink-800)",
                    border: "1px solid var(--line)",
                    borderRadius: 8,
                    padding: "9px 15px",
                    fontSize: 13,
                    fontWeight: 550,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                >
                  Simulate worst case
                </button>
              </div>
            </div>
          )}

          {/* Capability breakdown */}
          <div style={{ marginTop: 24 }}>
            <h3 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 600, color: "var(--ink-900)" }}>
              Capability breakdown
            </h3>
            <div
              style={{
                background: "#fff",
                border: "1px solid var(--line)",
                borderRadius: 12,
                padding: "18px 20px",
                boxShadow: "var(--shadow-card-new)",
              }}
            >
              <CapBars caps={a.caps} gap={11} showZeros={false} />
            </div>
          </div>

          {/* Risk chains */}
          <div style={{ marginTop: 24 }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: 6,
              }}
            >
              <h3
                style={{
                  margin: 0,
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--ink-900)",
                  whiteSpace: "nowrap",
                }}
              >
                Risk chains{" "}
                <span className="mono" style={{ color: "var(--ink-400)", fontWeight: 500 }}>
                  {chains?.length ?? a.chains}
                </span>
              </h3>
              {a.critical > 0 && (
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--critical)", whiteSpace: "nowrap" }}>
                  {a.critical} critical
                </span>
              )}
            </div>
            {chains && chains.length > 0 ? (
              <div
                style={{
                  background: "#fff",
                  border: "1px solid var(--line)",
                  borderRadius: 12,
                  padding: "4px 20px",
                  boxShadow: "var(--shadow-card-new)",
                }}
              >
                {chains.map((c) => (
                  <ChainRow key={c.id} chain={c} />
                ))}
              </div>
            ) : (
              <div
                style={{
                  background: "#fff",
                  border: "1px solid var(--line)",
                  borderRadius: 12,
                  padding: "24px 20px",
                  textAlign: "center",
                  fontSize: 13,
                  color: "var(--ink-500)",
                  boxShadow: "var(--shadow-card-new)",
                }}
              >
                {detailError
                  ? "We couldn't load the chains. Reopen to try again."
                  : chains === null
                  ? "Loading chains…"
                  : "No dangerous chains detected."}
              </div>
            )}
          </div>

          {/* Spend footer */}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              borderTop: "1px solid var(--line)",
              marginTop: 26,
              paddingTop: 18,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  color: "var(--ink-400)",
                }}
              >
                Est. spend / mo
              </div>
              {a.spend !== null && (
                <div style={{ fontSize: 12, color: "var(--ink-400)", marginTop: 3 }}>
                  {/* Was hardcoded "pre-deployment estimate", which contradicted
                      the fleet list as soon as an agent showed observed traffic. */}
                  {a.deploymentState === "deployed"
                    ? `from ${a.liveCalls7d ? `${a.liveCalls7d.toLocaleString()} captured calls` : "observed traffic"}`
                    : "pre-deployment estimate"}
                </div>
              )}
            </div>
            {a.spend !== null ? (
              <span
                className="mono"
                style={{ fontSize: 30, fontWeight: 600, color: "var(--ink-900)", letterSpacing: -0.8 }}
              >
                {fmtMoney(a.spend)}
              </span>
            ) : (
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--accent)" }}>
                Run a simulation to generate
              </span>
            )}
          </div>
        </div>

        {/* Footer band */}
        <div className="px-8 py-5 border-t border-neutral-border bg-neutral-sunken flex items-center justify-end gap-3 rounded-b-lg shrink-0">
          <Link
            to={`/agent/${a.id}/spend`}
            className="btn btn--secondary"
          >
            <DollarSign size={16} strokeWidth={1.8} />
            View spend
          </Link>
          <Link
            to={`/agent/${a.id}`}
            className="btn btn--secondary"
          >
            <TrendingUp size={16} strokeWidth={1.8} />
            Open agent
          </Link>
          <button
            type="button"
            onClick={() => onSimulate?.(a.id)}
            className="btn btn--primary"
          >
            <FlaskConical size={16} strokeWidth={1.8} />
            Simulate in Sandbox
          </button>
        </div>
      </aside>
      </div>
    </>
  );
}
