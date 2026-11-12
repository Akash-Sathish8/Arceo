/**
 * Incident replay: the July 2026 OpenAI / Hugging Face agent intrusion,
 * played through Arceo twice.
 *
 *  · Without Arceo: the recorded trace as historical evidence. Every step
 *    ran, and the analyzer names the dangerous chains that formed across
 *    the steps. Read from the stored ingest simulation the seeder created.
 *  · With Arceo: the same trace posted to POST /api/replay against the
 *    agent's guard policies. Every decision on screen is the engine's own;
 *    the two held steps land in the approvals queue as a side effect.
 *
 * If the backend cannot be reached the page falls back to the recorded
 * result in data/incidentTrace.ts and says so, so nothing dies on stage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, Ban, ExternalLink, GitBranch, Hand, Plug, RotateCcw, ShieldCheck,
} from "lucide-react";
import PageHeader from "@/components/shared/PageHeader";
import SimulationCanvas, { type CanvasRun } from "@/components/sandbox/SimulationCanvas";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/shared/Toast";
import {
  FALLBACK_CHAINS, HEADLINE_CHAINS, INCIDENT_AGENT_ID, INCIDENT_AGENT_NAME, INCIDENT_SOURCES,
  INCIDENT_STEPS, toReplayTrace, type Decision,
} from "@/data/incidentTrace";

type Mode = "without" | "with";

interface ReplayStep {
  tool: string;
  action: string;
  policy_decision: string;
  matched_policy: { action_pattern?: string; effect?: string; reason?: string } | null;
  risk_labels: string[];
}
interface ReplayReport {
  steps: ReplayStep[];
  actions_would_allow: number;
  actions_would_block: number;
  actions_would_require_approval: number;
}
interface ChainHit {
  chain_id: string;
  chain_name: string;
  severity: string;
  step_indices?: number[];
}

interface ChainSpan {
  chain: ChainHit;
  start: number;
  end: number;
  lane: number;
  color: string;
}

/** Same lane packing as SimulationDetail, so overlapping chains never draw over each other. */
function buildChainSpans(chains: ChainHit[]): ChainSpan[] {
  const raw = chains
    .map((c) => {
      const idx = (c.step_indices ?? []).filter((n) => Number.isInteger(n));
      if (idx.length < 2) return null;
      return { chain: c, start: Math.min(...idx), end: Math.max(...idx) };
    })
    .filter((v): v is { chain: ChainHit; start: number; end: number } => v !== null)
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
    const color = sev === "critical" ? "var(--critical)" : sev === "high" ? "var(--high)" : "var(--caution)";
    return { ...v, lane, color };
  });
}

const DECISION: Record<Decision, {
  label: string; Icon: typeof Plug; fg: string;
  markerBg: string; markerBorder: string; markerFg: string;
  cardBorder: string; chipBg: string; chipFg: string; chipBorder: string;
}> = {
  ALLOW: {
    label: "Ran", Icon: Plug, fg: "var(--ink-500)",
    markerBg: "var(--paper-2)", markerBorder: "var(--line)", markerFg: "var(--ink-600)",
    cardBorder: "var(--line)", chipBg: "var(--paper-2)", chipFg: "var(--ink-600)", chipBorder: "var(--line)",
  },
  REQUIRE_APPROVAL: {
    label: "Held for approval", Icon: Hand, fg: "var(--on-caution)",
    markerBg: "var(--caution-bg)", markerBorder: "var(--caution-line)", markerFg: "var(--on-caution)",
    cardBorder: "var(--caution-line)", chipBg: "var(--caution-bg)", chipFg: "var(--on-caution)", chipBorder: "var(--caution-line)",
  },
  BLOCK: {
    label: "Blocked", Icon: Ban, fg: "var(--critical)",
    markerBg: "var(--critical-bg)", markerBorder: "var(--critical-line)", markerFg: "var(--critical)",
    cardBorder: "var(--critical-line)", chipBg: "var(--critical)", chipFg: "#ffffff", chipBorder: "var(--critical)",
  },
};

function asDecision(v: string | undefined): Decision {
  return v === "BLOCK" || v === "REQUIRE_APPROVAL" ? v : "ALLOW";
}

const CACHE_KEY = `arceo_incident_replay:${INCIDENT_AGENT_ID}`;

export default function IncidentReplay(): React.ReactElement {
  const [mode, setMode] = useState<Mode>("without");
  const [replay, setReplay] = useState<ReplayReport | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [chains, setChains] = useState<ChainHit[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [runId, setRunId] = useState(0);
  const inFlight = useRef(false);

  // ── Without Arceo: the stored ingest simulation ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiFetch<{ simulations: { id: string; agent_id: string; scenario_id: string }[] }>(
          "/api/sandbox/simulations?limit=100",
        );
        const sim = list.simulations.find(
          (s) => s.agent_id === INCIDENT_AGENT_ID && String(s.scenario_id).startsWith("ingest-"),
        );
        if (!sim) throw new Error("no ingest simulation");
        const detail = await apiFetch<{ report: { chains_triggered: ChainHit[] } }>(`/api/sandbox/simulation/${sim.id}`);
        if (!cancelled) setChains(detail.report.chains_triggered ?? []);
      } catch {
        if (!cancelled) {
          setChains(FALLBACK_CHAINS);
          setOffline(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── With Arceo: the engine's decisions ──
  const runReplay = useCallback(async (force: boolean) => {
    if (!force) {
      try {
        const cached = sessionStorage.getItem(CACHE_KEY);
        if (cached) {
          setReplay(JSON.parse(cached) as ReplayReport);
          return;
        }
      } catch { /* no cache */ }
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setReplaying(true);
    try {
      const r = await apiFetch<ReplayReport>("/api/replay", {
        method: "POST",
        body: JSON.stringify({ agent_id: INCIDENT_AGENT_ID, traces: toReplayTrace() }),
      });
      setReplay(r);
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(r)); } catch { /* ignore */ }
      if (force) toast("Replayed. Held steps are in the approvals queue.");
    } catch {
      setOffline(true);
      setReplay({
        steps: INCIDENT_STEPS.map((s) => ({
          tool: s.tool, action: s.action, policy_decision: s.expected,
          matched_policy: s.expectedReason ? { reason: s.expectedReason } : null, risk_labels: [],
        })),
        actions_would_allow: INCIDENT_STEPS.filter((s) => s.expected === "ALLOW").length,
        actions_would_block: INCIDENT_STEPS.filter((s) => s.expected === "BLOCK").length,
        actions_would_require_approval: INCIDENT_STEPS.filter((s) => s.expected === "REQUIRE_APPROVAL").length,
      });
    }
    setReplaying(false);
    inFlight.current = false;
    setRunId((n) => n + 1);
  }, []);

  useEffect(() => { void runReplay(false); }, [runReplay]);

  // ── Derived ──
  const decisions: Decision[] = useMemo(
    () => INCIDENT_STEPS.map((s, i) => (mode === "with" ? asDecision(replay?.steps[i]?.policy_decision) : "ALLOW")),
    [mode, replay],
  );
  const firstStop = decisions.findIndex((d) => d !== "ALLOW");
  const blocked = decisions.filter((d) => d === "BLOCK").length;
  const held = decisions.filter((d) => d === "REQUIRE_APPROVAL").length;
  const passed = decisions.length - blocked - held;

  const allChains = chains ?? [];
  const headline = allChains.filter((c) => HEADLINE_CHAINS.includes(c.chain_id));
  const chainSpans = useMemo(() => (mode === "without" ? buildChainSpans(headline) : []), [mode, headline]);
  const otherChains = Math.max(0, allChains.length - headline.length);

  const firedPolicies = useMemo(() => {
    if (mode !== "with" || !replay) return [];
    const seen = new Map<string, { reason: string; effect: Decision; steps: number[] }>();
    replay.steps.forEach((s, i) => {
      const d = asDecision(s.policy_decision);
      if (d === "ALLOW") return;
      const reason = s.matched_policy?.reason ?? INCIDENT_STEPS[i]?.expectedReason ?? "Policy";
      const cur = seen.get(reason) ?? { reason, effect: d, steps: [] };
      cur.steps.push(i + 1);
      seen.set(reason, cur);
    });
    return Array.from(seen.values());
  }, [mode, replay]);

  const canvasTools = useMemo(() => {
    const order: string[] = [];
    INCIDENT_STEPS.forEach((s) => { if (!order.includes(s.tool)) order.push(s.tool); });
    return order.slice(0, 6);
  }, []);
  const canvasRun: CanvasRun = useMemo(() => ({
    id: `${mode}-${runId}`,
    scenario: mode === "with" ? "With Arceo" : "Without Arceo",
    steps: INCIDENT_STEPS.map((s, i) => ({ tool: s.tool, action: s.action, decision: decisions[i] })),
  }), [mode, runId, decisions]);

  const modeButton = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className="px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors"
      style={{
        background: mode === m ? "var(--ink-900)" : "transparent",
        color: mode === m ? "#fff" : "var(--ink-600)",
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="px-container-padding py-stack-gap w-full">
      <PageHeader
        title="Incident replay"
        description={`The OpenAI eval-agent intrusion into Hugging Face, 9 to 13 July 2026, as the twelve tool calls it was made of. Played against ${INCIDENT_AGENT_NAME} with and without its guards.`}
        actions={
          <div className="flex items-center gap-3 flex-wrap">
            <div className="inline-flex items-center gap-1 p-1 rounded-lg" style={{ background: "var(--paper-2)", border: "1px solid var(--line)" }}>
              {modeButton("without", "Without Arceo")}
              {modeButton("with", "With Arceo")}
            </div>
            <button
              type="button"
              className="btn btn--secondary inline-flex items-center gap-1.5"
              onClick={() => { setMode("with"); void runReplay(true); }}
              disabled={replaying}
            >
              <RotateCcw size={14} /> {replaying ? "Replaying" : "Replay again"}
            </button>
          </div>
        }
      />

      {offline && (
        <div className="mb-4 flex items-center gap-2 text-[13px] px-3 py-2 rounded-lg" style={{ background: "var(--caution-bg)", color: "var(--on-caution)", border: "1px solid var(--caution-line)" }}>
          <AlertTriangle size={14} /> The engine could not be reached. Showing the recorded result.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* ── Left: canvas + timeline ── */}
        <div className="lg:col-span-2 flex flex-col gap-6 min-w-0">
          <div className="relative bg-surface-container-lowest rounded-xl p-5 flex flex-col overflow-hidden" style={{ minHeight: 460 }}>
            <div className="flex items-center justify-between gap-3 z-10 relative">
              <h2 className="font-card-title text-card-title text-on-surface m-0">
                {mode === "with" ? "The same attack, through Arceo" : "The attack as it happened"}
              </h2>
              <span className="text-[12px]" style={{ color: "var(--ink-500)" }}>Use Replay last run to walk the trace</span>
            </div>
            <SimulationCanvas tools={canvasTools} running={false} progress={null} lastRun={canvasRun} />
          </div>

          <div className="bg-surface-container-lowest rounded-xl overflow-hidden">
            <div className="p-5 border-b border-neutral-border flex items-center justify-between gap-3">
              <h2 className="font-card-title text-card-title text-on-surface m-0">Twelve tool calls</h2>
              {mode === "without" && otherChains > 0 && (
                <span className="text-[12px]" style={{ color: "var(--ink-500)" }}>
                  {headline.length} chains shown, {otherChains} more detected
                </span>
              )}
            </div>
            <div className="p-6 relative">
              <div className="absolute w-px bg-neutral-border" style={{ left: 43, top: 32, bottom: 32 }} />
              <div className="flex flex-col gap-7 relative z-20">
                {INCIDENT_STEPS.map((step, i) => {
                  const d = DECISION[decisions[i]];
                  const startsHere = chainSpans.filter((c) => c.start === i);
                  const reason = mode === "with"
                    ? replay?.steps[i]?.matched_policy?.reason ?? step.expectedReason
                    : undefined;
                  const dayBreak = i === 0 || INCIDENT_STEPS[i - 1].day !== step.day;
                  return (
                    <div key={i} className="relative">
                      {dayBreak && (
                        <div className="ml-14 mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--ink-400)" }}>
                          {step.day} 2026
                        </div>
                      )}
                      {startsHere.map((c) => (
                        <div key={c.chain.chain_id} className="flex items-center gap-1.5 mb-2 ml-14">
                          <GitBranch size={11} style={{ color: c.color, flexShrink: 0 }} />
                          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: c.color }}>
                            Dangerous chain: {c.chain.chain_name} (steps {c.start + 1} to {c.end + 1})
                          </span>
                        </div>
                      ))}
                      <div className="flex items-start gap-4">
                        <div
                          className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 z-10 text-[12px] font-semibold"
                          style={{ background: d.markerBg, border: `1px solid ${d.markerBorder}`, color: d.markerFg }}
                        >
                          {String(i + 1).padStart(2, "0")}
                        </div>
                        <div className="flex-1 min-w-0 rounded-lg p-4" style={{ background: "var(--card)", border: `1px solid ${d.cardBorder}` }}>
                          <div className="flex justify-between items-center gap-3 mb-1.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <d.Icon size={16} style={{ color: d.fg, flexShrink: 0 }} />
                              <span className="font-monospace-data text-[13px] text-on-surface truncate">{step.tool}.{step.action}</span>
                            </div>
                            <span
                              className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider shrink-0"
                              style={{ background: d.chipBg, color: d.chipFg, border: `1px solid ${d.chipBorder}` }}
                            >
                              {d.label}
                            </span>
                          </div>
                          <p className="text-[13.5px] leading-relaxed m-0" style={{ color: "var(--ink-700)" }}>{step.narration}</p>
                          <pre className="mt-3 bg-surface-container-low rounded p-3 border border-neutral-border font-monospace-data text-[11.5px] text-neutral-primary whitespace-pre-wrap overflow-x-auto m-0">
                            {JSON.stringify(step.params, null, 2)}
                          </pre>
                          {reason && decisions[i] !== "ALLOW" && (
                            <div
                              className="mt-3 flex items-start gap-2 text-[12.5px] font-medium p-2 rounded"
                              style={{
                                color: decisions[i] === "BLOCK" ? "var(--critical)" : "var(--on-caution)",
                                background: decisions[i] === "BLOCK" ? "var(--critical-bg)" : "var(--caution-bg)",
                                border: `1px solid ${decisions[i] === "BLOCK" ? "var(--critical-line)" : "var(--caution-line)"}`,
                              }}
                            >
                              <ShieldCheck size={15} className="shrink-0 mt-px" />
                              <span>{decisions[i] === "BLOCK" ? "Blocked by policy: " : "Held by policy: "}{reason}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* ── Right rail ── */}
        <div className="lg:col-span-1 flex flex-col gap-6">
          <div
            className="rounded-xl p-6"
            style={{
              background: mode === "with" ? "var(--safe-bg)" : "var(--critical-bg)",
              border: `1px solid ${mode === "with" ? "var(--safe-line)" : "var(--critical-line)"}`,
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: mode === "with" ? "var(--safe)" : "var(--critical)" }}>
              {mode === "with" ? "Outcome with Arceo" : "Outcome as it happened"}
            </div>
            <div className="text-[22px] font-semibold leading-tight" style={{ color: "var(--ink-900)" }}>
              {mode === "with" && firstStop >= 0
                ? `Stopped at step ${firstStop + 1} of ${decisions.length}`
                : "Ran to completion"}
            </div>
            <p className="text-[13px] mt-2 m-0 leading-relaxed" style={{ color: "var(--ink-700)" }}>
              {mode === "with"
                ? "The first callback to a paste service is refused on day one. Everything after it depended on that channel."
                : "Five datasets left Hugging Face. Alerts fired but never reached criticality, and OpenAI learned the scope when it called to revoke credentials that were already revoked."}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Blocked", value: blocked, color: "var(--critical)" },
              { label: "Held", value: held, color: "var(--on-caution)" },
              { label: "Ran", value: passed, color: "var(--ink-900)" },
            ].map((t) => (
              <div key={t.label} className="bg-surface-container-lowest rounded-xl p-4 flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--ink-500)" }}>{t.label}</span>
                <span className="text-[26px] font-semibold leading-none" style={{ color: t.color }}>{t.value}</span>
              </div>
            ))}
          </div>

          {mode === "with" ? (
            <div className="bg-surface-container-lowest rounded-xl">
              <div className="p-5 border-b border-neutral-border">
                <h3 className="font-card-title text-card-title text-on-surface m-0">Guards that fired</h3>
              </div>
              <ul className="p-5 m-0 flex flex-col gap-3 list-none">
                {firedPolicies.map((p) => (
                  <li key={p.reason} className="flex items-start gap-2.5">
                    {p.effect === "BLOCK"
                      ? <Ban size={15} className="shrink-0 mt-0.5" style={{ color: "var(--critical)" }} />
                      : <Hand size={15} className="shrink-0 mt-0.5" style={{ color: "var(--on-caution)" }} />}
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium" style={{ color: "var(--ink-900)" }}>{p.reason}</div>
                      <div className="text-[12px]" style={{ color: "var(--ink-500)" }}>
                        {p.effect === "BLOCK" ? "Blocked" : "Held"} step{p.steps.length > 1 ? "s" : ""} {p.steps.join(", ")}
                      </div>
                    </div>
                  </li>
                ))}
                {firedPolicies.length === 0 && (
                  <li className="text-[13px]" style={{ color: "var(--ink-500)" }}>No guard fired. Seed the policies and replay.</li>
                )}
              </ul>
              {held > 0 && (
                <div className="px-5 pb-5">
                  <Link to="/approvals" className="btn btn--primary inline-flex items-center gap-1.5 w-full justify-center">
                    Review the {held} held step{held > 1 ? "s" : ""} <ArrowRight size={14} />
                  </Link>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-surface-container-lowest rounded-xl">
              <div className="p-5 border-b border-neutral-border">
                <h3 className="font-card-title text-card-title text-on-surface m-0">Chains the attack walked</h3>
              </div>
              <ul className="p-5 m-0 flex flex-col gap-3 list-none">
                {headline.map((c) => (
                  <li key={c.chain_id} className="flex items-start gap-2.5">
                    <GitBranch size={15} className="shrink-0 mt-0.5" style={{ color: c.severity === "critical" ? "var(--critical)" : "var(--high)" }} />
                    <div>
                      <div className="text-[13px] font-medium" style={{ color: "var(--ink-900)" }}>{c.chain_name}</div>
                      <div className="text-[12px]" style={{ color: "var(--ink-500)" }}>
                        {c.severity === "critical" ? "Critical" : "High"} · steps {(c.step_indices ?? []).map((n) => n + 1).join(" and ")}
                      </div>
                    </div>
                  </li>
                ))}
                {chains === null && <li className="text-[13px]" style={{ color: "var(--ink-500)" }}>Loading</li>}
              </ul>
              <div className="px-5 pb-5">
                <Link to={`/agent/${INCIDENT_AGENT_ID}?tab=chains`} className="btn btn--secondary inline-flex items-center gap-1.5 w-full justify-center">
                  These were visible before it ran <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          )}

          <div className="bg-surface-container-lowest rounded-xl p-5">
            <h3 className="font-card-title text-card-title text-on-surface m-0 mb-2">What Arceo does not do</h3>
            <p className="text-[13px] m-0 leading-relaxed" style={{ color: "var(--ink-700)" }}>
              It does not patch the Artifactory zero-day or the kernel bug. It governs the tool calls that pass through it.
              An agent with this tool set should never have been deployable without these guards.
            </p>
          </div>

          <div className="text-[12px] flex flex-col gap-1.5" style={{ color: "var(--ink-500)" }}>
            {INCIDENT_SOURCES.map((s) => (
              <a key={s.href} href={s.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                {s.label} <ExternalLink size={11} />
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
