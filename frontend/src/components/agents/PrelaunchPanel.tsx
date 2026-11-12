/**
 * Pre-launch audit tab on the agent page.
 *
 * Runs POST /api/prelaunch/{agentId}: the boundary test enumerates every
 * dangerous action and chain the agent can reach and checks whether a policy
 * gates it, then the cost model runs. No LLM is involved. The result is a
 * ready / not-ready verdict and a fix list ranked by severity; "Apply all"
 * writes every auto-fixable policy in one call and re-runs the audit so the
 * verdict visibly moves.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RotateCcw, ShieldCheck, Wand2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/shared/Toast";

interface FixItem {
  priority: number;
  severity: string;
  category: string;
  action: string;
  problem: string;
  fix: string;
  fix_type: string;
  auto_fixable: boolean;
  policy_suggestion?: { action_pattern: string; effect: string; reason?: string } | null;
}

interface PrelaunchReport {
  ready_for_production: boolean;
  total_issues: number;
  critical: number;
  high: number;
  medium: number;
  policy_coverage: number;
  resilience_score: number;
  fixes: FixItem[];
  generated_at?: string;
}

const SEV: Record<string, { bg: string; color: string; line: string }> = {
  critical: { bg: "var(--critical-bg)", color: "var(--critical)", line: "var(--critical-line)" },
  high: { bg: "var(--high-bg)", color: "var(--high)", line: "var(--high-line)" },
  medium: { bg: "var(--caution-bg)", color: "var(--on-caution)", line: "var(--caution-line)" },
};

const EFFECT: Record<string, { bg: string; color: string }> = {
  BLOCK: { bg: "var(--critical)", color: "#fff" },
  REQUIRE_APPROVAL: { bg: "var(--caution-bg)", color: "var(--on-caution)" },
  ALLOW: { bg: "var(--safe-bg)", color: "var(--safe)" },
};

const CATEGORY_LABEL: Record<string, string> = {
  chain_unprotected: "Unguarded chain",
  policy_gap: "No policy",
  regression: "Regression",
  cost_exposure: "Cost exposure",
  historical_gap: "Seen in a trace",
};

export default function PrelaunchPanel({
  agentId,
  onPoliciesChanged,
}: {
  agentId: string;
  onPoliciesChanged?: () => void;
}): React.ReactElement {
  const [report, setReport] = useState<PrelaunchReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<number | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch<PrelaunchReport>(`/api/prelaunch/${agentId}`, {
        method: "POST",
        body: JSON.stringify({ daily_runs: 0, historical_traces: [] }),
        timeoutMs: 120000,
      });
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The audit could not run");
    }
    setLoading(false);
  }, [agentId]);

  useEffect(() => { void run(); }, [run]);

  const applyAll = async () => {
    setApplying(true);
    try {
      const r = await apiFetch<{ applied: { action_pattern: string; effect: string }[]; count: number }>(
        `/api/prelaunch/${agentId}/auto-fix`,
        { method: "POST", body: JSON.stringify({}), timeoutMs: 120000 },
      );
      setLastApplied(r.count);
      toast(r.count > 0 ? `Applied ${r.count} polic${r.count === 1 ? "y" : "ies"}` : "Nothing left to apply");
      onPoliciesChanged?.();
      await run();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not apply fixes", "error");
    }
    setApplying(false);
  };

  const fixes = (report?.fixes ?? []).slice().sort((a, b) => a.priority - b.priority);
  const autoFixable = fixes.filter((f) => f.auto_fixable).length;

  return (
    <div className="bg-white rounded-xl p-6 mb-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-semibold text-gray-800 flex items-center gap-1.5">
          Pre-launch audit
        </h2>
        <div className="flex items-center gap-2">
          <button className="btn btn--secondary inline-flex items-center gap-1.5" onClick={() => void run()} disabled={loading || applying}>
            <RotateCcw size={13} /> {loading ? "Running" : "Run again"}
          </button>
          <button
            className="btn btn--primary inline-flex items-center gap-1.5"
            onClick={() => void applyAll()}
            disabled={loading || applying || autoFixable === 0}
          >
            <Wand2 size={13} /> {applying ? "Applying" : `Apply all${autoFixable ? ` (${autoFixable})` : ""}`}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm p-3 rounded-lg mb-4" style={{ background: "var(--critical-bg)", color: "var(--critical)", border: "1px solid var(--critical-line)" }}>
          <AlertTriangle size={15} /> {error}
        </div>
      )}

      {loading && !report && (
        <p className="text-sm text-gray-500 m-0">Enumerating every dangerous action and chain this agent can reach.</p>
      )}

      {report && (
        <>
          <div
            className="rounded-lg p-4 mb-4 flex items-start gap-3"
            style={{
              background: report.ready_for_production ? "var(--safe-bg)" : "var(--critical-bg)",
              border: `1px solid ${report.ready_for_production ? "var(--safe-line)" : "var(--critical-line)"}`,
            }}
          >
            {report.ready_for_production
              ? <CheckCircle2 size={20} style={{ color: "var(--safe)", flexShrink: 0 }} />
              : <ShieldCheck size={20} style={{ color: "var(--critical)", flexShrink: 0 }} />}
            <div>
              <div className="font-semibold text-[15px]" style={{ color: "var(--ink-900)" }}>
                {report.ready_for_production ? "Ready for production" : "Not ready for production"}
              </div>
              <div className="text-[13px] mt-0.5" style={{ color: "var(--ink-700)" }}>
                {report.ready_for_production
                  ? "No critical gaps, policy coverage over 80 percent, and no regression against the last baseline."
                  : `${report.total_issues} issue${report.total_issues === 1 ? "" : "s"} to close before this agent ships.`}
                {lastApplied !== null && lastApplied > 0 && ` ${lastApplied} fix${lastApplied === 1 ? "" : "es"} just applied.`}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
            {[
              { label: "Critical", value: report.critical, color: "var(--critical)" },
              { label: "High", value: report.high, color: "var(--high)" },
              { label: "Medium", value: report.medium, color: "var(--on-caution)" },
              { label: "Policy coverage", value: `${Math.round(report.policy_coverage)}%`, color: "var(--ink-900)" },
              { label: "Resilience", value: `${Math.round(report.resilience_score)}`, color: "var(--ink-900)" },
            ].map((t) => (
              <div key={t.label} className="rounded-lg p-3" style={{ background: "var(--paper-2)" }}>
                <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--ink-500)" }}>{t.label}</div>
                <div className="text-[22px] font-semibold leading-tight mt-0.5" style={{ color: t.color }}>{t.value}</div>
              </div>
            ))}
          </div>

          {fixes.length === 0 ? (
            <p className="text-sm text-gray-500 m-0">Every dangerous action and chain has a policy on it.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {fixes.map((f, i) => {
                const sev = SEV[f.severity] ?? SEV.medium;
                const eff = f.policy_suggestion ? EFFECT[f.policy_suggestion.effect] ?? EFFECT.ALLOW : null;
                return (
                  <div
                    key={`${f.action}-${f.category}-${i}`}
                    className="rounded-lg p-3.5"
                    style={{ background: "var(--card)", border: "1px solid var(--line)", borderLeft: `3px solid ${sev.color}` }}
                  >
                    <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: sev.bg, color: sev.color }}>
                          {f.severity}
                        </span>
                        <span className="text-[11px]" style={{ color: "var(--ink-500)" }}>{CATEGORY_LABEL[f.category] ?? f.category}</span>
                        <span className="font-monospace-data text-[12.5px] truncate" style={{ color: "var(--ink-900)" }}>{f.action}</span>
                      </div>
                      {f.policy_suggestion && eff && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0" style={{ background: eff.bg, color: eff.color }}>
                          {f.policy_suggestion.effect === "REQUIRE_APPROVAL" ? "Require approval" : f.policy_suggestion.effect}
                        </span>
                      )}
                    </div>
                    <div className="text-[13px]" style={{ color: "var(--ink-800)" }}>{f.problem}</div>
                    <div className="text-[12.5px] mt-0.5" style={{ color: "var(--ink-500)" }}>{f.fix}</div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
