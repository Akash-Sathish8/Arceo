import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, setToken, setUser } from "./api.js";
import "./Login.css";

const AGENT_TYPES = [
  { id: "support", label: "Customer support agent", desc: "Handles tickets, refunds, account lookups, and customer emails" },
  { id: "devops",  label: "DevOps agent",           desc: "Manages deployments, infrastructure, incidents, and alerts" },
  { id: "sales",   label: "Sales agent",            desc: "CRM updates, outreach, deal tracking, and meeting scheduling" },
  { id: "custom",  label: "Custom / other",         desc: "I'll configure the tools and actions myself" },
];

// Maps agent type → template tool config (mirrors Authority.jsx TEMPLATES)
const AGENT_TYPE_TEMPLATES = {
  support: {
    name: "Customer Support Agent",
    description: "Handles tickets, refunds, account lookups, and customer emails",
    tools: "Stripe: get_customer, list_payments, create_refund, create_charge, cancel_subscription\nZendesk: get_ticket, update_ticket, close_ticket, add_comment, delete_ticket\nSalesforce: query_contacts, get_account, update_record, delete_record\nSendGrid: send_email, send_template_email",
  },
  devops: {
    name: "DevOps Agent",
    description: "Manages deployments, infrastructure, incidents, and team notifications",
    tools: "GitHub: list_repos, get_pull_request, merge_pull_request, create_branch, delete_branch, trigger_workflow, create_release\nAWS: list_instances, start_instance, stop_instance, terminate_instance, scale_service, update_security_group, delete_snapshot\nSlack: send_message, send_channel_message\nPagerDuty: create_incident, acknowledge_incident, resolve_incident, escalate_incident",
  },
  sales: {
    name: "Sales Agent",
    description: "Manages leads, outreach, deals, meetings, and pipeline updates",
    tools: "HubSpot: get_contact, create_contact, update_contact, delete_contact, list_deals, update_deal, create_deal, query_contacts\nGmail: send_email, read_inbox, search_emails, create_draft, send_draft\nSlack: send_message, send_channel_message\nCalendly: list_events, create_invite_link, cancel_event, get_availability",
  },
};

function templateToTools(toolsString) {
  return toolsString.trim().split("\n").filter(Boolean).map((line) => {
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
}

export default function Login() {
  const [onboardStep, setOnboardStep] = useState(0); // 0 = login form, 1 = welcome, 2 = agent type
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState(null);
  const [loading, setLoading]   = useState(false);
  const navigate = useNavigate();

  // Auto-login when DEMO_MODE is active — no login screen shown
  useEffect(() => {
    apiFetch("/api/demo-mode", { skipLogoutOn401: true })
      .then((data) => {
        if (data?.demo) {
          apiFetch("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ email: "admin@actiongate.io", password: "admin123" }),
            skipLogoutOn401: true,
          }).then((d) => {
            setToken(d.token);
            setUser(d.user);
            navigate("/");
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }, [navigate]);

  const doLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const loginEmail    = email    || "admin@actiongate.io";
      const loginPassword = password || "admin123";
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
        skipLogoutOn401: true,
      });
      setToken(data.token);
      setUser(data.user);
      navigate("/");
    } catch {
      setError("Invalid email or password");
    }
    setLoading(false);
  };

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    await doLogin();
  };

  const doGetStarted = async () => {
    setLoading(true);
    setError(null);
    const loginEmail    = email    || "admin@actiongate.io";
    const loginPassword = password || "admin123";
    // Attempt signup first if user provided their own credentials
    if (email.trim() && password.trim()) {
      try {
        await apiFetch("/api/auth/signup", {
          method: "POST",
          body: JSON.stringify({
            email: email.trim(),
            password: password.trim(),
            name: email.split("@")[0],
          }),
          skipLogoutOn401: true,
        });
      } catch {
        // Expected if user already exists — proceed to login below
      }
    }
    try {
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
        skipLogoutOn401: true,
      });
      setToken(data.token);
      setUser(data.user);

      // Auto-create agents from selected types (skip "custom" — user configures manually)
      const typesToCreate = selectedTypes.filter((id) => id !== "custom" && AGENT_TYPE_TEMPLATES[id]);
      for (const typeId of typesToCreate) {
        const tmpl = AGENT_TYPE_TEMPLATES[typeId];
        try {
          await apiFetch("/api/authority/agents", {
            method: "POST",
            body: JSON.stringify({
              name: tmpl.name,
              description: tmpl.description,
              tools: templateToTools(tmpl.tools),
            }),
          });
        } catch {
          // Non-fatal — agent may already exist
        }
      }

      navigate("/");
    } catch {
      setError("Invalid email or password");
    }
    setLoading(false);
  };

  const toggleType = (id) => {
    setSelectedTypes((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  };

  // ── Onboarding Step 1: Welcome ─────────────────────────────────
  if (onboardStep === 1) {
    return (
      <div className="ob-page">
        <div className="ob-topbar">
          <div className="ob-logo">Arceo</div>
          <div className="ob-progress">
            <div className="ob-progress-fill" style={{ width: "33%" }} />
          </div>
        </div>

        <div className="ob-body">
          <div className="ob-left">
            <h1 className="ob-heading">
              <strong>Get started with Arceo.</strong> Your workspace is a safe environment to audit AI agent risk before anything runs in production.
            </h1>

            <ol className="ob-steps">
              <li>
                <div className="ob-step-num">1</div>
                <div>
                  <strong>Register your agent</strong>
                  <p>List the tools your AI agent can access — Stripe, Zendesk, Salesforce, or any custom tool.</p>
                </div>
              </li>
              <li>
                <div className="ob-step-num">2</div>
                <div>
                  <strong>Assess the risk exposure</strong>
                  <p>Instantly see which actions can move money, delete data, or leak PII — and how dangerous they are.</p>
                </div>
              </li>
              <li>
                <div className="ob-step-num">3</div>
                <div>
                  <strong>Enforce policies</strong>
                  <p>Block or require human approval for risky actions before they run in production.</p>
                </div>
              </li>
            </ol>
          </div>

          <div className="ob-right">
            <div className="ob-preview">
              <div className="ob-preview-header">Risk Analysis</div>
              <div className="ob-preview-content">
                <div className="ob-preview-card">
                  <div className="ob-preview-card-top">
                    <div className="ob-preview-lines">
                      <div className="ob-preview-line" style={{ width: "60%" }} />
                      <div className="ob-preview-line" style={{ width: "40%", opacity: 0.4 }} />
                    </div>
                    <div className="ob-preview-score" style={{ background: "#fef2f2", color: "#dc2626" }}>67</div>
                  </div>
                  <div className="ob-preview-bars">
                    {[["Moves Money", "#dc2626", "55%"], ["Touches PII", "#7c3aed", "40%"], ["Deletes Data", "#ea580c", "30%"], ["Sends External", "#2563eb", "20%"]].map(([label, color, w]) => (
                      <div key={label} className="ob-preview-bar-row">
                        <span>{label}</span>
                        <div className="ob-preview-bar-track">
                          <div className="ob-preview-bar-fill" style={{ width: w, background: color }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="ob-preview-card ob-preview-card-sm">
                  <div className="ob-preview-line" style={{ width: "50%", marginBottom: 8 }} />
                  <div className="ob-preview-chain">
                    <span className="ob-preview-chip red">critical</span>
                    <span className="ob-preview-chip-label">PII Exfiltration</span>
                  </div>
                  <div className="ob-preview-chain">
                    <span className="ob-preview-chip orange">high</span>
                    <span className="ob-preview-chip-label">Unsupervised Refund</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="ob-footer">
          <button className="ob-back" onClick={() => setOnboardStep(0)}>← Back</button>
          <button className="ob-primary" onClick={() => setOnboardStep(2)}>Continue →</button>
        </div>
      </div>
    );
  }

  // ── Onboarding Step 2: Agent type ──────────────────────────────
  if (onboardStep === 2) {
    return (
      <div className="ob-page">
        <div className="ob-topbar">
          <div className="ob-logo">Arceo</div>
          <div className="ob-progress">
            <div className="ob-progress-fill" style={{ width: "66%" }} />
          </div>
        </div>

        <div className="ob-body ob-body-narrow">
          <h1 className="ob-heading">
            <strong>Select the type of AI agent you're working with.</strong> You can always add more later.
          </h1>

          <div className="ob-options">
            {AGENT_TYPES.map((t) => (
              <label key={t.id} className={`ob-option${selectedTypes.includes(t.id) ? " selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={selectedTypes.includes(t.id)}
                  onChange={() => toggleType(t.id)}
                />
                <div className="ob-option-text">
                  <strong>{t.label}</strong>
                  <span>{t.desc}</span>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="ob-footer">
          <button className="ob-back" onClick={() => setOnboardStep(1)}>← Back</button>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="ob-skip" onClick={doLogin} disabled={loading}>Skip</button>
            <button className="ob-primary" onClick={doGetStarted} disabled={loading}>
              {loading ? "Getting started..." : "Get started →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Normal login / signup form ─────────────────────────────────
  return (
    <div className="login-page">
      <div className="login-brand-panel">
        <div className="login-brand-logo">Arceo</div>
        <h1 className="login-brand-headline">Know what your AI agents can do before they do it.</h1>
        <p className="login-brand-sub">Map every tool, score the risk exposure, catch dangerous chains — before a single action runs in production.</p>
        <div className="login-brand-features">
          <div className="login-brand-feature">
            <span className="login-brand-feature-label">Authority</span>
            <span className="login-brand-feature-value">Map agent permissions</span>
          </div>
          <div className="login-brand-feature">
            <span className="login-brand-feature-label">Sandbox</span>
            <span className="login-brand-feature-value">Simulate before deploy</span>
          </div>
          <div className="login-brand-feature">
            <span className="login-brand-feature-label">Enforce</span>
            <span className="login-brand-feature-value">Block risky actions</span>
          </div>
        </div>
      </div>
      <div className="login-form-panel">
        <form className="login-form" onSubmit={handleLoginSubmit}>
          <div className="login-brand">Arceo</div>
          <p className="login-subtitle">Sign in to your workspace</p>

          {error && <div className="login-error">{error}</div>}

          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />

          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="" />

          <button type="submit" disabled={loading}>
            {loading ? "Signing in..." : "Sign In"}
          </button>

          <p className="login-toggle">
            Don't have an account? <button type="button" className="login-toggle-btn" onClick={() => { setOnboardStep(1); setError(null); }}>Create one</button>
          </p>

          <button type="button" className="login-demo-btn" onClick={doLogin} disabled={loading}>
            Try demo account →
          </button>
        </form>
      </div>
    </div>
  );
}
