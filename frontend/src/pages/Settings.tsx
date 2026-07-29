import { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff, Copy, Check, Users, KeyRound, UserCircle, Banknote, Bell, X } from "lucide-react";
import { apiFetch, getUser, getToken } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/shared/Toast";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NavSection {
  id: string;
  label: string;
  icon: React.ReactNode;
}

interface CodeTab {
  label: string;
  code: string;
  lang: string;
}

// ── CopyButton ────────────────────────────────────────────────────────────────

interface CopyButtonProps {
  text: string;
}

function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={copy}
      icon={copied ? <Check size={12} /> : <Copy size={12} />}
    >
      {copied ? "Copied!" : "Copy"}
    </Button>
  );
}

// ── CodeBlock ─────────────────────────────────────────────────────────────────

interface CodeBlockProps {
  code: string;
  language?: string;
}

function CodeBlock({ code, language = "bash" }: CodeBlockProps) {
  return (
    <div
      style={{
        background: "var(--bg-sunken)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-sunken)",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
          }}
        >
          {language}
        </span>
        <CopyButton text={code} />
      </div>
      <pre
        style={{
          overflowX: "auto",
          padding: 16,
          fontSize: 12,
          fontFamily: "monospace",
          color: "var(--text-primary)",
          background: "var(--bg-sunken)",
          lineHeight: 1.6,
          margin: 0,
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ── CodeSnippetTabs ───────────────────────────────────────────────────────────

interface CodeSnippetTabsProps {
  tabs: CodeTab[];
}

function CodeSnippetTabs({ tabs }: CodeSnippetTabsProps) {
  const [active, setActive] = useState(0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "4px",
          background: "var(--bg-sunken)",
          borderRadius: "var(--radius-full)",
          width: "fit-content",
          marginBottom: 8,
        }}
      >
        {tabs.map((t, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            style={{
              padding: "5px 14px",
              fontSize: 13,
              fontWeight: active === i ? 600 : 400,
              borderRadius: "var(--radius-full)",
              border: "none",
              cursor: "pointer",
              background: active === i ? "var(--color-cta)" : "transparent",
              color: active === i ? "var(--text-inverse)" : "var(--text-secondary)",
              transition: "background 0.15s, color 0.15s",
              fontFamily: "inherit",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <CodeBlock code={tabs[active].code} language={tabs[active].lang} />
    </div>
  );
}

// ── Main Settings page ────────────────────────────────────────────────────────

// ── Cost overrides ────────────────────────────────────────────────────────────

interface CostOverrideRow {
  id: number;
  scope: string;
  key: string;
  sub_key: string;
  value: number;
}

interface CostDefaultsCatalog {
  models: Record<string, Record<string, number>>;
  infrastructure: Record<string, number>;
  breach?: Record<string, Record<string, number>>;
}

// CFO-facing plain labels for the breach categories (no jargon).
const BREACH_LABELS: Record<string, { label: string; help: string }> = {
  direct_financial_loss: { label: "Money lost directly", help: "A wrong refund, charge, or transfer the agent could make." },
  regulatory_fine: { label: "Regulatory fines", help: "Penalties if private customer data is mishandled (GDPR, HIPAA, CCPA)." },
  operational_disruption: { label: "Downtime & disruption", help: "Cost of an outage or broken process the agent could cause." },
  reputation_damage: { label: "Reputation damage", help: "PR / crisis-response cost of a public incident." },
};
const BREACH_ORDER = ["direct_financial_loss", "regulatory_fine", "operational_disruption", "reputation_damage"];
const BREACH_COLUMNS: Array<{ sub: string; label: string }> = [
  { sub: "per_incident_min_usd", label: "Typical incident ($)" },
  { sub: "per_incident_max_usd", label: "Worst case ($)" },
];

const MODEL_PRICE_COLUMNS: Array<{ sub: string; label: string }> = [
  { sub: "input_per_mtok", label: "Input $ / MTok" },
  { sub: "output_per_mtok", label: "Output $ / MTok" },
  { sub: "cache_discount", label: "Cache discount (0–1)" },
];

function CostOverridesSection({ inputStyle }: { inputStyle: React.CSSProperties }) {
  const [overrides, setOverrides] = useState<CostOverrideRow[]>([]);
  const [defaults, setDefaults] = useState<CostDefaultsCatalog | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [toolName, setToolName] = useState("");
  const [toolAction, setToolAction] = useState("");
  const [toolCost, setToolCost] = useState("");

  const load = useCallback(() => {
    apiFetch<{ overrides: CostOverrideRow[]; defaults: CostDefaultsCatalog }>("/api/cost-overrides")
      .then((d) => {
        setOverrides(d.overrides ?? []);
        setDefaults(d.defaults ?? null);
        setDrafts({});
      })
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const findOverride = (scope: string, key: string, sub: string) =>
    overrides.find((o) => o.scope === scope && o.key === key && o.sub_key === sub);

  // Commit a cell: differs from default → save override; equals default while
  // an override exists → clear it (back to default); otherwise no-op.
  const commitCell = async (scope: string, key: string, sub: string, defaultValue: number, raw: string) => {
    const parsed = parseFloat(raw);
    const existing = findOverride(scope, key, sub);
    if (raw.trim() === "" || isNaN(parsed) || parsed < 0) {
      setDrafts((d) => ({ ...d, [`${scope}|${key}|${sub}`]: String(existing?.value ?? defaultValue) }));
      return;
    }
    try {
      if (parsed !== defaultValue) {
        if (existing?.value === parsed) return;
        await apiFetch("/api/cost-overrides", {
          method: "PUT",
          body: JSON.stringify({ scope, key, sub_key: sub, value: parsed }),
        });
        toast("Custom rate saved — forecasts now use it");
        load();
      } else if (existing) {
        await apiFetch(`/api/cost-overrides/${existing.id}`, { method: "DELETE" });
        toast("Back to the default rate");
        load();
      }
    } catch {
      toast("Couldn't save the rate", "error");
    }
  };

  const addToolOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(toolCost);
    if (!toolName.trim() || !toolAction.trim() || isNaN(parsed) || parsed < 0) {
      toast("Tool, action, and a non-negative cost are required", "error");
      return;
    }
    try {
      await apiFetch("/api/cost-overrides", {
        method: "PUT",
        body: JSON.stringify({
          scope: "tool",
          key: toolName.trim().toLowerCase(),
          sub_key: toolAction.trim().toLowerCase(),
          value: parsed,
        }),
      });
      toast("Tool cost saved");
      setToolName(""); setToolAction(""); setToolCost("");
      load();
    } catch {
      toast("Couldn't save the tool cost", "error");
    }
  };

  const removeOverride = async (id: number) => {
    try {
      await apiFetch(`/api/cost-overrides/${id}`, { method: "DELETE" });
      toast("Back to the default rate");
      load();
    } catch {
      toast("Couldn't remove the override", "error");
    }
  };

  if (!defaults) return null;

  const cardStyle: React.CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 24,
  };
  const cellInputStyle: React.CSSProperties = {
    ...inputStyle,
    height: 34,
    padding: "0 10px",
    fontSize: 12.5,
    fontFamily: "ui-monospace, monospace",
    width: 130,
  };
  const thStyle: React.CSSProperties = {
    textAlign: "left", fontSize: 11, fontWeight: 600, textTransform: "uppercase",
    letterSpacing: "0.05em", color: "var(--text-muted)", padding: "0 12px 8px 0",
  };
  const toolOverrides = overrides.filter((o) => o.scope === "tool");
  const infraDefault = defaults.infrastructure?.per_call_overhead_usd ?? 0;
  const infraOverride = findOverride("infra", "per_call_overhead_usd", "");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={cardStyle}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Model pricing
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
          If your contract has different prices than the list rates below, type yours in — every
          forecast for your organization will use your numbers. Setting a price back to the list
          rate removes the custom value.
        </p>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>Model</th>
              {MODEL_PRICE_COLUMNS.map((c) => <th key={c.sub} style={thStyle}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {Object.entries(defaults.models).map(([modelKey, pricing]) => (
              <tr key={modelKey}>
                <td style={{ fontSize: 13, color: "var(--text-primary)", padding: "6px 24px 6px 0", fontFamily: "ui-monospace, monospace" }}>
                  {modelKey}
                </td>
                {MODEL_PRICE_COLUMNS.map(({ sub }) => {
                  const def = Number(pricing[sub] ?? 0);
                  const ov = findOverride("model", modelKey, sub);
                  const draftKey = `model|${modelKey}|${sub}`;
                  const shown = drafts[draftKey] ?? String(ov?.value ?? def);
                  return (
                    <td key={sub} style={{ padding: "6px 12px 6px 0" }}>
                      <div style={{ position: "relative", display: "inline-block" }}>
                        <input
                          style={{
                            ...cellInputStyle,
                            border: ov ? "2px solid var(--severity-safe, #16a34a)" : cellInputStyle.border,
                          }}
                          value={shown}
                          onChange={(e) => setDrafts((d) => ({ ...d, [draftKey]: e.target.value }))}
                          onBlur={(e) => commitCell("model", modelKey, sub, def, e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          title={ov ? `Custom rate (list: ${def})` : "List rate"}
                        />
                        {ov && (
                          <span style={{ position: "absolute", top: -7, right: -6, fontSize: 9, fontWeight: 700, background: "var(--severity-safe-bg, #dcfce7)", color: "var(--severity-safe, #16a34a)", borderRadius: 6, padding: "1px 5px" }}>
                            CUSTOM
                          </span>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {defaults.breach && Object.keys(defaults.breach).length > 0 && (
        <div style={cardStyle}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
            What a breach could cost you
          </h2>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
            These drive the "worst case if it goes wrong" figure on each agent's cost portfolio.
            The defaults are industry estimates — put in your own numbers and the worst-case
            exposure becomes specific to your business.
          </p>
          <table style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Kind of damage</th>
                {BREACH_COLUMNS.map((c) => <th key={c.sub} style={thStyle}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {BREACH_ORDER.filter((cat) => defaults.breach?.[cat]).map((cat) => {
                const meta = BREACH_LABELS[cat] ?? { label: cat, help: "" };
                const ranges = defaults.breach![cat];
                return (
                  <tr key={cat}>
                    <td style={{ fontSize: 13, color: "var(--text-primary)", padding: "8px 24px 8px 0" }} title={meta.help}>
                      <div style={{ fontWeight: 500 }}>{meta.label}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{meta.help}</div>
                    </td>
                    {BREACH_COLUMNS.map(({ sub }) => {
                      const def = Number(ranges[sub] ?? 0);
                      const ov = findOverride("breach", cat, sub);
                      const draftKey = `breach|${cat}|${sub}`;
                      const shown = drafts[draftKey] ?? String(ov?.value ?? def);
                      return (
                        <td key={sub} style={{ padding: "8px 12px 8px 0", verticalAlign: "top" }}>
                          <div style={{ position: "relative", display: "inline-block" }}>
                            <input
                              style={{ ...cellInputStyle, border: ov ? "2px solid var(--severity-safe, #16a34a)" : cellInputStyle.border }}
                              value={shown}
                              onChange={(e) => setDrafts((d) => ({ ...d, [draftKey]: e.target.value }))}
                              onBlur={(e) => commitCell("breach", cat, sub, def, e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              title={ov ? `Your number (default: $${def.toLocaleString()})` : `Default $${def.toLocaleString()}`}
                            />
                            {ov && (
                              <span style={{ position: "absolute", top: -7, right: -6, fontSize: 9, fontWeight: 700, background: "var(--severity-safe-bg, #dcfce7)", color: "var(--severity-safe, #16a34a)", borderRadius: 6, padding: "1px 5px" }}>
                                CUSTOM
                              </span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={cardStyle}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Infrastructure overhead
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
          Added to every agent call to cover compute, observability, and plumbing. Default ${infraDefault}.
        </p>
        <input
          style={{ ...cellInputStyle, width: 160, border: infraOverride ? "2px solid var(--severity-safe, #16a34a)" : cellInputStyle.border }}
          value={drafts["infra|per_call_overhead_usd|"] ?? String(infraOverride?.value ?? infraDefault)}
          onChange={(e) => setDrafts((d) => ({ ...d, "infra|per_call_overhead_usd|": e.target.value }))}
          onBlur={(e) => commitCell("infra", "per_call_overhead_usd", "", infraDefault, e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Custom tool costs
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
          Price internal or unlisted tools per action — e.g. an internal API that costs $0.02 per
          lookup. Forecasts add these on top of model spend.
        </p>
        {toolOverrides.length > 0 && (
          <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            {toolOverrides.map((o) => (
              <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, fontFamily: "ui-monospace, monospace", color: "var(--text-primary)" }}>
                <span>{o.key}.{o.sub_key}</span>
                <span style={{ color: "var(--text-secondary)" }}>${o.value}</span>
                <button
                  onClick={() => removeOverride(o.id)}
                  style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "inline-flex", padding: 2 }}
                  aria-label={`Remove ${o.key}.${o.sub_key}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={addToolOverride} style={{ display: "flex", gap: 8 }}>
          <input style={{ ...cellInputStyle, width: 140 }} placeholder="tool (e.g. internal_api)" value={toolName} onChange={(e) => setToolName(e.target.value)} />
          <input style={{ ...cellInputStyle, width: 140 }} placeholder="action (e.g. lookup)" value={toolAction} onChange={(e) => setToolAction(e.target.value)} />
          <input style={{ ...cellInputStyle, width: 110 }} placeholder="$ per call" value={toolCost} onChange={(e) => setToolCost(e.target.value)} />
          <Button type="submit" variant="secondary">Add</Button>
        </form>
      </div>
    </div>
  );
}

// ── Notifications section ───────────────────────────────────────────────────

function NotificationsSection({ inputStyle }: { inputStyle: React.CSSProperties }) {
  const [slackUrl, setSlackUrl] = useState("");
  const [alertEmail, setAlertEmail] = useState("");
  const [notifyOnBlock, setNotifyOnBlock] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);

  useEffect(() => {
    apiFetch<{ slack_webhook_url: string; alert_email: string; notify_on_block: boolean }>(
      "/api/notifications/settings",
    )
      .then((d) => {
        setSlackUrl(d.slack_webhook_url || "");
        setAlertEmail(d.alert_email || "");
        setNotifyOnBlock(d.notify_on_block);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch("/api/notifications/settings", {
        method: "POST",
        body: JSON.stringify({
          slack_webhook_url: slackUrl.trim(),
          alert_email: alertEmail.trim(),
          notify_on_block: notifyOnBlock,
        }),
      });
      toast("Notification settings saved");
    } catch (e) {
      // The webhook URL is now validated server-side (allowlisted host, no internal
      // targets), so show why it was refused instead of a generic failure.
      toast(e instanceof Error ? e.message : "Failed to save settings", "error");
    }
    setSaving(false);
  };

  const sendTest = async () => {
    setSendingTest(true);
    try {
      const r = await apiFetch<{ sent_to: string }>("/api/notifications/digest/test", { method: "POST" });
      toast(`Test digest sent to ${r.sent_to}`);
    } catch (e) {
      toast((e as Error).message || "Could not send digest", "error");
    }
    setSendingTest(false);
  };

  const cardStyle: React.CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 24,
    maxWidth: 640,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 13, fontWeight: 600, color: "var(--text-primary)", display: "block", marginBottom: 6,
  };
  const fieldInput: React.CSSProperties = {
    ...inputStyle, width: "100%", height: 38, padding: "0 12px", fontSize: 13,
  };

  if (loading) {
    return <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading…</div>;
  }

  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
        Alerts &amp; notifications
      </h2>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
        Where Arceo sends spend anomalies, budget-cap warnings, and blocked-action alerts. Leave the
        Slack webhook empty to turn alerts off.
      </p>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Slack incoming webhook URL</label>
        <input
          style={fieldInput}
          value={slackUrl}
          onChange={(e) => setSlackUrl(e.target.value)}
          placeholder="https://hooks.slack.com/services/…"
        />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 5 }}>
          Spend spikes, budget-cap breaches, and blocked actions post here. Create one under Slack →
          Incoming Webhooks.
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Weekly digest email</label>
        <input
          style={fieldInput}
          value={alertEmail}
          onChange={(e) => setAlertEmail(e.target.value)}
          placeholder="finops@yourcompany.com"
        />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 5 }}>
          A weekly cost + risk summary lands here. Requires email delivery configured on the server.
        </div>
      </div>

      <label
        style={{
          display: "flex", alignItems: "center", gap: 8, fontSize: 13,
          color: "var(--text-primary)", cursor: "pointer", marginBottom: 20,
        }}
      >
        <input
          type="checkbox"
          checked={notifyOnBlock}
          onChange={(e) => setNotifyOnBlock(e.target.checked)}
        />
        Notify on every blocked action
      </label>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save notification settings"}
        </Button>
        <Button variant="secondary" onClick={sendTest} disabled={sendingTest}>
          {sendingTest ? "Sending…" : "Send a test digest"}
        </Button>
      </div>
    </div>
  );
}

export default function Settings() {
  const user = getUser();
  const token = getToken() || "";
  const maskedToken = token ? token.slice(0, Math.min(16, token.length)) + "•".repeat(Math.max(0, Math.min(24, token.length - 16))) : "—";
  const [showToken, setShowToken] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSent, setInviteSent] = useState(false);
  const [inviteSending, setInviteSending] = useState(false);
  const [createdEmail, setCreatedEmail] = useState("");
  const [tempPass, setTempPass] = useState("");

  const [activeSection, setActiveSection] = useState("api");
  const [firstAgentId, setFirstAgentId] = useState("your-agent-id");

  useEffect(() => {
    apiFetch<{ agents?: Array<{ id: string }> } | Array<{ id: string }>>("/api/authority/agents")
      .then((data) => {
        const agents =
          (data as { agents?: Array<{ id: string }> }).agents ||
          (Array.isArray(data) ? data : []);
        if (agents.length > 0) setFirstAgentId(agents[0].id);
      })
      .catch(() => {});
  }, []);

  const sendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteSending(true);
    const emailToCreate = inviteEmail.trim();
    const tempPassword =
      Math.random().toString(36).slice(2, 8) +
      Math.random().toString(36).slice(2, 6).toUpperCase();
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

  const tokenPrefix = token.slice(0, 20);

  const enforceSnippetPython = `import requests

ARCEO_TOKEN = "${tokenPrefix}..."
AGENT_ID = "${firstAgentId}"

def enforce(tool: str, action: str, params: dict) -> bool:
    resp = requests.post(
        "https://api.arceo.io/api/enforce",
        json={"agent_id": AGENT_ID, "tool": tool, "action": action, "params": params},
        headers={"Authorization": f"Bearer {ARCEO_TOKEN}"}
    )
    result = resp.json()
    return result.get("decision") == "ALLOW"

# Before every tool call:
if enforce("Stripe", "create_refund", {"amount": 500, "customer_id": "cus_123"}):
    stripe.create_refund(...)`;

  const enforceSnippetCurl = `curl -X POST https://api.arceo.io/api/enforce \\
  -H "Authorization: Bearer ${tokenPrefix}..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "${firstAgentId}",
    "tool": "Stripe",
    "action": "create_refund",
    "params": {"amount": 500, "customer_id": "cus_123"}
  }'

# Response:
# { "decision": "ALLOW" }       → proceed
# { "decision": "BLOCK", ... }  → stop the action
# { "decision": "REQUIRE_APPROVAL", ... } → pause for human review`;

  const enforceSnippetNode = `const axios = require("axios");

const ARCEO_TOKEN = "${tokenPrefix}...";
const AGENT_ID = "${firstAgentId}";

async function enforce(tool, action, params) {
  const { data } = await axios.post(
    "https://api.arceo.io/api/enforce",
    { agent_id: AGENT_ID, tool, action, params },
    { headers: { Authorization: \`Bearer \${ARCEO_TOKEN}\` } }
  );
  return data.decision === "ALLOW";
}

// Before every tool call:
if (await enforce("Stripe", "create_refund", { amount: 500 })) {
  await stripe.refunds.create({ ... });
}`;

  const sections: NavSection[] = [
    { id: "api",     label: "API & Integration", icon: <KeyRound size={15} /> },
    { id: "cost",    label: "Cost model",        icon: <Banknote size={15} /> },
    { id: "notifications", label: "Notifications", icon: <Bell size={15} /> },
    { id: "team",    label: "Team",              icon: <Users size={15} /> },
    { id: "account", label: "Account",           icon: <UserCircle size={15} /> },
  ];

  const inputStyle: React.CSSProperties = {
    background: "var(--bg-sunken)",
    border: "2px solid transparent",
    borderRadius: "var(--radius-md)",
    color: "var(--text-primary)",
    padding: "0 16px",
    height: 42,
    fontSize: 13,
    width: "100%",
    outline: "none",
    boxSizing: "border-box",
    fontFamily: "inherit",
  };

  return (
    <div style={{ padding: 40, minHeight: "100%" }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>Settings</h1>
        <div style={{ display: "flex", marginTop: 24 }}>
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              style={{
                background: "transparent",
                border: "none",
                padding: "8px 16px 10px",
                fontSize: 13,
                fontWeight: activeSection === s.id ? 600 : 400,
                color: activeSection === s.id ? "var(--text-primary)" : "var(--text-secondary)",
                borderBottom: activeSection === s.id ? "2px solid var(--text-primary)" : "2px solid transparent",
                marginBottom: "-1px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div>

          {/* ── API & Integration ── */}
          {activeSection === "api" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <div
                style={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-lg)",
                  padding: 24,
                }}
              >
                <h2
                  style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}
                >
                  API Key
                </h2>
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
                  Use this token to authenticate your agent with Arceo's enforcement API. Pass it
                  as a{" "}
                  <code
                    style={{
                      background: "var(--bg-sunken)",
                      padding: "1px 6px",
                      borderRadius: "var(--radius-md)",
                      color: "var(--text-primary)",
                    }}
                  >
                    Bearer
                  </code>{" "}
                  token in the{" "}
                  <code
                    style={{
                      background: "var(--bg-sunken)",
                      padding: "1px 6px",
                      borderRadius: "var(--radius-md)",
                      color: "var(--text-primary)",
                    }}
                  >
                    Authorization
                  </code>{" "}
                  header.
                </p>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: "var(--bg-sunken)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-md)",
                    padding: "0 12px",
                    height: 42,
                  }}
                >
                  <code
                    style={{
                      flex: 1,
                      fontSize: 12,
                      fontFamily: "monospace",
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {showToken ? token : maskedToken}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowToken((v) => !v)}
                    icon={showToken ? <EyeOff size={12} /> : <Eye size={12} />}
                  >
                    {showToken ? "Hide" : "Show"}
                  </Button>
                  <CopyButton text={token} />
                </div>

                <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, marginBottom: 0 }}>
                  Your token never expires unless you log out and back in. Keep it secret — it
                  grants full API access.
                </p>
              </div>

              <div
                style={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-lg)",
                  padding: 24,
                }}
              >
                <h2
                  style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}
                >
                  Integrate the Enforcement API
                </h2>
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
                  Call{" "}
                  <code
                    style={{
                      background: "var(--bg-sunken)",
                      padding: "1px 6px",
                      borderRadius: "var(--radius-md)",
                      color: "var(--text-primary)",
                    }}
                  >
                    POST /api/enforce
                  </code>{" "}
                  before every tool action your agent takes. Arceo checks your policies and returns
                  a decision instantly.
                </p>

                <CodeSnippetTabs
                  tabs={[
                    { label: "Python",  code: enforceSnippetPython, lang: "python" },
                    { label: "curl",    code: enforceSnippetCurl,   lang: "bash" },
                    { label: "Node.js", code: enforceSnippetNode,   lang: "javascript" },
                  ]}
                />

                <div style={{ marginTop: 16 }}>
                  <h3
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      marginBottom: 8,
                      marginTop: 0,
                    }}
                  >
                    Decision responses
                  </h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                      <span
                        style={{
                          marginTop: 2,
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "#f0fdf4",
                          color: "#16a34a",
                          whiteSpace: "nowrap",
                        }}
                      >
                        ALLOW
                      </span>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        Action is permitted — proceed normally.
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                      <span
                        style={{
                          marginTop: 2,
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "#fef2f2",
                          color: "#dc2626",
                          whiteSpace: "nowrap",
                        }}
                      >
                        BLOCK
                      </span>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        Action is blocked by policy — do not proceed. Log the attempt.
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                      <span
                        style={{
                          marginTop: 2,
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "#fefce8",
                          color: "#ca8a04",
                          whiteSpace: "nowrap",
                        }}
                      >
                        REQUIRE_APPROVAL
                      </span>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        Action needs human approval — pause and wait for confirmation.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Cost model ── */}
          {activeSection === "cost" && <CostOverridesSection inputStyle={inputStyle} />}

          {/* ── Notifications ── */}
          {activeSection === "notifications" && <NotificationsSection inputStyle={inputStyle} />}

          {/* ── Team ── */}
          {activeSection === "team" && (
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                padding: 24,
                display: "flex",
                flexDirection: "column",
                gap: 24,
              }}
            >
              <div>
                <h2
                  style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}
                >
                  Team Members
                </h2>
                <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
                  Invite teammates to view agents, run simulations, and manage policies.
                </p>
              </div>

              {/* Current user */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  background: "var(--bg-sunken)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-lg)",
                  padding: "10px 12px",
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    background: "var(--color-cta)",
                    color: "var(--text-inverse)",
                    fontSize: 13,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {user?.email?.[0]?.toUpperCase() ?? "?"}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {user?.email}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Admin</div>
                </div>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "2px 8px",
                    borderRadius: "var(--radius-full)",
                    background: "#e5e7eb",
                    color: "var(--text-secondary)",
                  }}
                >
                  You
                </span>
              </div>

              {/* Invite form */}
              <div>
                <h3
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    margin: "0 0 4px",
                  }}
                >
                  Invite a teammate
                </h3>
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
                  Create an account for a teammate so they can view agents, run simulations, and
                  manage policies.
                </p>

                {inviteSent ? (
                  <div
                    style={{
                      border: "1px solid #bbf7d0",
                      background: "#f0fdf4",
                      borderRadius: "var(--radius-lg)",
                      padding: 16,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#166534" }}>
                      Account created for {createdEmail}
                    </div>
                    {tempPass ? (
                      <>
                        <p style={{ fontSize: 12, color: "#15803d", margin: 0 }}>
                          Share these login credentials with them:
                        </p>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: "#15803d",
                                width: 64,
                              }}
                            >
                              Email
                            </span>
                            <code
                              style={{
                                fontSize: 12,
                                background: "var(--bg-card)",
                                border: "1px solid #bbf7d0",
                                borderRadius: "var(--radius-md)",
                                padding: "2px 8px",
                                color: "#166534",
                              }}
                            >
                              {createdEmail}
                            </code>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: "#15803d",
                                width: 64,
                              }}
                            >
                              Password
                            </span>
                            <code
                              style={{
                                fontSize: 12,
                                background: "var(--bg-card)",
                                border: "1px solid #bbf7d0",
                                borderRadius: "var(--radius-md)",
                                padding: "2px 8px",
                                color: "#166534",
                              }}
                            >
                              {tempPass}
                            </code>
                          </div>
                        </div>
                        <p style={{ fontSize: 11, color: "#16a34a", margin: 0 }}>
                          They can change their password after signing in.
                        </p>
                      </>
                    ) : (
                      <p style={{ fontSize: 12, color: "#15803d", margin: 0 }}>
                        This email already has an account — they can sign in directly.
                      </p>
                    )}
                    <Button
                      style={{ marginTop: 8 }}
                      onClick={() => {
                        setInviteSent(false);
                        setCreatedEmail("");
                        setTempPass("");
                      }}
                    >
                      Invite another
                    </Button>
                  </div>
                ) : (
                  <form onSubmit={sendInvite} style={{ display: "flex", gap: 8 }}>
                    <input
                      type="email"
                      placeholder="teammate@company.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      required
                      style={{ ...inputStyle, flex: 1, width: "auto" }}
                      onFocus={(e) => {
                        (e.target as HTMLInputElement).style.borderColor = "var(--border-focus)";
                      }}
                      onBlur={(e) => {
                        (e.target as HTMLInputElement).style.borderColor = "transparent";
                      }}
                    />
                    <Button
                      type="submit"
                      disabled={inviteSending}
                      loading={inviteSending}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      {inviteSending ? "Creating..." : "Create Account"}
                    </Button>
                  </form>
                )}
              </div>
            </div>
          )}

          {/* ── Account ── */}
          {activeSection === "account" && (
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)",
                padding: 24,
                display: "flex",
                flexDirection: "column",
                gap: 24,
              }}
            >
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
                Account
              </h2>

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--text-muted)",
                      marginBottom: 4,
                    }}
                  >
                    Email
                  </label>
                  <input
                    type="email"
                    value={user?.email || ""}
                    readOnly
                    style={{ ...inputStyle, cursor: "not-allowed", opacity: 0.7 }}
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--text-muted)",
                      marginBottom: 4,
                    }}
                  >
                    Role
                  </label>
                  <input
                    type="text"
                    value={user?.role || "admin"}
                    readOnly
                    style={{ ...inputStyle, cursor: "not-allowed", opacity: 0.7 }}
                  />
                </div>
              </div>

              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                To change your password or delete your account, contact{" "}
                <a
                  href="mailto:support@arceo.ai"
                  style={{ color: "var(--text-link)", fontWeight: 500 }}
                >
                  support@arceo.ai
                </a>
                .
              </p>
            </div>
          )}

      </div>
    </div>
  );
}
