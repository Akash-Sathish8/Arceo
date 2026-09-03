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
          {/* Agent selection */}
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

          {/* Scenario template */}
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
                description="Intercept outbound calls and return deterministic JSON responses."
                checked={mockExternal}
                onChange={onMockExternalChange}
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
            className="bg-surface-container-lowest border border-neutral-border text-neutral-secondary font-body text-body font-medium px-5 py-2.5 rounded hover:bg-surface-container-low hover:text-on-surface transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCreate}
            disabled={creating || !agentId || !scenarioId}
            className="bg-primary text-on-primary font-body text-body font-medium px-6 py-2.5 rounded hover:opacity-90 transition-opacity shadow-sm border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? "Creating…" : "Create Simulation"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One override row: label, description, and the canvas's 40×20 switch. */
function OverrideRow({
  label, description, checked, onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-surface-container-low transition-colors cursor-pointer">
      <span className="flex flex-col">
        <span className="text-body font-body font-medium text-on-surface">{label}</span>
        <span className="text-meta font-meta text-neutral-secondary">{description}</span>
      </span>
      <span className="relative inline-flex items-center shrink-0">
        <input
          type="checkbox"
          className="sr-only peer"
          checked={checked}
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
