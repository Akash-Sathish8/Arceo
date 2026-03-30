import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, setToken, setUser } from "./api.js";
import "./Login.css";

const AGENT_TYPES = [
  { id: "support", label: "Customer support agent", desc: "Handles tickets, refunds, account lookups, and customer emails" },
  { id: "devops",  label: "DevOps agent",           desc: "Manages deployments, infrastructure, incidents, and alerts" },
  { id: "sales",   label: "Sales agent",            desc: "CRM updates, outreach, deal tracking, and meeting scheduling" },
  { id: "custom",  label: "Custom / other",         desc: "I'll configure the tools and actions myself" },
];

export default function Login() {
  const [onboardStep, setOnboardStep] = useState(0); // 0 = login form, 1 = welcome, 2 = agent type
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [name, setName]         = useState("");
  const [error, setError]       = useState(null);
  const [loading, setLoading]   = useState(false);
  const navigate = useNavigate();

  const doLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const loginEmail    = email    || "admin@actiongate.io";
      const loginPassword = password || "admin123";
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
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
          <div className="ob-logo">ActionGate</div>
          <div className="ob-progress">
            <div className="ob-progress-fill" style={{ width: "33%" }} />
          </div>
        </div>

        <div className="ob-body">
          <div className="ob-left">
            <h1 className="ob-heading">
              <strong>Get started with ActionGate.</strong> Your workspace is a safe environment to audit AI agent risk before anything runs in production.
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
              <div className="ob-preview-header">Authority Engine</div>
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
          <div className="ob-logo">ActionGate</div>
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
            <button className="ob-primary" onClick={doLogin} disabled={loading}>
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
        <div className="login-brand-logo">ActionGate</div>
        <h1 className="login-brand-headline">Know what your AI agents can do before they do it.</h1>
        <p className="login-brand-sub">Map every tool, score the blast radius, catch dangerous chains — before a single action runs in production.</p>
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
          <div className="login-brand">ActionGate</div>
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
