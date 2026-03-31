import { useState, useEffect } from "react";
import { getUser, getToken, apiFetch } from "./api.js";
import "./Settings.css";

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button className="copy-btn" onClick={copy}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function CodeBlock({ code, language = "bash" }) {
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-lang">{language}</span>
        <CopyButton text={code} />
      </div>
      <pre className="code-pre"><code>{code}</code></pre>
    </div>
  );
}

export default function Settings() {
  const user = getUser();
  const token = getToken() || "";
  const maskedToken = token ? token.slice(0, 16) + "••••••••••••••••••••••••" : "—";
  const [showToken, setShowToken] = useState(false);

  const [slackUrl, setSlackUrl] = useState("");
  const [alertEmail, setAlertEmail] = useState("");
  const [blockAlerts, setBlockAlerts] = useState(true);
  const [notifLoading, setNotifLoading] = useState(true);
  const [savedNotif, setSavedNotif] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSent, setInviteSent] = useState(false);
  const [inviteSending, setInviteSending] = useState(false);
  const [createdEmail, setCreatedEmail] = useState("");
  const [tempPass, setTempPass] = useState("");

  const [activeSection, setActiveSection] = useState("api");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwChanging, setPwChanging] = useState(false);
  const [pwError, setPwError] = useState(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  const [firstAgentId, setFirstAgentId] = useState("");

  useEffect(() => {
    apiFetch("/api/authority/agents")
      .then((d) => { if (d.agents?.[0]) setFirstAgentId(d.agents[0].id); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    apiFetch("/api/notifications/settings")
      .then((d) => {
        setSlackUrl(d.slack_webhook_url || "");
        setAlertEmail(d.alert_email || "");
        setBlockAlerts(d.notify_on_block !== false);
        setNotifLoading(false);
      })
      .catch(() => setNotifLoading(false));
  }, []);

  const saveNotifications = async () => {
    try {
      await apiFetch("/api/notifications/settings", {
        method: "POST",
        body: JSON.stringify({
          slack_webhook_url: slackUrl,
          alert_email: alertEmail,
          notify_on_block: blockAlerts,
        }),
      });
      setSavedNotif(true);
      setTimeout(() => setSavedNotif(false), 2000);
    } catch {
      setSavedNotif(false);
    }
  };

  const sendInvite = async (e) => {
    e.preventDefault();
    setInviteSending(true);
    const emailToCreate = inviteEmail.trim();
    const tempPassword = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6).toUpperCase();
    try {
      await apiFetch("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          email: emailToCreate,
          password: tempPassword,
          name: emailToCreate.split("@")[0],
        }),
        skipLogoutOn401: true,
      });
      setCreatedEmail(emailToCreate);
      setTempPass(tempPassword);
    } catch {
      // User may already exist — still show as "invited"
      setCreatedEmail(emailToCreate);
      setTempPass("");
    }
    setInviteEmail("");
    setInviteSent(true);
    setInviteSending(false);
  };

  const enforceSnippetPython = `import requests

ARCEO_TOKEN = "${token.slice(0, 20)}..."
AGENT_ID = "${firstAgentId || "your-agent-id"}"

def enforce(tool: str, action: str, params: dict) -> bool:
    resp = requests.post(
        "http://localhost:8000/api/enforce",
        json={"agent_id": AGENT_ID, "tool": tool, "action": action, "params": params},
        headers={"Authorization": f"Bearer {ARCEO_TOKEN}"}
    )
    result = resp.json()
    return result.get("decision") == "ALLOW"

# Before every tool call:
if enforce("Stripe", "create_refund", {"amount": 500, "customer_id": "cus_123"}):
    stripe.create_refund(...)`;

  const enforceSnippetCurl = `curl -X POST http://localhost:8000/api/enforce \\
  -H "Authorization: Bearer ${token.slice(0, 20)}..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "${firstAgentId || "your-agent-id"}",
    "tool": "Stripe",
    "action": "create_refund",
    "params": {"amount": 500, "customer_id": "cus_123"}
  }'

# Response:
# { "decision": "ALLOW" }       → proceed
# { "decision": "BLOCK", ... }  → stop the action
# { "decision": "REQUIRE_APPROVAL", ... } → pause for human review`;

  const enforceSnippetNode = `const axios = require("axios");

const ARCEO_TOKEN = "${token.slice(0, 20)}...";
const AGENT_ID = "${firstAgentId || "your-agent-id"}";

async function enforce(tool, action, params) {
  const { data } = await axios.post(
    "http://localhost:8000/api/enforce",
    { agent_id: AGENT_ID, tool, action, params },
    { headers: { Authorization: \`Bearer \${ARCEO_TOKEN}\` } }
  );
  return data.decision === "ALLOW";
}

// Before every tool call:
if (await enforce("Stripe", "create_refund", { amount: 500 })) {
  await stripe.refunds.create({ ... });
}`;

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setPwError("New passwords do not match");
      return;
    }
    if (newPassword.length < 6) {
      setPwError("New password must be at least 6 characters");
      return;
    }
    setPwChanging(true);
    setPwError(null);
    try {
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      setPwSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPwSuccess(false), 3000);
    } catch (err) {
      setPwError(err.message.replace(/^\d+:\s*/, ""));
    }
    setPwChanging(false);
  };

  const sections = [
    { id: "api",     label: "API & Integration" },
    { id: "notif",   label: "Notifications" },
    { id: "team",    label: "Team" },
    { id: "account", label: "Account" },
  ];

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h1>Settings</h1>
        <p className="settings-sub">Manage your API key, notifications, and team access.</p>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav">
          {sections.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item${activeSection === s.id ? " active" : ""}`}
              onClick={() => setActiveSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">

          {/* ── API & Integration ── */}
          {activeSection === "api" && (
            <div className="settings-section">
              <h2>API Key</h2>
              <p className="settings-desc">
                Use this token to authenticate your agent with Arceo's enforcement API.
                Pass it as a <code>Bearer</code> token in the <code>Authorization</code> header.
              </p>
              <div className="api-key-box">
                <span className="api-key-value">
                  {showToken ? token : maskedToken}
                </span>
                <button className="toggle-show-btn" onClick={() => setShowToken((v) => !v)}>
                  {showToken ? "Hide" : "Show"}
                </button>
                <CopyButton text={token} />
              </div>
              <p className="settings-hint">
                Your token never expires unless you log out and back in. Keep it secret — it grants full API access.
              </p>

              <h2 style={{ marginTop: 36 }}>Integrate the Enforcement API</h2>
              <p className="settings-desc">
                Call <code>POST /api/enforce</code> before every tool action your agent takes.
                Arceo checks your policies and returns a decision instantly.
              </p>

              <div className="code-tabs">
                <CodeSnippetTabs
                  tabs={[
                    { label: "Python", code: enforceSnippetPython, lang: "python" },
                    { label: "curl",   code: enforceSnippetCurl,   lang: "bash" },
                    { label: "Node.js",code: enforceSnippetNode,   lang: "javascript" },
                  ]}
                />
              </div>

              <div className="response-guide">
                <h3>Decision responses</h3>
                <div className="response-rows">
                  <div className="response-row">
                    <span className="response-badge allow">ALLOW</span>
                    <span>Action is permitted — proceed normally.</span>
                  </div>
                  <div className="response-row">
                    <span className="response-badge block">BLOCK</span>
                    <span>Action is blocked by policy — do not proceed. Log the attempt.</span>
                  </div>
                  <div className="response-row">
                    <span className="response-badge approval">REQUIRE_APPROVAL</span>
                    <span>Action needs human approval — pause and wait for confirmation.</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Notifications ── */}
          {activeSection === "notif" && (
            <div className="settings-section">
              <h2>Notifications</h2>
              <p className="settings-desc">Get alerted when your agents are blocked or trigger high-risk actions.</p>

              <div className="settings-field">
                <label>Slack Webhook URL</label>
                <input
                  type="url"
                  value={slackUrl}
                  onChange={(e) => setSlackUrl(e.target.value)}
                  placeholder="https://hooks.slack.com/services/..."
                />
                <span className="settings-field-hint">Paste your Slack incoming webhook to receive block alerts in a channel.</span>
              </div>

              <div className="settings-field">
                <label>Alert Email</label>
                <input
                  type="email"
                  value={alertEmail}
                  onChange={(e) => setAlertEmail(e.target.value)}
                  placeholder="you@yourcompany.com"
                />
                <span className="settings-field-hint">Receive an email summary of blocked actions every hour.</span>
              </div>

              <div className="settings-field">
                <label className="settings-toggle-label">
                  <input
                    type="checkbox"
                    checked={blockAlerts}
                    onChange={(e) => setBlockAlerts(e.target.checked)}
                  />
                  Send alert on every blocked action
                </label>
              </div>

              <div className="notif-save-row">
                <button className="settings-save-btn" onClick={saveNotifications}>
                  {savedNotif ? "Saved ✓" : "Save Notification Settings"}
                </button>
                <span className="notif-storage-hint">Alerts fire in real time on every blocked action</span>
              </div>
            </div>
          )}

          {/* ── Team ── */}
          {activeSection === "team" && (
            <div className="settings-section">
              <h2>Team Members</h2>
              <p className="settings-desc">Invite teammates to view agents, run simulations, and manage policies.</p>

              <div className="team-member-row current">
                <div className="team-avatar">{user?.email?.[0]?.toUpperCase()}</div>
                <div className="team-member-info">
                  <span className="team-member-email">{user?.email}</span>
                  <span className="team-member-role">Admin</span>
                </div>
                <span className="team-you-badge">You</span>
              </div>

              <div className="invite-notify-section">
                <h3>Invite a teammate</h3>
                <p className="settings-desc">Create an account for a teammate so they can view agents, run simulations, and manage policies.</p>
                {inviteSent ? (
                  <div className="invite-sent-msg">
                    <strong>Account created for {createdEmail}</strong>
                    {tempPass ? (
                      <>
                        <br />Share these login credentials with them:
                        <div className="invite-creds">
                          <span className="invite-cred-row"><span className="invite-cred-label">Email</span><code className="invite-cred-val">{createdEmail}</code></span>
                          <span className="invite-cred-row"><span className="invite-cred-label">Password</span><code className="invite-cred-val">{tempPass}</code></span>
                        </div>
                        <span className="invite-cred-hint">They can change their password after signing in.</span>
                      </>
                    ) : (
                      <><br />This email already has an account — they can sign in directly.</>
                    )}
                    <br />
                    <button
                      className="invite-notify-btn"
                      style={{ marginTop: 12 }}
                      onClick={() => { setInviteSent(false); setCreatedEmail(""); setTempPass(""); }}
                    >
                      Invite another
                    </button>
                  </div>
                ) : (
                  <form className="invite-form" onSubmit={sendInvite}>
                    <input
                      type="email"
                      className="invite-email-input"
                      placeholder="teammate@company.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      required
                    />
                    <button type="submit" className="invite-notify-btn" disabled={inviteSending}>
                      {inviteSending ? "Creating..." : "Create Account"}
                    </button>
                  </form>
                )}
              </div>
            </div>
          )}

          {/* ── Account ── */}
          {activeSection === "account" && (
            <div className="settings-section">
              <h2>Account</h2>
              <div className="settings-field">
                <label>Email</label>
                <input type="email" value={user?.email || ""} readOnly />
              </div>
              <div className="settings-field">
                <label>Role</label>
                <input type="text" value={user?.role || "admin"} readOnly />
              </div>

              <h2 style={{ marginTop: 32 }}>Change Password</h2>
              <form className="pw-change-form" onSubmit={handleChangePassword}>
                <div className="settings-field">
                  <label>Current Password</label>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => { setCurrentPassword(e.target.value); setPwError(null); }}
                    placeholder="Your current password"
                    required
                  />
                </div>
                <div className="settings-field">
                  <label>New Password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => { setNewPassword(e.target.value); setPwError(null); }}
                    placeholder="At least 6 characters"
                    required
                  />
                </div>
                <div className="settings-field">
                  <label>Confirm New Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => { setConfirmPassword(e.target.value); setPwError(null); }}
                    placeholder="Repeat new password"
                    required
                  />
                </div>
                {pwError && <div className="pw-error">{pwError}</div>}
                {pwSuccess && <div className="pw-success">Password updated successfully</div>}
                <button type="submit" className="settings-save-btn" disabled={pwChanging}>
                  {pwChanging ? "Updating..." : "Update Password"}
                </button>
              </form>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

function CodeSnippetTabs({ tabs }) {
  const [active, setActive] = useState(0);
  return (
    <div className="snippet-tabs">
      <div className="snippet-tab-bar">
        {tabs.map((t, i) => (
          <button
            key={i}
            className={`snippet-tab${active === i ? " active" : ""}`}
            onClick={() => setActive(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <CodeBlock code={tabs[active].code} language={tabs[active].lang} />
    </div>
  );
}
