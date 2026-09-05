import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, Search } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { parseTimestamp } from "@/lib/time";
import PageHeader from "@/components/shared/PageHeader";
import { Input } from "@/components/ui/Input";

// Offset-safe CSV timestamp: backend emits naive SQLite datetimes that raw
// `new Date().toISOString()` throws on (RangeError: Invalid time value),
// aborting the whole export. Fall back to the raw value if unparseable.
function csvTime(ts: string): string {
  const d = parseTimestamp(ts);
  return isNaN(d.getTime()) ? (ts ?? "") : d.toISOString();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExecutionEntry {
  id: string;
  agent_id: string;
  tool: string;
  action: string;
  status: "EXECUTED" | "BLOCKED" | "PENDING_APPROVAL";
  detail?: string;
  timestamp: string;
}

interface AuditEntry {
  id: string;
  user_email?: string;
  action: string;
  resource?: string;
  detail?: string;
  timestamp: string;
  _count?: number;
}

interface AgentSummary {
  id: string;
  name: string;
}

type RiskCategory = "destructive" | "financial" | "sends" | "readonly";
type View = "executions" | "audit";
type TimeFilter = "all" | "today" | "7d" | "30d";
type StatusFilter = "all" | "EXECUTED" | "BLOCKED" | "PENDING_APPROVAL";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// `short` is the name printed in the row. It replaced a four-colour dot
// legend floating above the table: if a row needs a key to be read, the row
// should have said it. Read-only rows say nothing, which is the point.
const RISK_META: Record<
  RiskCategory,
  { dot: string; short: string | null; label: string }
> = {
  destructive: {
    dot: "var(--label-deletes-data)",
    short: "deletes",
    label: "Permanently deletes or cancels something",
  },
  financial: {
    dot: "var(--label-moves-money)",
    short: "money",
    label: "Moves or modifies money",
  },
  sends: {
    dot: "var(--label-sends-external)",
    short: "sends",
    label: "Sends an email, message, or webhook outside your org",
  },
  readonly: {
    dot: "var(--ink-400)",
    short: null,
    label: "Read-only, nothing was changed",
  },
};

const STATUS_CONFIG: Record<string, { bg: string; color: string; label: string }> =
  {
    EXECUTED: { bg: "var(--status-executed-bg)", color: "var(--status-executed)", label: "Executed" },
    BLOCKED: { bg: "var(--status-blocked-bg)",  color: "var(--status-blocked)",  label: "Blocked" },
    PENDING_APPROVAL: { bg: "var(--status-pending-bg)",  color: "var(--status-pending)",  label: "Pending" },
  };

const TIME_FILTERS: { value: TimeFilter; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
];


/** Colour for a status tally, applied only when its count is non-zero. */
const STATUS_TONE: Record<string, string | null> = {
  all: null,
  EXECUTED: "var(--safe)",
  BLOCKED: "var(--critical)",
  PENDING_APPROVAL: "var(--caution)",
};

const AUDIT_ACTION_LABELS: Record<string, string> = {
  LOGIN: "Signed in",
  LOGOUT: "Signed out",
  LIST_AGENTS: "Listed agents",
  CREATE_AGENT: "Created agent",
  UPDATE_AGENT: "Updated agent",
  DELETE_AGENT: "Deleted agent",
  CREATE_POLICY: "Created policy",
  DELETE_POLICY: "Deleted policy",
  RUN_SIMULATION: "Ran simulation",
  IMPORT_MCP: "Imported via MCP",
  IMPORT_OPENAI: "Imported via OpenAI",
  APPLY_POLICY: "Applied policy",
};

const SYSTEM_ACTIONS = new Set([
  "LIST_AGENTS",
  "GET_AGENT",
  "LIST_POLICIES",
  "LIST_SIMULATIONS",
]);

const TIME_CUTOFFS_MS: Record<string, number> = {
  today: 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTs(ts: string): Date {
  if (!ts) return new Date();
  return new Date(ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z");
}

function relativeTime(ts: string): string {
  const diff = (Date.now() - parseTs(ts).getTime()) / 1000;
  if (diff < 0) return fullTime(ts);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return parseTs(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function fullTime(ts: string): string {
  return parseTs(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatAction(action: string): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function actionRiskCategory(tool: string, action: string): RiskCategory {
  const s = `${tool}.${action}`.toLowerCase();
  if (/delete|terminate|drop|destroy|remove|cancel/.test(s)) return "destructive";
  if (/charge|transfer|pay|refund|create_charge/.test(s)) return "financial";
  if (/send|email|message|notify/.test(s)) return "sends";
  return "readonly";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DetailCell({ detail }: { detail?: string }): React.ReactElement {
  const base: React.CSSProperties = { fontSize: "var(--fs-small)" };
  if (!detail || detail === "No matching policy") {
    return <span style={{ ...base, color: "var(--ink-300)" }}>No policy</span>;
  }
  if (detail.toLowerCase().startsWith("matched policy")) {
    return <span style={{ ...base, color: "var(--accent-ink)", fontWeight: 500 }}>{detail}</span>;
  }
  return <span style={{ ...base, color: "var(--ink-500)" }}>{detail}</span>;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function History(): React.ReactElement {
  const [searchParams] = useSearchParams();
  // /audit redirects here with ?view=audit — honor it so the audit tab is deep-linkable.
  const [view, setView] = useState<View>(searchParams.get("view") === "audit" ? "audit" : "executions");
  const [executions, setExecutions] = useState<ExecutionEntry[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [agentMap, setAgentMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [search, setSearch] = useState("");
  const [hideSystem, setHideSystem] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch<{ entries: ExecutionEntry[] }>("/api/executions"),
      // The audit trail is admin-only (it carries captured LLM content). For
      // non-admins the 403 degrades to an empty list rather than failing the page.
      apiFetch<{ entries: AuditEntry[] }>("/api/audit").catch(
        () => ({ entries: [] as AuditEntry[] })
      ),
      apiFetch<{ agents: AgentSummary[] }>("/api/authority/agents").catch(
        () => ({ agents: [] as AgentSummary[] })
      ),
    ])
      .then(([execData, auditData, agentData]) => {
        setExecutions(execData.entries ?? []);
        setAuditEntries(auditData.entries ?? []);
        const map: Record<string, string> = {};
        (agentData.agents ?? []).forEach((a) => {
          map[a.id] = a.name;
        });
        setAgentMap(map);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Unknown error");
        setLoading(false);
      });
  }, []);

  const applyTimeFilter = <T extends { timestamp: string }>(entries: T[]): T[] => {
    if (timeFilter === "all") return entries;
    const cutoff = new Date(Date.now() - TIME_CUTOFFS_MS[timeFilter]);
    return entries.filter((e) => parseTs(e.timestamp) >= cutoff);
  };

  const filteredExecs = useMemo(() => {
    let result =
      filterStatus === "all"
        ? executions
        : executions.filter((e) => e.status === filterStatus);
    result = applyTimeFilter(result);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          (agentMap[e.agent_id] ?? e.agent_id ?? "").toLowerCase().includes(q) ||
          `${e.tool}.${e.action}`.toLowerCase().includes(q) ||
          (e.detail ?? "").toLowerCase().includes(q)
      );
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executions, filterStatus, timeFilter, search, agentMap]);

  const filteredAudit = useMemo(() => {
    let result = applyTimeFilter(auditEntries);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          (e.user_email ?? "").toLowerCase().includes(q) ||
          (e.action ?? "").toLowerCase().includes(q) ||
          (e.resource ?? "").toLowerCase().includes(q) ||
          (e.detail ?? "").toLowerCase().includes(q)
      );
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditEntries, timeFilter, search]);

  const groupedAudit = useMemo<AuditEntry[]>(() => {
    let entries = filteredAudit;
    if (hideSystem) entries = entries.filter((e) => !SYSTEM_ACTIONS.has(e.action));
    const grouped: AuditEntry[] = [];
    entries.forEach((entry) => {
      const last = grouped[grouped.length - 1];
      if (
        last &&
        last.action === entry.action &&
        last.user_email === entry.user_email
      ) {
        last._count = (last._count ?? 1) + 1;
      } else {
        grouped.push({ ...entry, _count: 1 });
      }
    });
    return grouped;
  }, [filteredAudit, hideSystem]);

  const systemHiddenCount = filteredAudit.filter((e) =>
    SYSTEM_ACTIONS.has(e.action)
  ).length;

  const blocked = executions.filter((e) => e.status === "BLOCKED").length;
  const executed = executions.filter((e) => e.status === "EXECUTED").length;
  const pending = executions.filter((e) => e.status === "PENDING_APPROVAL").length;
  const total = executions.length;


  const handleExport = (): void => {
    const isExec = view === "executions";
    const data = isExec ? filteredExecs : filteredAudit;
    const headers = isExec
      ? ["Time", "Agent", "Tool", "Action", "Status", "Detail"]
      : ["Time", "User", "Action", "Resource", "Detail"];
    const rows: string[][] = [headers];
    data.forEach((e) => {
      if (isExec) {
        const ex = e as ExecutionEntry;
        rows.push([
          csvTime(ex.timestamp),
          agentMap[ex.agent_id] ?? ex.agent_id,
          ex.tool,
          ex.action,
          ex.status,
          ex.detail ?? "",
        ]);
      } else {
        const au = e as AuditEntry;
        rows.push([
          csvTime(au.timestamp),
          au.user_email ?? "",
          au.action,
          au.resource ?? "",
          au.detail ?? "",
        ]);
      }
    });
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${view}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="p-6" aria-busy="true" aria-label="Loading history">
        {/* Mirrors the page: title → filter bar → log rows */}
        <div className="skeleton" style={{ height: 30, width: 200 }} />
        <div className="skeleton" style={{ height: 40, marginTop: 20 }} />
        <div style={{ marginTop: 12 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton" style={{ height: 48, marginTop: 10 }} />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {error}
          <button className="btn btn--primary ml-4 transition-colors hover:opacity-80" onClick={() => window.location.reload()} >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const STATUS_CHIPS: { value: StatusFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: total },
    { value: "EXECUTED", label: "Executed", count: executed },
    { value: "BLOCKED", label: "Blocked", count: blocked },
    { value: "PENDING_APPROVAL", label: "Pending", count: pending },
  ];

  return (
    <div className="p-10">
      <PageHeader
        title="History"
        description="Every action your agents took, and every change your team made."
        actions={
          <button type="button" className="btn btn--secondary" onClick={handleExport}>
            <Download size={15} strokeWidth={1.9} />
            Export CSV
          </button>
        }
      />

      {/* Tabs. Counts sit beside the label so the strip says how much is in
          each view before you switch to it. */}
      <div style={{ display: 'flex', gap: 26, borderBottom: '1px solid var(--line)', marginBottom: 22 }}>
        {([
          { id: 'executions' as const, label: 'Agent actions', count: executions.length },
          { id: 'audit' as const, label: 'Audit log', count: auditEntries.length },
        ]).map((t) => {
          const active = view === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => { setView(t.id); setFilterStatus("all"); setSearch(""); }}
              style={{
                background: 'none', border: 'none', padding: '0 0 10px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 7,
                fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)',
                fontWeight: active ? 600 : 500,
                color: active ? 'var(--ink-900)' : 'var(--ink-500)',
                borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                marginBottom: -1,
              }}
            >
              {t.label}
              <span className="mono" style={{ fontSize: 12.5, color: active ? 'var(--accent-ink)' : 'var(--ink-400)' }}>
                {t.count}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── Executions view ── */}
      {view === "executions" && (
        <div className="panel-card panel-card--framed">
          {/* Head carries the tallies and the filters together: the counts ARE
              the filters, so they were two controls saying one thing. */}
          <div className="panel-head" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {STATUS_CHIPS.map((chip) => {
                const active = filterStatus === chip.value
                const tone = STATUS_TONE[chip.value]
                return (
                  <button
                    key={chip.value}
                    type="button"
                    onClick={() => setFilterStatus(chip.value)}
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 7,
                      background: active ? 'var(--card)' : 'transparent',
                      border: `1px solid ${active ? 'var(--line)' : 'transparent'}`,
                      borderRadius: 'var(--radius-btn)', padding: '6px 12px',
                      cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      boxShadow: active ? 'var(--shadow-card-new)' : 'none',
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 17, fontWeight: 600, letterSpacing: -0.4,
                        // Colour only where the count means something. A red 0
                        // and an amber 0 are three alarms for nothing happening.
                        color: chip.count > 0 && tone ? tone : 'var(--ink-900)',
                      }}
                    >
                      {chip.count}
                    </span>
                    <span style={{
                      fontSize: 'var(--fs-small)',
                      color: active ? 'var(--ink-700)' : 'var(--ink-500)',
                      fontWeight: active ? 600 : 400,
                    }}>
                      {chip.label}
                    </span>
                  </button>
                )
              })}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <Input
                  type="text"
                  icon={<Search size={14} />}
                  placeholder="Search by agent, action, or detail"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ height: 36 }}
                />
              </div>
              <SegControl
                options={TIME_FILTERS}
                value={timeFilter}
                onChange={setTimeFilter}
              />
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {["Time", "Agent", "Action", "Status", "Policy"].map((h) => (
                    <th key={h} style={TH_STYLE}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredExecs.map((e) => {
                  const st = STATUS_CONFIG[e.status];
                  const risk = actionRiskCategory(e.tool, e.action);
                  const meta = RISK_META[risk];
                  return (
                    <tr key={e.id} className="hist-row">
                      <td style={{ ...TD_STYLE, whiteSpace: 'nowrap' }}>
                        <div className="mono" style={{ fontSize: 12.5, color: 'var(--ink-800)' }}>
                          {relativeTime(e.timestamp)}
                        </div>
                        <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--ink-400)', marginTop: 2 }}>
                          {fullTime(e.timestamp)}
                        </div>
                      </td>
                      <td style={{ ...TD_STYLE, fontSize: 'var(--fs-small)', color: 'var(--ink-800)' }}>
                        {agentMap[e.agent_id] ?? e.agent_id}
                      </td>
                      <td style={TD_STYLE}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span className="tool-chip">{e.tool}</span>
                          <span style={{ fontSize: 'var(--fs-small)', color: 'var(--ink-900)' }}>
                            {formatAction(e.action)}
                          </span>
                          {/* The category is named, not dotted. A legend that
                              floats above a table decoding four colours is a
                              legend the row should have made unnecessary. */}
                          {meta.short && (
                            <span
                              title={meta.label}
                              style={{
                                fontFamily: 'var(--font-mono)', fontSize: 10.5,
                                letterSpacing: 0.4, textTransform: 'uppercase',
                                color: meta.dot,
                              }}
                            >
                              {meta.short}
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={TD_STYLE}>
                        {st && (
                          <span style={{
                            fontSize: 'var(--fs-micro)', fontWeight: 600,
                            color: st.color, background: st.bg,
                            borderRadius: 'var(--radius-sm)', padding: '2px 8px',
                          }}>
                            {st.label}
                          </span>
                        )}
                      </td>
                      <td style={TD_STYLE}>
                        <DetailCell detail={e.detail} />
                      </td>
                    </tr>
                  );
                })}
                {filteredExecs.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: '56px 20px', textAlign: 'center' }}>
                      <div style={{ fontSize: 'var(--fs-body)', fontWeight: 500, color: 'var(--ink-700)' }}>
                        {executions.length === 0 ? "No agent activity yet" : "Nothing matches that filter"}
                      </div>
                      <div style={{ fontSize: 'var(--fs-small)', color: 'var(--ink-400)', marginTop: 5 }}>
                        {executions.length === 0 ? (
                          <>
                            Your agents have not called the enforcement API yet.{" "}
                            <a href="/settings" style={{ color: 'var(--text-link)' }}>See how to connect one</a>
                          </>
                        ) : (
                          "Try a different search term or time range."
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Audit view ── */}
      {view === "audit" && (
        <div className="panel-card panel-card--framed">
          <div className="panel-head" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <Input
                type="text"
                icon={<Search size={14} />}
                placeholder="Search by user, action, or resource"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ height: 36 }}
              />
            </div>
            <SegControl options={TIME_FILTERS} value={timeFilter} onChange={setTimeFilter} />
            <label style={{
              display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
              fontSize: 'var(--fs-small)', color: 'var(--ink-600)', userSelect: 'none',
            }}>
              <input
                type="checkbox"
                checked={hideSystem}
                onChange={(e) => setHideSystem(e.target.checked)}
              />
              Hide system activity
              {hideSystem && systemHiddenCount > 0 && (
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-400)' }}>
                  {systemHiddenCount} hidden
                </span>
              )}
            </label>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {["Time", "User", "Action", "Resource", "Detail"].map((h) => (
                    <th key={h} style={TH_STYLE}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groupedAudit.map((e) => (
                  <tr key={e.id} className="hist-row">
                    <td style={{ ...TD_STYLE, whiteSpace: 'nowrap' }}>
                      <div className="mono" style={{ fontSize: 12.5, color: 'var(--ink-800)' }}>
                        {relativeTime(e.timestamp)}
                      </div>
                      <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--ink-400)', marginTop: 2 }}>
                        {fullTime(e.timestamp)}
                      </div>
                    </td>
                    <td style={{ ...TD_STYLE, fontSize: 'var(--fs-small)', color: 'var(--ink-800)' }}>
                      {e.user_email ?? "System"}
                    </td>
                    <td style={TD_STYLE}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 'var(--fs-small)', color: 'var(--ink-900)' }}>
                          {AUDIT_ACTION_LABELS[e.action] ??
                            e.action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                        </span>
                        {(e._count ?? 1) > 1 && (
                          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-400)' }}>
                            ×{e._count}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...TD_STYLE, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ink-500)' }}>
                      {e.resource ?? <span style={{ color: 'var(--ink-300)' }}>None</span>}
                    </td>
                    <td style={{ ...TD_STYLE, fontSize: 'var(--fs-small)', color: 'var(--ink-500)' }}>
                      {e.detail ?? <span style={{ color: 'var(--ink-300)' }}>None</span>}
                    </td>
                  </tr>
                ))}
                {groupedAudit.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: '56px 20px', textAlign: 'center' }}>
                      <div style={{ fontSize: 'var(--fs-body)', fontWeight: 500, color: 'var(--ink-700)' }}>
                        {auditEntries.length === 0 ? "No changes recorded yet" : "Nothing matches that filter"}
                      </div>
                      <div style={{ fontSize: 'var(--fs-small)', color: 'var(--ink-400)', marginTop: 5 }}>
                        {auditEntries.length === 0
                          ? "Policy changes, agent connections, and simulations all get logged here for compliance."
                          : "Try a different search term or time range."}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Segmented control. One shape for every "pick one of a few" filter, in place
 *  of the navy pill row, which read as four primary buttons competing with the
 *  page's real actions. */
function SegControl<T extends string>({
  options, value, onChange,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div style={{
      display: 'inline-flex', gap: 2, padding: 3,
      background: 'var(--bg-sunken)', borderRadius: 'var(--radius-md)',
    }}>
      {options.map((o) => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              border: 'none', borderRadius: 'var(--radius-btn)', padding: '5px 12px',
              cursor: 'pointer', whiteSpace: 'nowrap',
              fontFamily: 'var(--font-mono)', fontSize: 12,
              background: active ? 'var(--card)' : 'transparent',
              color: active ? 'var(--ink-900)' : 'var(--ink-500)',
              boxShadow: active ? '0 1px 2px rgba(15,15,15,.06)' : 'none',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

const TH_STYLE: React.CSSProperties = {
  textAlign: 'left',
  padding: '11px 16px',
  fontSize: 'var(--fs-micro)',
  fontWeight: 600,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  color: 'var(--ink-400)',
  borderBottom: '1px solid var(--line)',
  whiteSpace: 'nowrap',
}

const TD_STYLE: React.CSSProperties = {
  padding: '13px 16px',
  borderBottom: '1px solid var(--line)',
  verticalAlign: 'top',
}
