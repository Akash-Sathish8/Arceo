/**
 * "Explore Scenarios & Custom Input" — ported from the Stitch canvas
 * (Scenario Library & Custom Editor). Reached from the Configure Simulation
 * dialog's "Custom or More…" card.
 *
 * Canvas structure, kept: eyebrow + title with Cancel / Apply Selection on a
 * ruled header; a 5/7 split with "Write Your Own Scenario" and the amber
 * Advanced Configuration card on the left, and the Template Library — view
 * toggle, search, category chips, a scrolling card grid, "Load more" — on the
 * right.
 *
 * The canvas's catalogue is invented (CVEs, "Zero-Day Sequence Pattern",
 * enterprise-locked rows). These cards render the agent's real scenarios, and
 * the chips filter on the real categories rather than invented attack classes.
 */

import { useMemo, useState } from "react";
import {
  Search, SlidersHorizontal, LayoutGrid, List, Paperclip, Sparkles,
  Code2, CheckCircle2, ChevronDown, X, PenLine,
} from "lucide-react";

export interface LibraryScenario {
  id: string;
  name: string;
  description: string;
  category?: string;
  severity?: string;
}

const SEVERITY: Record<string, { label: string; color: string }> = {
  critical: { label: "CRITICAL", color: "var(--critical)" },
  high: { label: "HIGH", color: "var(--high)" },
  medium: { label: "MODERATE", color: "var(--caution)" },
  low: { label: "LOW", color: "var(--safe)" },
};

const CATEGORY_LABEL: Record<string, string> = {
  normal: "Normal",
  edge_case: "Edge Case",
  adversarial: "Adversarial",
  chain_exploit: "Chain Exploit",
};

const PAGE = 6;

interface Props {
  scenarios: LibraryScenario[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  customPrompt: string;
  onCustomPromptChange: (v: string) => void;
  onGenerate: () => void;
  generating: boolean;
  /** The exact body that /api/sandbox/simulate will receive. */
  requestPreview: string;
  onCancel: () => void;
  onApply: () => void;
}

export default function ScenarioLibrary({
  scenarios, selectedIds, onToggle,
  customPrompt, onCustomPromptChange, onGenerate, generating,
  requestPreview, onCancel, onApply,
}: Props): React.ReactElement {
  const [view, setView] = useState<"grid" | "list">("grid");
  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [shown, setShown] = useState(PAGE);
  const [editorOpen, setEditorOpen] = useState(false);

  const available = useMemo(() => {
    const cats = new Set<string>();
    scenarios.forEach((s) => { if (s.category) cats.add(s.category); });
    return [...cats];
  }, [scenarios]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scenarios.filter((s) => {
      if (categories.length > 0 && !categories.includes(s.category ?? "")) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [scenarios, search, categories]);

  const visible = filtered.slice(0, shown);

  const toggleCategory = (c: string) => {
    setShown(PAGE);
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  return (
    <div className="flex flex-col w-full gap-section-margin">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-neutral-border pb-4">
        <div>
          <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase tracking-wider block mb-2">
            Simulation Setup
          </span>
          <h1 className="font-page-title text-page-title text-on-surface m-0">
            Explore Scenarios &amp; Custom Input
          </h1>
        </div>
        <div className="flex gap-4 items-center">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 font-body text-body text-neutral-secondary border border-neutral-border rounded hover:bg-surface-container-low transition-colors bg-surface-container-lowest cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={selectedIds.length === 0 && !customPrompt.trim()}
            className="px-6 py-2 font-body text-body text-on-primary bg-primary rounded hover:opacity-90 transition-opacity shadow-sm border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Apply Selection
          </button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-8">
        {/* ── Left: custom input ── */}
        <div className="col-span-12 lg:col-span-5 flex flex-col gap-6">
          <div className="bg-surface-container-lowest border border-neutral-border rounded p-6 flex flex-col" style={{ boxShadow: "0 1px 2px rgba(15,15,15,0.03)" }}>
            <div className="flex items-center gap-3 mb-4">
              <span className="w-8 h-8 rounded flex items-center justify-center" style={{ background: "var(--accent-soft)" }}>
                <PenLine size={18} strokeWidth={1.9} style={{ color: "var(--accent)" }} />
              </span>
              <h2 className="font-card-title text-card-title text-on-surface m-0">Write Your Own Scenario</h2>
            </div>
            <p className="font-body text-body text-neutral-secondary mb-6 m-0">
              Describe a hostile environment or specific vulnerability path in plain English. Our engine will
              translate this into executable test parameters.
            </p>
            <div className="flex-1 flex flex-col relative">
              <label className="sr-only" htmlFor="library-custom-scenario">Custom scenario description</label>
              <textarea
                id="library-custom-scenario"
                value={customPrompt}
                onChange={(e) => onCustomPromptChange(e.target.value)}
                placeholder="e.g., Simulate an attack where an authenticated user attempts to escalate privileges by manipulating JWT tokens while concurrently flooding the reporting API with malformed requests…"
                className="w-full flex-1 min-h-[200px] resize-none border border-neutral-border rounded p-4 pb-14 font-body text-body text-on-surface bg-surface-container-lowest focus:outline-none focus:border-outline-variant transition-all"
              />
              <div className="absolute bottom-4 right-4 flex gap-2">
                {/* Attaching a file has no ingest route yet; the control is
                    shown in its unavailable state rather than silently inert. */}
                <button
                  type="button"
                  disabled
                  title="Attaching a file isn't supported yet"
                  className="w-8 h-8 rounded flex items-center justify-center bg-surface-container text-on-surface-variant border-0 opacity-50 cursor-not-allowed"
                >
                  <Paperclip size={16} />
                </button>
                <button
                  type="button"
                  onClick={onGenerate}
                  disabled={generating}
                  title="Generate scenarios for this agent with Claude"
                  className="w-8 h-8 rounded flex items-center justify-center bg-primary text-on-primary hover:opacity-90 transition-opacity border-0 cursor-pointer disabled:opacity-60"
                >
                  <Sparkles size={16} />
                </button>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ background: "var(--aqua-ink)" }} />
              <span className="font-monospace-label text-monospace-label text-neutral-secondary">
                {generating ? "Translating…" : "AI Translation Active"}
              </span>
            </div>
          </div>

          {/* Advanced configuration */}
          <div className="border border-neutral-border rounded p-6" style={{ background: "var(--caution-bg)", boxShadow: "0 1px 2px rgba(15,15,15,0.03)" }}>
            <h3 className="font-card-title text-card-title mb-2 m-0" style={{ color: "var(--amber-ink)" }}>
              Advanced Configuration
            </h3>
            <p className="font-body text-body mb-4 m-0" style={{ color: "var(--amber-ink)", opacity: 0.85 }}>
              Define precise vector constraints and payload parameters via JSON configuration.
            </p>
            <button
              type="button"
              onClick={() => setEditorOpen((v) => !v)}
              className="px-4 py-2 font-body text-body bg-surface-container-lowest rounded transition-colors w-max flex items-center gap-2 cursor-pointer"
              style={{ color: "var(--amber-ink)", border: "1px solid var(--caution-line)" }}
            >
              <Code2 size={16} />
              {editorOpen ? "Hide Editor" : "Open Editor"}
            </button>
            {editorOpen && (
              /* The real request body this setup will POST — editable payload
                 parameters need a backend that accepts them, so for now the
                 editor shows exactly what gets sent. */
              <pre
                className="mt-4 p-3 rounded font-monospace-label text-monospace-label overflow-x-auto m-0"
                style={{ background: "var(--card)", border: "1px solid var(--caution-line)", color: "var(--ink-800)" }}
              >
                {requestPreview}
              </pre>
            )}
          </div>
        </div>

        {/* ── Right: template library ── */}
        <div className="col-span-12 lg:col-span-7 flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="font-card-title text-card-title text-on-surface m-0">Template Library</h2>
              <div className="flex items-center gap-2">
                <span className="font-eyebrow text-eyebrow text-neutral-secondary uppercase">View:</span>
                <div className="flex bg-surface-container-low rounded border border-neutral-border p-0.5">
                  {([
                    { id: "grid" as const, Icon: LayoutGrid, label: "Grid view" },
                    { id: "list" as const, Icon: List, label: "List view" },
                  ]).map(({ id, Icon, label }) => (
                    <button
                      key={id}
                      type="button"
                      aria-label={label}
                      aria-pressed={view === id}
                      onClick={() => setView(id)}
                      className={`w-8 h-7 rounded flex items-center justify-center border-0 cursor-pointer transition-colors ${
                        view === id
                          ? "bg-surface-container-lowest shadow-sm text-on-surface"
                          : "bg-transparent text-neutral-secondary hover:text-on-surface"
                      }`}
                    >
                      <Icon size={16} />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="relative flex-1">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-secondary" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }}
                  placeholder="Search scenarios, tools, or actions…"
                  className="w-full h-10 pl-10 pr-4 bg-surface-container-lowest border border-neutral-border rounded font-body text-body text-on-surface focus:outline-none focus:border-outline-variant transition-all"
                />
              </div>
              <button
                type="button"
                onClick={() => { setCategories([]); setSearch(""); setShown(PAGE); }}
                className="h-10 px-4 bg-surface-container-lowest border border-neutral-border rounded flex items-center gap-2 font-body text-body text-on-surface-variant hover:bg-surface-container-low transition-colors cursor-pointer"
              >
                <SlidersHorizontal size={18} />
                Clear
              </button>
            </div>

            {/* Category chips — the real scenario categories */}
            <div className="flex gap-2 flex-wrap">
              {available.map((c) => {
                const on = categories.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleCategory(c)}
                    className="px-3 py-1 rounded-full font-monospace-label text-monospace-label flex items-center gap-1 cursor-pointer transition-colors"
                    style={
                      on
                        ? { background: "var(--aqua-soft)", border: "1px solid var(--aqua-line)", color: "var(--aqua-deep)" }
                        : { background: "var(--paper-2)", border: "1px solid var(--line)", color: "var(--ink-500)" }
                    }
                  >
                    {CATEGORY_LABEL[c] ?? c}
                    {on && <X size={14} />}
                  </button>
                );
              })}
            </div>
          </div>

          <div
            className={`gap-4 overflow-y-auto pr-2 pb-4 ${view === "grid" ? "grid grid-cols-1 md:grid-cols-2" : "flex flex-col"}`}
            style={{ height: 500, scrollbarWidth: "thin" }}
          >
            {visible.length === 0 && (
              <p className="font-body text-body text-neutral-muted m-0">No scenarios match that search.</p>
            )}
            {visible.map((s) => {
              const sev = SEVERITY[(s.severity ?? "").toLowerCase()] ?? { label: "UNRATED", color: "var(--ink-400)" };
              const selected = selectedIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onToggle(s.id)}
                  className="bg-surface-container-lowest rounded p-5 transition-all cursor-pointer relative group flex flex-col text-left w-full"
                  style={{
                    border: `1px solid ${selected ? "var(--accent)" : "var(--line)"}`,
                    boxShadow: selected ? "0 0 0 1px var(--accent)" : "0 1px 2px rgba(15,15,15,0.03)",
                  }}
                >
                  {selected && (
                    <span className="absolute top-2 right-2">
                      <CheckCircle2 size={20} style={{ color: "var(--accent)" }} />
                    </span>
                  )}
                  <span className="flex justify-between items-start mb-3 w-full">
                    <span className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ background: sev.color }} />
                      <span className="font-monospace-label text-monospace-label" style={{ color: sev.color }}>
                        {sev.label}
                      </span>
                    </span>
                    {!selected && (
                      <span title={s.id} className="font-monospace-label text-monospace-label text-neutral-secondary truncate max-w-[45%]">
                        ID: {s.id.toUpperCase()}
                      </span>
                    )}
                  </span>
                  <h3 className="font-card-title text-card-title text-on-surface mb-2 m-0">{s.name}</h3>
                  <p className="font-body text-body text-neutral-secondary mb-4 flex-1 m-0">{s.description}</p>
                  <span className="flex items-center justify-between mt-auto pt-4 border-t border-neutral-border w-full">
                    <span className="flex gap-2">
                      {s.category && (
                        <span
                          className="px-2 py-0.5 text-[10px] font-monospace-label rounded"
                          style={{ background: "var(--paper-2)", color: "var(--ink-500)" }}
                        >
                          {(CATEGORY_LABEL[s.category] ?? s.category).toUpperCase()}
                        </span>
                      )}
                    </span>
                    <span
                      className="font-meta text-meta"
                      style={{ color: selected ? "var(--accent)" : "var(--ink-600)", fontWeight: selected ? 500 : 400 }}
                    >
                      {selected ? "Selected" : "Select →"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {filtered.length > shown && (
            <div className="flex justify-center mt-2 border-t border-neutral-border pt-4">
              <button
                type="button"
                onClick={() => setShown((n) => n + PAGE)}
                className="font-body text-body transition-colors flex items-center gap-2 bg-transparent border-0 cursor-pointer"
                style={{ color: "var(--accent)" }}
              >
                Load More Scenarios <ChevronDown size={18} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
