import { useState, useEffect, useMemo, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiFetch } from "./api.js";
import { toast } from "./Toast.jsx";
import "./Authority.css";

function Tooltip({ text, children }) {
  return (
    <span className="tooltip-wrap">
      {children}
      <span className="tooltip-bubble">{text}</span>
    </span>
  );
}

const SEVERITY_COLORS = {
  critical: { bg: "#fef2f2", color: "#dc2626", border: "#fca5a5" },
  high: { bg: "#fff7ed", color: "#ea580c", border: "#fdba74" },
  medium: { bg: "#fefce8", color: "#ca8a04", border: "#fde68a" },
};

function timeAgo(ts) {
  if (!ts) return "";
  const diff = (Date.now() - new Date(ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z")) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const SORT_OPTIONS = [
  { value: "score-desc", label: "Highest Risk" },
  { value: "score-asc", label: "Lowest Risk" },
  { value: "actions-desc", label: "Most Actions" },
  { value: "chains-desc", label: "Most Chains" },
  { value: "name-asc", label: "Name A-Z" },
];

const RISK_FILTERS = [
  { value: "all", label: "All Agents" },
  { value: "critical", label: "Critical (70+)" },
  { value: "warning", label: "Warning (40-69)" },
  { value: "safe", label: "Safe (<40)" },
];

function RiskBar({ label, count, max, color }) {
  if (count === 0) return null;
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="risk-bar-row">
      <span className="risk-bar-label">{label}</span>
      <div className="risk-bar-track">
        <div className="risk-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="risk-bar-count">{count}</span>
    </div>
  );
}

function AgentCard({ agent }) {
  const br = agent.blast_radius;
  const scoreColor = br.score >= 70 ? '#dc2626' : br.score >= 40 ? '#f59e0b' : '#16a34a';
  const riskLevel = br.score >= 70 ? "Critical" : br.score >= 40 ? "Warning" : "Safe";
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - br.score / 100);

  return (
    <Link to={`/agent/${agent.id}`} className={`agent-card risk-${riskLevel.toLowerCase()}`}>
      <div className="agent-card-header">
        <div>
          <h3>{agent.name}</h3>
          <p className="agent-desc">{agent.description}</p>
          <div className="agent-tools">
            {agent.tools.map((t) => (
              <span key={t} className="tool-chip">{t}</span>
            ))}
          </div>
        </div>
        <div className="blast-score" style={{ color: scoreColor }}>
          <svg className="blast-ring" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r={radius} fill="none" stroke="currentColor" strokeWidth="5" opacity="0.15" />
            <circle cx="40" cy="40" r={radius} fill="none" stroke="currentColor" strokeWidth="5"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              transform="rotate(-90 40 40)"
              style={{ transition: "stroke-dashoffset 0.6s ease" }}
            />
          </svg>
          <div className="blast-number">{br.score}</div>
          <div className="blast-label">Risk Score</div>
          <div className="blast-level">{riskLevel}</div>
        </div>
      </div>

      <div className="risk-bars">
        <RiskBar label="Moves Money"        count={br.moves_money}        max={br.total_actions} color="#dc2626" />
        <RiskBar label="Touches PII"        count={br.touches_pii}        max={br.total_actions} color="#7c3aed" />
        <RiskBar label="Deletes Data"       count={br.deletes_data}       max={br.total_actions} color="#ea580c" />
        <RiskBar label="Sends External"     count={br.sends_external}     max={br.total_actions} color="#2563eb" />
        <RiskBar label="Changes Production" count={br.changes_production} max={br.total_actions} color="#0d9488" />
      </div>

      <div className="agent-card-footer">
        <span className="stat">{br.total_actions} actions</span>
        <span className="stat">{br.irreversible_actions}/{br.total_actions} permanent</span>
        <span className="stat chain-stat">
          {agent.chain_count} risk combos
          {agent.critical_chains > 0 && (
            <span className="crit-badge">{agent.critical_chains} critical</span>
          )}
        </span>
      </div>
      <div className="agent-card-meta-row">
        <span className={`agent-policy-badge${(agent.policy_count || 0) === 0 ? " no-policies" : ""}`}>
          {(agent.policy_count || 0) === 0 ? "⚠ No policies" : `${agent.policy_count} polic${agent.policy_count === 1 ? "y" : "ies"}`}
        </span>
        {(agent.pending_count || 0) > 0 && (
          <span className="agent-pending-badge">{agent.pending_count} pending approval</span>
        )}
        {agent.last_execution_at && (
          <span className="agent-last-seen">Last active {timeAgo(agent.last_execution_at)}</span>
        )}
      </div>
    </Link>
  );
}

export default function Authority() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [agents, setAgents] = useState([]);
  const [chains, setChains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [executions, setExecutions] = useState([]);

  // Filters
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("score-desc");
  const [riskFilter, setRiskFilter] = useState("all");
  const [chainSeverityFilter, setChainSeverityFilter] = useState("all");

  // Create agent form
  const [showCreate, setShowCreate] = useState(false);
  const [connectTab, setConnectTab] = useState("manual"); // "manual" | "mcp"
  const connectFormRef = useRef(null);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newToolsText, setNewToolsText] = useState("");
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState(null);

  // MCP connect
  const [showMcpConnect, setShowMcpConnect] = useState(false);
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpAgentName, setMcpAgentName] = useState("");
  const [mcpConnecting, setMcpConnecting] = useState(false);
  const [mcpResult, setMcpResult] = useState(null);

  const [simulations, setSimulations] = useState([]);

  const loadData = () => {
    Promise.all([
      apiFetch("/api/authority/agents"),
      apiFetch("/api/authority/chains"),
      apiFetch("/api/executions").catch(() => ({ entries: [] })),
      apiFetch("/api/sandbox/simulations").catch(() => ({ simulations: [] })),
    ])
      .then(([agentData, chainData, execData, simData]) => {
        setAgents(agentData.agents);
        setChains(chainData.chains);
        setExecutions(execData.entries || []);
        setSimulations(simData.simulations || []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  // Auto-open connect form when ?connect=true (e.g. from sidebar CTA)
  useEffect(() => {
    if (searchParams.get("connect") === "true") {
      setShowCreate(true);
      setConnectTab("manual");
      setSearchParams({}, { replace: true });
      setTimeout(() => connectFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    }
  }, [searchParams]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    setCreateResult(null);
    try {
      // Parse tools text: each line is "toolname: action1, action2, action3"
      const tools = newToolsText.trim().split("\n").filter(Boolean).map((line) => {
        const [toolPart, actionsPart] = line.split(":").map((s) => s.trim());
        const actions = (actionsPart || "").split(",").map((a) => a.trim()).filter(Boolean);
        return {
          name: toolPart.toLowerCase().replace(/\s+/g, "_"),
          service: toolPart,
          description: toolPart,
          actions: actions.map((a) => ({
            action: a.toLowerCase().replace(/\s+/g, "_"),
            description: a,
            risk_labels: [],
            reversible: true,
          })),
        };
      });

      const data = await apiFetch("/api/authority/agents", {
        method: "POST",
        body: JSON.stringify({ name: newName, description: newDesc, tools }),
      });

      setCreateResult(data);
      setNewName("");
      setNewDesc("");
      setNewToolsText("");
      setShowCreate(false);
      toast("Agent created successfully");
      loadData(); // refresh
    } catch (err) {
      setCreateResult({ error: err.message });
      toast(err.message, "error");
    }
    setCreating(false);
  };

  // Filtered + sorted agents
  const filteredAgents = useMemo(() => {
    let result = [...agents];

    // Search by name, description, or tool
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.tools.some((t) => t.toLowerCase().includes(q))
      );
    }

    // Risk level filter
    if (riskFilter === "critical") result = result.filter((a) => a.blast_radius.score >= 70);
    else if (riskFilter === "warning") result = result.filter((a) => a.blast_radius.score >= 40 && a.blast_radius.score < 70);
    else if (riskFilter === "safe") result = result.filter((a) => a.blast_radius.score < 40);

    // Sort
    const [field, dir] = sortBy.split("-");
    result.sort((a, b) => {
      let va, vb;
      if (field === "score") { va = a.blast_radius.score; vb = b.blast_radius.score; }
      else if (field === "actions") { va = a.blast_radius.total_actions; vb = b.blast_radius.total_actions; }
      else if (field === "chains") { va = a.chain_count; vb = b.chain_count; }
      else if (field === "name") { va = a.name; vb = b.name; }
      if (typeof va === "string") return dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return dir === "asc" ? va - vb : vb - va;
    });

    return result;
  }, [agents, search, sortBy, riskFilter]);

  // Filtered chains
  const filteredChains = useMemo(() => {
    if (chainSeverityFilter === "all") return chains;
    return chains.filter((c) => c.severity === chainSeverityFilter);
  }, [chains, chainSeverityFilter]);

  const agentNameMap = useMemo(() => {
    const m = {};
    agents.forEach((a) => { m[a.id] = a.name; });
    return m;
  }, [agents]);

  const agentIdByName = useMemo(() => {
    const m = {};
    agents.forEach((a) => { m[a.name] = a.id; });
    return m;
  }, [agents]);

  const formatRiskTag = (tag) =>
    tag.split("_").map((w) => (w === "pii" ? "PII" : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");

  const stepTagStyle = (step) => {
    const s = step.toLowerCase();
    if (s.includes("pii"))                                   return { bg: "#f5f3ff", color: "#7c3aed", border: "#ddd6fe" };
    if (s.includes("money") || s.includes("charge"))        return { bg: "#eff6ff", color: "#2563eb", border: "#bfdbfe" };
    if (s.includes("delet"))                                 return { bg: "#fef2f2", color: "#dc2626", border: "#fecaca" };
    if (s.includes("external") || s.includes("send"))       return { bg: "#fdf4ff", color: "#a21caf", border: "#f0abfc" };
    if (s.includes("production") || s.includes("change"))   return { bg: "#f0fdfa", color: "#0d9488", border: "#99f6e4" };
    return { bg: "var(--bg)", color: "var(--text-secondary)", border: "var(--border)" };
  };

  if (loading) {
    return (
      <div className="authority-page">
        <div className="loading-state">
          <div className="spinner" />
          <p>Loading authority data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="authority-page">
        <div className="error-state">
          <div className="error-icon">!</div>
          <h2>Failed to load data</h2>
          <p>{error}</p>
          <button className="retry-btn" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const criticalChains = chains.filter((c) => c.severity === "critical");

  // Onboarding checklist — show until all 4 steps done
  const hasAgent = agents.length > 0;
  const hasSimulation = simulations.length > 0;
  const hasExecution = executions.length > 0;
  const hasPolicies = agents.some((a) => (a.policy_count || 0) > 0);
  const checklistDone = hasAgent && hasSimulation && hasExecution && hasPolicies;
  const checklistSteps = [
    { done: hasAgent,     label: "Connect your first agent",   action: () => setShowCreate(true),   link: null },
    { done: hasSimulation,label: "Run a simulation in Sandbox", action: null,                        link: "/sandbox" },
    { done: hasExecution, label: "Send a real enforcement call",action: null,                        link: "/settings" },
    { done: hasPolicies,  label: "Add an enforcement policy",   action: null,                        link: agents[0] ? `/agent/${agents[0].id}` : "/" },
  ];
  const checklistProgress = checklistSteps.filter((s) => s.done).length;
  const totalActions = agents.reduce((s, a) => s + a.blast_radius.total_actions, 0);
  const totalIrreversible = agents.reduce((s, a) => s + a.blast_radius.irreversible_actions, 0);

  // Today / yesterday stats from executions
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const todayExecs = executions.filter((e) => new Date(e.timestamp) >= todayStart);
  const yesterdayExecs = executions.filter((e) => {
    const t = new Date(e.timestamp);
    return t >= yesterdayStart && t < todayStart;
  });
  const todayBlocked = todayExecs.filter((e) => e.status === "BLOCKED").length;
  const yesterdayBlocked = yesterdayExecs.filter((e) => e.status === "BLOCKED").length;
  const todayExecuted = todayExecs.filter((e) => e.status === "EXECUTED").length;

  // 7-day bar chart data
  const days7 = Array.from({ length: 7 }, (_, i) => {
    const start = new Date(todayStart.getTime() - (6 - i) * 86400000);
    const end = new Date(start.getTime() + 86400000);
    const dayExecs = executions.filter((e) => {
      const t = new Date(e.timestamp);
      return t >= start && t < end;
    });
    return {
      label: start.toLocaleDateString("en-US", { weekday: "short" }),
      total: dayExecs.length,
      blocked: dayExecs.filter((e) => e.status === "BLOCKED").length,
    };
  });
  const maxDay = Math.max(...days7.map((d) => d.total), 1);

  const recentExecs = executions.slice(0, 10);

  const formatAction = (action) =>
    action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const actionRiskDot = (tool, action) => {
    const s = `${tool}.${action}`.toLowerCase();
    if (/delete|terminate|drop|destroy|remove|cancel/.test(s)) return "#dc2626";
    if (/charge|transfer|pay|refund|create_charge/.test(s)) return "#2563eb";
    if (/send|email|message|notify/.test(s)) return "#7c3aed";
    return "#9ca3af";
  };

  const handleMcpConnect = async (e) => {
    e.preventDefault();
    setMcpConnecting(true);
    setMcpResult(null);
    try {
      const data = await apiFetch("/api/authority/agents/connect/mcp", {
        method: "POST",
        body: JSON.stringify({
          url: mcpUrl,
          agent_name: mcpAgentName,
        }),
      });
      setMcpResult(data);
      setMcpUrl("");
      setMcpAgentName("");
      setShowMcpConnect(false);
      toast(`Connected — ${data.tools_imported} tool${data.tools_imported !== 1 ? "s" : ""} imported`);
      loadData();
    } catch (err) {
      setMcpResult({ error: err.message });
      toast(err.message, "error");
    }
    setMcpConnecting(false);
  };

  // Agent templates for one-click onboarding
  const TEMPLATES = [
    {
      name: "Customer Support Agent",
      description: "Handles tickets, refunds, account lookups, and customer emails",
      tools: "Stripe: get_customer, list_payments, create_refund, create_charge, cancel_subscription\nZendesk: get_ticket, update_ticket, close_ticket, add_comment, delete_ticket\nSalesforce: query_contacts, get_account, update_record, delete_record\nSendGrid: send_email, send_template_email",
    },
    {
      name: "DevOps Agent",
      description: "Manages deployments, infrastructure, incidents, and team notifications",
      tools: "GitHub: list_repos, get_pull_request, merge_pull_request, create_branch, delete_branch, trigger_workflow, create_release\nAWS: list_instances, start_instance, stop_instance, terminate_instance, scale_service, update_security_group, delete_snapshot\nSlack: send_message, send_channel_message\nPagerDuty: create_incident, acknowledge_incident, resolve_incident, escalate_incident",
    },
    {
      name: "Sales Agent",
      description: "Manages leads, outreach, deals, meetings, and pipeline updates",
      tools: "HubSpot: get_contact, create_contact, update_contact, delete_contact, list_deals, update_deal, create_deal, query_contacts\nGmail: send_email, read_inbox, search_emails, create_draft, send_draft\nSlack: send_message, send_channel_message\nCalendly: list_events, create_invite_link, cancel_event, get_availability",
    },
  ];

  const handleCreateFromTemplate = async (template) => {
    setCreating(true);
    try {
      const tools = template.tools.trim().split("\n").filter(Boolean).map((line) => {
        const [toolPart, actionsPart] = line.split(":").map((s) => s.trim());
        const actions = (actionsPart || "").split(",").map((a) => a.trim()).filter(Boolean);
        return {
          name: toolPart.toLowerCase().replace(/\s+/g, "_"),
          service: toolPart,
          description: toolPart,
          actions: actions.map((a) => ({
            action: a.toLowerCase().replace(/\s+/g, "_"),
            description: a,
            risk_labels: [],
            reversible: true,
          })),
        };
      });
      await apiFetch("/api/authority/agents", {
        method: "POST",
        body: JSON.stringify({ name: template.name, description: template.description, tools }),
      });
      toast(`${template.name} created`);
      loadData();
    } catch (err) {
      toast("Failed: " + err.message, "error");
    }
    setCreating(false);
  };

  // Empty state — onboarding
  if (agents.length === 0 && !showCreate) {
    return (
      <div className="authority-page">
        <div className="onboarding">
          <h1>Welcome to ActionGate</h1>
          <p className="onboarding-sub">Tell us what your AI agent can do. We'll show you what can go wrong.</p>

          <div className="onboarding-steps">
            <div className="onboarding-step">
              <div className="onboarding-num">1</div>
              <h3>Register your agent</h3>
              <p>List the tools your AI agent can use — Stripe, Zendesk, Salesforce, or anything custom.</p>
            </div>
            <div className="onboarding-step">
              <div className="onboarding-num">2</div>
              <h3>See what can go wrong</h3>
              <p>Instantly get a risk score, dangerous capability combinations, and which tools could cause real-world damage.</p>
            </div>
            <div className="onboarding-step">
              <div className="onboarding-num">3</div>
              <h3>Enforce policies</h3>
              <p>Block or require approval for risky actions before they run in production.</p>
            </div>
          </div>

          <h2 className="onboarding-section-title">Start with a template</h2>
          <div className="template-grid">
            {TEMPLATES.map((t, i) => (
              <div key={i} className="template-card" onClick={() => handleCreateFromTemplate(t)}>
                <h3>{t.name}</h3>
                <p>{t.description}</p>
                <div className="template-tools">{t.tools.split("\n").map((l) => l.split(":")[0].trim()).join(", ")}</div>
                <span className="template-cta">{creating ? "Creating..." : "Use This Template"}</span>
              </div>
            ))}
          </div>

          <div className="onboarding-divider">
            <span>or</span>
          </div>

          <div className="onboarding-alt-actions">
            <button className="onboarding-alt-btn" onClick={() => setShowMcpConnect(true)}>
              Connect MCP Server
            </button>
            <button className="onboarding-alt-btn" onClick={() => setShowCreate(true)}>
              Create Custom Agent
            </button>
            <span className="onboarding-alt-hint">
              Or use the SDK: <code>pip install -e sdk/</code> — your agent self-registers on first run
            </span>
          </div>

          {showMcpConnect && (
            <form className="mcp-connect-form" onSubmit={handleMcpConnect}>
              <h3>Connect to MCP Server</h3>
              <p className="mcp-connect-desc">Enter your MCP server's HTTP URL. ActionGate will call tools/list and import all tools automatically.</p>
              <div className="form-row">
                <div className="form-group">
                  <label>MCP Server URL</label>
                  <input type="url" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)}
                         placeholder="http://localhost:3000" required />
                </div>
                <div className="form-group">
                  <label>Agent Name</label>
                  <input type="text" value={mcpAgentName} onChange={(e) => setMcpAgentName(e.target.value)}
                         placeholder="e.g. My MCP Agent" required />
                </div>
              </div>
              <div className="form-actions">
                <button type="button" className="onboarding-alt-btn" onClick={() => setShowMcpConnect(false)}>Cancel</button>
                <button type="submit" disabled={mcpConnecting || !mcpUrl.trim() || !mcpAgentName.trim()}>
                  {mcpConnecting ? "Connecting..." : "Connect & Import"}
                </button>
              </div>
              {mcpResult && mcpResult.error && (
                <div className="run-error" style={{ marginTop: 12 }}><strong>Failed:</strong> {mcpResult.error}</div>
              )}
              {mcpResult && mcpResult.tools_imported && (
                <div className="mcp-success">Imported {mcpResult.tools_imported} tools: {mcpResult.tool_names.join(", ")}</div>
              )}
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="authority-page">
      <header className="auth-header">
        <div className="auth-header-row">
          <div>
            <h1>Dashboard</h1>
            <p>See what your AI agents can do — and what they could do wrong — before it happens in production.</p>
          </div>
          <div className="header-buttons">
            <button className="create-agent-btn" onClick={() => { setShowCreate(!showCreate); setShowMcpConnect(false); }}>
              {showCreate ? "Cancel" : "+ Connect Agent"}
            </button>
          </div>
        </div>
      </header>

      {showCreate && (
        <div className="create-agent-form-wrapper" ref={connectFormRef}>
          <div className="create-agent-form">
            {/* Tabs */}
            <div className="connect-tabs">
              <button
                className={`connect-tab${connectTab === "manual" ? " active" : ""}`}
                onClick={() => setConnectTab("manual")}
                type="button"
              >
                Manual setup
              </button>
              <button
                className={`connect-tab${connectTab === "mcp" ? " active" : ""}`}
                onClick={() => setConnectTab("mcp")}
                type="button"
              >
                Import from MCP server
              </button>
            </div>

            {connectTab === "manual" && (
              <form onSubmit={handleCreate}>
                <div className="form-row">
                  <div className="form-group">
                    <label>Agent Name</label>
                    <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                           placeholder="e.g. Customer Support Agent" required />
                  </div>
                  <div className="form-group">
                    <label>Description</label>
                    <input type="text" value={newDesc} onChange={(e) => setNewDesc(e.target.value)}
                           placeholder="What this agent does" />
                  </div>
                </div>
                <div className="form-group">
                  <label>Tools &amp; Actions (one tool per line: <code>ToolName: action1, action2, action3</code>)</label>
                  <textarea
                    value={newToolsText}
                    onChange={(e) => setNewToolsText(e.target.value)}
                    placeholder={"Stripe: get_customer, create_refund, create_charge\nZendesk: get_ticket, update_ticket, close_ticket\nSendGrid: send_email, list_templates"}
                    rows={4}
                  />
                </div>
                <div className="form-actions">
                  <button type="submit" disabled={creating || !newName.trim() || !newToolsText.trim()}>
                    {creating ? "Creating..." : "Create Agent & Score Risk"}
                  </button>
                </div>
              </form>
            )}

            {connectTab === "mcp" && (
              <form onSubmit={handleMcpConnect}>
                <p className="connect-tab-desc">
                  Point to your MCP server URL — ActionGate auto-discovers all tools and imports them instantly.
                </p>
                <div className="form-row">
                  <div className="form-group">
                    <label>MCP Server URL</label>
                    <input type="url" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)}
                           placeholder="http://localhost:3000" required />
                  </div>
                  <div className="form-group">
                    <label>Agent Name</label>
                    <input type="text" value={mcpAgentName} onChange={(e) => setMcpAgentName(e.target.value)}
                           placeholder="e.g. My Production Agent" required />
                  </div>
                </div>
                <div className="form-actions">
                  <button type="submit" disabled={mcpConnecting || !mcpUrl.trim() || !mcpAgentName.trim()}>
                    {mcpConnecting ? "Connecting..." : "Connect & Import Tools"}
                  </button>
                </div>
                {mcpResult && mcpResult.error && (
                  <div className="run-error" style={{ marginTop: 12 }}><strong>Failed:</strong> {mcpResult.error}</div>
                )}
                {mcpResult && mcpResult.tools_imported && (
                  <div className="mcp-success">Imported {mcpResult.tools_imported} tools: {mcpResult.tool_names.join(", ")}</div>
                )}
              </form>
            )}
          </div>
        </div>
      )}

      {/* Onboarding checklist — hide once all steps complete */}
      {!checklistDone && (
        <div className="setup-checklist">
          <div className="setup-checklist-header">
            <div>
              <span className="setup-checklist-title">Get started</span>
              <span className="setup-checklist-sub">{checklistProgress} of {checklistSteps.length} steps complete</span>
            </div>
            <div className="setup-progress-bar">
              <div className="setup-progress-fill" style={{ width: `${(checklistProgress / checklistSteps.length) * 100}%` }} />
            </div>
          </div>
          <div className="setup-steps">
            {checklistSteps.map((step, i) => (
              <div key={i} className={`setup-step${step.done ? " done" : ""}`}>
                <div className="setup-step-check">
                  {step.done ? (
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2 5.5L4.5 8L9 3" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  ) : (
                    <span className="setup-step-num">{i + 1}</span>
                  )}
                </div>
                <span className="setup-step-label">{step.label}</span>
                {!step.done && (
                  step.action
                    ? <button className="setup-step-cta" onClick={step.action}>Start →</button>
                    : <Link className="setup-step-cta" to={step.link}>Start →</Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Critical alert banner */}
      {criticalChains.length > 0 && (
        <div className="critical-banner">
          <span className="critical-banner-icon">⚠</span>
          <div className="critical-banner-body">
            <strong>{criticalChains.length} high-risk capability combination{criticalChains.length > 1 ? "s" : ""} detected</strong>
            <span className="critical-banner-names">
              Your agents can combine {criticalChains.slice(0, 2).map(c => c.chain_name).join(" and ")}
              {criticalChains.length > 2 ? ` — and ${criticalChains.length - 2} more` : ""}
            </span>
          </div>
          <a href="#danger-chains" className="critical-banner-link">Review risks ↓</a>
        </div>
      )}

      {/* Overview Panel — today + fleet merged into one card */}
      <div className="overview-panel">
        <div className="today-section">
          <div className="today-metrics">
            <div className="today-metric">
              <div className="today-value blocked">{todayBlocked}</div>
              <div className="today-label">Blocked today</div>
              {(todayBlocked > 0 || yesterdayBlocked > 0) && (
                <div className="today-delta">
                  {todayBlocked === yesterdayBlocked ? "— same as yesterday" : todayBlocked > yesterdayBlocked ? `↑ ${todayBlocked - yesterdayBlocked} vs yesterday` : `↓ ${yesterdayBlocked - todayBlocked} vs yesterday`}
                </div>
              )}
            </div>
            <div className="today-metric">
              <div className="today-value executed">{todayExecuted}</div>
              <div className="today-label">Completed today</div>
            </div>
            <div className="today-metric">
              <div className="today-value">{todayExecs.length}</div>
              <div className="today-label">Total today</div>
            </div>
          </div>
          <div className="activity-bars">
            <div className="activity-bars-label">Last 7 days</div>
            <div className="activity-bars-chart">
              {days7.map((d, i) => (
                <div key={i} className="activity-bar-col">
                  <div className="activity-bar-wrap">
                    {d.total > 0 && (
                      <div
                        className={`activity-bar${i === 6 ? " today" : ""}`}
                        style={{ height: `${Math.max((d.total / maxDay) * 100, 15)}%` }}
                        title={`${d.total} actions${d.blocked ? `, ${d.blocked} blocked` : ""}`}
                      />
                    )}
                  </div>
                  <div className="activity-bar-day">{d.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="fleet-overview">
        <div className="fleet-stat">
          <div className="fleet-stat-number">{agents.length}</div>
          <div className="fleet-stat-label">Agents Connected</div>
        </div>
        <div className="fleet-divider" />
        <div className="fleet-stat">
          <div className="fleet-stat-number">{totalActions}</div>
          <div className="fleet-stat-label">Total Actions</div>
        </div>
        <div className="fleet-divider" />
        <div className="fleet-stat fleet-stat-warn">
          <div className="fleet-stat-number">{totalIrreversible}</div>
          <div className="fleet-stat-label">Permanent Actions</div>
        </div>
        <div className="fleet-divider" />
        <div className="fleet-stat fleet-stat-danger">
          <div className="fleet-stat-number">{chains.length}</div>
          <div className="fleet-stat-label">Risk Combinations</div>
        </div>
        <div className="fleet-divider" />
        <div className={`fleet-stat ${criticalChains.length > 0 ? "fleet-stat-critical" : ""}`}>
          <div className="fleet-stat-number">{criticalChains.length}</div>
          <div className="fleet-stat-label">Critical Risks</div>
        </div>
        <div className="fleet-divider" />
        <div className="fleet-stat fleet-risk-level">
          <div className={`fleet-risk-badge ${
            agents.some(a => a.blast_radius.score >= 70) ? "fleet-risk-critical" :
            agents.some(a => a.blast_radius.score >= 40) ? "fleet-risk-warning" :
            "fleet-risk-safe"
          }`}>
            {agents.some(a => a.blast_radius.score >= 70) ? "High Risk" :
             agents.some(a => a.blast_radius.score >= 40) ? "Needs Review" :
             agents.length === 0 ? "No Agents" : "All Clear"}
          </div>
          <div className="fleet-stat-label">Overall Status</div>
        </div>
      </div>
      </div>{/* end overview-panel */}

      {/* Recent Activity Feed */}
      {recentExecs.length > 0 && (
        <div className="recent-activity">
          <div className="section-header">
            <div>
              <h2>Recent Activity</h2>
              <div className="risk-legend">
                <span className="risk-legend-item"><span className="risk-legend-dot" style={{ background: "#dc2626" }} />Destructive</span>
                <span className="risk-legend-item"><span className="risk-legend-dot" style={{ background: "#2563eb" }} />Financial</span>
                <span className="risk-legend-item"><span className="risk-legend-dot" style={{ background: "#7c3aed" }} />Sends message</span>
                <span className="risk-legend-item"><span className="risk-legend-dot" style={{ background: "#9ca3af" }} />Read-only</span>
              </div>
            </div>
            <Link to="/history" className="view-all-link">View all →</Link>
          </div>
          <div className="activity-feed">
            <div className="activity-header">
              <span className="activity-time">Time</span>
              <span className="activity-agent">Agent</span>
              <span className="activity-action-header">Action</span>
              <span className="activity-status-header">Status</span>
            </div>
            {recentExecs.map((e) => {
              const STATUS_STYLE = { EXECUTED: { bg: "#d4edda", color: "#155724" }, BLOCKED: { bg: "#f8d7da", color: "#721c24" }, PENDING_APPROVAL: { bg: "#fff3cd", color: "#856404" } };
              const st = STATUS_STYLE[e.status] || {};
              const dot = actionRiskDot(e.tool, e.action);
              const agentName = agentNameMap[e.agent_id] || e.agent_id;
              const riskClass = dot === "#dc2626" ? " activity-item--destructive" : dot === "#2563eb" ? " activity-item--financial" : dot === "#7c3aed" ? " activity-item--message" : "";
              const statusClass = e.status === "BLOCKED" ? " activity-item--blocked" : e.status === "PENDING_APPROVAL" ? " activity-item--pending" : "";
              return (
                <Link key={e.id} to={`/agent/${e.agent_id}`} className={`activity-item${riskClass}${statusClass}`}>
                  <span className="activity-time">{timeAgo(e.timestamp)}</span>
                  <span className="activity-agent" title={agentName}>{agentName}</span>
                  <div className="activity-action-cell">
                    <span className="activity-dot" style={{ background: dot }} />
                    <span className="activity-tool">{e.tool.charAt(0).toUpperCase() + e.tool.slice(1)}</span>
                    <span className="activity-action">{formatAction(e.action)}</span>
                  </div>
                  <span className="activity-status" style={{ background: st.bg, color: st.color }}>
                    {e.status === "PENDING_APPROVAL" ? "Pending" : e.status === "EXECUTED" ? "Completed" : e.status === "BLOCKED" ? "Blocked" : e.status.charAt(0) + e.status.slice(1).toLowerCase()}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Agent Section with Controls */}
      <section>
        <div className="section-header">
          <h2>Agent Risk Scores <Tooltip text="A 0–100 score showing how much damage an agent could cause if it acted without restriction. Combines irreversible actions, financial exposure, PII access, and dangerous capability chains."><span className="jargon-hint">?</span></Tooltip></h2>
          <div className="controls">
            <input
              type="text"
              className="search-input"
              placeholder="Search agents, tools..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="control-select" value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)}>
              {RISK_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            <select className="control-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {SORT_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>

        {filteredAgents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⚙</div>
            <div className="empty-state-title">No agents match your filters</div>
            <div className="empty-state-desc">Try adjusting your search or risk filter</div>
          </div>
        ) : (
          <div className="agent-grid">
            {filteredAgents.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        )}
      </section>

      {/* Dangerous Chains with filter */}
      <section id="danger-chains">
        <div className="section-header">
          <h2>Dangerous Capability Combinations ({filteredChains.length}) <Tooltip text="Multi-step action sequences where an agent could chain together individually-allowed actions to cause serious harm — e.g. reading PII then emailing it externally."><span className="jargon-hint">?</span></Tooltip></h2>
          <div className="controls">
            <select
              className="control-select"
              value={chainSeverityFilter}
              onChange={(e) => setChainSeverityFilter(e.target.value)}
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical Only</option>
              <option value="high">High Only</option>
            </select>
          </div>
        </div>
        <div className="chains-list">
          {filteredChains.map((c, i) => {
            const sev = SEVERITY_COLORS[c.severity] || SEVERITY_COLORS.high;
            const agentId = agentIdByName[c.agent_name];
            return (
              <div key={i} className="chain-card" style={{ borderLeftColor: sev.border }}>
                <div className="chain-header">
                  <span className="chain-severity" style={{ background: sev.bg, color: sev.color }}>
                    {c.severity.toUpperCase()}
                  </span>
                  <strong>{c.chain_name}</strong>
                  <span className="chain-agent-badge">{c.agent_name}</span>
                  {agentId && (
                    <Link to={`/agent/${agentId}`} className="chain-policy-btn" onClick={(e) => e.stopPropagation()}>
                      Set Policy →
                    </Link>
                  )}
                </div>
                <p className="chain-desc">{c.description}</p>
                <div className="chain-steps">
                  {c.steps.map((step, j) => {
                    const ts = stepTagStyle(step);
                    return (
                      <span key={j} className="chain-step-group">
                        <span className="step-tag" style={{ background: ts.bg, color: ts.color, borderColor: ts.border }}>
                          {formatRiskTag(step)}
                        </span>
                        {j < c.steps.length - 1 && <span className="step-arrow">→</span>}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
