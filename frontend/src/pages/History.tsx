import { useState, useEffect, useMemo, useRef, useDeferredValue } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, Search } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { parseTimestamp } from "@/lib/time";
import { riskLabelColor } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import PageHeader from "@/components/shared/PageHeader";

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

const RISK_META: Record<
  RiskCategory,
  { dot: string; rowBg: string | null; label: string }
> = {
  destructive: {
    dot: "var(--text-muted)",
    rowBg: "var(--severity-critical-bg)",
    label: "Destructive — permanently deletes or cancels something",
  },
  financial: {
    dot: riskLabelColor("moves_money"),
    rowBg: null,
    label: "Financial — moves or modifies money",
  },
  sends: {
    dot: riskLabelColor("sends_external"),
    rowBg: null,
    label: "Sends message — emails, SMS, or webhooks",
  },
  readonly: {
    dot: "var(--text-muted)",
    rowBg: null,
    label: "Read-only — no data was changed",
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

const TOOL_CHIP_COLORS: Record<string, { bg: string; color: string }> = {
  stripe: { bg: "#ede9fe", color: "#6d28d9" },
  zendesk: { bg: "var(--high-bg)", color: "var(--severity-high)" },
  salesforce: { bg: "#dbeafe", color: "#1e40af" },
  sendgrid: { bg: "#d1fae5", color: "#065f46" },
  github: { bg: "var(--paper-2)", color: "var(--ink-900)" },
  slack: { bg: "var(--high-bg)", color: "var(--severity-high)" },
  aws: { bg: "var(--high-bg)", color: "var(--high)" },
  hubspot: { bg: "#fce7f3", color: "#9d174d" },
  pagerduty: { bg: "var(--critical-bg)", color: "var(--critical)" },
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
  if (!detail || detail === "No matching policy") {
    return <span className="text-xs text-gray-400 italic">No policy set</span>;
  }
  if (detail.toLowerCase().startsWith("matched policy")) {
    return <span className="text-xs font-medium text-indigo-600">{detail}</span>;
  }
  return <span className="text-xs text-gray-600">{detail}</span>;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function useCountUp(target: number, enabled: boolean): number {
  const [val, setVal] = useState(0);
  const rafRef = useRef<number | undefined>(undefined);
  const startRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    startRef.current = undefined;
    function tick(ts: number) {
      if (startRef.current === undefined) startRef.current = ts;
      const progress = Math.min((ts - startRef.current) / 700, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setVal(Math.round(target * eased));
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current); };
  }, [target, enabled]);
  return enabled ? val : target;
}

// Render cap per page of rows — tables grow with account history; slicing
// keeps the DOM sane without a virtualization dependency.
const ROW_PAGE = 100;

export default function History(): React.ReactElement {
  const [searchParams] = useSearchParams();
  // /audit redirects here with ?view=audit — honor it so the audit tab is deep-linkable.
  const [view, setView] = useState<View>(searchParams.get("view") === "audit" ? "audit" : "executions");
  const [executions, setExecutions] = useState<ExecutionEntry[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [agentMap, setAgentMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const animReadyRef = useRef(false);
  const [animReady, setAnimReady] = useState(false);
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [search, setSearch] = useState("");
  const [hideSystem, setHideSystem] = useState(true);
  // Typing stays responsive: filtering keys off the deferred value.
  const deferredSearch = useDeferredValue(search);
  const [rowLimit, setRowLimit] = useState(ROW_PAGE);

  useEffect(() => {
    setRowLimit(ROW_PAGE);
  }, [view, filterStatus, timeFilter, deferredSearch, hideSystem]);

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

  useEffect(() => {
    if (!loading && !animReadyRef.current) {
      animReadyRef.current = true;
      setAnimReady(true);
    }
  }, [loading]);

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
    if (deferredSearch.trim()) {
      const q = deferredSearch.toLowerCase();
      result = result.filter(
        (e) =>
          (agentMap[e.agent_id] ?? e.agent_id ?? "").toLowerCase().includes(q) ||
          `${e.tool}.${e.action}`.toLowerCase().includes(q) ||
          (e.detail ?? "").toLowerCase().includes(q)
      );
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executions, filterStatus, timeFilter, deferredSearch, agentMap]);

  const filteredAudit = useMemo(() => {
    let result = applyTimeFilter(auditEntries);
    if (deferredSearch.trim()) {
      const q = deferredSearch.toLowerCase();
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
  }, [auditEntries, timeFilter, deferredSearch]);

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
  const blockedPct = total > 0 ? Math.round((blocked / total) * 100) : 0;
  const executedPct = total > 0 ? Math.round((executed / total) * 100) : 0;

  const animTotal    = useCountUp(total,    animReady);
  const animExecuted = useCountUp(executed, animReady);
  const animBlocked  = useCountUp(blocked,  animReady);
  const animPending  = useCountUp(pending,  animReady);

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
          <button
            style={{ background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '6px 16px', fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
            className="ml-4 transition-colors hover:opacity-80"
            onClick={() => window.location.reload()}
          >
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
    <div className="space-y-8" style={{ padding: "var(--page-pad)" }}>
      {/* Header */}
      <PageHeader
        title="History"
        description="Every agent action and account change, logged for review and compliance."
        actions={
          <div className="flex items-center">
            {([
              { id: 'executions' as const, label: 'Agent Actions' },
              { id: 'audit' as const, label: 'Audit Log' },
            ]).map((t) => (
              <button
                key={t.id}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: '8px 16px 10px',
                  fontWeight: view === t.id ? 600 : 400,
                  fontSize: 13,
                  color: view === t.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderBottom: view === t.id ? '2px solid var(--text-primary)' : '2px solid transparent',
                  marginBottom: '-1px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
                onClick={() => { setView(t.id); setFilterStatus("all"); setSearch(""); }}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />

      {/* Search + time filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-48">
          <Input
            type="text"
            icon={<Search size={14} />}
            placeholder={
              view === "executions"
                ? "Search by agent, action, or detail…"
                : "Search by user, action, or resource…"
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ height: 42 }}
          />
        </div>
        <div className="flex items-center gap-1">
          {TIME_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setTimeFilter(f.value)}
              style={timeFilter === f.value
                ? { background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '6px 14px', fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }
                : { background: 'var(--bg-sunken)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-full)', border: 'none', padding: '6px 14px', fontWeight: 500, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Executions view ── */}
      {view === "executions" && (
        <>
          {/* Stats row */}
          <div className="grid grid-cols-4 gap-5">
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
              <div className="text-[26px] font-extrabold leading-none tracking-tight text-gray-900">{animTotal}</div>
              <div className="text-xs text-gray-500 mt-1">Total Actions</div>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
              <div className="text-[26px] font-extrabold leading-none tracking-tight text-green-700">{animExecuted}</div>
              <div className="text-xs text-gray-500 mt-1">Executed</div>
              {total > 0 && (
                <div className="mt-3 h-1 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500 rounded-full"
                    style={{ width: `${executedPct}%` }}
                  />
                </div>
              )}
            </div>
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
              <div className="text-[26px] font-extrabold leading-none tracking-tight text-red-700">{animBlocked}</div>
              <div className="text-xs text-gray-500 mt-1">Blocked</div>
              {total > 0 && (
                <div className="mt-3 h-1 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-red-500 rounded-full"
                    style={{ width: `${blockedPct}%` }}
                  />
                </div>
              )}
            </div>
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
              <div className="text-[26px] font-extrabold leading-none tracking-tight text-yellow-700">{animPending}</div>
              <div className="text-xs text-gray-500 mt-1">Pending Review</div>
            </div>
          </div>

          {/* Filter chips + export */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              {STATUS_CHIPS.map((chip) => (
                <button
                  key={chip.value}
                  onClick={() => setFilterStatus(chip.value)}
                  style={filterStatus === chip.value
                    ? { background: 'var(--color-cta)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', border: 'none', padding: '6px 14px', fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }
                    : { background: 'var(--bg-sunken)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-full)', border: 'none', padding: '6px 14px', fontWeight: 500, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  {chip.label}
                  <span
                    style={filterStatus === chip.value
                      ? { background: 'rgba(255,255,255,0.2)', color: 'var(--text-inverse)', borderRadius: 'var(--radius-full)', padding: '1px 6px', fontSize: 10, fontWeight: 700 }
                      : { background: 'var(--border)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-full)', padding: '1px 6px', fontSize: 10, fontWeight: 700 }}
                  >
                    {chip.count}
                  </span>
                </button>
              ))}
            </div>
            <Button variant="secondary" size="sm" onClick={handleExport} icon={<Download size={13} />}>
              Export CSV
            </Button>
          </div>

          {/* Risk legend */}
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 rounded-sm border"
                style={{ background: "var(--severity-critical-bg)", borderColor: "var(--critical-line)" }}
              />
              Destructive
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full"
                style={{ background: riskLabelColor("moves_money") }}
              />
              Financial
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full"
                style={{ background: riskLabelColor("sends_external") }}
              />
              Sends message
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full"
                style={{ background: "var(--text-muted)" }}
              />
              Read-only
            </span>
          </div>

          {/* Table */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  {["Time", "Agent", "Action", "Status", "Policy / Reason"].map(
                    (h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-4 text-[11px] font-semibold text-gray-400"
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredExecs.slice(0, rowLimit).map((e) => {
                  const st = STATUS_CONFIG[e.status];
                  const risk = actionRiskCategory(e.tool, e.action);
                  const meta = RISK_META[risk];
                  const toolKey = e.tool.toLowerCase();
                  const toolChip = TOOL_CHIP_COLORS[toolKey];
                  return (
                    <tr
                      key={e.id}
                      style={meta.rowBg ? { background: meta.rowBg } : {}}
                      className="hover:brightness-95 transition-[filter]"
                    >
                      <td className="px-4 py-4 whitespace-nowrap">
                        <span
                          className="text-sm text-gray-700"
                          title={fullTime(e.timestamp)}
                        >
                          {relativeTime(e.timestamp)}
                        </span>
                        <div className="text-[11px] text-gray-400 mt-0.5">
                          {fullTime(e.timestamp)}
                        </div>
                      </td>
                      <td className="px-4 py-4 text-sm text-gray-700 font-medium">
                        {agentMap[e.agent_id] ?? e.agent_id}
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block w-2 h-2 rounded-full shrink-0"
                            style={{ background: meta.dot }}
                            title={meta.label}
                          />
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
                            style={
                              toolChip
                                ? { background: toolChip.bg, color: toolChip.color }
                                : { background: "var(--paper-2)", color: "var(--ink-700)" }
                            }
                          >
                            {e.tool.toUpperCase()}
                          </span>
                          <span className="text-sm text-gray-800">
                            {formatAction(e.action)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        {st && (
                          <span
                            className="px-2 py-0.5 rounded text-xs font-semibold"
                            style={{ background: st.bg, color: st.color }}
                          >
                            {st.label}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <DetailCell detail={e.detail} />
                      </td>
                    </tr>
                  );
                })}
                {filteredExecs.length > rowLimit && (
                  <tr>
                    <td colSpan={5} style={{ padding: "12px 0", textAlign: "center" }}>
                      <Button variant="secondary" size="sm" onClick={() => setRowLimit((n) => n + ROW_PAGE)}>
                        Show more — {filteredExecs.length - rowLimit} remaining
                      </Button>
                    </td>
                  </tr>
                )}
                {filteredExecs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center">
                      <svg
                        className="w-10 h-10 mx-auto text-gray-200 mb-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                      <div className="text-sm font-medium text-gray-600 mb-1">
                        {executions.length === 0
                          ? "No agent activity yet"
                          : "No matching entries"}
                      </div>
                      <div className="text-xs text-gray-400">
                        {executions.length === 0 ? (
                          <>
                            Your agents haven&apos;t called the enforcement API yet.{" "}
                            <a
                              href="/settings"
                              className="text-indigo-600 hover:underline"
                            >
                              See how to integrate →
                            </a>
                          </>
                        ) : (
                          "Try a different filter or search term."
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Audit view ── */}
      {view === "audit" && (
        <>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                className="rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                checked={hideSystem}
                onChange={(e) => setHideSystem(e.target.checked)}
              />
              Hide system activity
              {hideSystem && systemHiddenCount > 0 && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-gray-100 text-gray-500 rounded">
                  {systemHiddenCount} hidden
                </span>
              )}
            </label>
            <Button variant="secondary" size="sm" onClick={handleExport} icon={<Download size={13} />}>
              Export CSV
            </Button>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  {["Time", "User", "Action", "Resource", "Detail"].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {groupedAudit.slice(0, rowLimit).map((e) => (
                  <tr key={e.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className="text-sm text-gray-700"
                        title={fullTime(e.timestamp)}
                      >
                        {relativeTime(e.timestamp)}
                      </span>
                      <div className="text-[11px] text-gray-400 mt-0.5">
                        {fullTime(e.timestamp)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 font-medium">
                      {e.user_email ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-800">
                          {AUDIT_ACTION_LABELS[e.action] ??
                            e.action
                              .replace(/_/g, " ")
                              .replace(/\b\w/g, (c) => c.toUpperCase())}
                        </span>
                        {(e._count ?? 1) > 1 && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-gray-100 text-gray-600 rounded">
                            ×{e._count}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                      {e.resource ?? <span className="text-gray-300 font-sans">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {e.detail ?? <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                ))}
                {groupedAudit.length > rowLimit && (
                  <tr>
                    <td colSpan={5} style={{ padding: "12px 0", textAlign: "center" }}>
                      <Button variant="secondary" size="sm" onClick={() => setRowLimit((n) => n + ROW_PAGE)}>
                        Show more — {groupedAudit.length - rowLimit} remaining
                      </Button>
                    </td>
                  </tr>
                )}
                {groupedAudit.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center">
                      <svg
                        className="w-10 h-10 mx-auto text-gray-200 mb-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                        />
                      </svg>
                      <div className="text-sm font-medium text-gray-600 mb-1">
                        {auditEntries.length === 0
                          ? "No changes recorded yet"
                          : "No matching entries"}
                      </div>
                      <div className="text-xs text-gray-400">
                        {auditEntries.length === 0
                          ? "Policy changes, agent connections, and simulations will be logged here for compliance."
                          : "Try a different filter or search term."}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
