/**
 * Simulation canvas — the node graph on the Sandbox stage.
 *
 * Same picture as before (grid, bezier edges, mono labels, identical node
 * geometry), but it now reports real state instead of decorating the card:
 *
 *  · Idle — one node per tool the selected agent can actually call. Hovering
 *    or tabbing to a node lifts it, brightens the edges it sits on, and shows
 *    what the last run did through that tool.
 *  · Last run — each node wears a ring in the colour of the worst enforcement
 *    decision that tool drew (allow / require-approval / block), so the graph
 *    answers "where did this agent get stopped?" at a glance.
 *  · Replay — walks the recorded trace step by step, lighting each node in the
 *    order the agent actually called it.
 *  · Running — the edges flow and the output node fills with batch progress.
 *
 * Motion is suppressed under prefers-reduced-motion; every state stays
 * readable from the rings and labels alone.
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
  scenario: string;
  steps: CanvasStep[];
}

interface Props {
  tools: string[];
  running: boolean;
  progress: { current: number; total: number } | null;
  lastRun?: CanvasRun | null;
}

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

const STEP_MS = 900;

export default function SimulationCanvas({ tools, running, progress, lastRun }: Props): React.ReactElement {
  const nodes = tools.slice(0, 6);
  const n = nodes.length;
  const ys = useMemo(
    () => (n === 0 ? [] : n === 1 ? [300] : nodes.map((_, i) => 150 + (i * 300) / (n - 1))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [n],
  );

  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const timer = useRef<number | null>(null);

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  /** Per-tool rollup of the recorded trace: calls, worst decision, actions. */
  const byTool = useMemo(() => {
    const map = new Map<string, { calls: number; worst: string; actions: string[] }>();
    for (const s of lastRun?.steps ?? []) {
      const key = s.tool.toLowerCase();
      const cur = map.get(key) ?? { calls: 0, worst: "ALLOW", actions: [] };
      cur.calls += 1;
      const d = (s.decision || "ALLOW").toUpperCase();
      if (DECISION_RANK.indexOf(d) > DECISION_RANK.indexOf(cur.worst)) cur.worst = d;
      if (!cur.actions.includes(s.action)) cur.actions.push(s.action);
      map.set(key, cur);
    }
    return map;
  }, [lastRun]);

  // Replay ticks through the recorded steps; a real run cancels it. The final
  // step holds for its full beat and then ends — advancing past it left the
  // control reading "Step 1/1" with nothing lit.
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

  const replayStep = replayAt !== null ? lastRun?.steps[replayAt] : undefined;
  const replayToolIdx = replayStep
    ? nodes.findIndex((t) => t.toLowerCase() === replayStep.tool.toLowerCase())
    : -1;

  const active = pinned ?? hovered;
  const flowing = running || replayAt !== null;
  const progressPct = progress && progress.total > 0 ? progress.current / progress.total : 0;

  const tip = active !== null && nodes[active] !== undefined ? nodes[active] : null;
  const tipStats = tip ? byTool.get(tip.toLowerCase()) : undefined;

  return (
    <div className="absolute inset-0 top-16 rounded-b-lg z-0">
      <svg
        className="w-full h-full"
        preserveAspectRatio="xMidYMid meet"
        viewBox="0 0 800 600"
        role="img"
        aria-label={
          n === 0
            ? "No agent selected"
            : `Tool graph: scenario through ${nodes.join(", ")} to trace`
        }
      >
        <defs>
          <pattern id="sandbox-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--line)" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#sandbox-grid)" opacity="0.7" />

        {n > 0 && (
          <>
            {/* Edges. An edge brightens when its node is focused, when replay is
                on that step, or while a run is in flight. */}
            {ys.map((y, i) => {
              const lit = flowing || active === i || replayToolIdx === i;
              const stroke = replayToolIdx === i ? "var(--accent)" : lit ? "var(--accent-line)" : "var(--ink-300)";
              const w = replayToolIdx === i ? 2.5 : lit ? 2 : 1.5;
              return (
                <g key={`edge-${i}`} fill="none" stroke={stroke} strokeWidth={w} style={{ transition: "stroke 180ms" }}>
                  <path
                    d={`M 200,300 C 300,300 300,${y} 400,${y}`}
                    className={flowing && !reduceMotion ? "sim-edge-flow" : undefined}
                  />
                  <path
                    d={`M 400,${y} C 500,${y} 500,300 600,300`}
                    className={flowing && !reduceMotion ? "sim-edge-flow" : undefined}
                  />
                </g>
              );
            })}

            {/* Input node */}
            <circle cx="200" cy="300" r="16" fill="var(--accent)" />
            {flowing && !reduceMotion && (
              <circle cx="200" cy="300" r="16" fill="none" stroke="var(--accent)" strokeWidth="2" className="sim-pulse" />
            )}

            {/* Tool nodes */}
            {ys.map((y, i) => {
              const stats = byTool.get(nodes[i].toLowerCase());
              const ring = stats ? DECISION_COLOR[stats.worst] : null;
              const isActive = active === i;
              const isReplay = replayToolIdx === i;
              const r = isReplay ? 16 : isActive ? 15 : 12;
              return (
                <g
                  key={`node-${i}`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${nodes[i]}${stats ? `, ${stats.calls} calls last run, ${DECISION_LABEL[stats.worst]}` : ", not called in the last run"}`}
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
                  <circle cx="400" cy={y} r="30" fill="transparent" />
                  {ring && (
                    <circle
                      cx="400"
                      cy={y}
                      r={r + 6}
                      fill="none"
                      stroke={ring}
                      strokeWidth="2"
                      opacity={isActive || isReplay ? 1 : 0.6}
                      style={{ transition: "r 180ms, opacity 180ms" }}
                    />
                  )}
                  {isReplay && !reduceMotion && (
                    <circle cx="400" cy={y} r={r + 6} fill="none" stroke="var(--accent)" strokeWidth="2" className="sim-pulse" />
                  )}
                  <circle
                    cx="400"
                    cy={y}
                    r={r}
                    fill={isReplay ? "var(--accent)" : "var(--chart-tools)"}
                    style={{ transition: "r 180ms, fill 180ms" }}
                  />
                </g>
              );
            })}

            {/* Output node — fills with batch progress while a run is in flight.
                Cyan, not the aquamarine "controlled" tone: progress is activity,
                not a safety verdict, and the run has not reached one yet. */}
            <circle cx="600" cy="300" r="16" fill="var(--cyan-ring)" opacity={running ? 0.25 : 1} />
            {running && (
              <circle
                cx="600"
                cy="300"
                r="16"
                fill="none"
                stroke="var(--cyan-ring)"
                strokeWidth="4"
                strokeDasharray={`${progressPct * 100.5} 100.5`}
                transform="rotate(-90 600 300)"
                style={{ transition: "stroke-dasharray 400ms" }}
              />
            )}

            <g
              fill="var(--ink-700)"
              fontFamily="var(--font-num)"
              fontSize="11"
              fontWeight="500"
              textAnchor="middle"
              style={{ pointerEvents: "none" }}
            >
              <text x="200" y="332">SCENARIO</text>
              {nodes.map((t, i) => (
                <text
                  key={t + i}
                  x="400"
                  y={ys[i] - (replayToolIdx === i || active === i ? 26 : 22)}
                  fill={replayToolIdx === i ? "var(--accent)" : "var(--ink-700)"}
                >
                  {t.toUpperCase()}
                </text>
              ))}
              <text x="600" y="332">TRACE</text>
            </g>
          </>
        )}

        {n === 0 && (
          <text
            x="400"
            y="300"
            textAnchor="middle"
            fill="var(--ink-400)"
            fontFamily="var(--font-num)"
            fontSize="12"
          >
            SELECT AN AGENT TO MAP ITS TOOLS
          </text>
        )}
      </svg>

      {/* Replay control — only offered when there is a real trace to replay */}
      {lastRun && lastRun.steps.length > 0 && !running && (
        <button
          type="button"
          onClick={() => setReplayAt((v) => (v === null ? 0 : null))}
          className="absolute top-3 right-4 flex items-center gap-1.5 px-2.5 py-1 rounded-full font-monospace-label text-monospace-label border cursor-pointer transition-colors"
          style={{
            background: "var(--card)",
            borderColor: "var(--line)",
            color: replayAt === null ? "var(--ink-600)" : "var(--accent)",
          }}
        >
          {replayAt === null ? <Play size={12} /> : <Square size={12} />}
          {replayAt === null ? "Replay last run" : `Step ${replayAt + 1}/${lastRun.steps.length}`}
        </button>
      )}

      {/* What the focused node did on the last run */}
      {tip && (
        <div
          /* Clear of the run pill, which sits bottom-centre. */
          className="absolute left-4 bottom-24 rounded-lg px-3 py-2 pointer-events-none"
          style={{ background: "var(--card)", boxShadow: "var(--shadow-md)", maxWidth: 300 }}
        >
          <div className="font-monospace-data text-monospace-data text-on-surface">{tip}</div>
          {tipStats ? (
            <>
              <div className="font-meta text-meta text-neutral-secondary mt-0.5">
                {tipStats.calls} {tipStats.calls === 1 ? "call" : "calls"} last run ·{" "}
                <span style={{ color: DECISION_COLOR[tipStats.worst] }}>{DECISION_LABEL[tipStats.worst]}</span>
              </div>
              <div className="font-monospace-label text-monospace-label text-neutral-muted mt-1 truncate">
                {tipStats.actions.join(", ")}
              </div>
            </>
          ) : (
            <div className="font-meta text-meta text-neutral-secondary mt-0.5">
              {lastRun ? "Not called in the last run" : "No recorded run yet"}
            </div>
          )}
        </div>
      )}

      {/* Which step the replay is on, in words */}
      {replayStep && (
        <div
          className="absolute left-4 top-3 rounded-lg px-3 py-1.5 pointer-events-none"
          style={{ background: "var(--card)", boxShadow: "var(--shadow-md)" }}
        >
          <span className="font-monospace-data text-monospace-data text-on-surface">
            {replayStep.tool}.{replayStep.action}
          </span>
          <span
            className="font-monospace-label text-monospace-label ml-2"
            style={{ color: DECISION_COLOR[(replayStep.decision || "ALLOW").toUpperCase()] }}
          >
            {(replayStep.decision || "ALLOW").toUpperCase()}
          </span>
        </div>
      )}
    </div>
  );
}
