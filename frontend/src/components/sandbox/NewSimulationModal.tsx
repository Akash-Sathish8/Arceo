/**
 * "Configure Simulation" dialog — ported from the Stitch canvas
 * (New Simulation Setup / Expanded Options). Opens from the Sandbox header's
 * "New Simulation" button.
 *
 * Canvas structure, kept exactly: scrim over graphite at 50% with a 2px blur,
 * a max-w-2xl card, a header band, then Agent selection → Scenario template
 * (3 featured cards plus a dashed "Custom or More…") → a Configuration
 * overrides block with three labelled toggles, then Cancel / Create Simulation
 * on a sunken footer.
 *
 * The canvas's scenarios are invented (TPL-84X "Hostile Takeover"); the cards
 * here render the agent's real scenario catalogue, with the real scenario id on
 * the ID line and an icon keyed to the scenario's own category and severity.
 */

import { useEffect, useRef } from "react";
import {
  Activity, AlertTriangle, FileUp, KeyRound, Link2, PlusCircle, ChevronsUpDown,
  Search, Gauge, Check,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface ModalScenario {
  id: string;
  name: string;
  description: string;
  category?: string;
  severity?: string;
}

export interface ModalAgent {
  id: string;
  name: string;
}

/** The sentinel the "Custom or More…" card selects. */
export const CUSTOM_SCENARIO_ID = "__custom__";

/**
 * Why the run is happening. The two answers want different scenarios and
 * different settings, and conflating them is how someone ends up running an
 * adversarial dry run and wondering why their forecast is still LOW.
 *
 * `explore` — probe what could go wrong. Any scenario, dry run allowed.
 * `calibrate` — measure how this agent actually behaves so the forecast can
 *   leave the capability-only tier. Normal-path scenarios, real model, no
 *   dry run (see CALIBRATION_NOTE).
 */
export type RunPurpose = "explore" | "calibrate";

/** The one constraint the calibrate path cannot bend, stated where it is set.
 *  `_sandbox_traces_for_tier` selects `run_mode = 'live'` only, and
 *  `compute_sandbox_averages` needs `turn_usage` with non-zero tokens — a dry
 *  run appends neither, so it is not a weaker measurement but no measurement. */
export const CALIBRATION_NOTE =
  "A dry run records no token usage, so it cannot move the forecast. This runs against the real model.";

const CATEGORY_ICON: Record<string, LucideIcon> = {
  adversarial: AlertTriangle,
  chain_exploit: Link2,
  edge_case: FileUp,
  normal: Activity,
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--critical)",
  high: "var(--high)",
  medium: "var(--caution)",
  low: "var(--safe)",
};

function scenarioIcon(s: ModalScenario): { Icon: LucideIcon; color: string } {
  const Icon = CATEGORY_ICON[s.category ?? "normal"] ?? KeyRound;
  const color = SEVERITY_COLOR[(s.severity ?? "").toLowerCase()] ?? "var(--ink-500)";
  return { Icon, color };
}

interface Props {
  open: boolean;
  onClose: () => void;
  agents: ModalAgent[];
  agentId: string;
  onAgentChange: (id: string) => void;
  purpose: RunPurpose;
  onPurposeChange: (p: RunPurpose) => void;
  /** The normal-path scenarios the calibrate path will run, in order. */
  calibrationScenarios: ModalScenario[];
  /** This agent's current forecast tier, so the dialog can say what the run
   *  will actually change rather than promising a jump it may not produce. */
  currentConfidence?: "low" | "medium" | "high" | null;
  /** More than one agent means a bulk calibration queued from the fleet spend
   *  page — the agent picker gives way to the queue it was handed. */
  queuedAgents?: ModalAgent[];
  /** Full catalogue; the first three are featured as cards. */
  scenarios: ModalScenario[];
  scenarioId: string;
  onScenarioChange: (id: string) => void;
  strictMode: boolean;
  onStrictModeChange: (v: boolean) => void;
  mockExternal: boolean;
  onMockExternalChange: (v: boolean) => void;
  debugLogging: boolean;
  onDebugLoggingChange: (v: boolean) => void;
  onCreate: () => void;
  creating?: boolean;
}

export default function NewSimulationModal({
  open, onClose, agents, agentId, onAgentChange,
  purpose, onPurposeChange, calibrationScenarios, currentConfidence,
  queuedAgents = [],
  scenarios, scenarioId, onScenarioChange,
  strictMode, onStrictModeChange,
  mockExternal, onMockExternalChange,
  debugLogging, onDebugLoggingChange,
  onCreate, creating = false,
}: Props): React.ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes; focus lands inside so the dialog is keyboard-reachable.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const featured = scenarios.slice(0, 3);
  const calibrating = purpose === "calibrate";
  const queued = calibrating && queuedAgents.length > 1 ? queuedAgents : [];
  const runCount = queued.length || 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto"
      style={{ background: "rgba(30, 40, 54, 0.5)", backdropFilter: "blur(2px)" }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="configure-simulation-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl bg-surface-container-lowest border border-neutral-border rounded-lg flex flex-col my-auto outline-none"
        style={{ boxShadow: "0 4px 24px rgba(30, 40, 54, 0.08), 0 1px 2px rgba(15,15,15,0.03)" }}
      >
        {/* Header */}
        <div className="px-8 pt-8 pb-6 border-b border-neutral-border">
          <h2
            id="configure-simulation-title"
            className="text-page-title font-page-title text-on-surface mb-2 tracking-tight m-0"
          >
            Configure Simulation
          </h2>
          <p className="text-body font-body text-neutral-secondary leading-relaxed m-0">
            Define the parameters for this run. Agents will execute tools within the isolated sandbox environment.
          </p>
        </div>

        {/* Body */}
        <div className="p-8 space-y-8">
          {/* Run purpose — asked first, because it changes what the rest of the
              dialog offers. */}
          <div className="flex flex-col gap-3">
            <span className="text-eyebrow font-eyebrow text-neutral-secondary uppercase tracking-widest">
              Run Purpose
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <PurposeCard
                Icon={Search}
                title="Explore risk"
                description="Probe what this agent could do wrong. Any scenario, dry run or real model."
                checked={!calibrating}
                onSelect={() => onPurposeChange("explore")}
              />
              <PurposeCard
                Icon={Gauge}
                title="Calibrate the forecast"
                description={
                  currentConfidence === "low"
                    ? "Measure how this agent behaves so its spend forecast leaves LOW confidence."
                    : "Re-measure this agent's behaviour to refresh the sandbox basis of its forecast."
                }
                checked={calibrating}
                onSelect={() => onPurposeChange("calibrate")}
              />
            </div>
          </div>

          {/* Agent selection — replaced by the queue when the fleet page has
              already chosen who runs. */}
          {queued.length > 0 ? (
            <div className="flex flex-col gap-3">
              <span className="text-eyebrow font-eyebrow text-neutral-secondary uppercase tracking-widest">
                Queue &middot; {queued.length} agents
              </span>
              <div className="rounded border border-neutral-border divide-y divide-neutral-border">
                {queued.map((a) => (
                  <div key={a.id} className="px-5 py-3 flex items-center justify-between gap-3">
                    <span className="text-body font-body text-on-surface truncate">{a.name}</span>
                    <span className="text-monospace-label font-monospace-label text-neutral-secondary shrink-0">
                      LOW
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-meta font-meta text-neutral-secondary m-0">
                Runs one after another, {calibrationScenarios.length} scenarios each, for{" "}
                {queued.length * calibrationScenarios.length} simulations in total.
              </p>
            </div>
          ) : (
          <div className="flex flex-col gap-3">
            <label
              htmlFor="configure-simulation-agent"
              className="text-eyebrow font-eyebrow text-neutral-secondary uppercase tracking-widest"
            >
              Agent Selection
            </label>
            <div className="relative group">
              <select
                id="configure-simulation-agent"
                value={agentId}
                onChange={(e) => onAgentChange(e.target.value)}
                className="w-full appearance-none bg-surface-container-lowest border border-neutral-border text-on-surface font-body text-body py-3 pl-4 pr-10 rounded focus:outline-none focus:border-primary transition-colors cursor-pointer"
              >
                {agents.length === 0 && <option value="">No agents yet</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-neutral-secondary">
                <ChevronsUpDown size={20} strokeWidth={1.8} />
              </div>
            </div>
          </div>
          )}

          {/* What a calibration run does — shown in place of the scenario
              picker, because the whole point is that the run is chosen FOR you
              from what the forecaster can actually read. */}
          {calibrating && (
            <div className="flex flex-col gap-3">
              <span className="text-eyebrow font-eyebrow text-neutral-secondary uppercase tracking-widest">
                What This Run Does
              </span>
              <div className="rounded border border-neutral-border overflow-hidden">
                <div className="px-5 py-4 flex flex-col gap-2.5">
                  <CalibrationLine>
                    Runs {calibrationScenarios.length}{" "}
                    {calibrationScenarios.length === 1 ? "normal-path scenario" : "normal-path scenarios"},
                    not adversarial ones. The forecast wants typical behaviour, not a worst case.
                  </CalibrationLine>
                  <CalibrationLine>
                    Records turns per run and tokens per turn from the trace, replacing the
                    archetype defaults the forecast falls back on today.
                  </CalibrationLine>
                  <CalibrationLine>
                    {currentConfidence === "low"
                      ? "Lifts the forecast from LOW to MEDIUM confidence (about \u00b128%)."
                      : "Refreshes the measurement behind the current MEDIUM-tier band."}{" "}
                    HIGH needs live production traffic, which a sandbox run cannot supply.
                  </CalibrationLine>
                </div>
                {calibrationScenarios.length > 0 && (
                  <div className="px-5 py-3 border-t border-neutral-border bg-neutral-sunken flex flex-wrap gap-x-2 gap-y-1">
                    {calibrationScenarios.map((sc, i) => (
                      <span key={sc.id} className="text-monospace-label font-monospace-label text-neutral-secondary">
                        {i > 0 && <span className="text-neutral-muted mr-2">&middot;</span>}
                        {sc.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-meta font-meta text-neutral-secondary m-0">{CALIBRATION_NOTE}</p>
            </div>
          )}

          {/* Scenario template */}
          {!calibrating && (
          <div className="flex flex-col gap-3">
            <span className="text-eyebrow font-eyebrow text-neutral-secondary uppercase tracking-widest">
              Scenario Template
            </span>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {featured.map((s) => {
                const { Icon, color } = scenarioIcon(s);
                const checked = scenarioId === s.id;
                return (
                  <label key={s.id} className="relative block h-full cursor-pointer group">
                    <input
                      type="radio"
                      name="configure-simulation-scenario"
                      className="peer sr-only"
                      value={s.id}
                      checked={checked}
                      onChange={() => onScenarioChange(s.id)}
                    />
                    <div
                      className="h-full bg-surface-container-lowest rounded p-4 flex flex-col gap-2 transition-all"
                      style={{
                        border: `1px solid ${checked ? "var(--accent)" : "var(--line)"}`,
                        background: checked ? "var(--accent-soft)" : "var(--card)",
                      }}
                    >
                      <div className="flex justify-between items-start">
                        <Icon size={20} strokeWidth={1.9} style={{ color, marginBottom: 4 }} />
                        <span
                          className="w-4 h-4 rounded-full flex items-center justify-center transition-colors"
                          style={{ border: `1px solid ${checked ? "var(--accent)" : "var(--line)"}` }}
                        >
                          <span
                            className="w-2 h-2 rounded-full transition-transform"
                            style={{
                              background: "var(--accent)",
                              transform: checked ? "scale(1)" : "scale(0)",
                            }}
                          />
                        </span>
                      </div>
                      <div className="text-card-title font-card-title text-on-surface">{s.name}</div>
                      <div className="text-meta font-meta text-neutral-secondary leading-snug">
                        {s.description}
                      </div>
                      <div className="mt-auto pt-3 min-w-0">
                        <span
                          title={s.id}
                          className="text-monospace-label font-monospace-label text-neutral-muted block truncate"
                        >
                          ID: {s.id.toUpperCase()}
                        </span>
                      </div>
                    </div>
                  </label>
                );
              })}

              {/* Custom or More… — the route to the full catalogue and to a
                  hand-written scenario prompt. */}
              <label className="relative block h-full cursor-pointer group">
                <input
                  type="radio"
                  name="configure-simulation-scenario"
                  className="peer sr-only"
                  value={CUSTOM_SCENARIO_ID}
                  checked={scenarioId === CUSTOM_SCENARIO_ID}
                  onChange={() => onScenarioChange(CUSTOM_SCENARIO_ID)}
                />
                <div
                  className="h-full rounded p-4 flex flex-col gap-2 transition-all"
                  style={{
                    border: `1px dashed ${scenarioId === CUSTOM_SCENARIO_ID ? "var(--accent)" : "var(--line)"}`,
                    background: scenarioId === CUSTOM_SCENARIO_ID ? "var(--accent-soft)" : "var(--card)",
                  }}
                >
                  <div className="flex justify-between items-start">
                    <PlusCircle size={20} strokeWidth={1.9} style={{ color: "var(--ink-500)", marginBottom: 4 }} />
                    <span
                      className="w-4 h-4 rounded-full flex items-center justify-center transition-colors"
                      style={{ border: `1px solid ${scenarioId === CUSTOM_SCENARIO_ID ? "var(--accent)" : "var(--line)"}` }}
                    >
                      <span
                        className="w-2 h-2 rounded-full transition-transform"
                        style={{
                          background: "var(--accent)",
                          transform: scenarioId === CUSTOM_SCENARIO_ID ? "scale(1)" : "scale(0)",
                        }}
                      />
                    </span>
                  </div>
                  <div className="text-card-title font-card-title text-on-surface">Custom or More…</div>
                  <div className="text-meta font-meta text-neutral-secondary leading-snug">
                    Browse the full library or write a custom scenario prompt.
                  </div>
                  <div className="mt-auto pt-3">
                    <span className="text-monospace-label font-monospace-label text-neutral-muted">ID: CUSTOM</span>
                  </div>
                </div>
              </label>
            </div>
          </div>
          )}

          {/* Configuration overrides */}
          <div className="flex flex-col rounded border border-neutral-border overflow-hidden">
            <div className="px-5 py-3 border-b border-neutral-border bg-neutral-sunken">
              <span className="text-eyebrow font-eyebrow text-neutral-secondary uppercase tracking-widest">
                Configuration Overrides
              </span>
            </div>
            <div className="flex flex-col divide-y divide-neutral-border">
              {/* Strict mode and debug logging are held here and shown on the
                  run, but /api/sandbox/simulate takes only `dry_run` today —
                  they reach the engine once it accepts them. */}
              <OverrideRow
                label="Strict Mode"
                description="Fail execution immediately upon single policy violation."
                checked={strictMode}
                onChange={onStrictModeChange}
              />
              <OverrideRow
                label="Mock External APIs"
                description={
                  calibrating
                    ? "Off for calibration \u2014 a mocked run never calls the model, so it measures nothing."
                    : "Intercept outbound calls and return deterministic JSON responses."
                }
                checked={calibrating ? false : mockExternal}
                onChange={onMockExternalChange}
                disabled={calibrating}
              />
              <OverrideRow
                label="Enable Debug Logging"
                description="Capture verbose trace events and state changes."
                checked={debugLogging}
                onChange={onDebugLoggingChange}
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-8 py-5 border-t border-neutral-border bg-neutral-sunken flex items-center justify-end gap-3 rounded-b-lg">
          <button
            type="button"
            onClick={onClose}
            className="btn btn--secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCreate}
            disabled={
              creating ||
              (queued.length === 0 && !agentId) ||
              (calibrating ? calibrationScenarios.length === 0 : !scenarioId)
            }
            className="btn btn--primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating
              ? (calibrating ? "Calibrating…" : "Creating…")
              : calibrating
                ? (queued.length > 0 ? `Run ${runCount} calibrations` : "Run calibration")
                : "Create Simulation"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One override row: label, description, and the canvas's 40×20 switch. */
function OverrideRow({
  label, description, checked, onChange, disabled = false,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label
      className="flex items-center justify-between gap-4 px-5 py-4 transition-colors"
      style={{
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span className="flex flex-col">
        <span className="text-body font-body font-medium text-on-surface">{label}</span>
        <span className="text-meta font-meta text-neutral-secondary">{description}</span>
      </span>
      <span className="relative inline-flex items-center shrink-0">
        <input
          type="checkbox"
          className="sr-only peer"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          className="w-10 h-5 rounded-full relative transition-colors"
          style={{ background: checked ? "var(--accent)" : "var(--surface-variant, #e2e2e9)" }}
        >
          <span
            className="absolute top-[2px] h-4 w-4 rounded-full border transition-all"
            style={{ left: checked ? 22 : 2, background: "#ffffff", borderColor: "var(--line)" }}
          />
        </span>
      </span>
    </label>
  );
}

/** One choice of run purpose. Same selected treatment as the scenario cards so
 *  the two rows read as the same kind of control. */
function PurposeCard({
  Icon, title, description, checked, onSelect,
}: {
  Icon: LucideIcon
  title: string
  description: string
  checked: boolean
  onSelect: () => void
}) {
  return (
    <label className="relative block h-full cursor-pointer">
      <input
        type="radio"
        name="configure-simulation-purpose"
        className="sr-only"
        checked={checked}
        onChange={onSelect}
      />
      <div
        className="h-full rounded p-4 flex gap-3 transition-all"
        style={{
          border: `1px solid ${checked ? "var(--accent)" : "var(--line)"}`,
          background: checked ? "var(--accent-soft)" : "var(--card)",
        }}
      >
        <Icon
          size={20}
          strokeWidth={1.9}
          className="shrink-0 mt-0.5"
          style={{ color: checked ? "var(--accent)" : "var(--ink-500)" }}
        />
        <span className="flex flex-col gap-1 min-w-0">
          <span className="text-card-title font-card-title text-on-surface">{title}</span>
          <span className="text-meta font-meta text-neutral-secondary leading-snug">{description}</span>
        </span>
      </div>
    </label>
  );
}

function CalibrationLine({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-start gap-2.5">
      <Check size={15} strokeWidth={2.2} className="shrink-0 mt-0.5" style={{ color: "var(--safe)" }} />
      <span className="text-body font-body text-neutral-secondary leading-snug">{children}</span>
    </span>
  );
}
