import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PageHeader from "@/components/shared/PageHeader";
import {
  ArrowRight,
  TrendingDown,
  TrendingUp,
  Minus,
  ChevronDown,
  AlertTriangle,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/shared/Toast";
import { timeAgo } from "@/lib/utils";

// Summary row from GET /api/sandbox/simulations — flat fields only, no
// report object and no trace (those live on the detail endpoint below).
interface SimRun {
  id: string;
  agent_id: string;
  agent_name?: string;
  scenario_id: string;
  scenario_name?: string;
  status: string;
  created_at: string;
  risk_score?: number;
  violations?: number;
  actions_blocked?: number;
  total_steps?: number;
}

// Full detail from GET /api/sandbox/simulation/{id} — the shape the
// comparison metrics actually need (matches sandbox/models.py serialization).
interface SimStep {
  tool: string;
  action: string;
  enforce_decision: string; // ALLOW, BLOCK, REQUIRE_APPROVAL
}

interface SimViolation {
  type: string;
  severity: string;
  title: string;
  description: string;
}

interface SimChain {
  chain_id: string;
  chain_name: string;
  severity: string;
  description: string;
}

interface SimDetail {
  simulation_id: string;
  agent_id: string;
  scenario_id: string;
  status: string;
  created_at: string;
  report: {
    risk_score: number;
    violations: SimViolation[];
    chains_triggered: SimChain[];
    actions_blocked: number;
    total_steps: number;
  };
  trace: { steps?: SimStep[]; unified_steps?: SimStep[] };
}

function useAnimatedNumber(target: number, trigger: boolean) {
  const [current, setCurrent] = useState(0);
  const rafRef = useRef<number | undefined>(undefined);
  const startRef = useRef<number | undefined>(undefined);
  const fromRef = useRef(0);

  useEffect(() => {
    if (!trigger) return;
    fromRef.current = current;
    startRef.current = undefined;

    function step(ts: number) {
      if (startRef.current === undefined) startRef.current = ts;
      const progress = Math.min((ts - startRef.current) / 800, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCurrent(Math.round(fromRef.current + (target - fromRef.current) * eased));
      if (progress < 1) rafRef.current = requestAnimationFrame(step);
    }

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, trigger]);

  return current;
}

function SimulationPicker({
  simulations,
  value,
  onChange,
  label,
}: {
  simulations: SimRun[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = simulations.find((s) => s.id === value);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside-click or Escape (the dropdown used to stay open over
  // content until you re-clicked the trigger).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
        {label}
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          background: "var(--bg-sunken)",
          border: "2px solid transparent",
          borderRadius: "var(--radius-md)",
          padding: "0 16px",
          height: 42,
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "inherit",
        }}
      >
        <div style={{ flex: 1 }}>
          {selected ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                {selected.scenario_name ?? selected.scenario_id}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {selected.agent_name ?? selected.agent_id} · {timeAgo(selected.created_at)}
              </div>
            </>
          ) : (
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Select simulation…</span>
          )}
        </div>
        <ChevronDown size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 4,
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
            zIndex: 20,
            maxHeight: 256,
            overflowY: "auto",
          }}
        >
          {simulations.length === 0 ? (
            <div
              style={{
                padding: "16px 12px",
                fontSize: 13,
                color: "var(--text-muted)",
                textAlign: "center",
              }}
            >
              No simulations found
            </div>
          ) : (
            simulations.map((sim) => (
              <button
                key={sim.id}
                onClick={() => {
                  onChange(sim.id);
                  setOpen(false);
                }}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 12px",
                  fontSize: 13,
                  background: sim.id === value ? "var(--bg-sunken)" : "transparent",
                  border: "none",
                  cursor: "pointer",
                  display: "block",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ fontWeight: 500, color: "var(--text-primary)" }}>
                  {sim.scenario_name ?? sim.scenario_id}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {sim.agent_name ?? sim.agent_id} · Score: {sim.risk_score ?? "—"} ·{" "}
                  {timeAgo(sim.created_at)}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function MetricRow({
  label,
  before,
  after,
  lowerIsBetter = true,
}: {
  label: string;
  before: number;
  after: number;
  lowerIsBetter?: boolean;
}) {
  const delta = after - before;
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  const neutral = delta === 0;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "10px 0",
      }}
    >
      <div style={{ flex: 1, fontSize: 13, color: "var(--text-secondary)" }}>{label}</div>
      <div
        style={{ width: 64, textAlign: "right", fontWeight: 500, color: "var(--text-primary)", fontSize: 13 }}
      >
        {before}
      </div>
      <ArrowRight size={14} style={{ color: "var(--ink-300)", flexShrink: 0 }} />
      <div
        style={{ width: 64, textAlign: "right", fontWeight: 500, color: "var(--text-primary)", fontSize: 13 }}
      >
        {after}
      </div>
      <div
        style={{
          width: 96,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 4,
        }}
      >
        {neutral ? (
          <span
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "center",
              gap: 2,
            }}
          >
            <Minus size={12} /> no change
          </span>
        ) : (
          // Arrow direction follows the actual delta sign; color follows whether
          // that direction is an improvement (a rise in Blocked Actions is good,
          // so it's a green up-arrow — not a green down-arrow).
          <span
            style={{
              fontSize: 12,
              color: improved ? "var(--safe)" : "var(--critical)",
              display: "flex",
              alignItems: "center",
              gap: 2,
            }}
          >
            {delta > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {delta > 0 ? `+${delta}` : Math.abs(delta)}
          </span>
        )}
      </div>
    </div>
  );
}

export default function Comparison() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [simulations, setSimulations] = useState<SimRun[]>([]);
  const [simA, setSimA] = useState<SimRun | null>(null);
  const [simB, setSimB] = useState<SimRun | null>(null);
  const [detailA, setDetailA] = useState<SimDetail | null>(null);
  const [detailB, setDetailB] = useState<SimDetail | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [animTrigger, setAnimTrigger] = useState(false);

  // Accept before/after too — the Sandbox "Compare Runs" banner historically
  // linked with those keys while this page read a/b, so the preselect silently
  // failed and fell through to the default picker.
  const idA = searchParams.get("a") ?? searchParams.get("before") ?? "";
  const idB = searchParams.get("b") ?? searchParams.get("after") ?? "";

  const animScoreA = useAnimatedNumber(Math.round(detailA?.report?.risk_score ?? 0), animTrigger);
  const animScoreB = useAnimatedNumber(Math.round(detailB?.report?.risk_score ?? 0), animTrigger);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch<{ simulations: SimRun[] }>("/api/sandbox/simulations");
        const sims = data.simulations ?? [];
        setSimulations(sims);

        if (idA && idB) {
          setSimA(sims.find((s) => s.id === idA) ?? null);
          setSimB(sims.find((s) => s.id === idB) ?? null);
        } else if (sims.length >= 2) {
          // Prefer the two most recent COMPLETED runs — defaulting to the two
          // newest sims often landed on errored/all-zero runs, rendering a
          // meaningless "No change" on first load.
          const completed = sims.filter((s) => s.status === "completed");
          const pool = completed.length >= 2 ? completed : sims;
          const [last, prev] = pool;
          setSimA(prev);
          setSimB(last);
          setSearchParams({ a: prev.id, b: last.id }, { replace: true });
        }
      } catch {
        toast("Failed to load simulations", "error");
      } finally {
        setLoading(false);
        setTimeout(() => setAnimTrigger(true), 50);
      }
    }
    load();
  }, []);

  // The list endpoint only returns summary fields, so the full report + trace
  // for each selected sim must be fetched from the detail endpoint. Without
  // this the comparison renders all-zeros (the original bug).
  useEffect(() => {
    if (!idA) { setDetailA(null); return; }
    let cancelled = false;
    setDetailsLoading(true);
    apiFetch<SimDetail>(`/api/sandbox/simulation/${idA}`)
      .then((d) => {
        if (cancelled) return;
        setDetailA(d);
        setAnimTrigger(false);
        setTimeout(() => setAnimTrigger(true), 50);
      })
      .catch(() => { if (!cancelled) setDetailA(null); })
      .finally(() => { if (!cancelled) setDetailsLoading(false); });
    return () => { cancelled = true; };
  }, [idA]);

  useEffect(() => {
    if (!idB) { setDetailB(null); return; }
    let cancelled = false;
    setDetailsLoading(true);
    apiFetch<SimDetail>(`/api/sandbox/simulation/${idB}`)
      .then((d) => {
        if (cancelled) return;
        setDetailB(d);
        setAnimTrigger(false);
        setTimeout(() => setAnimTrigger(true), 50);
      })
      .catch(() => { if (!cancelled) setDetailB(null); })
      .finally(() => { if (!cancelled) setDetailsLoading(false); });
    return () => { cancelled = true; };
  }, [idB]);

  function handlePickA(id: string) {
    setSimA(simulations.find((s) => s.id === id) ?? null);
    setSearchParams({ a: id, b: idB }, { replace: true });
  }

  function handlePickB(id: string) {
    setSimB(simulations.find((s) => s.id === id) ?? null);
    setSearchParams({ a: idA, b: id }, { replace: true });
  }

  const differentAgents = simA && simB && simA.agent_id !== simB.agent_id;

  const scoreA = Math.round(detailA?.report?.risk_score ?? 0);
  const scoreB = Math.round(detailB?.report?.risk_score ?? 0);
  const improved = scoreB < scoreA;
  const neutral = scoreB === scoreA;

  const violA = detailA?.report?.violations?.length ?? 0;
  const violB = detailB?.report?.violations?.length ?? 0;
  const chainsA = detailA?.report?.chains_triggered?.length ?? 0;
  const chainsB = detailB?.report?.chains_triggered?.length ?? 0;
  const blockedA = detailA?.report?.actions_blocked ?? 0;
  const blockedB = detailB?.report?.actions_blocked ?? 0;

  // Multi-agent traces store their steps as `unified_steps` (MultiAgentTrace),
  // single-agent as `steps` — support both so comparing multi-agent runs
  // doesn't silently diff empty lists.
  const stepsA = detailA?.trace?.steps ?? detailA?.trace?.unified_steps ?? [];
  const stepsB = detailB?.trace?.steps ?? detailB?.trace?.unified_steps ?? [];
  const actionsA = new Set(
    stepsA
      .filter((s) => s.enforce_decision === "BLOCK")
      .map((s) => `${s.tool}.${s.action}`)
  );
  const newlyBlocked = stepsB
    .filter((s) => s.enforce_decision === "BLOCK" && !actionsA.has(`${s.tool}.${s.action}`))
    .map((s) => `${s.tool}.${s.action}`);

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ height: 32, background: "var(--bg-sunken)", borderRadius: "var(--radius-md)", width: 192 }} />
          <div style={{ height: 80, background: "var(--bg-sunken)", borderRadius: "var(--radius-lg)" }} />
          <div style={{ height: 256, background: "var(--bg-sunken)", borderRadius: "var(--radius-lg)" }} />
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "var(--page-pad)",
        display: "flex",
        flexDirection: "column",
        gap: 32,
        maxWidth: 1100,
        margin: "0 auto",
        width: "100%",
      }}
    >
      {/* Header */}
      <PageHeader
        title="Compare Simulations"
        back={{ to: "/sandbox", label: "Back to Sandbox" }}
      />

      {/* Pickers */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 24,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
        }}
      >
        <SimulationPicker
          simulations={simulations}
          value={idA}
          onChange={handlePickA}
          label="Baseline (A)"
        />
        <SimulationPicker
          simulations={simulations}
          value={idB}
          onChange={handlePickB}
          label="Target (B)"
        />
      </div>

      {differentAgents && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: 12,
            background: "var(--severity-high-bg)",
            border: "1px solid var(--severity-high-border)",
            borderRadius: "var(--radius-lg)",
            fontSize: 13,
            color: "var(--severity-high)",
          }}
        >
          <AlertTriangle size={16} style={{ flexShrink: 0 }} />
          These simulations are from different agents — comparison may not be meaningful.
        </div>
      )}

      {simA && simB && (!detailA || !detailB) && (
        <div style={{ textAlign: "center", padding: "48px 0", color: "var(--text-muted)", fontSize: 13 }}>
          {detailsLoading
            ? "Loading comparison…"
            : "Couldn't load full detail for one of these simulations. Re-run them in Sandbox."}
        </div>
      )}

      {simA && simB && detailA && detailB && (
        <>
          {/* Headline banner */}
          <div
            style={{
              borderRadius: "var(--radius-lg)",
              padding: 24,
              textAlign: "center",
              backgroundColor: neutral ? "var(--paper-2)" : improved ? "var(--safe-bg)" : "var(--critical-bg)",
              border: `1px solid ${neutral ? "var(--border)" : improved ? "var(--severity-safe-border)" : "var(--severity-critical-border)"}`,
            }}
          >
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                marginBottom: 4,
                color: neutral ? "var(--ink-500)" : improved ? "var(--safe)" : "var(--critical)",
              }}
            >
              {neutral
                ? "No change"
                : improved
                ? `Risk improved by ${scoreA - scoreB} points`
                : `Risk increased by ${scoreB - scoreA} points`}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {simA.scenario_name ?? simA.scenario_id} vs{" "}
              {simB.scenario_name ?? simB.scenario_id}
            </div>
          </div>

          {/* Score cards */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {(
              [
                { label: "Baseline (A)", sim: simA, score: animScoreA },
                { label: "Target (B)", sim: simB, score: animScoreB },
              ] as const
            ).map(({ label, sim, score }) => {
              const color = score >= 70 ? "var(--critical)" : score >= 40 ? "var(--high)" : "var(--safe)";
              return (
                <div
                  key={label}
                  style={{
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-lg)",
                    padding: 24,
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}
                  >
                    {label}
                  </div>
                  <div style={{ fontSize: 36, fontWeight: 700, marginBottom: 4, color }}>
                    {score}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 4 }}>
                    {sim.scenario_name ?? sim.scenario_id}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {sim.agent_name ?? sim.agent_id} · {timeAgo(sim.created_at)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Metrics table */}
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              padding: 24,
            }}
          >
            <h3
              style={{
                fontWeight: 600,
                color: "var(--text-primary)",
                marginBottom: 12,
                fontSize: 15,
                marginTop: 0,
                letterSpacing: "-0.01em",
              }}
            >
              Metrics Comparison
            </h3>
            <div style={{ display: "flex", alignItems: "center", gap: 16, paddingBottom: 4 }}>
              <div style={{ flex: 1 }} />
              <div
                style={{
                  width: 64,
                  textAlign: "right",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                }}
              >
                Baseline
              </div>
              <div style={{ width: 14 }} />
              <div
                style={{
                  width: 64,
                  textAlign: "right",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                }}
              >
                Target
              </div>
              <div style={{ width: 96 }} />
            </div>
            <MetricRow label="Risk Score" before={scoreA} after={scoreB} />
            <MetricRow label="Violations" before={violA} after={violB} />
            <MetricRow label="Chains Triggered" before={chainsA} after={chainsB} />
            <MetricRow
              label="Blocked Actions"
              before={blockedA}
              after={blockedB}
              lowerIsBetter={false}
            />
          </div>

          {/* Newly blocked */}
          {newlyBlocked.length > 0 && (
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                padding: 24,
              }}
            >
              <h3
                style={{
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  marginBottom: 12,
                  fontSize: 13,
                  marginTop: 0,
                }}
              >
                Newly Blocked in Target
              </h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {newlyBlocked.map((action) => (
                  <span
                    key={action}
                    style={{
                      fontSize: 12,
                      padding: "4px 8px",
                      background: "var(--critical-bg)",
                      color: "var(--critical)",
                      border: "1px solid var(--critical-line)",
                      borderRadius: "var(--radius-md)",
                    }}
                  >
                    {action}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Violations + Chains side by side */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                padding: 24,
              }}
            >
              <h3
                style={{
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  marginBottom: 12,
                  fontSize: 13,
                  marginTop: 0,
                }}
              >
                Violations
              </h3>
              {(detailA.report?.violations ?? []).length === 0 &&
              (detailB.report?.violations ?? []).length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic", margin: 0 }}>
                  No violations in either simulation
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {(detailA.report?.violations ?? []).map((v, i) => (
                    <div
                      key={`a-${i}`}
                      style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 }}
                    >
                      <span style={{ color: "var(--text-muted)", flexShrink: 0, fontWeight: 500 }}>A:</span>
                      <span style={{ color: "var(--critical)", fontWeight: 500 }}>{v.title}</span>
                    </div>
                  ))}
                  {(detailB.report?.violations ?? []).map((v, i) => (
                    <div
                      key={`b-${i}`}
                      style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 }}
                    >
                      <span style={{ color: "var(--text-muted)", flexShrink: 0, fontWeight: 500 }}>B:</span>
                      <span style={{ color: "var(--critical)", fontWeight: 500 }}>{v.title}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                padding: 24,
              }}
            >
              <h3
                style={{
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  marginBottom: 12,
                  fontSize: 13,
                  marginTop: 0,
                }}
              >
                Chains Triggered
              </h3>
              {(detailA.report?.chains_triggered ?? []).length === 0 &&
              (detailB.report?.chains_triggered ?? []).length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic", margin: 0 }}>
                  No chains in either simulation
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {(detailA.report?.chains_triggered ?? []).map((c, i) => (
                    <div
                      key={`a-${i}`}
                      style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 }}
                    >
                      <span style={{ color: "var(--text-muted)", flexShrink: 0, fontWeight: 500 }}>A:</span>
                      <span style={{ color: "var(--high)", fontWeight: 500 }}>{c.chain_name}</span>
                    </div>
                  ))}
                  {(detailB.report?.chains_triggered ?? []).map((c, i) => (
                    <div
                      key={`b-${i}`}
                      style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 }}
                    >
                      <span style={{ color: "var(--text-muted)", flexShrink: 0, fontWeight: 500 }}>B:</span>
                      <span style={{ color: "var(--high)", fontWeight: 500 }}>{c.chain_name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {!(simA && simB) && simulations.length > 0 && (
        <div style={{ textAlign: "center", padding: "48px 0", color: "var(--text-muted)" }}>
          <p style={{ fontSize: 13 }}>
            Select two simulations above to compare.
            {simulations.length < 2
              ? " Run at least one more simulation in Sandbox to enable comparison."
              : ""}
          </p>
        </div>
      )}

      {simulations.length === 0 && (
        <div style={{ textAlign: "center", padding: "64px 0", color: "var(--text-muted)" }}>
          <p style={{ fontSize: 13 }}>No simulations found. Run a simulation in Sandbox first.</p>
        </div>
      )}
    </div>
  );
}
