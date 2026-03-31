import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useParams, Link, useNavigate } from "react-router-dom";
import { apiFetch, getToken } from "./api.js";
import { toast } from "./Toast.jsx";
import "./AgentDetail.css";

const formatAction = (action) =>
  action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const parsePolicyPattern = (pattern) => {
  const dot = pattern.indexOf(".");
  if (dot === -1) return { service: "", action: formatAction(pattern) };
  const svc = pattern.slice(0, dot);
  return {
    service: svc.charAt(0).toUpperCase() + svc.slice(1),
    action: formatAction(pattern.slice(dot + 1)),
  };
};

const formatDescription = (text) =>
  text.replace(/\b([a-z]+(?:_[a-z]+)+)\b/g, (m) =>
    m.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
  );

const actionRiskDot = (tool, action) => {
  const s = `${tool}.${action}`.toLowerCase();
  if (/delete|terminate|drop|destroy|remove|cancel/.test(s)) return "#dc2626";
  if (/charge|transfer|pay|refund|create_charge/.test(s)) return "#2563eb";
  if (/send|email|message|notify/.test(s)) return "#7c3aed";
  return "#9ca3af";
};

const RISK_COLORS = {
  moves_money: "#dc2626",
  touches_pii: "#7c3aed",
  deletes_data: "#ea580c",
  sends_external: "#2563eb",
  changes_production: "#0d9488",
};

const RISK_LABELS = {
  moves_money: "Moves Money",
  touches_pii: "Touches PII",
  deletes_data: "Deletes Data",
  sends_external: "Sends External",
  changes_production: "Changes Prod",
};

const SEV_STYLE = {
  critical: { bg: "#fef2f2", color: "#dc2626" },
  high: { bg: "#fff7ed", color: "#ea580c" },
};

function Tooltip({ text, children }) {
  const [coords, setCoords] = useState(null);
  const ref = useRef(null);
  const show = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      setCoords({ top: r.top, left: r.left + r.width / 2 });
    }
  };
  return (
    <span ref={ref} className="tooltip-wrap" onMouseEnter={show} onMouseLeave={() => setCoords(null)}>
      {children}
      {coords && createPortal(
        <span className="tooltip-bubble" style={{ top: coords.top, left: coords.left, transform: "translate(-50%, calc(-100% - 8px))" }}>
          {text}
        </span>,
        document.body
      )}
    </span>
  );
}

// ── Authority Map ─────────────────────────────────────────────────────────

function AuthorityMap({ graph }) {
  const nodeById = {};
  graph.nodes.forEach((n) => { nodeById[n.id] = n; });

  const toolActionIds = {};
  graph.edges.filter((e) => e.relation === "exposes").forEach((e) => {
    if (!toolActionIds[e.source]) toolActionIds[e.source] = [];
    toolActionIds[e.source].push(e.target);
  });

  const toolIds = graph.edges
    .filter((e) => e.relation === "has_tool")
    .map((e) => e.target);

  const tools = toolIds.map((id) => nodeById[id]).filter(Boolean);
  const [collapsed, setCollapsed] = useState(() => {
    const init = {};
    tools.forEach((tool) => {
      const acts = (toolActionIds[tool.id] || []).map((id) => nodeById[id]).filter(Boolean);
      const hasDanger = acts.some((a) => a.reversible === false || a.risk_labels?.length > 0);
      if (!hasDanger) init[tool.id] = true;
    });
    return init;
  });
  const toggle = (id) => setCollapsed((p) => ({ ...p, [id]: !p[id] }));
  const [graphSearch, setGraphSearch] = useState("");
  const [riskFilter, setRiskFilter] = useState("all");

  const searchLower = graphSearch.toLowerCase();

  return (
    <div className="authority-map">
      <div className="am-search-row">
        <input
          className="am-search"
          placeholder="Search actions..."
          value={graphSearch}
          onChange={(e) => setGraphSearch(e.target.value)}
        />
        <div className="am-risk-filters">
          {["all", "irreversible", "risky", "safe"].map((f) => (
            <button key={f} className={`am-risk-filter${riskFilter === f ? " active" : ""}`} onClick={() => setRiskFilter(f)}>
              {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {tools.map((tool) => {
        const allActions = (toolActionIds[tool.id] || [])
          .map((id) => nodeById[id])
          .filter(Boolean)
          .sort((a, b) => {
            const rank = (x) => x.reversible === false ? 0 : x.risk_labels?.length ? 1 : 2;
            return rank(a) - rank(b);
          });
        const actions = allActions.filter((a) => {
          if (searchLower && !a.label?.toLowerCase().includes(searchLower)) return false;
          if (riskFilter === "irreversible" && a.reversible !== false) return false;
          if (riskFilter === "risky" && (a.reversible === false || !a.risk_labels?.length)) return false;
          if (riskFilter === "safe" && (a.reversible === false || a.risk_labels?.length)) return false;
          return true;
        });
        if (actions.length === 0) return null;
        const nIrrev = allActions.filter((a) => a.reversible === false).length;
        const nRisky = allActions.filter((a) => a.reversible !== false && a.risk_labels?.length).length;
        const nSafe  = allActions.filter((a) => a.reversible !== false && !a.risk_labels?.length).length;
        const isOpen = !collapsed[tool.id] || !!searchLower || riskFilter !== "all";
        const accentColor = nIrrev > 0 ? "#dc2626" : nRisky > 0 ? "#f59e0b" : "#d1d5db";
        return (
          <div key={tool.id} className="am-tool" style={{ borderLeftColor: accentColor }}>
            <div className="am-tool-header" onClick={() => toggle(tool.id)}>
              <span className="am-tool-name">{tool.label}</span>
              <div className="am-tool-header-right">
                <div className="am-tool-risk-counts">
                  {nIrrev > 0 && <span className="am-count-chip am-count-irrev">{nIrrev} irreversible</span>}
                  {nRisky > 0 && <span className="am-count-chip am-count-risky">{nRisky} risky</span>}
                  {nSafe  > 0 && <span className="am-count-chip am-count-safe">{nSafe} safe</span>}
                </div>
                <span className="am-chevron">{isOpen ? "▾" : "▸"}</span>
              </div>
            </div>
            {isOpen && (
              <div className="am-actions">
                {actions.map((action) => {
                  const isIrrev = action.reversible === false;
                  const hasRisk = action.risk_labels && action.risk_labels.length > 0;
                  const dotClass = isIrrev ? "irreversible" : hasRisk ? "risky" : "safe";
                  return (
                    <div key={action.id} className={`am-action${isIrrev ? " am-action-irrev" : hasRisk ? " am-action-risky" : ""}`}>
                      <span className={`am-dot am-dot-${dotClass}`} />
                      <span className="am-action-name">{formatAction(action.label)}</span>
                      <div className="am-badges">
                        {action.risk_labels?.map((r) => (
                          <span key={r} className="am-badge" style={{
                            background: RISK_COLORS[r] + "18",
                            color: RISK_COLORS[r],
                            borderColor: RISK_COLORS[r] + "50",
                          }}>
                            {RISK_LABELS[r]}
                          </span>
                        ))}
                        {isIrrev && (
                          <span className="am-badge am-badge-irrev">Irreversible</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Policy Form ───────────────────────────────────────────────────────────

const EFFECT_OPTIONS = ["BLOCK", "REQUIRE_APPROVAL", "ALLOW"];
const EFFECT_STYLE = {
  BLOCK: { bg: "#fef2f2", color: "#dc2626" },
  REQUIRE_APPROVAL: { bg: "#fff7ed", color: "#ea580c" },
  ALLOW: { bg: "#f0fdf4", color: "#16a34a" },
};
const EXEC_STATUS_STYLE = {
  EXECUTED: { bg: "#d4edda", color: "#155724" },
  BLOCKED: { bg: "#f8d7da", color: "#721c24" },
  PENDING_APPROVAL: { bg: "#fff3cd", color: "#856404" },
};

// ── Action Picker ─────────────────────────────────────────────────────────

function ActionPicker({ tools, selectedPatterns, onAdd }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const searchLow = search.toLowerCase();
  const filteredTools = tools
    .map((t) => ({
      ...t,
      filteredActions: t.actions.filter(
        (a) => !searchLow || a.action.toLowerCase().includes(searchLow) || formatAction(a.action).toLowerCase().includes(searchLow)
      ),
      wildcardMatch: !searchLow || (t.service || t.name).toLowerCase().includes(searchLow) || "wildcard all actions".includes(searchLow),
    }))
    .filter((t) => t.wildcardMatch || t.filteredActions.length > 0);

  return (
    <div className="action-picker" ref={ref}>
      <button
        type="button"
        className={`action-picker-btn${open ? " open" : ""}${selectedPatterns.length > 0 ? " has-value" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ap-placeholder">
          {selectedPatterns.length === 0 ? "Add an action…" : "Add another action…"}
        </span>
        <span className="ap-chevron">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="action-picker-dropdown">
          <div className="ap-search-wrap">
            <input
              autoFocus
              className="ap-search"
              placeholder="Search actions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="ap-list">
            {filteredTools.map((t) => (
              <div key={t.name} className="ap-group">
                <div className="ap-group-label">{t.service || t.name}</div>
                {t.wildcardMatch && (
                  <button
                    type="button"
                    className={`ap-option ap-option-wildcard${selectedPatterns.includes(`${t.name}.*`) ? " ap-opt-checked" : ""}`}
                    onClick={() => { onAdd(`${t.name}.*`); setSearch(""); setOpen(false); }}
                  >
                    <span className="ap-opt-check">{selectedPatterns.includes(`${t.name}.*`) ? "✓" : ""}</span>
                    <span className="ap-opt-label">All actions</span>
                    <span className="ap-badge ap-badge-wildcard">wildcard</span>
                  </button>
                )}
                {t.filteredActions.map((a) => {
                  const isIrrev = a.reversible === false;
                  const isRisky = a.risk_labels?.length > 0;
                  const key = `${t.name}.${a.action}`;
                  const alreadySelected = selectedPatterns.includes(key);
                  return (
                    <button
                      key={a.action}
                      type="button"
                      className={`ap-option${isIrrev ? " ap-opt-irrev" : isRisky ? " ap-opt-risky" : ""}${alreadySelected ? " ap-opt-checked" : ""}`}
                      onClick={() => { onAdd(key); setSearch(""); setOpen(false); }}
                    >
                      <span className="ap-opt-check">{alreadySelected ? "✓" : ""}</span>
                      <span className={`ap-opt-dot${isIrrev ? " ap-dot-irrev" : isRisky ? " ap-dot-risky" : " ap-dot-safe"}`} />
                      <span className="ap-opt-label">{formatAction(a.action)}</span>
                      <div className="ap-opt-badges">
                        {isIrrev && <span className="ap-badge ap-badge-irrev">irreversible</span>}
                        {a.risk_labels?.map((r) => (
                          <span key={r} className="ap-badge ap-badge-risk" style={{ background: RISK_COLORS[r] + "22", color: RISK_COLORS[r], borderColor: RISK_COLORS[r] + "55" }}>
                            {RISK_LABELS[r] || r}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
            {filteredTools.length === 0 && <div className="ap-empty">No actions match "{search}"</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Condition Builder ─────────────────────────────────────────────────────

function ConditionBuilder({ conditions, onChange }) {
  const STANDARD_OPS = [
    { value: "gt",  label: ">" },
    { value: "gte", label: "≥" },
    { value: "lt",  label: "<" },
    { value: "lte", label: "≤" },
    { value: "eq",  label: "=" },
    { value: "neq", label: "≠" },
  ];
  const add = () => onChange([...conditions, { field: "", op: "gt", value: "" }]);
  const addPrior = () => onChange([...conditions, { op: "requires_prior", value: "" }]);
  const remove = (i) => onChange(conditions.filter((_, j) => j !== i));
  const update = (i, key, val) => {
    const next = [...conditions];
    next[i] = { ...next[i], [key]: val };
    onChange(next);
  };
  return (
    <div className="condition-builder">
      {conditions.map((c, i) => (
        <div key={i} className="condition-row">
          {c.op === "requires_prior" ? (
            <>
              <span className="condition-label-text">requires prior action</span>
              <input
                className="condition-input condition-input-wide"
                placeholder="e.g. pagerduty.get_incident"
                value={c.value}
                onChange={(e) => update(i, "value", e.target.value)}
              />
            </>
          ) : (
            <>
              <input
                className="condition-input"
                placeholder="field (e.g. amount)"
                value={c.field}
                onChange={(e) => update(i, "field", e.target.value)}
              />
              <select
                className="condition-op"
                value={c.op}
                onChange={(e) => update(i, "op", e.target.value)}
              >
                {STANDARD_OPS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <input
                className="condition-input condition-input-val"
                placeholder="value (e.g. 100)"
                value={c.value}
                onChange={(e) => update(i, "value", e.target.value)}
              />
            </>
          )}
          <button type="button" className="condition-remove" onClick={() => remove(i)}>×</button>
        </div>
      ))}
      <div className="condition-add-row">
        <button type="button" className="condition-add-btn" onClick={add}>+ Parameter condition</button>
        <button type="button" className="condition-add-btn" onClick={addPrior}>+ Requires prior action</button>
      </div>
    </div>
  );
}

// ── Effect Toggle ─────────────────────────────────────────────────────────

function EffectToggle({ value, onChange }) {
  const OPTIONS = [
    {
      value: "BLOCK",
      label: "Block",
      desc: "Agent is stopped — action never executes",
      icon: "✕",
      color: "#dc2626",
      bg: "#fef2f2",
      border: "#fca5a5",
    },
    {
      value: "REQUIRE_APPROVAL",
      label: "Require Approval",
      desc: "Pauses for a human to review and approve",
      icon: "⏸",
      color: "#ea580c",
      bg: "#fff7ed",
      border: "#fdba74",
    },
    {
      value: "ALLOW",
      label: "Allow",
      desc: "Explicitly permitted — logged for audit",
      icon: "✓",
      color: "#16a34a",
      bg: "#f0fdf4",
      border: "#86efac",
    },
  ];
  return (
    <div className="effect-toggle">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`effect-card${value === o.value ? " active" : ""}`}
          style={value === o.value ? { borderColor: o.border, background: o.bg } : {}}
          onClick={() => onChange(o.value)}
        >
          <span className="effect-card-icon" style={value === o.value ? { color: o.color } : {}}>{o.icon}</span>
          <span className="effect-card-label" style={value === o.value ? { color: o.color } : {}}>{o.label}</span>
          <span className="effect-card-desc">{o.desc}</span>
        </button>
      ))}
    </div>
  );
}

// ── Main Detail Page ──────────────────────────────────────────────────────

export default function AgentDetail() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showIntegration, setShowIntegration] = useState(false);

  // Policy form
  const [newPatterns, setNewPatterns] = useState([]);
  const [newEffect, setNewEffect] = useState("BLOCK");
  const [newReason, setNewReason] = useState("");
  const [newConditions, setNewConditions] = useState([]);
  const [showConditions, setShowConditions] = useState(false);

  // Agent edit
  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const addPattern = (p) => { if (!newPatterns.includes(p)) setNewPatterns((prev) => [...prev, p]); };
  const removePattern = (p) => setNewPatterns((prev) => prev.filter((x) => x !== p));

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [collapsedChains, setCollapsedChains] = useState({});
  const toggleChain = (id) => setCollapsedChains((p) => ({ ...p, [id]: !p[id] }));
  const [policyAdded, setPolicyAdded] = useState(false);
  const [applyingRecs, setApplyingRecs] = useState(false);
  const [showRecsMenu, setShowRecsMenu] = useState(false);
  const [selectedRecs, setSelectedRecs] = useState(new Set());
  const [appliedRecIndices, setAppliedRecIndices] = useState(new Set());
  const [policyConflicts, setPolicyConflicts] = useState([]);

  const loadData = () => {
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch(`/api/authority/agent/${agentId}`),
      apiFetch(`/api/authority/agent/${agentId}/policy-conflicts`).catch(() => ({ conflicts: [] })),
    ])
      .then(([d, c]) => {
        setData(d);
        setPolicyConflicts(c.conflicts || []);
        setLoading(false);
      })
      .catch((err) => { setError(err.message); setLoading(false); });
  };

  useEffect(() => { loadData(); }, [agentId]);

  useEffect(() => {
    if (!showRecsMenu) return;
    const handler = (e) => { if (!e.target.closest(".apply-recs-wrapper")) setShowRecsMenu(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showRecsMenu]);

  const handleEdit = async (e) => {
    e.preventDefault();
    setEditSaving(true);
    try {
      await apiFetch(`/api/authority/agent/${agentId}`, {
        method: "PUT",
        body: JSON.stringify({ name: editName, description: editDesc }),
      });
      toast("Agent updated");
      setEditMode(false);
      loadData();
    } catch (err) {
      toast("Failed to update: " + err.message, "error");
    }
    setEditSaving(false);
  };

  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    try {
      await apiFetch(`/api/authority/agent/${agentId}`, { method: "DELETE" });
      toast("Agent deleted");
      navigate("/");
    } catch (err) {
      toast("Failed to delete: " + err.message, "error");
    }
  };

  const handleAddPolicy = async (e) => {
    e.preventDefault();
    if (newPatterns.length === 0) return;
    try {
      await Promise.all(
        newPatterns.map((pattern) =>
          apiFetch(`/api/authority/agent/${agentId}/policies`, {
            method: "POST",
            body: JSON.stringify({
              action_pattern: pattern,
              effect: newEffect,
              reason: newReason,
              ...(newConditions.filter((c) =>
                c.op === "requires_prior" ? c.value.trim() : c.field.trim() && String(c.value).trim()
              ).length > 0 && {
                conditions: newConditions.filter((c) =>
                  c.op === "requires_prior" ? c.value.trim() : c.field.trim() && String(c.value).trim()
                ),
              }),
            }),
          })
        )
      );
      setNewPatterns([]);
      setNewReason("");
      setNewConditions([]);
      setShowConditions(false);
      setPolicyAdded(true);
      toast(`${newPatterns.length} polic${newPatterns.length !== 1 ? "ies" : "y"} added`);
      loadData();
    } catch (err) {
      toast("Failed to add policy: " + err.message, "error");
    }
  };

  const getPoliciesForRec = (rec) => {
    const tokens = rec.description.match(/\b[a-z]+(?:_[a-z]+)+\b/g) || [];
    const fallbackRe = /delete|terminate|cancel|charge|refund|send_email|send_template/;
    return agent.tools.flatMap((t) =>
      t.actions
        .filter((a) => tokens.length > 0 ? tokens.includes(a.action) : fallbackRe.test(a.action))
        .map((a) => `${t.name}.${a.action}`)
    );
  };

  const handleApplySelected = async () => {
    setApplyingRecs(true);
    const existingPatterns = new Set((policies || []).map((p) => p.action_pattern));
    const toCreate = new Set();
    recommendations.forEach((rec, i) => {
      if (selectedRecs.has(i)) getPoliciesForRec(rec).forEach((p) => { if (!existingPatterns.has(p)) toCreate.add(p); });
    });
    if (toCreate.size === 0) {
      toast("All selected policies are already applied");
      setAppliedRecIndices((prev) => new Set([...prev, ...selectedRecs]));
      setApplyingRecs(false);
      setShowRecsMenu(false);
      return;
    }
    try {
      await Promise.all([...toCreate].map((pattern) =>
        apiFetch(`/api/authority/agent/${agentId}/policies`, {
          method: "POST",
          body: JSON.stringify({ action_pattern: pattern, effect: "REQUIRE_APPROVAL", reason: "Auto-applied from recommendations" }),
        })
      ));
      toast(`Applied ${toCreate.size} polic${toCreate.size !== 1 ? "ies" : "y"}`);
      setAppliedRecIndices((prev) => new Set([...prev, ...selectedRecs]));
      loadData();
      setShowRecsMenu(false);
    } catch (err) {
      toast("Failed: " + err.message, "error");
    }
    setApplyingRecs(false);
  };

  const handleDeletePolicy = async (policyId) => {
    try {
      await apiFetch(`/api/authority/policy/${policyId}`, { method: "DELETE" });
      toast("Policy removed");
      loadData();
    } catch (err) {
      toast("Failed to delete policy: " + err.message, "error");
    }
  };

  if (loading) {
    return (
      <div className="detail-page">
        <Link to="/" className="back-link">&larr; All Agents</Link>
        <div className="loading-state"><div className="spinner" /><p>Loading agent data...</p></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="detail-page">
        <Link to="/" className="back-link">&larr; All Agents</Link>
        <div className="error-state">
          <div className="error-icon">!</div>
          <h2>Failed to load agent</h2>
          <p>{error}</p>
          <button className="retry-btn" onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    );
  }

  const { agent, graph, blast_radius: br, chains, recommendations, policies, executions } = data;
  const scoreColor = br.score >= 70 ? "#dc2626" : br.score >= 40 ? "#ea580c" : "#16a34a";
  const scoreLevel = br.score >= 70 ? "Critical" : br.score >= 40 ? "Warning" : "Safe";
  const ringR = 44;
  const ringC = 2 * Math.PI * ringR;
  const ringOffset = ringC * (1 - br.score / 100);

  const statItems = [
    { label: "Total Actions",  tooltip: "Every individual API call or operation this agent can perform across all its connected tools.", value: br.total_actions,        color: null },
    { label: "Move Money",     tooltip: "Charges, refunds, transfers, and subscription changes — any action that moves funds.",         value: br.moves_money,          color: "#dc2626" },
    { label: "Touch PII",      tooltip: "Reads or writes personal data — names, emails, addresses, payment info, or any customer record.", value: br.touches_pii,        color: "#7c3aed" },
    { label: "Delete Data",    tooltip: "Permanently removes records, files, or data. Cannot be undone.",                               value: br.deletes_data,         color: "#ea580c" },
    { label: "Send External",  tooltip: "Emails, messages, or webhooks sent to customers or third-party services outside your system.", value: br.sends_external,       color: "#2563eb" },
    { label: "Change Prod",    tooltip: "Edits to live configuration, infrastructure, access rules, or deployment settings.",           value: br.changes_production,   color: "#0d9488" },
    { label: "Irreversible",   tooltip: "Actions that cannot be undone — includes permanent deletions, charges, and outbound sends.",   value: br.irreversible_actions, color: null },
  ];
  const visibleStats = statItems.filter((s, i) => i === 0 || i === statItems.length - 1 || s.value > 0);

  const formatExecTime = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === now.toDateString()) return `Today ${time}`;
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ` ${time}`;
  };

  const noPolicyCount = executions?.filter((e) => e.detail === "No matching policy").length || 0;
  const allUnpolicied = executions?.length > 0 && noPolicyCount === executions.length;

  const EFFECT_ORDER = { BLOCK: 0, REQUIRE_APPROVAL: 1, ALLOW: 2 };
  const sortedPolicies = [...(policies || [])].sort((a, b) => (EFFECT_ORDER[a.effect] ?? 3) - (EFFECT_ORDER[b.effect] ?? 3));
  const policyEffectCounts = sortedPolicies.reduce((acc, p) => { acc[p.effect] = (acc[p.effect] || 0) + 1; return acc; }, {});
  const allSamePolicyReason = sortedPolicies.length > 1 && sortedPolicies.every((p) => p.reason === sortedPolicies[0]?.reason) ? sortedPolicies[0]?.reason : null;

  const existingPolicyPatterns = new Set((policies || []).map((p) => p.action_pattern));
  const visibleRecs = recommendations
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => {
      if (appliedRecIndices.has(i)) return false;
      const tokens = r.description.match(/\b[a-z]+(?:_[a-z]+)+\b/g) || [];
      const fallbackRe = /delete|terminate|cancel|charge|refund|send_email|send_template/;
      const needed = agent.tools.flatMap((t) =>
        t.actions
          .filter((a) => tokens.length > 0 ? tokens.includes(a.action) : fallbackRe.test(a.action))
          .map((a) => `${t.name}.${a.action}`)
      );
      if (needed.length === 0) return true;
      return !needed.every((p) => existingPolicyPatterns.has(p));
    })
    .sort((a, b) => (a.r.severity === "critical" ? -1 : 1) - (b.r.severity === "critical" ? -1 : 1));

  return (
    <div className="detail-page">
      <div className="detail-topbar">
        <Link to="/" className="back-link">&larr; All Agents</Link>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Link to={`/sandbox?agent=${agentId}`} className="sandbox-agent-btn sandbox-agent-btn-primary">Simulate in Sandbox →</Link>
          {!editMode && !confirmDelete && (
            <button
              className="sandbox-agent-btn"
              onClick={() => { setEditName(agent.name); setEditDesc(agent.description); setEditMode(true); setConfirmDelete(false); }}
            >
              Edit
            </button>
          )}
          {confirmDelete ? (
            <>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Are you sure?</span>
              <button className="delete-agent-btn confirm" onClick={handleDelete}>Yes, delete</button>
              <button className="delete-agent-btn cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            !editMode && <button className="delete-agent-btn" onClick={handleDelete}>Delete Agent</button>
          )}
        </div>
      </div>

      <div className="detail-header">
        {editMode ? (
          <form className="edit-agent-form" onSubmit={handleEdit}>
            <input
              className="edit-agent-input edit-agent-name-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Agent name"
              required
            />
            <input
              className="edit-agent-input"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              placeholder="Description"
            />
            <div className="edit-agent-actions">
              <button type="submit" className="sandbox-agent-btn sandbox-agent-btn-primary" disabled={editSaving || !editName.trim()}>
                {editSaving ? "Saving..." : "Save Changes"}
              </button>
              <button type="button" className="sandbox-agent-btn" onClick={() => setEditMode(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div>
            <h1>{agent.name}</h1>
            <p>{agent.description}</p>
            <div className="detail-tools">
              {agent.tools.map((t) => (
                <span key={t.name} className="tool-chip-lg">{t.service}</span>
              ))}
            </div>
          </div>
        )}
        <div className="detail-score" style={{ color: scoreColor }}>
          <svg className="detail-score-svg" viewBox="0 0 110 110">
            <circle cx="55" cy="55" r={ringR} fill="none" stroke="currentColor" strokeWidth="7" opacity="0.12" />
            <circle cx="55" cy="55" r={ringR} fill="none" stroke="currentColor" strokeWidth="7"
              strokeDasharray={ringC}
              strokeDashoffset={ringOffset}
              strokeLinecap="round"
              transform="rotate(-90 55 55)"
              style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1)" }}
            />
          </svg>
          <div className="ds-number">{br.score}</div>
          <div className="ds-label">Risk Score</div>
          <div className="ds-level">{scoreLevel}</div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="detail-stats" style={{ gridTemplateColumns: `repeat(${visibleStats.length}, 1fr)` }}>
        {visibleStats.map((s) => (
          <div key={s.label} className="d-stat" style={s.color ? { color: s.color } : undefined}>
            <strong>{s.value}</strong>
            <span>
              {s.label}
              {s.tooltip && (
                <Tooltip text={s.tooltip}>
                  <span className="jargon-hint">?</span>
                </Tooltip>
              )}
            </span>
          </div>
        ))}
      </div>

      {/* Enforcement Policies */}
      <div className="detail-section" style={{ position: "relative", zIndex: 2 }}>
        <div className="chain-section-header">
          <h2>
            Enforcement Policies ({sortedPolicies.length})
            <Tooltip text="Rules that tell Arceo what to do when this agent attempts specific actions — block them outright, require a human to approve first, or explicitly allow them.">
              <span className="jargon-hint">?</span>
            </Tooltip>
          </h2>
          <div className="chain-sev-counts">
            {policyEffectCounts.BLOCK > 0 && <span className="chain-sev-chip" style={{ background: "#fef2f2", color: "#dc2626" }}>{policyEffectCounts.BLOCK} Block</span>}
            {policyEffectCounts.REQUIRE_APPROVAL > 0 && <span className="chain-sev-chip" style={{ background: "#fff7ed", color: "#ea580c" }}>{policyEffectCounts.REQUIRE_APPROVAL} Req. Approval</span>}
            {policyEffectCounts.ALLOW > 0 && <span className="chain-sev-chip" style={{ background: "#f0fdf4", color: "#16a34a" }}>{policyEffectCounts.ALLOW} Allow</span>}
          </div>
        </div>
        {allSamePolicyReason && (
          <p className="policy-shared-reason">All policies: {allSamePolicyReason}</p>
        )}
        <div className="policies-list">
          {sortedPolicies.map((p) => {
            const es = EFFECT_STYLE[p.effect] || EFFECT_STYLE.BLOCK;
            const { service, action } = parsePolicyPattern(p.action_pattern);
            const effectLabel = p.effect === "REQUIRE_APPROVAL" ? "Approval" : p.effect === "BLOCK" ? "Block" : "Allow";
            return (
              <div key={p.id} className="policy-row" style={{ borderLeftColor: es.color }}>
                <span className="policy-effect-dot" style={{ background: es.color }} title={p.effect} />
                <div className="policy-row-main">
                  <div className="policy-row-top">
                    <div className="policy-action">
                      {service && <span className="policy-service">{service}</span>}
                      <span className="policy-action-name">{action}</span>
                    </div>
                    <span className="policy-effect-label" style={{ background: es.bg, color: es.color }}>{effectLabel}</span>
                  </div>
                  {!allSamePolicyReason && p.reason && <span className="policy-reason">{p.reason}</span>}
                  {p.conditions && p.conditions.length > 0 && (
                    <div className="policy-conditions-display">
                      {p.conditions.map((c, ci) => (
                        <span key={ci} className="policy-condition-chip">
                          {c.op === "requires_prior"
                            ? `if prior: ${c.value}`
                            : `${c.field} ${c.op} ${c.value}`}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button className="policy-delete" onClick={() => handleDeletePolicy(p.id)}>Remove</button>
              </div>
            );
          })}
        </div>
        {policyConflicts.length > 0 && (
          <div className="policy-conflict-banner">
            <div className="pcb-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="#b45309" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="pcb-body">
              <strong>{policyConflicts.length} policy conflict{policyConflicts.length !== 1 ? "s" : ""} detected</strong>
              <span>Overlapping rules — only the highest-priority policy applies per action.</span>
              <div className="pcb-conflicts">
                {policyConflicts.slice(0, 3).map((c, i) => (
                  <div key={i} className="pcb-conflict-row">
                    <code>{c.winner?.action_pattern || c.pattern || "—"}</code>
                    <span className="pcb-overrides">overrides</span>
                    <code>{c.loser?.action_pattern || "—"}</code>
                  </div>
                ))}
                {policyConflicts.length > 3 && (
                  <span className="pcb-more">+{policyConflicts.length - 3} more</span>
                )}
              </div>
            </div>
          </div>
        )}
        {sortedPolicies.length === 0 && (
          <div className="zero-policies-callout">
            <div className="zpc-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L4 6v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V6L12 2z" stroke="#ca8a04" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M12 8v4M12 16h.01" stroke="#ca8a04" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </div>
            <div className="zpc-body">
              <strong>No enforcement rules set</strong>
              <span>This agent runs with no restrictions. Add a policy below to block or require approval for risky actions.</span>
            </div>
          </div>
        )}
        <form className="policy-form" onSubmit={handleAddPolicy}>
          <div className="policy-form-field-label">1. Choose actions</div>
          <ActionPicker tools={agent.tools} selectedPatterns={newPatterns} onAdd={addPattern} />
          {newPatterns.length > 0 && (
            <div className="selected-patterns">
              {newPatterns.map((p) => {
                const isWildcard = p.endsWith(".*");
                const { service, action } = parsePolicyPattern(p);
                const dot = p.indexOf(".");
                const toolName = dot !== -1 ? p.slice(0, dot) : p;
                const actionName = dot !== -1 ? p.slice(dot + 1) : "";
                const tool = agent.tools.find((t) => t.name === toolName);
                const actionObj = isWildcard ? null : tool?.actions.find((a) => a.action === actionName);
                const isIrrev = actionObj?.reversible === false;
                const riskLabels = actionObj?.risk_labels || [];
                return (
                  <span key={p} className="sp-chip">
                    <span className="sp-chip-service">{service}</span>
                    <span className="sp-chip-sep">›</span>
                    <span className="sp-chip-action">{action}</span>
                    {isWildcard && <span className="ap-badge ap-badge-wildcard">wildcard</span>}
                    {isIrrev && <span className="ap-badge ap-badge-irrev">irreversible</span>}
                    {!isIrrev && !isWildcard && riskLabels.length > 0 && <span className="ap-badge ap-badge-risky">risky</span>}
                    <button type="button" className="sp-chip-remove" onClick={() => removePattern(p)}>×</button>
                  </span>
                );
              })}
              {newPatterns.length > 1 && (
                <button type="button" className="sp-clear" onClick={() => setNewPatterns([])}>Clear all</button>
              )}
            </div>
          )}
          {newPatterns.some((p) => p.endsWith(".*")) && (
            <p className="policy-wildcard-hint">
              Wildcard patterns apply to <strong>all actions</strong> in that service.
            </p>
          )}
          <div className="policy-form-field-label" style={{ marginTop: 4 }}>2. Set enforcement</div>
          <EffectToggle value={newEffect} onChange={setNewEffect} />
          {newEffect !== "ALLOW" && (
            <input
              className="policy-reason-input"
              placeholder={newEffect === "BLOCK" ? "Why should this be blocked? (e.g. No refunds over $500 without manager sign-off)" : "When should this require approval? (e.g. Any charge over $100 or from a new customer)"}
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
              required
            />
          )}
          {newEffect === "ALLOW" && (
            <input
              className="policy-reason-input"
              placeholder="Reason (optional)"
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
            />
          )}
          <div className="policy-form-conditions-section">
            <button
              type="button"
              className="conditions-toggle-btn"
              onClick={() => setShowConditions((v) => !v)}
            >
              {showConditions ? "▾" : "▸"} Conditions (optional)
              {newConditions.length > 0 && (
                <span className="condition-count-badge">{newConditions.length}</span>
              )}
            </button>
            {showConditions && (
              <>
                <p className="policy-form-conditions-hint">
                  Only trigger this policy when specific parameters match — e.g. only block charges over $500, or only require approval for new customers.
                </p>
                <ConditionBuilder conditions={newConditions} onChange={setNewConditions} />
              </>
            )}
          </div>
          <button type="submit" className="policy-submit-btn" disabled={newPatterns.length === 0 || (newEffect !== "ALLOW" && !newReason.trim())}>
            {newPatterns.length > 1 ? `Add ${newPatterns.length} Policies` : "Add Policy"}
          </button>
        </form>
        {policyAdded && (
          <div className="policy-added-banner">
            <span className="policy-added-icon">✓</span>
            <span>Policies saved — they'll be enforced on your next simulation run.</span>
            <Link to="/sandbox" className="policy-added-link">Run in Sandbox →</Link>
          </div>
        )}
      </div>

      {/* Execution Log */}
      {executions && executions.length > 0 && (
        <div className="detail-section">
          <h2>Recent Executions ({executions.length})</h2>
          {allUnpolicied && (
            <div className="no-policy-banner">
              None of these {executions.length} executions matched a policy — this agent runs with no enforcement rules.
              <span className="no-policy-hint">Use the form above to block or require approval for risky actions.</span>
            </div>
          )}
          <div className="exec-list">
            {executions.slice(0, 20).map((e) => {
              const st = EXEC_STATUS_STYLE[e.status] || {};
              const dot = actionRiskDot(e.tool, e.action);
              const statusLabel = e.status === "PENDING_APPROVAL" ? "Pending" : e.status.charAt(0) + e.status.slice(1).toLowerCase();
              return (
                <div key={e.id} className="exec-row">
                  <span className="exec-time">{formatExecTime(e.timestamp)}</span>
                  <div className="exec-action-cell">
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0, display: "inline-block" }} />
                    <span className="exec-tool">{e.tool.charAt(0).toUpperCase() + e.tool.slice(1)}</span>
                    <span className="exec-action">{formatAction(e.action)}</span>
                  </div>
                  <span className="exec-status" style={{ background: st.bg, color: st.color }}>{statusLabel}</span>
                  {!allUnpolicied && <span className="exec-detail">{e.detail}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Authority Map */}
      <div className="detail-section">
        <div className="am-section-header">
          <h2>
            Authority Graph
            <Tooltip text="A complete map of every tool and action this agent has access to, grouped by service and color-coded by risk level.">
              <span className="jargon-hint">?</span>
            </Tooltip>
          </h2>
          <div className="am-legend">
            <span><span className="am-dot am-dot-safe" /> Safe</span>
            <span><span className="am-dot am-dot-risky" /> Risky</span>
            <span><span className="am-dot am-dot-irreversible" /> Irreversible</span>
          </div>
        </div>
        <AuthorityMap graph={graph} />
      </div>

      {/* Chains */}
      {chains.length > 0 && (
        <div className="detail-section">
          <div className="chain-section-header">
            <h2>
              Dangerous Chains ({chains.length})
              <Tooltip text="Multi-step sequences where two or more of this agent's capabilities combine to create elevated risk — e.g. accessing customer PII then emailing it externally.">
                <span className="jargon-hint">?</span>
              </Tooltip>
            </h2>
            <div className="chain-sev-counts">
              {chains.filter((c) => c.severity === "critical").length > 0 && (
                <span className="chain-sev-chip chain-sev-critical">{chains.filter((c) => c.severity === "critical").length} Critical</span>
              )}
              {chains.filter((c) => c.severity === "high").length > 0 && (
                <span className="chain-sev-chip chain-sev-high">{chains.filter((c) => c.severity === "high").length} High</span>
              )}
            </div>
          </div>
          <div className="detail-chains">
            {chains.map((c) => {
              const sev = SEV_STYLE[c.severity] || SEV_STYLE.high;
              const isOpen = !collapsedChains[c.id];
              return (
                <div key={c.id} className="d-chain" style={{ borderLeftColor: sev.color }}>
                  <div className="d-chain-header" onClick={() => toggleChain(c.id)}>
                    <div className="d-chain-top">
                      <span className="d-chain-sev" style={{ background: sev.bg, color: sev.color }}>{c.severity}</span>
                      <strong>{c.name}</strong>
                    </div>
                    <span className="d-chain-chevron">{isOpen ? "▾" : "▸"}</span>
                  </div>
                  {isOpen && (
                    <>
                      <p>{c.description}</p>
                      <div className="d-chain-steps">
                        {c.steps.map((step, j) => (
                          <span key={j}>
                            <span className="step-tag" style={{
                              borderColor: RISK_COLORS[step] || "#ccc",
                              color: RISK_COLORS[step] || "#555",
                              background: (RISK_COLORS[step] || "#ccc") + "12",
                            }}>
                              {RISK_LABELS[step] || step}
                            </span>
                            {j < c.steps.length - 1 && <span className="step-arrow">→</span>}
                          </span>
                        ))}
                      </div>
                      <div className="d-chain-actions">
                        {c.matching_actions.map((group, gi) => {
                          const byService = {};
                          const order = [];
                          group.forEach((a) => {
                            const dot = a.indexOf(".");
                            const svc = dot > -1 ? a.slice(0, dot) : a;
                            const act = dot > -1 ? a.slice(dot + 1) : a;
                            if (!byService[svc]) { byService[svc] = []; order.push(svc); }
                            byService[svc].push(act);
                          });
                          return (
                            <div key={gi} className="match-group">
                              <span className="match-label">Step {gi + 1}</span>
                              <div className="match-service-rows">
                                {order.map((svc) => (
                                  <div key={svc} className="match-service-row">
                                    <span className="match-svc">{svc.charAt(0).toUpperCase() + svc.slice(1)}</span>
                                    {byService[svc].map((a) => {
                                      const isDanger = /delete|terminate|drop|destroy|cancel|charge|refund/.test(a.toLowerCase());
                                      return (
                                        <span key={a} className={`match-action${isDanger ? " match-action-danger" : ""}`}>
                                          {formatAction(a)}
                                        </span>
                                      );
                                    })}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {visibleRecs.length > 0 && (
        <div className="detail-section">
          <div className="chain-section-header">
            <h2>
              Recommendations ({visibleRecs.length})
              <Tooltip text="Policy suggestions auto-generated based on this agent's risk profile. Applying them adds enforcement rules to reduce your exposure.">
                <span className="jargon-hint">?</span>
              </Tooltip>
            </h2>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="chain-sev-counts">
                {visibleRecs.filter(({ r }) => r.severity === "critical").length > 0 && (
                  <span className="chain-sev-chip chain-sev-critical">{visibleRecs.filter(({ r }) => r.severity === "critical").length} Critical</span>
                )}
                {visibleRecs.filter(({ r }) => r.severity === "high").length > 0 && (
                  <span className="chain-sev-chip chain-sev-high">{visibleRecs.filter(({ r }) => r.severity === "high").length} High</span>
                )}
              </div>
              <div className="apply-recs-wrapper">
                <button
                  className="apply-recs-btn"
                  onClick={() => {
                    setSelectedRecs(new Set(visibleRecs.map(({ i }) => i)));
                    setShowRecsMenu((v) => !v);
                  }}
                >
                  Apply Recommendations {showRecsMenu ? "▾" : "▸"}
                </button>
                {showRecsMenu && (
                  <div className="apply-recs-menu">
                    <div className="apply-recs-menu-header">
                      <span>Select to apply</span>
                      <button className="apply-recs-toggle" onClick={() =>
                        setSelectedRecs(selectedRecs.size === visibleRecs.length ? new Set() : new Set(visibleRecs.map(({ i }) => i)))
                      }>
                        {selectedRecs.size === visibleRecs.length ? "Deselect all" : "Select all"}
                      </button>
                    </div>
                    {visibleRecs.map(({ r, i }) => {
                      const sev = SEV_STYLE[r.severity] || SEV_STYLE.high;
                      const checked = selectedRecs.has(i);
                      return (
                        <label key={i} className="apply-recs-item">
                          <input type="checkbox" checked={checked} onChange={() => {
                            const next = new Set(selectedRecs);
                            checked ? next.delete(i) : next.add(i);
                            setSelectedRecs(next);
                          }} />
                          <span className="rec-sev" style={{ background: sev.bg, color: sev.color }}>{r.severity}</span>
                          <span className="apply-recs-item-title">{r.title}</span>
                        </label>
                      );
                    })}
                    <div className="apply-recs-menu-footer">
                      <button className="apply-recs-confirm" onClick={handleApplySelected} disabled={applyingRecs || selectedRecs.size === 0}>
                        {applyingRecs ? "Applying…" : `Apply ${selectedRecs.size} selected`}
                      </button>
                      <button className="apply-recs-cancel" onClick={() => setShowRecsMenu(false)}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="recs">
            {visibleRecs.map(({ r, i }) => {
              const sev = SEV_STYLE[r.severity] || SEV_STYLE.high;
              return (
                <div key={i} className="rec-card" style={{ borderLeftColor: sev.color }}>
                  <div className="rec-top">
                    <span className="rec-sev" style={{ background: sev.bg, color: sev.color }}>{r.severity}</span>
                    <strong>{r.title}</strong>
                  </div>
                  <p>{formatDescription(r.description)}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Integration Guide ── */}
      <div className="integration-guide">
        <button className="integration-guide-toggle" onClick={() => setShowIntegration((v) => !v)}>
          <span>How to enforce policies for this agent</span>
          <span className="integration-guide-chevron">{showIntegration ? "▲" : "▼"}</span>
        </button>
        {showIntegration && (
          <div className="integration-guide-body">
            <p className="integration-guide-desc">
              Call <code>POST /api/enforce</code> before every tool action this agent takes. Use the agent ID below — Arceo checks your policies and returns a decision in &lt;10ms.
            </p>
            <div className="integration-agent-id-row">
              <span className="integration-label">Agent ID</span>
              <code className="integration-agent-id">{agentId}</code>
              <button className="copy-inline-btn" onClick={() => navigator.clipboard.writeText(agentId)}>Copy</button>
            </div>
            <IntegrationSnippets agentId={agentId} token={getToken()} />
          </div>
        )}
      </div>
    </div>
  );
}

function IntegrationSnippets({ agentId, token }) {
  const [tab, setTab] = useState("python");
  const shortToken = token ? token.slice(0, 20) + "..." : "YOUR_TOKEN";

  const snippets = {
    python: `import requests

def enforce(tool: str, action: str, params: dict) -> str:
    resp = requests.post(
        "http://localhost:8000/api/enforce",
        json={
            "agent_id": "${agentId}",
            "tool": tool,
            "action": action,
            "params": params
        },
        headers={"Authorization": "Bearer ${shortToken}"}
    )
    return resp.json()["decision"]  # "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL"

# Usage — call before every tool action:
decision = enforce("Stripe", "create_refund", {"amount": 500})
if decision == "ALLOW":
    stripe.create_refund(...)
elif decision == "BLOCK":
    raise Exception("Action blocked by policy")`,

    curl: `curl -X POST http://localhost:8000/api/enforce \\
  -H "Authorization: Bearer ${shortToken}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "${agentId}",
    "tool": "Stripe",
    "action": "create_refund",
    "params": {"amount": 500}
  }'`,

    node: `const response = await fetch("http://localhost:8000/api/enforce", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${shortToken}",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    agent_id: "${agentId}",
    tool: "Stripe",
    action: "create_refund",
    params: { amount: 500 }
  })
});
const { decision } = await response.json();
// decision: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL"`,
  };

  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(snippets[tab]);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="integration-snippet-wrap">
      <div className="integration-tabs">
        {["python", "curl", "node"].map((t) => (
          <button key={t} className={`integration-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {t === "node" ? "Node.js" : t}
          </button>
        ))}
        <button className="integration-copy-btn" onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
      </div>
      <pre className="integration-code"><code>{snippets[tab]}</code></pre>
    </div>
  );
}
