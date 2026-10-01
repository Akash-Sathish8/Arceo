/**
 * Simulation canvas — the node graph on the Sandbox stage.
 *
 * It reports real state, never decoration:
 *
 *  · Scenario — the card on the left is the scenario that will run. Drag a
 *    scenario from the list onto the canvas to set it; with none set, the card
 *    is a drop target.
 *  · Tools — one node per tool the selected agent can actually call. After a
 *    run, each node shows the step numbers it was called at and wears a ring in
 *    the colour of the worst enforcement decision it drew (allowed / held for
 *    approval / blocked). Hover, tab to, or click a node for its calls.
 *  · Result — the right-hand node takes the colour of the run's worst decision.
 *  · Playback — after a run (or on "Replay") the path lights tool by tool in
 *    the order the agent called them, with the step in words above the graph.
 *
 * Motion is suppressed under prefers-reduced-motion; every state stays
 * readable from the rings, numbers and labels alone.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Square } from "lucide-react";

export interface CanvasStep {
  tool: string;
  action: string;
  decision: string;
}

export interface CanvasRun {
  id: string;
  /** Scenario id (or the custom prompt) the run was for. */
  scenarioId?: string;
  /** Dry run: steps are predicted calls ranked most-likely first, not the
   *  order anything happened in. Live runs record the real order. */
  predicted?: boolean;
  scenario: string;
  steps: CanvasStep[];
}

interface Props {
  tools: string[];
  running: boolean;
  progress: { current: number; total: number } | null;
  lastRun?: CanvasRun | null;
  /** What will run: a scenario name, "3 scenarios", or null for none yet. */
  scenarioLabel: string | null;
  /** Called with the dragged scenario's id when one is dropped on the canvas. */
  onDropScenario: (scenarioId: string) => void;
  /** Changes when a fresh run lands, so the canvas plays it back on its own. */
  autoplayKey?: string | null;
  /** Optional control of the playback position, so a step list beside the
   *  canvas can follow it and jump to a step. */
  replayAt?: number | null;
  onReplayAtChange?: (i: number | null) => void;
  /** Opens the full report for the run on the canvas (the Result node). */
  onOpenResult?: (runId: string) => void;
}

/** MIME type the scenario list puts on a drag, so stray drops are ignored. */
export const SCENARIO_DRAG_TYPE = "application/x-arceo-scenario";

/** Worst-first, so a tool that was ever blocked reads as blocked. */
const DECISION_RANK = ["ALLOW", "REQUIRE_APPROVAL", "BLOCK"];
const DECISION_COLOR: Record<string, string> = {
  ALLOW: "var(--aqua-ink)",
  REQUIRE_APPROVAL: "var(--caution-ring)",
  BLOCK: "var(--critical)",
};
const DECISION_LABEL: Record<string, string> = {
  ALLOW: "allowed",
  REQUIRE_APPROVAL: "held for approval",
  BLOCK: "blocked",
};

const STEP_MS = 1800;
const SCENARIO_RIGHT = 230; // x where the scenario card ends and edges begin

const HALO = { paintOrder: "stroke", stroke: "var(--card, #fff)", strokeWidth: 5, strokeLinejoin: "round" } as const;

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A step's tool in the agent's own spelling ("SendGrid"), falling back to title case. */
const toolLabel = (tool: string, tools: string[]) =>
  tools.find((t) => t.toLowerCase() === tool.toLowerCase()) ?? titleCase(tool);
/** "get_contact" -> plain words: "get contact". */
export const humanAction = (a: string) => a.replace(/[_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
const decisionOf = (s: CanvasStep) => (s.decision || "ALLOW").toUpperCase();

export default function SimulationCanvas({
  tools,
  running,
  progress,
  lastRun,
  scenarioLabel,
  onDropScenario,
  autoplayKey,
  replayAt: replayAtProp,
  onReplayAtChange,
  onOpenResult,
}: Props): React.ReactElement {
  const nodes = tools.slice(0, 6);
  const n = nodes.length;
  const ys = useMemo(
    () => (n === 0 ? [] : n === 1 ? [300] : nodes.map((_, i) => 150 + (i * 300) / (n - 1))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [n],
  );

  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [innerReplayAt, setInnerReplayAt] = useState<number | null>(null);
  const controlled = replayAtProp !== undefined;
  const replayAt = controlled ? replayAtProp : innerReplayAt;
  const replayRef = useRef(replayAt);
  replayRef.current = replayAt;
  const setReplayAt = (next: number | null | ((i: number | null) => number | null)) => {
    const v = typeof next === "function" ? next(replayRef.current) : next;
    if (controlled) onReplayAtChange?.(v);
    else setInnerReplayAt(v);
  };
  const [dragOver, setDragOver] = useState(false);
  const [resultHover, setResultHover] = useState(false);
  const timer = useRef<number | null>(null);

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  /** Per-tool rollup of the recorded trace: step numbers, worst decision, actions. */
  const byTool = useMemo(() => {
    const map = new Map<string, { stepNums: number[]; worst: string; actions: string[] }>();
    (lastRun?.steps ?? []).forEach((s, idx) => {
      const key = s.tool.toLowerCase();
      const cur = map.get(key) ?? { stepNums: [], worst: "ALLOW", actions: [] };
      cur.stepNums.push(idx + 1);
      const d = decisionOf(s);
      if (DECISION_RANK.indexOf(d) > DECISION_RANK.indexOf(cur.worst)) cur.worst = d;
      if (!cur.actions.includes(s.action)) cur.actions.push(s.action);
      map.set(key, cur);
    });
    return map;
  }, [lastRun]);

  const runWorst = useMemo(() => {
    let worst: string | null = null;
    for (const s of lastRun?.steps ?? []) {
      const d = decisionOf(s);
      if (worst === null || DECISION_RANK.indexOf(d) > DECISION_RANK.indexOf(worst)) worst = d;
    }
    return worst;
  }, [lastRun]);

  // Replay ticks through the recorded steps; a real run cancels it. The final
  // step holds for its full beat and then ends.
  useEffect(() => {
    if (replayAt === null) return;
    const total = lastRun?.steps.length ?? 0;
    const isLast = replayAt >= total - 1;
    timer.current = window.setTimeout(
      () => setReplayAt((i) => (i === null || isLast ? null : i + 1)),
      STEP_MS,
    );
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [replayAt, lastRun]);

  useEffect(() => {
    if (running) setReplayAt(null);
  }, [running]);

  // A fresh run plays itself back so the audience sees the path it took.
  useEffect(() => {
    if (autoplayKey && (lastRun?.steps.length ?? 0) > 0 && !reduceMotion) setReplayAt(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplayKey]);

  const replayStep = replayAt !== null ? lastRun?.steps[replayAt] : undefined;
  const replayToolIdx = replayStep
    ? nodes.findIndex((t) => t.toLowerCase() === replayStep.tool.toLowerCase())
    : -1;
  // Steps already played light their tools, so the path builds up.
  const playedTools = useMemo(() => {
    const set = new Set<string>();
    if (replayAt === null) return set;
    (lastRun?.steps ?? []).slice(0, replayAt + 1).forEach((s) => set.add(s.tool.toLowerCase()));
    return set;
  }, [replayAt, lastRun]);

  const active = pinned ?? hovered;
  const progressPct = progress && progress.total > 0 ? progress.current / progress.total : 0;

  const tip = active !== null && nodes[active] !== undefined ? nodes[active] : null;
  const tipStats = tip ? byTool.get(tip.toLowerCase()) : undefined;

  const resultColor = running ? "var(--cyan-ring)" : runWorst ? DECISION_COLOR[runWorst] : "var(--ink-300)";

  return (
    <div
      className="absolute inset-0 top-16 bottom-20 z-0"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(SCENARIO_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(SCENARIO_DRAG_TYPE);
        setDragOver(false);
        if (id) {
          e.preventDefault();
          onDropScenario(id);
        }
      }}
    >
      <svg
        className="w-full h-full"
        preserveAspectRatio="xMidYMid meet"
        viewBox="20 110 680 380"
        role="img"
        aria-label={
          n === 0
            ? "No agent selected"
            : `Tool graph: ${scenarioLabel ?? "no scenario"} through ${nodes.join(", ")} to result`
        }
      >
        <defs>
          <pattern id="sandbox-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--line)" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect x="20" y="110" width="680" height="380" fill="url(#sandbox-grid)" opacity="0.7" />

        {n > 0 && (
          <>
            {/* Edges. Lit when the node is focused, once playback has reached
                it, or while a run is in flight. */}
            {ys.map((y, i) => {
              const key = nodes[i].toLowerCase();
              const current = replayToolIdx === i;
              const lit = running || active === i || current || playedTools.has(key);
              const stroke = current ? "var(--accent)" : lit ? "var(--accent-line)" : "var(--ink-300)";
              const w = current ? 2.5 : lit ? 2 : 1.5;
              return (
                <g key={`edge-${i}`} fill="none" stroke={stroke} strokeWidth={w} style={{ transition: "stroke 400ms ease, stroke-width 400ms ease" }}>
                  <path
                    d={`M ${SCENARIO_RIGHT},300 C 320,300 320,${y} 420,${y}`}
                    className={running && !reduceMotion ? "sim-edge-flow" : undefined}
                  />
                  <path
                    d={`M 420,${y} C 520,${y} 520,300 620,300`}
                    className={running && !reduceMotion ? "sim-edge-flow" : undefined}
                  />
                </g>
              );
            })}

            {/* The step in play: a dot carries it from the scenario, through its
                tool, to the result, over most of the step's beat. */}
            {replayToolIdx >= 0 && !reduceMotion && (
              <circle key={`dot-${replayAt}`} r="4.5" fill="var(--accent)">
                <animateMotion
                  dur={`${(STEP_MS * 0.85) / 1000}s`}
                  fill="freeze"
                  calcMode="spline"
                  keyTimes="0;1"
                  keySplines="0.4 0 0.2 1"
                  path={`M ${SCENARIO_RIGHT},300 C 320,300 320,${ys[replayToolIdx]} 420,${ys[replayToolIdx]} C 520,${ys[replayToolIdx]} 520,300 620,300`}
                />
              </circle>
            )}

            {/* Scenario card: what will run, or where to drop one. */}
            <foreignObject x="40" y="250" width={SCENARIO_RIGHT - 40} height="100">
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  padding: "10px 12px",
                  borderRadius: 10,
                  background: dragOver ? "var(--accent-soft)" : scenarioLabel ? "var(--bg-sunken)" : "transparent",
                  border: scenarioLabel
                    ? `1.5px solid ${dragOver ? "var(--accent)" : "transparent"}`
                    : `1.5px dashed ${dragOver ? "var(--accent)" : "var(--ink-300)"}`,
                  transition: "background 120ms, border-color 120ms",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ fontSize: 11, color: "var(--ink-500)" }}>
                  {scenarioLabel ? "Scenario" : dragOver ? "Drop to set the scenario" : "Drag a scenario here"}
                </div>
                {scenarioLabel && (
                  <div
                    style={{
                      fontSize: 13, fontWeight: 600, color: "var(--ink-900)", marginTop: 2,
                      overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                    }}
                  >
                    {scenarioLabel}
                  </div>
                )}
              </div>
            </foreignObject>

            {/* Tool nodes */}
            {ys.map((y, i) => {
              const stats = byTool.get(nodes[i].toLowerCase());
              const ring = stats ? DECISION_COLOR[stats.worst] : null;
              const isActive = active === i;
              const isCurrent = replayToolIdx === i;
              const r = isCurrent ? 16 : isActive ? 15 : 12;
              const nums = stats?.stepNums ?? [];
              const numText = nums.length > 3 ? `${nums.slice(0, 3).join(", ")}…` : nums.join(", ");
              return (
                <g
                  key={`node-${i}`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${nodes[i]}${stats ? `, called at step ${nums.join(", ")}, ${DECISION_LABEL[stats.worst]}` : lastRun ? ", not called in the last run" : ", not run yet"}`}
                  style={{ cursor: "pointer", outline: "none" }}
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
                  onFocus={() => setHovered(i)}
                  onBlur={() => setHovered((h) => (h === i ? null : h))}
                  onClick={() => setPinned((p) => (p === i ? null : i))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setPinned((p) => (p === i ? null : i));
                    }
                  }}
                >
                  {/* Generous invisible hit area — a 12px circle is a hard target */}
                  <circle cx="420" cy={y} r="30" fill="transparent" />
                  {ring && (
                    <circle
                      cx="420"
                      cy={y}
                      r={r + 6}
                      fill="none"
                      stroke={ring}
                      strokeWidth="2"
                      opacity={isActive || isCurrent ? 1 : 0.7}
                      style={{ transition: "r 300ms ease, opacity 300ms ease" }}
                    />
                  )}
                  {isCurrent && !reduceMotion && (
                    <circle cx="420" cy={y} r={r + 6} fill="none" stroke="var(--accent)" strokeWidth="2" className="sim-pulse" />
                  )}
                  <circle
                    cx="420"
                    cy={y}
                    r={r}
                    fill={isCurrent ? "var(--accent)" : stats ? "var(--chart-tools)" : "var(--ink-300)"}
                    style={{ transition: "r 300ms ease, fill 300ms ease" }}
                  />
                  {/* Step numbers this tool was called at, under the node */}
                  {numText && (
                    <text
                      x="420"
                      y={y + 30}
                      fontSize="10.5"
                      textAnchor="middle"
                      fill={ring ?? "var(--ink-500)"}
                      {...HALO}
                      style={{ pointerEvents: "none" }}
                    >
                      {lastRun?.predicted
                        ? `${nums.length === 1 ? "Call" : "Calls"} ${numText}`
                        : `${nums.length === 1 ? "Step" : "Steps"} ${numText}`}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Result node — fills with batch progress while a run is in flight,
                then takes the colour of the run's worst decision. */}
            {(() => {
              const openable = !running && !!lastRun && !!onOpenResult;
              const counts = { ALLOW: 0, REQUIRE_APPROVAL: 0, BLOCK: 0 } as Record<string, number>;
              (lastRun?.steps ?? []).forEach((st) => { counts[decisionOf(st)] = (counts[decisionOf(st)] ?? 0) + 1; });
              const summary = [
                `${counts.ALLOW} allowed`,
                counts.REQUIRE_APPROVAL ? `${counts.REQUIRE_APPROVAL} held for approval` : null,
                counts.BLOCK ? `${counts.BLOCK} blocked` : null,
              ].filter(Boolean).join(", ");
              return (
                <g
                  role={openable ? "link" : undefined}
                  tabIndex={openable ? 0 : undefined}
                  aria-label={openable ? `Result: ${summary}. Open the full report` : undefined}
                  style={{ cursor: openable ? "pointer" : "default", outline: "none" }}
                  onClick={() => openable && onOpenResult!(lastRun!.id)}
                  onKeyDown={(e) => {
                    if (openable && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onOpenResult!(lastRun!.id);
                    }
                  }}
                  onMouseEnter={() => openable && setResultHover(true)}
                  onMouseLeave={() => setResultHover(false)}
                  onFocus={() => openable && setResultHover(true)}
                  onBlur={() => setResultHover(false)}
                >
                  <circle cx="620" cy="300" r="30" fill="transparent" />
                  {openable && resultHover && (
                    <circle cx="620" cy="300" r="22" fill="none" stroke={resultColor} strokeWidth="2" opacity="0.5" />
                  )}
                  <circle cx="620" cy="300" r="16" fill={resultColor} opacity={running ? 0.25 : 1} />
                  {openable && (
                    <>
                      {/* hit area over the label too, so the words are clickable */}
                      <rect x="585" y="356" width="70" height="16" fill="transparent" />
                      <text
                        x="620" y="368" fontSize="10.5" textAnchor="middle" textDecoration="underline"
                        fill={resultHover ? "var(--ink-800)" : "var(--ink-500)"} {...HALO}
                      >
                        View report
                      </text>
                    </>
                  )}
                  <title>{openable ? `${summary}. Click to open the full report.` : "Result"}</title>
                </g>
              );
            })()}
            {running && (
              <circle
                cx="620"
                cy="300"
                r="16"
                fill="none"
                stroke="var(--cyan-ring)"
                strokeWidth="4"
                strokeDasharray={`${progressPct * 100.5} 100.5`}
                transform="rotate(-90 620 300)"
                style={{ transition: "stroke-dasharray 400ms" }}
              />
            )}

            <g
              fill="var(--ink-700)"
              fontFamily="inherit"
              fontSize="12"
              fontWeight="500"
              textAnchor="middle"
              style={{ pointerEvents: "none" }}
            >
              {nodes.map((t, i) => (
                <text
                  key={t + i}
                  x="420"
                  y={ys[i] - 24}
                  fill={replayToolIdx === i ? "var(--accent)" : "var(--ink-700)"}
                  {...HALO}
                  style={{ transition: "fill 300ms ease" }}
                >
                  {titleCase(t)}
                </text>
              ))}
              <text x="620" y="334" {...HALO}>Result</text>
              {!running && runWorst && (
                <text x="620" y="350" fontSize="11" fontWeight="400" fill={DECISION_COLOR[runWorst]} {...HALO}>
                  {runWorst === "ALLOW" ? "All allowed" : runWorst === "BLOCK" ? "Blocked" : "Held"}
                </text>
              )}

            </g>
          </>
        )}

        {n === 0 && (
          <text x="360" y="300" textAnchor="middle" fill="var(--ink-400)" fontSize="13">
            Select an agent to see its tools
          </text>
        )}
      </svg>

      {/* Replay control — only offered when there is a real trace to replay */}
      {lastRun && lastRun.steps.length > 0 && !running && (
        <button
          type="button"
          onClick={() => setReplayAt((v) => (v === null ? 0 : null))}
          className="absolute top-0 right-4 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
          style={{
            background: "var(--card)",
            borderColor: "var(--line)",
            color: replayAt === null ? "var(--ink-600)" : "var(--accent)",
          }}
        >
          {replayAt === null ? <Play size={12} /> : <Square size={12} />}
          {replayAt === null ? "Replay" : "Stop"}
        </button>
      )}

      {/* The step being played, in words */}
      {replayStep && (
        <div
          key={`caption-${replayAt}`}
          className="absolute left-4 top-0 rounded-md px-3 py-1.5 pointer-events-none text-xs"
          style={{ background: "var(--bg-sunken)", color: "var(--ink-700)" }}
        >
          {lastRun!.predicted ? "Likely call" : "Step"} {replayAt! + 1} of {lastRun!.steps.length}:{" "}
          {lastRun!.predicted ? "it would call " : "the agent called "}
          <strong style={{ fontWeight: 600 }}>{toolLabel(replayStep.tool, nodes)}</strong> to {humanAction(replayStep.action)}.{" "}
          <span style={{ color: DECISION_COLOR[decisionOf(replayStep)], fontWeight: 600 }}>
            {titleCase(DECISION_LABEL[decisionOf(replayStep)])}.
          </span>
        </div>
      )}

      {/* What the focused tool did on the last run */}
      {tip && !replayStep && (
        <div
          className="absolute left-4 top-0 rounded-md px-3 py-2 pointer-events-none"
          style={{ background: "var(--bg-sunken)", maxWidth: 300 }}
        >
          <div className="text-sm font-medium" style={{ color: "var(--ink-900)" }}>{titleCase(tip)}</div>
          {tipStats ? (
            <>
              <div className="text-xs mt-0.5" style={{ color: "var(--ink-600)" }}>
                {tipStats.stepNums.length} {tipStats.stepNums.length === 1 ? "call" : "calls"} last run,{" "}
                <span style={{ color: DECISION_COLOR[tipStats.worst] }}>{DECISION_LABEL[tipStats.worst]}</span>
              </div>
              <div className="font-monospace-label text-monospace-label mt-1 truncate" style={{ color: "var(--ink-500)" }}>
                {tipStats.actions.join(", ")}
              </div>
            </>
          ) : (
            <div className="text-xs mt-0.5" style={{ color: "var(--ink-600)" }}>
              {lastRun ? "Not called in the last run" : "Not run yet"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Every call in the run, in words, under the canvas. Follows playback and
 *  jumps the canvas to a call when one is clicked. */
export function StepList({
  run,
  tools,
  current,
  onSelect,
}: {
  run: CanvasRun;
  /** The agent's tool names, for display spelling. */
  tools: string[];
  current: number | null;
  onSelect: (i: number) => void;
}): React.ReactElement {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h3 className="font-eyebrow text-eyebrow text-neutral-secondary uppercase m-0">
          {run.predicted ? "Calls it would likely make" : "What the agent did"}
        </h3>
        <span className="text-xs text-gray-400">
          {run.predicted
            ? "Dry run: ranked most likely first, not in time order"
            : "In the order they happened"}
        </span>
      </div>
      <ol className="m-0 p-0" style={{ listStyle: "none" }}>
        {run.steps.map((st, i) => {
          const d = decisionOf(st);
          const on = current === i;
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => onSelect(i)}
                className="w-full flex items-center gap-3 text-left text-sm px-2 py-1.5 rounded-md border-0 cursor-pointer transition-colors hover:bg-gray-50"
                style={{ background: on ? "var(--bg-sunken)" : "transparent", fontFamily: "inherit" }}
              >
                <span className="text-xs tabular-nums w-5 text-right" style={{ color: on ? "var(--accent)" : "var(--ink-400)" }}>
                  {i + 1}
                </span>
                <span className="font-medium" style={{ color: "var(--ink-800)", minWidth: 84 }}>{toolLabel(st.tool, tools)}</span>
                <span className="flex-1 truncate" style={{ color: "var(--ink-600)" }}>{titleCase(humanAction(st.action))}</span>
                <span className="text-xs font-medium" style={{ color: DECISION_COLOR[d] }}>{titleCase(DECISION_LABEL[d])}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
