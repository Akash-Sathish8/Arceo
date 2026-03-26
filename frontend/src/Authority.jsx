import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "./api.js";
import "./Authority.css";

const SEVERITY_COLORS = {
  critical: { bg: "#fef2f2", color: "#dc2626", border: "#fca5a5" },
  high: { bg: "#fff7ed", color: "#ea580c", border: "#fdba74" },
  medium: { bg: "#fefce8", color: "#ca8a04", border: "#fde68a" },
};

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
  const scoreColor = br.score >= 70 ? "#dc2626" : br.score >= 40 ? "#ea580c" : "#16a34a";

  return (
    <Link to={`/agent/${agent.id}`} className="agent-card">
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
        <div className="blast-score" style={{ borderColor: scoreColor, color: scoreColor }}>
          <div className="blast-number">{br.score}</div>
          <div className="blast-label">Blast Radius</div>
        </div>
      </div>

      <div className="risk-bars">
        <RiskBar label="Moves Money" count={br.moves_money} max={br.total_actions} color="#dc2626" />
        <RiskBar label="Touches PII" count={br.touches_pii} max={br.total_actions} color="#7c3aed" />
        <RiskBar label="Deletes Data" count={br.deletes_data} max={br.total_actions} color="#ea580c" />
        <RiskBar label="Sends External" count={br.sends_external} max={br.total_actions} color="#2563eb" />
        <RiskBar label="Changes Prod" count={br.changes_production} max={br.total_actions} color="#0d9488" />
      </div>

      <div className="agent-card-footer">
        <span className="stat">{br.total_actions} actions</span>
        <span className="stat">{br.irreversible_actions} irreversible</span>
        <span className="stat chain-stat">
          {agent.chain_count} chains
          {agent.critical_chains > 0 && (
            <span className="crit-badge">{agent.critical_chains} critical</span>
          )}
        </span>
      </div>
    </Link>
  );
}

export default function Authority() {
  const [agents, setAgents] = useState([]);
  const [chains, setChains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("score-desc");
  const [riskFilter, setRiskFilter] = useState("all");
  const [chainSeverityFilter, setChainSeverityFilter] = useState("all");

  // Create agent form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newToolsText, setNewToolsText] = useState("");
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState(null);

  const loadData = () => {
    Promise.all([
      apiFetch("/api/authority/agents"),
      apiFetch("/api/authority/chains"),
    ])
      .then(([agentData, chainData]) => {
        setAgents(agentData.agents);
        setChains(chainData.chains);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(() => { loadData(); }, []);

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
      loadData(); // refresh
    } catch (err) {
      setCreateResult({ error: err.message });
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
  const totalActions = agents.reduce((s, a) => s + a.blast_radius.total_actions, 0);
  const totalIrreversible = agents.reduce((s, a) => s + a.blast_radius.irreversible_actions, 0);

  return (
    <div className="authority-page">
      <header className="auth-header">
        <div className="auth-header-row">
          <div>
            <h1>Authority Engine</h1>
            <p>Map what your AI agents can do. Score the blast radius. Find the dangers.</p>
          </div>
          <button className="create-agent-btn" onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? "Cancel" : "+ New Agent"}
          </button>
        </div>
      </header>

      {showCreate && (
        <div className="create-agent-form-wrapper">
          <form className="create-agent-form" onSubmit={handleCreate}>
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
        </div>
      )}

      {/* Summary Stats */}
      <div className="summary-row">
        <div className="summary-stat">
          <div className="summary-number">{agents.length}</div>
          <div className="summary-label">Agents</div>
        </div>
        <div className="summary-stat">
          <div className="summary-number">{totalActions}</div>
          <div className="summary-label">Total Actions</div>
        </div>
        <div className="summary-stat">
          <div className="summary-number">{totalIrreversible}</div>
          <div className="summary-label">Irreversible</div>
        </div>
        <div className="summary-stat warn">
          <div className="summary-number">{chains.length}</div>
          <div className="summary-label">Danger Chains</div>
        </div>
        <div className="summary-stat crit">
          <div className="summary-number">{criticalChains.length}</div>
          <div className="summary-label">Critical</div>
        </div>
      </div>

      {/* Agent Section with Controls */}
      <section>
        <div className="section-header">
          <h2>Agent Blast Radius</h2>
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
          <div className="empty-state">No agents match your filters.</div>
        ) : (
          <div className="agent-grid">
            {filteredAgents.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        )}
      </section>

      {/* Dangerous Chains with filter */}
      <section>
        <div className="section-header">
          <h2>Flagged Dangerous Chains ({filteredChains.length})</h2>
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
            return (
              <div key={i} className="chain-card" style={{ borderLeftColor: sev.border }}>
                <div className="chain-header">
                  <span className="chain-severity" style={{ background: sev.bg, color: sev.color }}>
                    {c.severity}
                  </span>
                  <strong>{c.chain_name}</strong>
                  <span className="chain-agent">{c.agent_name}</span>
                </div>
                <p className="chain-desc">{c.description}</p>
                <div className="chain-steps">
                  {c.steps.map((step, j) => (
                    <span key={j}>
                      <span className="step-tag">{step}</span>
                      {j < c.steps.length - 1 && <span className="step-arrow">&rarr;</span>}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
